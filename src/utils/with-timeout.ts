// src/utils/with-timeout.ts

export interface WithTimeoutOpts {
  // Opt-in cancellation. When supplied, the controller is `.abort()`ed the moment
  // the timeout fires, so a caller whose underlying op honours the signal
  // (fetch/DNS/a judge forwarding it to spawnSafely) actually STOPS the work
  // instead of leaving it running orphaned in the background. Pass the SAME
  // controller's `.signal` into the operation you wrap (e.g. `fetch(url, {signal})`).
  controller?: AbortController;
  // Reason passed to `controller.abort(reason)`; defaults to the timeout Error.
  abortReason?: unknown;
}

/**
 * Race a promise against a hard timeout. If `ms` elapses first, the returned
 * promise REJECTS with an "<label> timeout" error.
 *
 * Cancellation: WITHOUT `opts.controller`, the underlying promise is NOT
 * cancelled — `Promise.race` only abandons it, so a hard-bound op (DNS lookup,
 * fetch, judge subprocess) keeps running in the background until it finishes on
 * its own (a resource leak). To actually cancel on timeout, pass an
 * `AbortController` via `opts.controller` AND thread its `.signal` into the
 * wrapped operation; this calls `controller.abort()` when the timeout fires.
 *
 * Either way, a LATE rejection from the abandoned/cancelled promise is swallowed
 * here (attached `.catch`), so it can never surface as an `unhandledRejection`
 * after we've already settled via the timeout — an unhandled late rejection can
 * crash the process or be misread as a fresh failure (a fail-open hazard).
 */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label = "operation",
  opts?: WithTimeoutOpts,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} timeout`);
      // Reject FIRST so the race settles on the deterministic "<label> timeout"
      // error, THEN cancel the underlying op. If we aborted before rejecting, an
      // op that rejects synchronously on abort (e.g. an AbortError) could win the
      // race and surface its own error instead of the timeout — breaking callers
      // that key on the "timeout" message. The op's late abort-rejection is
      // swallowed by the `p.catch` below.
      reject(err);
      // Cancel the underlying op if the caller opted in. abort() is best-effort:
      // an already-aborted/absent controller is a no-op.
      if (opts?.controller) {
        try {
          opts.controller.abort(opts.abortReason ?? err);
        } catch {
          /* best-effort */
        }
      }
    }, ms);
  });
  // Attach a no-op catch to the ORIGINAL promise so that if it rejects AFTER the
  // timeout already won the race (the abandoned/aborted op finally fails), that
  // rejection is consumed and never becomes an unhandledRejection. Harmless when
  // `p` settles before the timeout — the race already observed that outcome.
  p.catch(() => {});
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
