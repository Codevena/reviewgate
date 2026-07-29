import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTemplateDir } from "../../src/cli/commands/init.ts";
import { installHostHookDocument, readHookDocument } from "../../src/hosts/hooks.ts";
import { installUserHooks, userShimPath } from "../../src/hosts/user-hooks.ts";

const TPL = resolveTemplateDir();

function home(): string {
  return mkdtempSync(join(tmpdir(), "rg-usershim-"));
}

async function repo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "rg-usershim-repo-"));
  await Bun.$`git -C ${dir} init -q`.quiet();
  await Bun.$`git -C ${dir} -c user.email=t@t -c user.name=t commit -q --allow-empty -m i`.quiet();
  return dir;
}

// A repo whose CLAUDE hooks are genuinely installed — the settings document AND an
// executable shim. Built with the real installer so the fixture cannot drift from what
// `init` writes.
async function repoWithClaudeHooks(): Promise<string> {
  const r = await repo();
  addSharedShim(r);
  installHostHookDocument(r, "claude", readHookDocument(r, "claude"));
  return r;
}

// `init` writes .reviewgate/bin/ host-independently, so this shape also exists after
// `init --host codex` — with no Claude hook anywhere.
function addSharedShim(root: string): void {
  mkdirSync(join(root, ".reviewgate", "bin"), { recursive: true });
  for (const name of ["gate", "trigger", "reset"]) {
    const shim = join(root, ".reviewgate", "bin", name);
    writeFileSync(shim, "#!/bin/sh\nexit 0\n");
    chmodSync(shim, 0o755);
  }
}

// Run the generated shim exactly as the host would: a real script, in the repo.
// `env` lets a case neutralise PATH so an installed `reviewgate` cannot be resolved.
async function runShim(shim: string, cwd: string, env: Record<string, string> = {}) {
  const p = Bun.spawn([shim], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, stdout, stderr };
}

// The shim asks the binary whether a repo-local hook is active, so the fake must answer
// that query as well as the gate call. `active` decides the query's exit code; `body` is
// what the real gate invocation does.
function fakeBinary(dir: string, body: string, active = false): string {
  const path = join(dir, "fake-reviewgate");
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$1" = "hooks" ]; then exit ${active ? 0 : 1}; fi\n${body}\n`,
  );
  chmodSync(path, 0o755);
  return path;
}

// An installed `reviewgate` must never satisfy a missing-binary case. NOT an empty PATH:
// the shims are `#!/usr/bin/env bash`, so wiping PATH breaks the interpreter lookup and
// the script exits 127 before its own logic ever runs — the test would then pass or fail
// for a reason that has nothing to do with the shim. /usr/bin:/bin has bash and env but
// no reviewgate (verified), and each case asserts the fail-open branch was really taken.
const NO_PATH = { PATH: "/usr/bin:/bin" };

describe("user-scoped gate shim", () => {
  test("stands down when a repo-local CLAUDE Stop hook is genuinely installed", async () => {
    const h = home();
    const r = await repoWithClaudeHooks();
    const bin = fakeBinary(h, 'echo "{\\"decision\\":\\"block\\"}"; exit 3', true);
    installUserHooks(h, bin, TPL);
    const out = await runShim(userShimPath(h, "gate"), r);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe(""); // the fake's block must NOT appear — the gate never ran
  });

  test("RUNS when only the shared shim exists but no Claude hook does (codex-only init)", async () => {
    // Standing down here would end the turn un-reviewed with nothing else firing.
    const h = home();
    const r = await repo();
    addSharedShim(r);
    const bin = fakeBinary(h, "echo ran; exit 0");
    installUserHooks(h, bin, TPL);
    const out = await runShim(userShimPath(h, "gate"), r);
    expect(out.stdout.trim()).toBe("ran");
  });

  test("fails OPEN and warns on STDERR when no binary resolves", async () => {
    const h = home();
    const r = await repo();
    installUserHooks(h, join(h, "does-not-exist"), TPL);
    const out = await runShim(userShimPath(h, "gate"), r, NO_PATH);
    expect(out.code).toBe(0);
    // Load-bearing: stdout is the decision channel, so a failing user-scoped hook must
    // stay OUT of it. The repo-local shim does the opposite on purpose.
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("Reviewgate");
    expect(out.stderr).toContain("NOT reviewed");
  });

  test("passes the gate's stdout AND its non-zero exit code through", async () => {
    const h = home();
    const r = await repo();
    // A distinctive non-zero code: with `exit 0` here, an implementation that forced every
    // child result to zero would still pass.
    const bin = fakeBinary(
      h,
      'echo "{\\"decision\\":\\"block\\",\\"reason\\":\\"probe\\"}"; exit 7',
    );
    installUserHooks(h, bin, TPL);
    const out = await runShim(userShimPath(h, "gate"), r);
    expect(out.code).toBe(7);
    expect(JSON.parse(out.stdout).reason).toBe("probe");
  });

  test("runs the gate from the repo ROOT even when invoked in a subdirectory", async () => {
    const h = home();
    const r = await repo();
    const bin = fakeBinary(h, "pwd; exit 0");
    installUserHooks(h, bin, TPL);
    mkdirSync(join(r, "deep", "nested"), { recursive: true });
    const out = await runShim(userShimPath(h, "gate"), join(r, "deep", "nested"));
    // The gate derives repoRoot from the working directory; a subdir would review the
    // wrong tree — and the activity query would answer for the wrong path too.
    expect(out.stdout).not.toContain("deep/nested");
  });

  test("a 126/127 exit is reported on stderr and still allows the turn", async () => {
    const h = home();
    const r = await repo();
    const bin = fakeBinary(h, "exit 127");
    installUserHooks(h, bin, TPL);
    const out = await runShim(userShimPath(h, "gate"), r);
    expect(out.code).toBe(0);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("NOT reviewed");
  });
});

describe("user-scoped trigger and reset shims", () => {
  for (const [shim, hook] of [
    ["trigger", "trigger"],
    ["reset", "reset"],
  ] as const) {
    test(`${shim}: silent on a missing binary`, async () => {
      const h = home();
      const r = await repo();
      installUserHooks(h, join(h, "does-not-exist"), TPL);
      const out = await runShim(userShimPath(h, shim), r, NO_PATH);
      expect(out.code).toBe(0);
      expect(out.stdout).toBe("");
      // Silent by design: this fires on every tool call / session start in every repo.
      expect(out.stderr).toBe("");
    });

    test(`${shim}: invokes the binary with --hook ${hook}`, async () => {
      const h = home();
      const r = await repo();
      const bin = fakeBinary(h, 'echo "$@"; exit 0');
      installUserHooks(h, bin, TPL);
      const out = await runShim(userShimPath(h, shim), r);
      expect(out.stdout.trim()).toBe(`gate --hook ${hook}`);
    });

    test(`${shim}: stands down when the repo-local hook is active`, async () => {
      const h = home();
      const r = await repoWithClaudeHooks();
      const bin = fakeBinary(h, 'echo "$@"; exit 0', true);
      installUserHooks(h, bin, TPL);
      const out = await runShim(userShimPath(h, shim), r);
      expect(out.stdout).toBe("");
    });
  }
});
