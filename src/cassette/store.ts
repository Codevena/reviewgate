import {
  constants,
  type Stats,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { type CassetteEntry, CassetteEntrySchema } from "../schemas/cassette.ts";

export const PRIVATE_CASSETTE_MAX_BYTES = 64 * 1024 * 1024;

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertPrivateRegular(stat: Stats, path: string): void {
  if (!stat.isFile()) throw new Error(`cassette: ${path} is not a regular file`);
  if (stat.nlink !== 1) throw new Error(`cassette: ${path} is a hardlink (nlink=${stat.nlink})`);
  if ((stat.mode & 0o7777) !== 0o600) {
    throw new Error(`cassette: ${path} mode must be exactly 0600`);
  }
}

function assertSamePathFile(path: string, opened: Stats): Stats {
  const current = lstatSync(path);
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.nlink !== 1 ||
    (current.mode & 0o7777) !== 0o600 ||
    current.dev !== opened.dev ||
    current.ino !== opened.ino
  ) {
    throw new Error(`cassette: ${path} changed identity or is not a private 0600 file`);
  }
  return current;
}

/** Exclusively create the Rig's empty private cassette before any agent is spawned. */
export function createPrivateCassette(path: string): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const opened = fstatSync(fd);
    assertPrivateRegular(opened, path);
    assertSamePathFile(path, opened);
  } finally {
    closeSync(fd);
  }
}

function openPrivateCassette(
  path: string,
  flags: number,
): {
  fd: number;
  stat: Stats;
  real: string;
} {
  const before = lstatSync(path);
  if (before.isSymbolicLink()) throw new Error(`cassette: refusing symlink ${path}`);
  if (!before.isFile()) throw new Error(`cassette: ${path} is not a regular file`);
  if (before.nlink !== 1)
    throw new Error(`cassette: ${path} is a hardlink (nlink=${before.nlink})`);
  if ((before.mode & 0o7777) !== 0o600) {
    throw new Error(`cassette: ${path} mode must be exactly 0600`);
  }
  const real = realpathSync(path);
  const fd = openSync(path, flags | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    assertPrivateRegular(opened, path);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.mtimeMs !== before.mtimeMs ||
      opened.ctimeMs !== before.ctimeMs
    ) {
      throw new Error(`cassette: ${path} changed while opening`);
    }
    assertSamePathFile(path, opened);
    if (realpathSync(path) !== real) throw new Error(`cassette: ${path} changed real path`);
    return { fd, stat: opened, real };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function assertContainedPrivatePath(path: string, root: string, real: string): void {
  const rootReal = realpathSync(root);
  if (!isContained(resolve(root), resolve(path)) || !isContained(rootReal, real)) {
    throw new Error(`cassette: ${path} is outside the measured repository`);
  }
}

/** Strict fstat-only size sampling used for per-turn byte ranges. */
export function privateCassetteSize(path: string, root: string): number {
  const opened = openPrivateCassette(path, constants.O_RDONLY);
  try {
    assertContainedPrivatePath(path, root, opened.real);
    const after = fstatSync(opened.fd);
    assertPrivateRegular(after, path);
    assertSamePathFile(path, after);
    if (
      after.dev !== opened.stat.dev ||
      after.ino !== opened.stat.ino ||
      after.size !== opened.stat.size ||
      after.mtimeMs !== opened.stat.mtimeMs ||
      after.ctimeMs !== opened.stat.ctimeMs ||
      realpathSync(path) !== opened.real
    ) {
      throw new Error(`cassette: ${path} changed while sampling size`);
    }
    return after.size;
  } finally {
    closeSync(opened.fd);
  }
}

/** Bounded, stable, single-buffer read used for both the authoritative hash and copy. */
export function readPrivateCassette(
  path: string,
  root: string,
  maxBytes = PRIVATE_CASSETTE_MAX_BYTES,
): Buffer {
  const opened = openPrivateCassette(path, constants.O_RDONLY);
  try {
    assertContainedPrivatePath(path, root, opened.real);
    if (opened.stat.size > maxBytes) throw new Error(`cassette: ${path} exceeds ${maxBytes} bytes`);
    const bytes = Buffer.alloc(opened.stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(opened.fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) throw new Error(`cassette: ${path} changed while reading`);
      offset += count;
    }
    const extra = Buffer.alloc(1);
    if (readSync(opened.fd, extra, 0, 1, bytes.length) !== 0) {
      throw new Error(`cassette: ${path} grew while reading`);
    }
    const after = fstatSync(opened.fd);
    assertPrivateRegular(after, path);
    assertSamePathFile(path, after);
    if (
      after.dev !== opened.stat.dev ||
      after.ino !== opened.stat.ino ||
      after.size !== opened.stat.size ||
      after.mtimeMs !== opened.stat.mtimeMs ||
      after.ctimeMs !== opened.stat.ctimeMs ||
      realpathSync(path) !== opened.real
    ) {
      throw new Error(`cassette: ${path} changed while reading`);
    }
    return bytes;
  } finally {
    closeSync(opened.fd);
  }
}

// Append-only JSONL. The synchronous single write keeps concurrent in-process recorder
// completions from interleaving, while all identity checks happen before victim bytes move.
export async function appendEntry(path: string, entry: CassetteEntry): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(path)) {
    try {
      createPrivateCassette(path);
    } catch (error) {
      if (!existsSync(path)) throw error;
    }
  }
  const opened = openPrivateCassette(path, constants.O_WRONLY | constants.O_APPEND);
  try {
    const line = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
    const written = writeSync(opened.fd, line);
    if (written !== line.length) throw new Error(`cassette: short append to ${path}`);
    const after = fstatSync(opened.fd);
    assertPrivateRegular(after, path);
    assertSamePathFile(path, after);
    if (
      after.dev !== opened.stat.dev ||
      after.ino !== opened.stat.ino ||
      after.size !== opened.stat.size + line.length ||
      realpathSync(path) !== opened.real
    ) {
      throw new Error(`cassette: ${path} changed while appending`);
    }
  } finally {
    closeSync(opened.fd);
  }
}

export function loadCassette(path: string): CassetteEntry[] {
  const raw = readFileSync(path, "utf8");
  const out: CassetteEntry[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(CassetteEntrySchema.parse(JSON.parse(t)));
    } catch {
      console.warn(`cassette: skipping malformed line in ${path}`);
    }
  }
  return out;
}

export interface CassetteEnv {
  mode: "record" | "replay";
  path: string;
}

// Parse REVIEWGATE_CASSETTE="record:<path>" | "replay:<path>". `value` defaults to
// the env var so callers can pass it explicitly in tests.
export function cassetteFromEnv(
  value: string | undefined = process.env.REVIEWGATE_CASSETTE,
): CassetteEnv | null {
  if (!value) return null;
  const m = value.match(/^(record|replay):(.+)$/);
  if (!m) return null;
  return { mode: m[1] as "record" | "replay", path: m[2] as string };
}
