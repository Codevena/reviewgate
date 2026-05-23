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
