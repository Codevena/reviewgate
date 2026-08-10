import { describe, expect, it } from "bun:test";
import { OrderedResponseHashes } from "../../src/core/policy/response-hashes.ts";

describe("OrderedResponseHashes", () => {
  it("hashes UTF-8 response bytes in logical ordinal order", () => {
    const hashes = new OrderedResponseHashes();

    hashes.record("critic", 2, "abc");
    hashes.record("reviewer", 0, "");
    hashes.record("grounding", 1, "Grüße 🚪");

    expect(hashes.values()).toEqual([
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "4df010e4ad94311d48de48a08a3fe623b46e5535377c83bd73eb7f1b7ad63355",
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    ]);
  });

  it("retains only call identity and SHA-256, never raw response text", () => {
    const hashes = new OrderedResponseHashes();

    hashes.record("reviewer", 0, "raw secret-shaped reviewer response");

    expect(hashes.entries()).toEqual([
      {
        kind: "reviewer",
        ordinal: 0,
        sha256: "ca072f2419f612818cc0be807a46c9a293797889a1cbd9454737bb5d0e9d92df",
      },
    ]);
    expect(JSON.stringify(hashes.entries())).not.toContain("secret-shaped");
  });

  it("distinguishes an empty successful response from no response", () => {
    const hashes = new OrderedResponseHashes();
    const recordCall = (ordinal: number, call: () => string): void => {
      const response = call();
      hashes.record("critic", ordinal, response);
    };

    expect(() =>
      recordCall(0, () => {
        throw new Error("provider failed before returning a response");
      }),
    ).toThrow("provider failed before returning a response");
    hashes.record("critic", 1, undefined);
    hashes.record("critic", 2, "");

    expect(hashes.entries()).toHaveLength(1);
    expect(hashes.entries()[0]).toEqual({
      kind: "critic",
      ordinal: 2,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    });
  });
});
