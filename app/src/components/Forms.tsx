import { useState } from "react";
import { parseRepoInput, previewPair, resolveSha } from "../lib/github";
import type { Watch } from "../lib/indexer";
import { MIN_JACCARD_BP } from "../lib/indexer";

const bp = (v: number) => `${(v / 100).toFixed(2)}%`;

export function NewWatch({
  busy,
  onSubmit,
  onCancel,
}: {
  busy: boolean;
  onSubmit: (input: {
    watchId: string;
    repo: string;
    sha: string;
    licenseId: string;
    bounty: string;
  }) => void;
  onCancel: () => void;
}) {
  const [repoInput, setRepoInput] = useState("");
  const [watchId, setWatchId] = useState("");
  const [licenseId, setLicenseId] = useState("GPL-3.0");
  const [bounty, setBounty] = useState("0.4");
  const [sha, setSha] = useState("");
  const [error, setError] = useState("");
  const [resolving, setResolving] = useState(false);

  const pin = async () => {
    setError("");
    setResolving(true);
    try {
      const { repo, ref } = parseRepoInput(repoInput);
      const resolved = await resolveSha(repo, ref);
      setSha(resolved);
      setRepoInput(repo);
      if (!watchId) setWatchId(repo.split("/")[1].slice(0, 32));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setResolving(false);
    }
  };

  return (
    <section className="form">
      <div className="form__head">
        <h2 className="form__title">Open a watch</h2>
        <p className="form__sub">
          Fund a bounty on a repository you maintain. Anyone who can show that
          another project shipped your code without preserving your licence can
          take it — but only if the network agrees with them.
        </p>
      </div>
      <div className="form__body">
        <div className="field">
          <label>Repository</label>
          <input
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            placeholder="owner/repo, a github.com URL, or owner/repo@branch"
          />
          <small>
            A branch is mutable, so the contract refuses it. Pinning resolves
            whatever you paste down to one immutable commit.
          </small>
        </div>

        <div className="actions">
          <button className="btn" onClick={pin} disabled={!repoInput || resolving}>
            {resolving ? "Pinning…" : "Pin to a commit"}
          </button>
          {sha && <code style={{ fontSize: 11, opacity: 0.7 }}>{sha}</code>}
        </div>

        <div className="grid-2">
          <div className="field">
            <label>Watch id</label>
            <input value={watchId} onChange={(e) => setWatchId(e.target.value)} />
          </div>
          <div className="field">
            <label>Licence</label>
            <input value={licenseId} onChange={(e) => setLicenseId(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label>Bounty (GEN)</label>
          <input value={bounty} onChange={(e) => setBounty(e.target.value)} />
        </div>

        {error && <div className="note">{error}</div>}

        <div className="actions">
          <button
            className="btn btn--primary"
            disabled={busy || !sha || !watchId}
            onClick={() => onSubmit({ watchId, repo: repoInput, sha, licenseId, bounty })}
          >
            {busy ? "Signing…" : "Fund the watch"}
          </button>
          <button className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}

type Row = { origin: string; suspect: string; bp?: number; identical?: boolean };

export function NewClaim({
  watch,
  busy,
  onSubmit,
  onCancel,
}: {
  watch: Watch;
  busy: boolean;
  onSubmit: (input: {
    repo: string;
    sha: string;
    pairs: { origin: string; suspect: string }[];
    bond: string;
  }) => void;
  onCancel: () => void;
}) {
  const [repoInput, setRepoInput] = useState("");
  const [sha, setSha] = useState("");
  const [bond, setBond] = useState("0.2");
  const [rows, setRows] = useState<Row[]>([{ origin: "", suspect: "" }]);
  const [error, setError] = useState("");
  const [busyLocal, setBusyLocal] = useState("");

  const pin = async () => {
    setError("");
    setBusyLocal("pin");
    try {
      const { repo, ref } = parseRepoInput(repoInput);
      setSha(await resolveSha(repo, ref));
      setRepoInput(repo);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyLocal("");
    }
  };

  const preview = async () => {
    setError("");
    setBusyLocal("preview");
    try {
      const measured = await Promise.all(
        rows.map(async (row) => {
          if (!row.origin || !row.suspect) return row;
          const result = await previewPair(
            { repo: watch.originRepo, sha: watch.originSha },
            { repo: repoInput, sha },
            row.origin,
            row.suspect,
          );
          return { ...row, bp: result.bp, identical: result.identical };
        }),
      );
      setRows(measured);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyLocal("");
    }
  };

  const usable = rows.filter((r) => r.origin && r.suspect);
  const best = rows.reduce((max, r) => Math.max(max, r.bp ?? 0), 0);

  return (
    <section className="form">
      <div className="form__head">
        <h2 className="form__title">File a claim</h2>
        <p className="form__sub">
          Against <b>{watch.originRepo}</b> @ {watch.originSha.slice(0, 12)} ·{" "}
          {watch.licenseId}. Your bond is returned unless the network decides the
          two projects are unrelated — junk claims cost money.
        </p>
      </div>
      <div className="form__body">
        <div className="field">
          <label>Suspect repository</label>
          <input
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            placeholder="owner/repo or a github.com URL"
          />
        </div>

        <div className="actions">
          <button className="btn" onClick={pin} disabled={!repoInput || !!busyLocal}>
            {busyLocal === "pin" ? "Pinning…" : "Pin to a commit"}
          </button>
          {sha && <code style={{ fontSize: 11, opacity: 0.7 }}>{sha}</code>}
        </div>

        <div className="field">
          <label>File pairs (max 3)</label>
          {rows.map((row, index) => (
            <div className="pairs__row" key={index}>
              <input
                placeholder="path in the original"
                value={row.origin}
                onChange={(e) =>
                  setRows(
                    rows.map((r, i) => (i === index ? { ...r, origin: e.target.value } : r)),
                  )
                }
              />
              <input
                placeholder="path in the suspect"
                value={row.suspect}
                onChange={(e) =>
                  setRows(
                    rows.map((r, i) => (i === index ? { ...r, suspect: e.target.value } : r)),
                  )
                }
              />
              <span className="tag" style={{ alignSelf: "center" }}>
                {row.identical ? "identical" : row.bp !== undefined ? bp(row.bp) : "—"}
              </span>
            </div>
          ))}
          <div className="actions">
            {rows.length < 3 && (
              <button
                className="btn btn--ghost"
                onClick={() => setRows([...rows, { origin: "", suspect: "" }])}
              >
                + pair
              </button>
            )}
            <button
              className="btn btn--ghost"
              onClick={preview}
              disabled={!sha || usable.length === 0 || !!busyLocal}
            >
              {busyLocal === "preview" ? "Measuring…" : "Preview similarity"}
            </button>
          </div>
          <small>
            The preview runs the contract's exact similarity measure in your
            browser. It is not authoritative — it just tells you whether the bond
            is worth risking. Below {bp(MIN_JACCARD_BP)} a violation verdict is
            vetoed on-chain.
          </small>
        </div>

        <div className="field">
          <label>Bond (GEN)</label>
          <input value={bond} onChange={(e) => setBond(e.target.value)} />
        </div>

        {best > 0 && best < MIN_JACCARD_BP && (
          <div className="note">
            Best pair measures {bp(best)}, under the {bp(MIN_JACCARD_BP)} floor. The
            contract will veto a violation verdict on this evidence.
          </div>
        )}
        {error && <div className="note">{error}</div>}

        <div className="actions">
          <button
            className="btn btn--primary"
            disabled={busy || !sha || usable.length === 0}
            onClick={() =>
              onSubmit({
                repo: repoInput,
                sha,
                pairs: usable.map((r) => ({ origin: r.origin, suspect: r.suspect })),
                bond,
              })
            }
          >
            {busy ? "Signing…" : "Post the bond and file"}
          </button>
          <button className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}
