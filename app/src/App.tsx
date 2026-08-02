import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CommandBar, type Command } from "./components/CommandBar";
import { Consensus, STAGES } from "./components/Consensus";
import { NewClaim, NewWatch } from "./components/Forms";
import { Receipt } from "./components/Receipt";
import { WalletModal } from "./components/WalletModal";
import { useWallet } from "./lib/wallet";
import { classifySendError, RETRY_DELAYS_MS, sleep } from "./lib/errors";
import {
  CONTRACT_ADDRESS,
  EXPLORER,
  FAUCET,
  makeClient,
  parseGen,
  short,
  toGen,
} from "./lib/genlayer";
import {
  loadLedger,
  measure,
  verdictOf,
  type Claim,
  type Ledger,
  type Measurements,
  type Watch,
} from "./lib/indexer";

type View =
  | { kind: "idle" }
  | { kind: "watch"; watchId: string }
  | { kind: "new-watch" }
  | { kind: "new-claim"; watchId: string }
  | { kind: "receipt"; claimId: number }
  | { kind: "running"; stage: number; note?: string; waiting?: string };

type LogLine = { at: string; message: string; kind?: "ok" | "err" | "run" };

export default function App() {
  const [ledger, setLedger] = useState<Ledger>({ watches: [], claims: [] });
  const [view, setView] = useState<View>({ kind: "idle" });
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [walletOpen, setWalletOpen] = useState(false);
  const [measurements, setMeasurements] = useState<Record<number, Measurements>>({});

  // Set while a resubmission is waiting out sequencer backpressure, so the user
  // is never held for four minutes with no way out.
  const abort = useRef(false);

  const wallet = useWallet();
  const { address, wrongChain } = wallet;
  const canWrite = Boolean(address) && !wrongChain;

  const client = useMemo(
    () => makeClient(address, wallet.connected?.provider),
    [address, wallet.connected],
  );

  const say = useCallback((message: string, kind?: LogLine["kind"]) => {
    setLog((lines) =>
      [
        { at: new Date().toLocaleTimeString([], { hour12: false }), message, kind },
        ...lines,
      ].slice(0, 120),
    );
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await loadLedger();
      setLedger(next);
      say(`ledger synced · ${next.watches.length} watches · ${next.claims.length} claims`);
    } catch (e: any) {
      say(`ledger sync failed: ${e.message}`, "err");
    }
  }, [say]);

  useEffect(() => {
    say("LicenseHound online. Press ⌘K / Ctrl-K for commands.");
    refresh();
  }, [refresh, say]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === "Escape") setWalletOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Deterministic re-measurement for judged claims, done lazily.
  useEffect(() => {
    const pending = ledger.claims.filter(
      (claim) => claim.derivative !== undefined && !measurements[claim.claimId],
    );
    if (pending.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const claim of pending) {
        const watch = ledger.watches.find((w) => w.watchId === claim.watchId);
        if (!watch) continue;
        try {
          const result = await measure(
            { repo: watch.originRepo, sha: watch.originSha },
            { repo: claim.suspectRepo, sha: claim.suspectSha },
            claim.pairs,
          );
          if (cancelled) return;
          setMeasurements((prev) => ({ ...prev, [claim.claimId]: result }));
          say(
            `claim #${claim.claimId} re-measured locally · similarity ${(
              result.similarityBp / 100
            ).toFixed(2)}% · licence match ${(result.licenseMatchBp / 100).toFixed(2)}%`,
          );
        } catch (e: any) {
          if (!cancelled) say(`re-measure failed for #${claim.claimId}: ${e.message}`, "err");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ledger, measurements, say]);

  const selectedWatch: Watch | undefined =
    view.kind === "watch" || view.kind === "new-claim"
      ? ledger.watches.find((w) => w.watchId === view.watchId)
      : undefined;

  useEffect(() => {
    if (address) say(`wallet connected · ${short(address, 6)}`, "ok");
  }, [address, say]);

  useEffect(() => {
    if (wrongChain) say("wallet is on the wrong network — switch to Bradbury", "err");
  }, [wrongChain, say]);

  const send = async (label: string, fn: () => Promise<any>, stages = 1) => {
    if (!canWrite) {
      setWalletOpen(true);
      return;
    }
    setBusy(true);
    setView({ kind: "running", stage: 0, note: label });
    say(`${label} · signing`, "run");
    try {
      // Only the submission is retried, and only when the node rejected it
      // outright. Once a transaction is broadcast, a second attempt would be a
      // second transaction.
      let hash: any;
      abort.current = false;
      for (let attempt = 0; ; attempt++) {
        try {
          hash = await fn();
          break;
        } catch (error: any) {
          const failure = classifySendError(error);
          if (!failure.retryable || attempt >= RETRY_DELAYS_MS.length) throw error;
          if (abort.current) throw new Error("Cancelled — nothing was sent.");
          const wait = RETRY_DELAYS_MS[attempt];
          say(
            `${label} · ${failure.message} Retry ${attempt + 1} of ` +
              `${RETRY_DELAYS_MS.length} in ${wait / 1000}s.`,
            "run",
          );
          setView({
            kind: "running",
            stage: 0,
            note: label,
            waiting:
              `The sequencer is shedding load. Attempt ${attempt + 1} of ` +
              `${RETRY_DELAYS_MS.length}, next in ${wait / 1000}s. ` +
              `Nothing has been sent or spent.`,
          });
          await sleep(wait);
          if (abort.current) throw new Error("Cancelled — nothing was sent.");
        }
      }
      say(`${label} · tx ${short(hash, 8)} submitted`, "run");
      for (let i = 1; i <= stages; i++) setView({ kind: "running", stage: i, note: label });
      const receipt: any = await client.waitForTransactionReceipt({
        hash,
        status: "ACCEPTED" as any,
        interval: 4000,
        retries: 120,
      });
      const outcome = receipt?.txExecutionResultName ?? "";
      const consensus = receipt?.resultName ?? "";
      if (consensus === "NO_MAJORITY") {
        say(`${label} · validators did not reach a majority — nothing settled`, "err");
      } else if (outcome === "FINISHED_WITH_ERROR") {
        say(`${label} · the contract rejected it`, "err");
      } else {
        say(`${label} · accepted · consensus ${consensus}`, "ok");
      }
      await refresh();
      return receipt;
    } catch (e: any) {
      const failure = classifySendError(e);
      say(`${label} failed · ${failure.message}`, "err");
      if (failure.retryable) {
        say("The network never took the transaction — nothing was spent.", "err");
      }
    } finally {
      setBusy(false);
      setView({ kind: "idle" });
    }
  };

  const judge = (claimId: number) =>
    send(
      `adjudicate #${claimId}`,
      () =>
        client.writeContract({
          address: CONTRACT_ADDRESS,
          functionName: "adjudicate",
          args: [BigInt(claimId)],
          value: 0n,
        }),
      STAGES.length - 1,
    );

  const commands: Command[] = [
    {
      id: "watch",
      glyph: "◆",
      label: "Open a watch",
      desc: "Fund a bounty on a repository you maintain",
      keywords: "new fund bounty maintainer",
      run: () => (canWrite ? setView({ kind: "new-watch" }) : setWalletOpen(true)),
    },
    {
      id: "claim",
      glyph: "▲",
      label: "File a claim",
      desc: selectedWatch ? `Against ${selectedWatch.originRepo}` : "Select a watch first",
      keywords: "report violation hunter bond",
      run: () =>
        !canWrite
          ? setWalletOpen(true)
          : selectedWatch &&
            setView({ kind: "new-claim", watchId: selectedWatch.watchId }),
      disabled: !selectedWatch,
    },
    ...ledger.claims
      .filter((claim) => !claim.judgeTx)
      .map((claim) => ({
        id: `judge-${claim.claimId}`,
        glyph: "§",
        label: `Adjudicate claim #${claim.claimId}`,
        desc: `${claim.suspectRepo} — runs the judgment through consensus`,
        keywords: "judge adjudicate verdict run",
        run: () => judge(claim.claimId),
      })),
    ...ledger.claims
      .filter((claim) => claim.judgeTx)
      .map((claim) => ({
        id: `receipt-${claim.claimId}`,
        glyph: "▤",
        label: `Receipt for claim #${claim.claimId}`,
        desc: `${claim.suspectRepo} — the settled evidence sheet`,
        keywords: "receipt evidence verdict document",
        run: () => setView({ kind: "receipt", claimId: claim.claimId }),
      })),
    {
      id: "withdraw",
      glyph: "↓",
      label: "Withdraw",
      desc: "Pull anything the contract owes you",
      keywords: "money payout claim funds",
      run: () =>
        send("withdraw", () =>
          client.writeContract({
            address: CONTRACT_ADDRESS,
            functionName: "withdraw",
            args: [],
            value: 0n,
          }),
        ),
    },
    {
      id: "refresh",
      glyph: "↻",
      label: "Resync the ledger",
      desc: "Rebuild state from the chain's transaction record",
      keywords: "reload refresh sync",
      run: refresh,
    },
    {
      id: "wallet",
      glyph: "◈",
      label: address ? "Wallet" : "Connect a wallet",
      desc: address
        ? `${short(address, 6)} · ${wallet.connected?.name ?? "connected"}`
        : "Sign with an injected wallet — no keys touch this page",
      keywords: "account connect login metamask sign disconnect",
      run: () => setWalletOpen(true),
    },
    {
      id: "switch",
      glyph: "⇄",
      label: "Switch to Bradbury",
      desc: "Point the wallet at chain 4221",
      keywords: "network chain switch bradbury",
      run: wallet.switchChain,
      disabled: !wrongChain,
    },
    {
      id: "faucet",
      glyph: "＋",
      label: "Open the faucet",
      desc: "Claim testnet GEN",
      keywords: "fund money gen tokens",
      run: () => window.open(FAUCET, "_blank"),
    },
    {
      id: "explorer",
      glyph: "↗",
      label: "View the contract",
      desc: CONTRACT_ADDRESS,
      keywords: "explorer chain address",
      run: () => window.open(`${EXPLORER}/address/${CONTRACT_ADDRESS}`, "_blank"),
    },
    {
      id: "disconnect",
      glyph: "×",
      label: "Disconnect",
      desc: "Forget the connected account",
      keywords: "logout remove disconnect",
      run: () => {
        wallet.disconnect();
        say("wallet disconnected");
      },
      disabled: !address,
    },
  ];

  const settled = ledger.claims.filter((c) => c.judgeTx).length;
  const violations = ledger.claims.filter(
    (c) => verdictOf(c, measurements[c.claimId]) === "VIOLATION",
  ).length;

  // A watch is spent the moment one of its claims lands a violation — the
  // bounty was paid out even though only the contract's own state says so.
  const isOpen = (watch: Watch) =>
    watch.open &&
    !ledger.claims.some(
      (c) =>
        c.watchId === watch.watchId &&
        verdictOf(c, measurements[c.claimId]) === "VIOLATION",
    );

  const pool = ledger.watches.reduce(
    (sum, w) => sum + (isOpen(w) ? w.bountyAtto : 0n),
    0n,
  );

  return (
    <div className="shell">
      <header className="masthead">
        <div className="masthead__brand">
          <h1 className="wordmark">
            <button
              className="wordmark__home"
              onClick={() => setView({ kind: "idle" })}
              title="Back to the front page"
            >
              License<em>Hound</em>
            </button>
          </h1>
          <span className="dateline">
            Bradbury Testnet · {new Date().toISOString().slice(0, 10)}
          </span>
        </div>
        <div className="masthead__right">
          <span className="kbd-hint">
            <kbd>⌘</kbd>
            <kbd>K</kbd> commands
          </span>
          <button
            className={`btn ${address ? "btn--ghost" : "btn--primary"}`}
            onClick={() => setWalletOpen(true)}
          >
            {address ? (
              <span className="wallet-chip">
                <span className={`wallet-chip__dot${wrongChain ? " is-warn" : ""}`} />
                {short(address, 5)}
              </span>
            ) : (
              "connect wallet"
            )}
          </button>
        </div>
      </header>

      {wrongChain && (
        <div className="chain-warning">
          <span>
            This wallet is on chain {wallet.chainId}. LicenseHound lives on Bradbury,
            chain 4221.
          </span>
          <button className="btn btn--ghost" onClick={wallet.switchChain}>
            Switch network
          </button>
        </div>
      )}

      <div className="ticker">
        <span>
          Contract <b>{short(CONTRACT_ADDRESS, 8)}</b>
        </span>
        <span>
          Open bounty pool <b>{toGen(pool)} GEN</b>
        </span>
        <span>
          Claims settled by consensus <b>{settled}</b>
        </span>
        <span>Evidence is fetched at an immutable commit SHA — never a branch</span>
      </div>

      <div className="body">
        <aside className="col-left">
          <div className="section">
            <div className="section__title">
              Docket <b>live</b>
            </div>
            <div className="stats">
              <div className="stat">
                <div className="stat__n">{ledger.watches.length}</div>
                <div className="stat__l">watches</div>
              </div>
              <div className="stat">
                <div className="stat__n">{ledger.claims.length}</div>
                <div className="stat__l">claims</div>
              </div>
              <div className="stat">
                <div className="stat__n">{settled}</div>
                <div className="stat__l">settled</div>
              </div>
              <div className="stat">
                <div className="stat__n">{violations}</div>
                <div className="stat__l">violations</div>
              </div>
            </div>
          </div>

          <div className="section" style={{ padding: 0, flex: 1, minHeight: 0 }}>
            <div className="section__title" style={{ padding: "16px 20px 10px", margin: 0 }}>
              Watches
            </div>
            <div className="watches">
              {ledger.watches.length === 0 && (
                <div style={{ padding: "14px 20px", color: "var(--ink-faint)" }}>
                  No watches yet. Press ⌘K → “Open a watch”.
                </div>
              )}
              {ledger.watches.map((watch) => {
                const claims = ledger.claims.filter((c) => c.watchId === watch.watchId);
                const active =
                  (view.kind === "watch" || view.kind === "new-claim") &&
                  view.watchId === watch.watchId;
                return (
                  <button
                    key={watch.watchId}
                    className="watch"
                    data-active={active}
                    onClick={() => setView({ kind: "watch", watchId: watch.watchId })}
                  >
                    <div className="watch__repo">{watch.originRepo}</div>
                    <div className="watch__meta">
                      <span className={`tag${isOpen(watch) ? " tag--accent" : " tag--closed"}`}>
                        {isOpen(watch) ? `${toGen(watch.bountyAtto)} GEN` : "paid out"}
                      </span>
                      <span className="tag">{watch.licenseId}</span>
                      <span>{watch.originSha.slice(0, 10)}</span>
                      <span>
                        {claims.length} claim{claims.length === 1 ? "" : "s"}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="section" style={{ borderBottom: 0, paddingBottom: 0 }}>
            <div className="section__title">Activity</div>
          </div>
          <div className="log">
            {log.map((line, index) => (
              <div className="log__line" key={index}>
                <span className="log__t">{line.at}</span>
                <span className="log__m" data-kind={line.kind}>
                  {line.message}
                </span>
              </div>
            ))}
          </div>
        </aside>

        <main className="col-right">
          <div className="sheet-wrap">
            {view.kind === "running" && (
              <Consensus
                stage={view.stage}
                note={view.note}
                waiting={view.waiting}
                onCancel={() => {
                  abort.current = true;
                  say("cancelling — the transaction was never sent", "run");
                }}
              />
            )}

            {view.kind === "new-watch" && (
              <NewWatch
                busy={busy}
                onCancel={() => setView({ kind: "idle" })}
                onSubmit={({ watchId, repo, sha, licenseId, bounty }) =>
                  send(`open watch ${watchId}`, () =>
                    client.writeContract({
                      address: CONTRACT_ADDRESS,
                      functionName: "open_watch",
                      args: [watchId, repo, sha, licenseId],
                      value: parseGen(bounty),
                    }),
                  )
                }
              />
            )}

            {view.kind === "new-claim" && selectedWatch && (
              <NewClaim
                watch={selectedWatch}
                busy={busy}
                onCancel={() => setView({ kind: "watch", watchId: selectedWatch.watchId })}
                onSubmit={({ repo, sha, pairs, bond }) =>
                  send(`file claim on ${repo}`, () =>
                    client.writeContract({
                      address: CONTRACT_ADDRESS,
                      functionName: "file_claim",
                      args: [selectedWatch.watchId, repo, sha, JSON.stringify(pairs)],
                      value: parseGen(bond),
                    }),
                  )
                }
              />
            )}

            {view.kind === "receipt" &&
              (() => {
                const claim = ledger.claims.find((c) => c.claimId === view.claimId);
                const watch = claim && ledger.watches.find((w) => w.watchId === claim.watchId);
                if (!claim || !watch) return null;
                return (
                  <Receipt
                    claim={claim}
                    watch={watch}
                    measurements={measurements[claim.claimId]}
                  />
                );
              })()}

            {view.kind === "watch" && selectedWatch && (
              <WatchDetail
                watch={selectedWatch}
                claims={ledger.claims.filter((c) => c.watchId === selectedWatch.watchId)}
                measurements={measurements}
                open={isOpen(selectedWatch)}
                canWrite={canWrite}
                onClaim={() =>
                  canWrite
                    ? setView({ kind: "new-claim", watchId: selectedWatch.watchId })
                    : setWalletOpen(true)
                }
                onOpenReceipt={(claimId) => setView({ kind: "receipt", claimId })}
                onJudge={judge}
              />
            )}

            {view.kind === "idle" && (
              <div className="empty">
                <div className="empty__mark">Who copied whom</div>
                <p style={{ maxWidth: "46ch" }}>
                  A bounty court for open-source licences. The contract fetches both
                  code bases itself, measures how much they overlap, and asks the
                  network the one question it cannot answer with arithmetic.
                </p>
                <button className="btn btn--primary" onClick={() => setPaletteOpen(true)}>
                  Press ⌘K to begin
                </button>
              </div>
            )}
          </div>
        </main>
      </div>

      <CommandBar
        open={paletteOpen}
        commands={commands}
        onClose={() => setPaletteOpen(false)}
      />

      {walletOpen && (
        <WalletModal wallet={wallet} onClose={() => setWalletOpen(false)} />
      )}
    </div>
  );
}

function WatchDetail({
  watch,
  claims,
  measurements,
  open,
  canWrite,
  onClaim,
  onJudge,
  onOpenReceipt,
}: {
  watch: Watch;
  claims: Claim[];
  measurements: Record<number, Measurements>;
  open: boolean;
  canWrite: boolean;
  onClaim: () => void;
  onJudge: (claimId: number) => void;
  onOpenReceipt: (claimId: number) => void;
}) {
  return (
    <section className="form">
      <div className="form__head">
        <div className="sheet__kicker" style={{ opacity: 0.5 }}>
          Watch · {watch.watchId}
        </div>
        <h2 className="form__title">{watch.originRepo}</h2>
        <p className="form__sub">
          Pinned at <code>{watch.originSha}</code> · {watch.licenseId} ·{" "}
          {open ? `${toGen(watch.bountyAtto)} GEN on the table` : "bounty paid out"} ·
          opened by {short(watch.owner, 5)}
        </p>
        <div className="actions" style={{ marginTop: 14 }}>
          <button className="btn btn--primary" onClick={onClaim} disabled={!open}>
            {canWrite ? "File a claim against this repo" : "Connect a wallet to file a claim"}
          </button>
          <a
            className="btn btn--ghost"
            href={`https://github.com/${watch.originRepo}/tree/${watch.originSha}`}
            target="_blank"
            rel="noreferrer"
          >
            Browse the pinned commit
          </a>
        </div>
      </div>
      <div className="form__body">
        <div className="section__title" style={{ margin: 0 }}>
          Claims
        </div>
        {claims.length === 0 && (
          <div className="note">
            Nobody has accused anyone yet. A claim needs a bond, so filing one is a bet
            that the network will agree with you.
          </div>
        )}
        <div className="claims-strip">
          {claims.map((claim) => {
            const verdict = verdictOf(claim, measurements[claim.claimId]);
            return (
              <button
                key={claim.claimId}
                className="claim-chip"
                onClick={() =>
                  claim.judgeTx ? onOpenReceipt(claim.claimId) : onJudge(claim.claimId)
                }
                disabled={!claim.judgeTx && !canWrite}
              >
                <span>#{claim.claimId}</span>
                <span style={{ color: "var(--ink-dim)" }}>{claim.suspectRepo}</span>
                <span className="pill" data-v={verdict}>
                  {claim.judgeTx ? verdict : "judge it"}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
