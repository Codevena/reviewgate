// tests/unit/sanitizer-redact.test.ts
// Finding 6: redactHighEntropy must also catch UUIDs (whose hyphen-flattened
// entropy slips under the 4.0 threshold) and hex secrets in a secret-key context,
// WITHOUT mangling benign 40-/64-char git SHAs that are common in diffs.
import { describe, expect, it } from "bun:test";
import { redactHighEntropy } from "../../src/diff/sanitizer.ts";

const MARK = "<REDACTED:HIGH_ENTROPY>";

describe("redactHighEntropy — UUID + contextual hex (F-6)", () => {
  it("redacts a canonical UUID", () => {
    const { out, count } = redactHighEntropy("session=550e8400-e29b-41d4-a716-446655440000 ok");
    expect(out).toContain(MARK);
    expect(out).not.toContain("550e8400-e29b-41d4-a716-446655440000");
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("redacts an uppercase UUID too", () => {
    const { out } = redactHighEntropy("id=F47AC10B-58CC-4372-A567-0E02B2C3D479");
    expect(out).toContain(MARK);
  });

  it("does NOT redact a bare 40-char git SHA (no hyphens, benign in diffs)", () => {
    const sha = "da39a3ee5e6b4b0d3255bfef95601890afd80709"; // 40 hex
    const { out } = redactHighEntropy(`commit ${sha} fixed it`);
    expect(out).toContain(sha);
    expect(out).not.toContain(MARK);
  });

  it("does NOT redact a bare 64-char sha256 (whitelisted shape)", () => {
    const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const { out } = redactHighEntropy(`hash: ${sha}`);
    expect(out).toContain(sha);
    expect(out).not.toContain(MARK);
  });

  it("redacts a long hex token assigned to a secret-ish key", () => {
    // Use a separator (space) so the entropy pass does NOT swallow the whole
    // `key sep hex` as one token — this exercises the contextual-hex rule, which
    // catches a hex secret a bare-SHA rule would (deliberately) leave alone.
    const hex = "deadbeefcafebabe0123456789abcdef01234567"; // 40 hex
    const { out } = redactHighEntropy(`api_key: ${hex}`);
    expect(out).toContain("api_key"); // key/label kept (colon breaks the token)
    expect(out).toContain(MARK);
    expect(out).not.toContain(hex); // the secret hex value is gone
  });

  it("still redacts the original high-entropy base64-ish tokens (no regression)", () => {
    const { out } = redactHighEntropy("token AbCd3fGh1jKlMnOpQrSt7vWxYz09+/=AbCd end");
    expect(out).toContain(MARK);
  });
});
