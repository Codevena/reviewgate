// src/providers/quota-signals.ts
// Detect provider quota / rate-limit exhaustion from a reviewer CLI's captured
// stderr/stdout. A quota error is categorically different from a normal review
// error (bad config, crash, syntax): it is TRANSIENT and provider-specific, so
// the orchestrator can fail over to a fallback provider instead of degrading
// coverage. Adapters map a matching error to status "quota-exhausted" (otherwise
// "error"), and the fallback chain only triggers on that status.
//
// Signatures are intentionally distinctive phrases — NOT bare words like "limit"
// — so an ordinary finding mentioning "rate limiting" in reviewed code can never
// be misread as the reviewer itself being throttled. Matched against the CLI's
// OWN diagnostic output, not the reviewed diff.
const QUOTA_SIGNATURES: RegExp[] = [
  // codex / OpenAI usage cap
  /hit your usage limit/i,
  /reached your usage limit/i,
  /usage limit reached/i,
  // Anthropic / generic
  /rate[_ ]?limit(?:_error|ed| exceeded| reached)/i,
  /\bquota (?:exceeded|exhausted|reached)\b/i,
  // Google Gemini
  /resource_exhausted/i,
  // HTTP status used by all three when throttled
  /\b429\b/,
  /too many requests/i,
  /insufficient[_ ]quota/i,
];

/** True when `text` (a CLI's own stderr/stdout) signals a quota/rate-limit hit. */
export function isQuotaExhausted(text: string | undefined | null): boolean {
  if (!text) return false;
  return QUOTA_SIGNATURES.some((re) => re.test(text));
}
