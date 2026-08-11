import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { z } from "zod";
import { canonicalJson } from "../audit/canonical.ts";
import { writeFileIfAbsent } from "../utils/atomic-write.ts";

export type CanonicalArtifactReason =
  | "invalid-reference"
  | "path-escape"
  | "missing"
  | "not-a-file"
  | "too-large"
  | "hash-mismatch"
  | "invalid-encoding"
  | "invalid-json"
  | "invalid-schema"
  | "non-canonical"
  | "identity-mismatch"
  | "read-error";

export type CanonicalArtifactVerification<T> =
  | { ok: true; value: T }
  | { ok: false; reason: CanonicalArtifactReason };

export type CanonicalArtifactWriteResult =
  | { ok: true; ref: string; sha256: string }
  | { ok: false; reason: CanonicalArtifactReason };

const FULL_SHA256 = /^[0-9a-f]{64}$/;

export const __test: {
  beforeOpen: (() => void) | undefined;
  beforePathRecheck: (() => void) | undefined;
  beforeHashVerification: (() => void) | undefined;
  beforeBoundedRead: (() => void) | undefined;
  readSync: (fd: number, buffer: Buffer) => number;
} = {
  beforeOpen: undefined,
  beforePathRecheck: undefined,
  beforeHashVerification: undefined,
  beforeBoundedRead: undefined,
  readSync: (fd, buffer) => readSync(fd, buffer, 0, buffer.length, null),
};

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isContainedPath(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isSafeDirectoryName(directory: string): boolean {
  return (
    directory.length > 0 &&
    !directory.includes("\\") &&
    !directory.includes("/") &&
    directory !== "." &&
    directory !== ".."
  );
}

function isValidReference(ref: string): boolean {
  return (
    !isAbsolute(ref) &&
    !ref.includes("\\") &&
    !ref.split("/").some((component) => component === "" || component === "." || component === "..")
  );
}

function artifactRefFor(directory: string, contentSha256: string): string {
  return `artifacts/${directory}/${contentSha256}.json`;
}

function validMaxBytes(maxBytes: number): boolean {
  return Number.isSafeInteger(maxBytes) && maxBytes >= 0;
}

function ensureDirectoryWithoutSymlinks(path: string): boolean {
  const target = resolve(path);
  const missing: string[] = [];
  let cursor = target;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return false;
    missing.unshift(basename(cursor));
    cursor = parent;
  }
  try {
    const existing = lstatSync(cursor);
    if (existing.isSymbolicLink() || !existing.isDirectory()) return false;
    for (const component of missing) {
      cursor = join(cursor, component);
      try {
        mkdirSync(cursor, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
      }
      const created = lstatSync(cursor);
      if (created.isSymbolicLink() || !created.isDirectory()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function ensureContainedArtifactParent(root: string, ref: string): boolean {
  if (!ensureDirectoryWithoutSymlinks(root)) return false;
  try {
    const realRoot = realpathSync(root);
    let parent = resolve(root);
    for (const component of ref.split("/").slice(0, -1)) {
      parent = join(parent, component);
      if (!existsSync(parent)) {
        try {
          mkdirSync(parent, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
        }
      }
      const stat = lstatSync(parent);
      if (
        stat.isSymbolicLink() ||
        !stat.isDirectory() ||
        !isContainedPath(realRoot, realpathSync(parent))
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function verifyCanonicalJsonArtifact<T>(input: {
  root: string;
  directory: string;
  schema: z.ZodType<T>;
  ref: string;
  sha256: string;
  maxBytes: number;
}): CanonicalArtifactVerification<T> {
  if (
    !isSafeDirectoryName(input.directory) ||
    !FULL_SHA256.test(input.sha256) ||
    !isValidReference(input.ref)
  ) {
    return { ok: false, reason: "invalid-reference" };
  }
  if (input.ref !== artifactRefFor(input.directory, input.sha256)) {
    return { ok: false, reason: "identity-mismatch" };
  }
  if (!validMaxBytes(input.maxBytes)) return { ok: false, reason: "too-large" };

  const root = resolve(input.root);
  const candidate = resolve(root, ...input.ref.split("/"));
  if (!isContainedPath(root, candidate)) return { ok: false, reason: "path-escape" };
  if (!existsSync(candidate)) return { ok: false, reason: "missing" };

  let fd: number | undefined;
  try {
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return { ok: false, reason: "path-escape" };
    }
    const realRoot = realpathSync(root);
    let parent = root;
    for (const component of input.ref.split("/").slice(0, -1)) {
      parent = join(parent, component);
      const parentStat = lstatSync(parent);
      if (
        parentStat.isSymbolicLink() ||
        !parentStat.isDirectory() ||
        !isContainedPath(realRoot, realpathSync(parent))
      ) {
        return { ok: false, reason: "path-escape" };
      }
    }
    const before = lstatSync(candidate);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1 ||
      (before.mode & 0o7777) !== 0o600
    ) {
      return { ok: false, reason: "not-a-file" };
    }
    if (before.size > input.maxBytes) return { ok: false, reason: "too-large" };
    if (!isContainedPath(realRoot, realpathSync(candidate))) {
      return { ok: false, reason: "path-escape" };
    }
    __test.beforeOpen?.();
    fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      (opened.mode & 0o7777) !== 0o600 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      return { ok: false, reason: "not-a-file" };
    }
    if (opened.size > input.maxBytes) return { ok: false, reason: "too-large" };
    const bounded = Buffer.allocUnsafe(input.maxBytes + 1);
    __test.beforeBoundedRead?.();
    const bytesRead = __test.readSync(fd, bounded);
    if (bytesRead > input.maxBytes) return { ok: false, reason: "too-large" };
    const bytes = bounded.subarray(0, bytesRead);
    const after = fstatSync(fd);
    __test.beforePathRecheck?.();
    const pathAfter = lstatSync(candidate);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs ||
      pathAfter.isSymbolicLink() ||
      !pathAfter.isFile() ||
      pathAfter.nlink !== 1 ||
      (after.mode & 0o7777) !== 0o600 ||
      (pathAfter.mode & 0o7777) !== 0o600 ||
      pathAfter.dev !== after.dev ||
      pathAfter.ino !== after.ino
    ) {
      return { ok: false, reason: "read-error" };
    }
    __test.beforeHashVerification?.();
    if (sha256(bytes) !== input.sha256) return { ok: false, reason: "hash-mismatch" };
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return { ok: false, reason: "invalid-encoding" };
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text);
    } catch {
      return { ok: false, reason: "invalid-json" };
    }
    const parsed = input.schema.safeParse(decoded);
    if (!parsed.success) return { ok: false, reason: "invalid-schema" };
    if (canonicalJson(parsed.data) !== text) return { ok: false, reason: "non-canonical" };
    return { ok: true, value: parsed.data };
  } catch {
    return { ok: false, reason: "read-error" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function writeCanonicalJsonArtifact<T>(input: {
  root: string;
  directory: string;
  schema: z.ZodType<T>;
  value: T;
  maxBytes: number;
}): CanonicalArtifactWriteResult {
  if (!isSafeDirectoryName(input.directory)) return { ok: false, reason: "invalid-reference" };
  if (!validMaxBytes(input.maxBytes)) return { ok: false, reason: "too-large" };
  const parsed = input.schema.safeParse(input.value);
  if (!parsed.success) return { ok: false, reason: "invalid-schema" };
  const canonical = canonicalJson(parsed.data);
  const bytes = Buffer.from(canonical, "utf8");
  if (bytes.length > input.maxBytes) return { ok: false, reason: "too-large" };
  const contentSha256 = sha256(bytes);
  const ref = artifactRefFor(input.directory, contentSha256);
  if (!ensureContainedArtifactParent(input.root, ref)) {
    return { ok: false, reason: "path-escape" };
  }
  const destination = resolve(input.root, ...ref.split("/"));
  try {
    writeFileIfAbsent(destination, canonical, { mode: 0o600 });
  } catch {
    return { ok: false, reason: "read-error" };
  }
  const verified = verifyCanonicalJsonArtifact({
    root: input.root,
    directory: input.directory,
    schema: input.schema,
    ref,
    sha256: contentSha256,
    maxBytes: input.maxBytes,
  });
  return verified.ok ? { ok: true, ref, sha256: contentSha256 } : verified;
}
