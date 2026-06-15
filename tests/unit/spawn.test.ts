// tests/unit/spawn.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSafely } from "../../src/utils/spawn.ts";

describe("spawnSafely", () => {
  it("captures the FULL stdout before resolving (no flush/close race)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-spawn-"));
    const outFile = join(dir, "out");
    const errFile = join(dir, "err");
    // A sizable payload makes a premature-resolve (read-before-flush) truncate.
    const res = await spawnSafely({
      command: "bash",
      args: ["-c", 'for i in $(seq 1 5000); do echo "line-$i"; done'],
      stdoutFile: outFile,
      stderrFile: errFile,
      timeoutMs: 30_000,
    });
    expect(res.exitCode).toBe(0);
    const out = readFileSync(outFile, "utf8");
    // Must contain the FIRST and the LAST line — i.e. nothing was dropped.
    expect(out).toContain("line-1\n");
    expect(out).toContain("line-5000\n");
    expect(out.trim().split("\n").length).toBe(5000);
  });

  it("strips NUL bytes from argv so spawn never throws 'must be a string without null bytes'", async () => {
    // Backstop: a reviewer prompt with an embedded NUL (from a binary/UTF-16/NUL-
    // after-8KB changed file in the diff) is passed as an argv element. node's spawn
    // rejects any arg containing \0 synchronously, erroring the reviewer at 0.0s.
    // spawnSafely must launder argv so no path can ever hand spawn a NUL. Build the
    // NUL via fromCharCode to keep this source pure ASCII.
    const NUL = String.fromCharCode(0);
    const dir = mkdtempSync(join(tmpdir(), "rg-spawn-nul-"));
    const res = await spawnSafely({
      command: "/bin/echo",
      args: [`a${NUL}b${NUL}c`],
      stdoutFile: join(dir, "out"),
      stderrFile: join(dir, "err"),
      timeoutMs: 30_000,
    });
    expect(res.exitCode).toBe(0);
    const out = readFileSync(join(dir, "out"), "utf8");
    expect(out.includes(NUL)).toBe(false);
    expect(out.trim()).toBe("abc");
  });

  it("captures stderr and reports a non-zero exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-spawn-"));
    const res = await spawnSafely({
      command: "bash",
      args: ["-c", "echo oops >&2; exit 3"],
      stdoutFile: join(dir, "out"),
      stderrFile: join(dir, "err"),
      timeoutMs: 30_000,
    });
    expect(res.exitCode).toBe(3);
    expect(readFileSync(join(dir, "err"), "utf8")).toContain("oops");
  });

  it("does NOT spuriously flag a timeout when the child exits but a grandchild lingers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-spawn-"));
    // Child exits 0 immediately but backgrounds a `sleep` that inherits the stdout
    // pipe → "close" is delayed. The wall time must stay bounded (~grace, not 3s)
    // and killedByTimeout must NOT be set (the child exited cleanly).
    const t0 = Date.now();
    const res = await spawnSafely({
      command: "bash",
      args: ["-c", "sleep 3 & echo done; exit 0"],
      stdoutFile: join(dir, "out"),
      stderrFile: join(dir, "err"),
      timeoutMs: 500,
    });
    expect(res.exitCode).toBe(0);
    expect(res.killedByTimeout).toBe(false);
    expect(Date.now() - t0).toBeLessThan(2000); // settled via grace, not the 3s sleep
    expect(readFileSync(join(dir, "out"), "utf8")).toContain("done");
  });

  it("lets the HOST process exit promptly after a killed child leaves an orphan holding the pipe", async () => {
    // Nested: an inner `bun -e` calls spawnSafely on `sleep 30 & wait`. The watchdog
    // kills the inner bash; the orphaned `sleep 30` keeps the inherited stdout pipe
    // open. If spawnSafely didn't destroy/unref its stdio handles, the inner bun
    // process would stay alive ~30s. We assert the OUTER run sees it exit on its own
    // (not killed by the outer timeout) well under 30s.
    const dir = mkdtempSync(join(tmpdir(), "rg-spawn-"));
    const spawnPath = join(process.cwd(), "src/utils/spawn.ts");
    // Use the precise timeout path (the watchdog only polls every 5s). The inner
    // run times out at 300ms → killTree() takes down bash AND the orphaned sleep →
    // the inner bun process can then exit instead of lingering ~30s.
    const inner = [
      `import { spawnSafely } from ${JSON.stringify(spawnPath)};`,
      `await spawnSafely({ command: "bash", args: ["-c", "sleep 30 & wait"],`,
      ` stdoutFile: ${JSON.stringify(join(dir, "io"))}, stderrFile: ${JSON.stringify(join(dir, "ie"))},`,
      " timeoutMs: 300 });",
      `process.stdout.write("INNER_DONE");`,
    ].join("");
    const t0 = Date.now();
    const res = await spawnSafely({
      command: process.execPath, // the running bun binary (robust vs PATH)
      args: ["-e", inner],
      stdoutFile: join(dir, "oo"),
      stderrFile: join(dir, "oe"),
      timeoutMs: 15_000,
    });
    expect(res.killedByTimeout).toBe(false); // inner exited itself → outer never had to kill it
    expect(readFileSync(join(dir, "oo"), "utf8")).toContain("INNER_DONE");
    expect(Date.now() - t0).toBeLessThan(10_000); // not the 30s the orphan would impose
  });

  it("flags killedByTimeout when the child outruns timeoutMs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-spawn-"));
    const res = await spawnSafely({
      command: "bash",
      args: ["-c", "sleep 5"],
      stdoutFile: join(dir, "out"),
      stderrFile: join(dir, "err"),
      timeoutMs: 150,
    });
    expect(res.killedByTimeout).toBe(true);
  });

  it("kills a running child promptly when its AbortSignal fires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-spawn-"));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const start = Date.now();
    const res = await spawnSafely({
      command: "bash",
      // Sleep far longer than we'll wait — only the abort should end it.
      args: ["-c", "sleep 30"],
      stdoutFile: join(dir, "out"),
      stderrFile: join(dir, "err"),
      timeoutMs: 30_000,
      signal: ac.signal,
    });
    const elapsed = Date.now() - start;
    expect(res.killedByAbort).toBe(true);
    expect(res.killedByTimeout).toBe(false);
    // Returned because of the abort, NOT the 30s sleep/timeout.
    expect(elapsed).toBeLessThan(3_000);
  });

  it("caps the captured stdout at maxOutputBytes and flags truncation (F-4, no OOM)", async () => {
    // A runaway reviewer dumping megabytes would, uncapped, produce a capture file
    // the adapter readFileSyncs into memory → OOM. The cap bounds the file; the
    // useful prefix (a reviewer's JSON comes first) is preserved.
    const dir = mkdtempSync(join(tmpdir(), "rg-spawn-cap-"));
    const outFile = join(dir, "out");
    const res = await spawnSafely({
      command: "bash",
      // ~2 MiB of output, capped at 64 KiB.
      args: ["-c", "yes ABCDEFGHIJKLMNOPQRSTUVWXYZ0123 | head -c 2097152"],
      stdoutFile: outFile,
      stderrFile: join(dir, "err"),
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
    });
    expect(res.outputTruncated).toBe(true);
    const out = readFileSync(outFile, "utf8");
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(64 * 1024);
  });

  it("does NOT truncate normal-size output (cap leaves real reviews intact)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-spawn-cap-ok-"));
    const outFile = join(dir, "out");
    const res = await spawnSafely({
      command: "bash",
      args: ["-c", 'for i in $(seq 1 1000); do echo "line-$i"; done'],
      stdoutFile: outFile,
      stderrFile: join(dir, "err"),
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
    });
    expect(res.outputTruncated).toBe(false);
    expect(res.exitCode).toBe(0);
    const out = readFileSync(outFile, "utf8");
    expect(out).toContain("line-1\n");
    expect(out).toContain("line-1000\n");
  });
});
