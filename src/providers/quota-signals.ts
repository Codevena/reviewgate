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
  // agy (Antigravity) — "⚠ Individual quota reached. Contact your administrator to
  // enable overages." The overage phrase is distinctive enough to key on by itself.
  /enable overages/i,
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

/**
 * A clean one-line snippet around the quota signal, for statusDetail. Needed
 * because some CLIs (codex) print the usage-limit banner — INCLUDING the
 * "try again at <date>" reset time — to STDOUT/events, not stderr; passing this
 * to statusDetail lets parseQuotaResetAt recover the reset time. Returns null if
 * no signal is present.
 */
export function extractQuotaMessage(text: string | undefined | null): string | null {
  if (!text) return null;
  let earliest = -1;
  for (const re of QUOTA_SIGNATURES) {
    const m = re.exec(text);
    if (m && (earliest === -1 || m.index < earliest)) earliest = m.index;
  }
  if (earliest === -1) return null;
  const start = Math.max(0, earliest - 40);
  return text
    .slice(start, start + 500)
    .replace(/\s+/g, " ")
    .trim();
}
