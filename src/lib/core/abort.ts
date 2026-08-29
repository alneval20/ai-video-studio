/**
 * Abort helpers.
 *
 * A per-request timeout and a caller's cancellation are both reasons to stop,
 * and every outbound HTTP call needs to honour both. Passing only
 * `AbortSignal.timeout(...)` — as is easy to do — means cancelling a job leaves
 * a multi-minute upload or artifact download running to completion.
 */

/** Combines a caller's signal with a timeout. Either one aborts the request. */
export function linkedSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** True when the error was caused by `signal` aborting rather than a timeout. */
export function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * Rejects when the signal aborts, so a polling loop can race it instead of
 * waiting out its full sleep interval before noticing a cancellation.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
