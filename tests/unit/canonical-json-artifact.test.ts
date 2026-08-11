import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  __test,
  verifyCanonicalJsonArtifact,
  writeCanonicalJsonArtifact,
} from "../../src/artifacts/canonical-json.ts";
import { canonicalJson } from "../../src/audit/canonical.ts";

const ExampleSchema = z.object({ schema: z.literal("example.v1"), value: z.number() }).strict();
const MAX_BYTES = 4096;

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function root(): string {
  return mkdtempSync(join(tmpdir(), "rg-canonical-json-artifact-"));
}

function refFor(contentSha256: string): string {
  return `artifacts/examples/${contentSha256}.json`;
}

function writeArtifact(
  rootDir: string,
  bytes: string | Buffer,
  filenameSha = sha256(bytes),
): {
  path: string;
  ref: string;
  sha256: string;
} {
  const ref = refFor(filenameSha);
  const path = join(rootDir, ref);
  mkdirSync(join(rootDir, "artifacts", "examples"), { recursive: true });
  writeFileSync(path, bytes, { mode: 0o600 });
  return { path, ref, sha256: filenameSha };
}

function verify(rootDir: string, ref: string, contentSha256: string, maxBytes = MAX_BYTES) {
  return verifyCanonicalJsonArtifact({
    root: rootDir,
    directory: "examples",
    schema: ExampleSchema,
    ref,
    sha256: contentSha256,
    maxBytes,
  });
}

