export type StageState = "idle" | "run" | "done";

export const STAGES = [
  {
    name: "Fetch the evidence",
    desc: "Both files pulled from raw.githubusercontent at a pinned commit SHA. Immutable bytes, so every validator reads exactly the same thing.",
    eq: "strict_eq",
  },
  {
    name: "Measure similarity",
    desc: "Comments and layout stripped, 5-token shingles, integer Jaccard in basis points. No floats, no model — arithmetic only.",
    eq: "strict_eq",
  },
  {
    name: "Measure attribution",
    desc: "The suspect's licence file is compared against the original's. Whether the licence was preserved is a text question, so code answers it.",
    eq: "strict_eq",
  },
  {
    name: "Ask the one hard question",
    desc: "Is the suspect code a derivative work? Every validator re-runs the judgment independently and the answers are compared.",
    eq: "prompt_comparative",
  },
  {
    name: "Derive the verdict and settle",
    desc: "The verdict follows from the measurements plus that single boolean. Deterministic vetoes block payouts the numbers do not support.",
    eq: "deterministic",
  },
] as const;

export function Consensus({
  stage,
  note,
  waiting,
  onCancel,
}: {
  stage: number;
  note?: string;
  /** Set while a submission is waiting out sequencer backpressure. */
  waiting?: string;
  onCancel?: () => void;
}) {
  return (
    <section className="consensus">
      <h2 className="consensus__title">
        {waiting ? "Waiting for the sequencer" : "Judgment in progress"}
      </h2>
      <p className="form__sub">
        Five validators are doing this work independently. The transaction only
        settles if their answers survive the equivalence principle.
        {note && (
          <>
            <br />
            {note}
          </>
        )}
      </p>

      {waiting && (
        <div className="backoff">
          <p className="backoff__text">{waiting}</p>
          {onCancel && (
            <button className="btn btn--ghost" onClick={onCancel}>
              Stop waiting
            </button>
          )}
        </div>
      )}
      <div className="stages">
        {STAGES.map((item, index) => (
          <div
            key={item.name}
            className="stage"
            data-state={index < stage ? "done" : index === stage ? "run" : "idle"}
          >
            <span className="stage__dot" />
            <span>
              <span className="stage__name">{item.name}</span>
              <span className="stage__desc">{item.desc}</span>
            </span>
            <span className="stage__eq">{item.eq}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
