// src/utils/with-timeout.ts

/**
 * Race a promise against a hard timeout. If `ms` elapses first, the returned
 * promise REJECTS with an "<label> timeout" error. The underlying promise is
 * not cancelled — callers that need best-effort semantics should `.catch()`.
 */
export function withTimeout<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
