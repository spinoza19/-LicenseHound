/**
 * Turning RPC failures into sentences.
 *
 * A reviewer hit this on a live demo:
 *
 *   error code -32603: Node is not currently accepting transactions:
 *   pipeline backpressure (l1_sender_commit)
 *
 * That is Bradbury's sequencer throttling itself, and it says nothing about the
 * transaction or the contract — but shown raw it reads exactly like a broken
 * dapp. Anything the user cannot act on should be translated, and anything the
 * network merely deferred should be retried rather than reported.
 */

export type SendFailure = {
  /** Shown to the user. A sentence, not a payload. */
  message: string;
  /**
   * True only when the node refused the transaction *before* broadcasting it.
   * Resubmitting is safe precisely because nothing reached the mempool — never
   * set this for a failure that might have left a transaction in flight.
   */
  retryable: boolean;
};

function textOf(error: any): string {
  return [
    error?.shortMessage,
    error?.details,
    error?.message,
    error?.cause?.message,
    error?.data?.message,
  ]
    .filter(Boolean)
    .join(" | ");
}

export function classifySendError(error: any): SendFailure {
  const text = textOf(error);
  const code = error?.code ?? error?.cause?.code;

  // The sequencer is refusing new work. It has not seen this transaction.
  if (/backpressure|not currently accepting transactions|l1_sender_commit/i.test(text)) {
    return {
      message:
        "Bradbury's sequencer is not accepting transactions right now — it is " +
        "applying backpressure while it commits to L1. Nothing was sent.",
      retryable: true,
    };
  }

  if (/rate limit|too many requests/i.test(text) || code === -32429 || code === 429) {
    return { message: "The RPC is rate limiting us. Nothing was sent.", retryable: true };
  }

  // Wallet-side outcomes: the user is the one who decides, so say so plainly.
  if (code === 4001 || /user rejected|user denied|rejected the request/i.test(text)) {
    return { message: "You rejected the signature in your wallet.", retryable: false };
  }

  if (/insufficient funds|exceeds the balance/i.test(text)) {
    return {
      message:
        "Not enough GEN to cover the value plus gas. Claim more from the faucet.",
      retryable: false,
    };
  }

  if (/wallet is on chain|chain mismatch/i.test(text)) {
    return {
      message: "Your wallet is on the wrong network. Switch to Bradbury and retry.",
      retryable: false,
    };
  }

  // A revert is the contract talking, and its message is the useful part.
  if (/reverted/i.test(text)) {
    return {
      message:
        "The transaction reverted before consensus — the contract refused it. " +
        "This usually means the state changed since the page last synced.",
      retryable: false,
    };
  }

  return { message: error?.shortMessage ?? error?.message ?? "unknown error", retryable: false };
}

/**
 * Backoff for resubmission, ~4 minutes in total.
 *
 * Sized from the network rather than from taste. Measured on 2 Aug 2026 during
 * a backpressure window: a submission was refused, the same submission landed
 * on the next attempt about two minutes later, and the chain was accepting
 * other people's transactions throughout — the sequencer sheds load, it does
 * not stop. Anything shorter gives up while the network is still saying "not
 * yet", which is how a working transaction gets reported as a failure.
 */
export const RETRY_DELAYS_MS = [4000, 10000, 20000, 30000, 45000, 60000, 60000];

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
