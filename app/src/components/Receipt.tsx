import type { Claim, Measurements, Watch } from "../lib/indexer";
import { MIN_JACCARD_BP, checkAgainstContract } from "../lib/indexer";
import { EXPLORER, short, toGen } from "../lib/genlayer";

const bp = (value: number) => `${(value / 100).toFixed(2)}%`;

export function Receipt({
  claim,
  watch,
  measurements,
}: {
  claim: Claim;
  watch: Watch;
  measurements?: Measurements;
}) {
  // The contract's stored verdict is the receipt. The browser's own
  // re-measurement is shown beside it as a check, never in place of it.
  const verdict = claim.verdict;
  const check = checkAgainstContract(claim, measurements);

  return (
    <article className="sheet">
      <div className="stamp" data-v={verdict}>
        {verdict}
      </div>

      <header className="sheet__head">
        <div>
          <div className="sheet__kicker">Evidence Receipt · GenLayer Bradbury</div>
          <h2 className="sheet__title">
            {watch.originRepo}
            <br />
            vs {claim.suspectRepo}
          </h2>
        </div>
        <div className="sheet__id">
          claim #{claim.claimId}
          <br />
          {claim.at
            ? new Date(claim.at * 1000).toISOString().slice(0, 16).replace("T", " ")
            : "on chain"}
        </div>
      </header>

      <div className="rows">
        <div className="k">Original</div>
        <div className="v">
          {watch.originRepo} @ {watch.originSha}
        </div>

        <div className="k">Suspect</div>
        <div className="v">
          {claim.suspectRepo} @ {claim.suspectSha}
        </div>

        <div className="k">Declared licence</div>
        <div className="v">{watch.licenseId}</div>

        <div className="k">Files compared</div>
        <div className="v">
          {claim.pairs.map((pair) => (
            <div key={pair.origin + pair.suspect}>
              {pair.origin} → {pair.suspect}
            </div>
          ))}
        </div>

        <div className="k">Derivative work</div>
        <div className="v">
          {!claim.settled
            ? "not yet judged"
            : claim.verdict === "UNSUBSTANTIATED"
              ? "not assessed — the cited files do not exist at the pinned commit, so no model was asked"
              : claim.derivative
                ? "yes — decided by validator consensus"
                : "no — decided by validator consensus"}
        </div>

        <div className="k">Similarity (on chain)</div>
        <div className="v">
          {bp(claim.similarityBp)} — stored by the contract when it settled
        </div>

        <div className="k">Licence preserved</div>
        <div className="v">
          {measurements
            ? measurements.attributionPresent
              ? `yes — suspect licence matches the original at ${bp(measurements.licenseMatchBp)}`
              : `no — suspect licence matches the original at only ${bp(measurements.licenseMatchBp)}`
            : "measuring…"}
        </div>

        <div className="k">Reporter</div>
        <div className="v">{short(claim.reporter, 6)}</div>

        <div className="k">Bond / bounty</div>
        <div className="v">
          {toGen(claim.bondAtto)} GEN bonded · {toGen(watch.bountyAtto)} GEN at stake
        </div>

        {check.checked && (
          <>
            <div className="k">Independent check</div>
            <div className="v">
              {check.agrees
                ? "this browser re-fetched both files and re-derived the same verdict"
                : "this browser re-derived a different verdict — the contract's answer stands, but the inputs are worth a look"}
            </div>
          </>
        )}
      </div>

      {measurements && (
        <div className="gauge">
          <div className="gauge__bar">
            <div
              className="gauge__fill"
              style={{ width: `${Math.min(measurements.similarityBp / 100, 100)}%` }}
            />
            <div
              className="gauge__threshold"
              style={{ left: `${MIN_JACCARD_BP / 100}%` }}
              title="violation threshold"
            />
          </div>
          <div className="gauge__legend">
            <span>re-measured here {bp(measurements.similarityBp)}</span>
            <span>threshold {bp(MIN_JACCARD_BP)}</span>
          </div>
        </div>
      )}

      {claim.reasoning && <p className="finding">“{claim.reasoning}”</p>}

      <footer className="sheet__foot">
        Similarity and licence matching were computed by deterministic code and
        re-derived independently by every validator. The single judgment call —
        whether the suspect code is a derivative work — was voted on by the
        network, not by any one party.
        {claim.judgeTx && (
          <>
            <br />
            Adjudication transaction:{" "}
            <a href={`${EXPLORER}/tx/${claim.judgeTx}`} target="_blank" rel="noreferrer">
              {claim.judgeTx}
            </a>
          </>
        )}
        <br />
        This document records a technical measurement and a network vote. It is
        not legal advice and it is not a finding of any court.
      </footer>
    </article>
  );
}
