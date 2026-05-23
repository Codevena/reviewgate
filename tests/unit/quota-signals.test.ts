import { describe, expect, test } from "bun:test";
import { isQuotaExhausted } from "../../src/providers/quota-signals.ts";

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
