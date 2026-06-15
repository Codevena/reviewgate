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
import { safeJsonParse } from "../utils/safe-json.ts";

const QUOTA_SIGNATURES: RegExp[] = [
  // codex / OpenAI usage cap
  /hit your usage limit/i,
  /reached your usage limit/i,
  /usage limit reached/i,
  // Anthropic / generic. Covers the canonical underscore forms emitted by API
  // error envelopes — `rate_limit_error` (Anthropic) AND `rate_limit_exceeded`
  // (OpenAI/OpenRouter) — plus the spaced "rate limit exceeded/reached" wording.
  // Without the explicit `rate_limit_exceeded` alternative the underscore form
  // slips through to a generic "error" and skips failover/cooldown (F-6a).
  /rate[_ ]?limit(?:_error|_exceeded|ed| exceeded| reached)/i,
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

// A real CLI quota/usage-limit banner is a SHORT diagnostic that LEADS with the
// quota signal (optionally behind a tiny prefix): `ERROR: You've hit your usage
// limit...`, `⚠ Individual quota reached...`, `HTTP 429 Too Many Requests`, or a
// codex `--json` event whose `text` field IS the message ("You have hit your
// usage limit..."). A reviewer echoing/quoting the reviewed diff, by contrast,
// produces a longer sentence where a planted quota phrase sits DEEP in the line
// ("...there's a comment that reads // TODO handle rate limit exceeded..."). So
// we require BOTH a short-enough line AND the signal to start near the front —
// that combination is what keeps an injected phrase from suppressing the reviewer
// (DoS) and a benign diff from false-triggering a cooldown.
const BANNER_LINE_MAX = 200;
const BANNER_SIGNAL_MAX_OFFSET = 80;

// True when `s` is a short line that LEADS with a quota signal (within the first
// BANNER_SIGNAL_MAX_OFFSET chars) — the shape of a real CLI banner, not an echoed
// sentence that merely mentions the phrase later on.
function isBannerShaped(s: string): boolean {
  if (s.length > BANNER_LINE_MAX) return false;
  for (const re of QUOTA_SIGNATURES) {
    // Each signature is global-less; build a fresh search from index 0.
    const m = re.exec(s);
    if (m && m.index <= BANNER_SIGNAL_MAX_OFFSET) return true;
  }
  return false;
}

/**
 * Channel-aware quota detection for an OUTPUT stream that can echo the reviewed
 * diff (the model's stdout / a CLI's `--json` event stream), as opposed to the
 * CLI's own stderr (use {@link isQuotaExhausted} for that — it scans freely).
 *
 * Untrusted because a malicious diff can make the reviewer quote a quota phrase
 * back into its reasoning; we must not let that suppress the reviewer (DoS) nor
 * let a benign diff false-trigger a cooldown. So a signature counts only when it
 * sits on a short banner-shaped line (leads with the signal) — for a JSON event
 * line we match against the structured `text`/`message`/`error` field, never the
 * whole serialized event. The diff itself rides STDIN and is never in this
 * channel verbatim; this guards the residual echo path.
 */
export function isQuotaBanner(text: string | undefined | null): boolean {
  if (!text) return false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // A JSON event line (codex `--json`): scan only its diagnostic string fields,
    // banner-shaped, rather than the serialized blob (whose unrelated fields would
    // otherwise shift the signal offset and defeat the leading-offset check).
    const parsed = safeJsonParse(line);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const o = parsed as Record<string, unknown>;
      const fields = [o.text, o.message, o.error, o.detail, o.reason];
      for (const f of fields) {
        if (typeof f === "string" && isBannerShaped(f.trim())) return true;
      }
      continue;
    }
    if (isBannerShaped(line)) return true;
  }
  return false;
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
