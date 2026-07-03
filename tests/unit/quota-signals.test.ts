import { describe, expect, test } from "bun:test";
import { extractQuotaMessage, isQuotaExhausted } from "../../src/providers/quota-signals.ts";

describe("isQuotaExhausted", () => {
  test("detects codex usage-limit banner", () => {
    expect(
      isQuotaExhausted("ERROR: You've hit your usage limit. Try again at May 27th, 2026 12:57 AM."),
    ).toBe(true);
  });

  test("detects gemini RESOURCE_EXHAUSTED", () => {
    expect(isQuotaExhausted('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}')).toBe(true);
  });

  test("detects claude rate_limit_error", () => {
    expect(isQuotaExhausted('{"type":"rate_limit_error","message":"..."}')).toBe(true);
  });

  test("detects a generic HTTP 429 quota line", () => {
    expect(isQuotaExhausted("HTTP 429 Too Many Requests: quota exceeded")).toBe(true);
  });

  test("is case-insensitive", () => {
    expect(isQuotaExhausted("you've HIT your USAGE LIMIT")).toBe(true);
  });

  test("does NOT match an ordinary review error", () => {
    expect(isQuotaExhausted("SyntaxError: unexpected token in JSON at position 0")).toBe(false);
  });

  test("does NOT match a model-not-found error", () => {
    expect(isQuotaExhausted("ModelNotFoundError: Requested entity was not found.")).toBe(false);
  });

  test("does NOT match a plain timeout", () => {
    expect(isQuotaExhausted("process killed after 300000ms")).toBe(false);
  });

  test("handles empty / undefined input", () => {
    expect(isQuotaExhausted("")).toBe(false);
    expect(isQuotaExhausted(undefined)).toBe(false);
  });
});

describe("extractQuotaMessage", () => {
  test("returns a snippet that retains the codex 'try again at <date>' reset time", () => {
    // The reset time can sit well after the first signal, buried in JSONL events.
    const events =
      '{"type":"item","text":"ERROR: You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at May 27th, 2026 12:57 AM."}';
    const msg = extractQuotaMessage(events);
    expect(msg).not.toBeNull();
    expect(msg).toContain("try again at May 27th, 2026 12:57 AM");
  });

  test("returns null when there is no quota signal", () => {
    expect(extractQuotaMessage("just a normal error")).toBeNull();
    expect(extractQuotaMessage(undefined)).toBeNull();
  });
});

describe("isQuotaExhausted — agy (Antigravity) wording", () => {
  test("detects the full agy quota banner", () => {
    expect(
      isQuotaExhausted(
        "⚠ Individual quota reached. Contact your administrator to enable overages. Resets in 25m38s.",
      ),
    ).toBe(true);
  });

  test("detects the distinctive 'enable overages' phrase on its own", () => {
    // agy's wording can surface without the "quota reached" clause; the overage
    // phrase is distinctive (never appears in reviewed code) so it is safe to key on.
    expect(isQuotaExhausted("Contact your administrator to enable overages.")).toBe(true);
  });
});

describe("isQuotaExhausted — 429 status (S4b)", () => {
  test("stack-trace line:col does not read as quota (S4b)", () => {
    expect(isQuotaExhausted("TypeError: x is not a function\n    at parse (foo.ts:429:12)")).toBe(
      false,
    );
    expect(isQuotaExhausted("at Object.<anonymous> (/app/dist/main.js:1429:3)")).toBe(false);
    expect(isQuotaExhausted("expected 429 items")).toBe(false); // bare count in prose
    expect(isQuotaExhausted("processed 429 files in 2s")).toBe(false);
  });

  test("real 429 diagnostics still read as quota", () => {
    expect(isQuotaExhausted("HTTP 429 Too Many Requests")).toBe(true);
    expect(isQuotaExhausted("429 Too Many Requests")).toBe(true); // curl-style status line
    expect(isQuotaExhausted("Request failed with status code 429")).toBe(true);
    expect(isQuotaExhausted("error: 429")).toBe(true);
    expect(isQuotaExhausted("upstream returned 429: slow down")).toBe(true);
    // round-3 W2: representative provider/SDK shapes
    expect(isQuotaExhausted("HTTP/2 429")).toBe(true);
    expect(isQuotaExhausted("HTTPError: 429")).toBe(true);
    expect(isQuotaExhausted("429 from upstream")).toBe(true);
  });

  test("crash diagnostics near an error word still do not read as quota", () => {
    expect(isQuotaExhausted("error a.ts:429:2")).toBe(false); // short path after context word
    expect(isQuotaExhausted("error at foo.ts:429:12")).toBe(false);
    expect(isQuotaExhausted("syntax error line 429")).toBe(false); // round-14 W2
    expect(isQuotaExhausted("error line 429")).toBe(false);
  });

  test("no-space colon form still reads as quota", () => {
    expect(isQuotaExhausted("error:429")).toBe(true);
  });
});