describe("canonical JSON artifacts", () => {
  it("writes canonical mode-0600 content addressed JSON and verifies the same inode", () => {
    const rootDir = root();
    const stored = writeCanonicalJsonArtifact({
      root: rootDir,
      directory: "examples",
      schema: ExampleSchema,
      value: { schema: "example.v1", value: 7 },
      maxBytes: MAX_BYTES,
    });
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.ref).toBe(`artifacts/examples/${stored.sha256}.json`);
    expect(lstatSync(join(rootDir, stored.ref)).mode & 0o7777).toBe(0o600);
    expect(verify(rootDir, stored.ref, stored.sha256)).toEqual({
      ok: true,
      value: { schema: "example.v1", value: 7 },
    });
  });

  it("rejects a symlinked artifact ancestor", () => {
    const rootDir = root();
    const outside = join(rootDir, "outside");
    mkdirSync(outside);
    mkdirSync(join(rootDir, "artifacts"));
    symlinkSync(outside, join(rootDir, "artifacts", "examples"));
    const bytes = canonicalJson({ schema: "example.v1", value: 7 });
    const contentSha256 = sha256(bytes);
    writeFileSync(join(outside, `${contentSha256}.json`), bytes, { mode: 0o600 });
    expect(verify(rootDir, refFor(contentSha256), contentSha256)).toEqual({
      ok: false,
      reason: "path-escape",
    });
  });

  it("rejects a final symlink", () => {
    const rootDir = root();
    const bytes = canonicalJson({ schema: "example.v1", value: 7 });
    const contentSha256 = sha256(bytes);
    const stored = writeArtifact(rootDir, bytes, contentSha256);
    const outside = join(rootDir, "outside.json");
    writeFileSync(outside, bytes, { mode: 0o600 });
    unlinkSync(stored.path);
    symlinkSync(outside, stored.path);
    expect(verify(rootDir, stored.ref, contentSha256)).toEqual({ ok: false, reason: "not-a-file" });
  });

  it("rejects a hardlinked artifact", () => {
    const rootDir = root();
    const bytes = canonicalJson({ schema: "example.v1", value: 7 });
    const contentSha256 = sha256(bytes);
    const stored = writeArtifact(rootDir, bytes, contentSha256);
    linkSync(stored.path, join(rootDir, "second-link.json"));
    expect(verify(rootDir, stored.ref, contentSha256)).toEqual({ ok: false, reason: "not-a-file" });
  });

  it("rejects a hash-valid artifact with mode 0644", () => {
    const rootDir = root();
    const bytes = canonicalJson({ schema: "example.v1", value: 7 });
    const contentSha256 = sha256(bytes);
    const stored = writeArtifact(rootDir, bytes, contentSha256);
    chmodSync(stored.path, 0o644);
    expect(verify(rootDir, stored.ref, contentSha256)).toEqual({ ok: false, reason: "not-a-file" });
  });

  it("rejects an artifact whose bytes exceed the configured bound", () => {
    const rootDir = root();
    const bytes = canonicalJson({ schema: "example.v1", value: 123456789 });
    const contentSha256 = sha256(bytes);
    const stored = writeArtifact(rootDir, bytes, contentSha256);
    expect(verify(rootDir, stored.ref, contentSha256, bytes.length - 1)).toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("reads one maxBytes+1 buffer after fstat and rejects growth at the cap", () => {
    const rootDir = root();
    const bytes = canonicalJson({ schema: "example.v1", value: 7 });
    const maxBytes = bytes.length;
    const contentSha256 = sha256(bytes);
    const stored = writeArtifact(rootDir, bytes, contentSha256);
    const readRequests: number[] = [];
    const originalReadSync = __test.readSync;
    __test.beforeBoundedRead = () => appendFileSync(stored.path, Buffer.alloc(maxBytes + 1));
    __test.readSync = (fd, buffer) => {
      readRequests.push(buffer.length);
      return originalReadSync(fd, buffer);
    };
    try {
      const result = verify(rootDir, stored.ref, contentSha256, maxBytes);
      expect(readRequests).toEqual([maxBytes + 1]);
      expect(result).toEqual({
        ok: false,
        reason: "too-large",
      });
    } finally {
      __test.beforeBoundedRead = undefined;
      __test.readSync = originalReadSync;
    }
  });

  it("rejects invalid UTF-8 bytes before JSON parsing", () => {
    const rootDir = root();
    const bytes = Buffer.from([0xc3, 0x28]);
    const contentSha256 = sha256(bytes);
    const stored = writeArtifact(rootDir, bytes, contentSha256);
    expect(verify(rootDir, stored.ref, contentSha256)).toEqual({
      ok: false,
      reason: "invalid-encoding",
    });
  });

  it("rejects valid but non-canonical JSON bytes", () => {
    const rootDir = root();
    const bytes = '{"value":7,"schema":"example.v1"}';
    const contentSha256 = sha256(bytes);
    const stored = writeArtifact(rootDir, bytes, contentSha256);
    expect(verify(rootDir, stored.ref, contentSha256)).toEqual({
      ok: false,
      reason: "non-canonical",
    });
  });

  it("rejects bytes which no longer match the content-addressed hash", () => {
    const rootDir = root();
    const original = canonicalJson({ schema: "example.v1", value: 7 });
    const stored = writeArtifact(rootDir, original);
    writeFileSync(stored.path, canonicalJson({ schema: "example.v1", value: 8 }), { mode: 0o600 });
    expect(verify(rootDir, stored.ref, stored.sha256)).toEqual({
      ok: false,
      reason: "hash-mismatch",
    });
  });

  it("rejects a traversal reference before resolving it", () => {
    const rootDir = root();
    expect(verify(rootDir, "artifacts/examples/../outside.json", "a".repeat(64))).toEqual({
      ok: false,
      reason: "invalid-reference",
    });
  });

  it("rejects an inode swapped after open and before the final path recheck", () => {
    const rootDir = root();
    const bytes = canonicalJson({ schema: "example.v1", value: 7 });
    const contentSha256 = sha256(bytes);
    const stored = writeArtifact(rootDir, bytes, contentSha256);
    const replacement = join(rootDir, "replacement.json");
    writeFileSync(replacement, bytes, { mode: 0o600 });
    __test.beforePathRecheck = () => renameSync(replacement, stored.path);
    try {
      expect(verify(rootDir, stored.ref, contentSha256)).toEqual({
        ok: false,
        reason: "read-error",
      });
    } finally {
      __test.beforePathRecheck = undefined;
    }
  });

  it("rejects a final symlink swapped in after lstat and before open", () => {
    const rootDir = root();
    const bytes = canonicalJson({ schema: "example.v1", value: 7 });
    const contentSha256 = sha256(bytes);
    const stored = writeArtifact(rootDir, bytes, contentSha256);
    const outside = join(rootDir, "outside.json");
    writeFileSync(outside, bytes, { mode: 0o600 });
    __test.beforeOpen = () => {
      unlinkSync(stored.path);
      symlinkSync(outside, stored.path);
    };
    try {
      expect(verify(rootDir, stored.ref, contentSha256)).toEqual({
        ok: false,
        reason: "read-error",
      });
    } finally {
      __test.beforeOpen = undefined;
    }
  });

  it("hashes the verified FD bytes rather than rereading the pathname", () => {
    const rootDir = root();
    const openedBytes = canonicalJson({ schema: "example.v1", value: 7 });
    const replacementBytes = canonicalJson({ schema: "example.v1", value: 8 });
    const replacementSha = sha256(replacementBytes);
    const stored = writeArtifact(rootDir, openedBytes, replacementSha);
    const replacement = join(rootDir, "replacement.json");
    writeFileSync(replacement, replacementBytes, { mode: 0o600 });
    let hookCalled = false;
    __test.beforeHashVerification = () => {
      hookCalled = true;
      renameSync(replacement, stored.path);
    };
    try {
      expect(hookCalled).toBe(false);
      expect(verify(rootDir, stored.ref, replacementSha)).toEqual({
        ok: false,
        reason: "hash-mismatch",
      });
      expect(hookCalled).toBe(true);
    } finally {
      __test.beforeHashVerification = undefined;
    }
  });
});
