# `reviewgate reset` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a clean top-level `reviewgate reset` CLI command that re-arms the gate (1:1 with the SessionStart reset), replacing `reviewgate gate --hook reset` as the command users/agents are told to run.

**Architecture:** `handleReset` (shared by the SessionStart hook and the new command) is refactored to return `{ cleared: string[] }` — a human-facing summary of the artifacts it actually removed; removal behaviour is unchanged. A new `runReset` command calls it and prints a one-line summary; it reads no stdin (so the historical TTY-hang cannot occur). The escalation/quota messages and user docs are switched to `reviewgate reset`; `gate --hook reset` stays as the internal hook entry point.

**Tech Stack:** Bun, TypeScript, `bun test`, citty (CLI), Biome (lint/format).

**Spec:** `docs/superpowers/specs/2026-06-02-reviewgate-reset-command-design.md`

---

## File Structure

- **Modify** `src/hooks/handlers.ts` — `handleReset` returns `ResetSummary { cleared: string[] }`; add presence detection before each removal. New `node:fs` import `readdirSync`; new paths import `proposalsPoolDir`.
- **Create** `src/cli/commands/reset.ts` — `runReset({ repoRoot, write? })`, follows the codebase's `write`-injection command convention, returns an exit code.
- **Modify** `src/cli/index.ts` — register a top-level `reset` subcommand (no `--hook`, no stdin read).
- **Modify** `src/core/loop-driver.ts` — two user-facing strings (`:1109` quota-degraded note, `:1153` escalation block) switch to `reviewgate reset`.
- **Modify** `README.md`, `docs/architecture.md`, `CLAUDE.md` — document `reviewgate reset` as the user-facing re-arm command.
- **Create** `tests/unit/reset-command.test.ts` — behaviour + parity tests.

`src/cli/commands/gate.ts:73` already does `await handleReset(...)` and ignores the result — no change needed (ignoring a non-void return is valid TS).

---

## Task 1: `handleReset` returns a cleared-summary

**Files:**
- Modify: `src/hooks/handlers.ts` (the `ResetInput`/`handleReset` block, ~lines 45-72)
- Test: `tests/unit/reset-command.test.ts` (new — first test lives here)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/reset-command.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleReset } from "../../src/hooks/handlers.ts";

function seedRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "rg-reset-"));
  const rg = join(root, ".reviewgate");
  mkdirSync(join(rg, "decisions"), { recursive: true });
  writeFileSync(join(rg, "state.json"), "{}");
  writeFileSync(join(rg, "dirty.flag"), "{}");
  writeFileSync(join(rg, "pending.md"), "# findings");
  writeFileSync(join(rg, "pending.json"), "[]");
  writeFileSync(join(rg, "research.md"), "research");
  writeFileSync(join(rg, "ESCALATION.md"), "escalated");
  writeFileSync(join(rg, "decisions", "1.jsonl"), "{}\n");
  return root;
}

describe("handleReset summary", () => {
  it("removes all per-session artifacts and reports them in cleared", async () => {
    const root = seedRepo();
    const { cleared } = await handleReset({ repoRoot: root });
    const rg = join(root, ".reviewgate");
    // Removal behaviour unchanged: every artifact is gone.
    for (const p of [
      "state.json",
      "dirty.flag",
      "pending.md",
      "pending.json",
      "research.md",
      "ESCALATION.md",
      "decisions",
    ]) {
      expect(existsSync(join(rg, p))).toBe(false);
    }
    // Summary lists the human-facing labels of what was present.
    expect(cleared).toContain("session state");
    expect(cleared).toContain("pending findings");
    expect(cleared).toContain("decisions");
    expect(cleared).toContain("research");
    expect(cleared).toContain("escalation");
  });

  it("returns an empty cleared list when nothing is present", async () => {
    const root = mkdtempSync(join(tmpdir(), "rg-reset-empty-"));
    mkdirSync(join(root, ".reviewgate"), { recursive: true });
    const { cleared } = await handleReset({ repoRoot: root });
    expect(cleared).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/reset-command.test.ts`
Expected: FAIL — `handleReset` currently returns `void`, so `const { cleared } = await handleReset(...)` is `undefined` and destructuring throws / `cleared` is undefined.

- [ ] **Step 3: Refactor `handleReset` to detect-then-remove and return a summary**

In `src/hooks/handlers.ts`:

Update the `node:fs` import to add `readdirSync`:

```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
```

Update the paths import to add `proposalsPoolDir`:

```ts
import { dirtyFlagPath, proposalsPoolDir, reviewgateDir, stateJsonPath } from "../utils/paths.ts";
```

Replace the `ResetInput` interface + `handleReset` function with:

```ts
export interface ResetInput {
  repoRoot: string;
}

export interface ResetSummary {
  /** Human-facing labels of the artifacts that were actually present and removed. */
  cleared: string[];
}

export async function handleReset(input: ResetInput): Promise<ResetSummary> {
  const dir = reviewgateDir(input.repoRoot);
  // Ordered artifact groups. Each group is removed together (behaviour unchanged
  // from before: best-effort rmSync with force) and contributes ONE human-facing
  // label to the summary if any of its paths was present.
  const groups: { label: string; paths: string[] }[] = [
    { label: "dirty flag", paths: [dirtyFlagPath(input.repoRoot)] },
    { label: "session state", paths: [stateJsonPath(input.repoRoot)] },
    { label: "decisions", paths: [`${dir}/decisions`] },
    { label: "pending findings", paths: [`${dir}/pending.md`, `${dir}/pending.json`] },
    { label: "research", paths: [`${dir}/research.md`] },
    { label: "escalation", paths: [`${dir}/ESCALATION.md`] },
  ];
  const cleared: string[] = [];
  for (const g of groups) {
    const present = g.paths.some((p) => existsSync(p));
    for (const p of g.paths) {
      try {
        rmSync(p, { recursive: true, force: true });
      } catch {
        // noop (best-effort, unchanged)
      }
    }
    if (present) cleared.push(g.label);
  }
  // F2: drop all per-run proposal pools so a new session can't see a prior
  // session's accumulated proposals. Detect presence BEFORE clearing because
  // clearAllProposalPools is silent.
  let poolPresent = false;
  try {
    const poolDir = proposalsPoolDir(input.repoRoot);
    poolPresent =
      existsSync(poolDir) &&
      readdirSync(poolDir).some((n) => n.endsWith(".jsonl") && n !== "errors.jsonl");
  } catch {
    poolPresent = false;
  }
  clearAllProposalPools(input.repoRoot);
  if (poolPresent) cleared.push("proposal pools");
  return { cleared };
}
```

(`clearAllProposalPools` is already imported at the top of the file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/reset-command.test.ts`
Expected: PASS (both tests).

- [ ] **Step 5: Verify the hook path still type-checks and existing handler tests pass**

Run: `bunx tsc --noEmit && bun test tests/unit/handlers.test.ts tests/unit/hooks.test.ts`
Expected: tsc clean (the `await handleReset(...)` call in `gate.ts:73` ignores the new return — valid); existing handler/hook tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/handlers.ts tests/unit/reset-command.test.ts
git commit -m "feat(reset): handleReset returns a cleared-artifact summary"
```

---

## Task 2: `runReset` command

**Files:**
- Create: `src/cli/commands/reset.ts`
- Test: `tests/unit/reset-command.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/reset-command.test.ts`:

```ts
import { runReset } from "../../src/cli/commands/reset.ts";

describe("runReset command", () => {
  it("clears artifacts and prints a re-armed summary listing them", async () => {
    const root = seedRepo();
    let out = "";
    const code = await runReset({ repoRoot: root, write: (s) => (out += s) });
    expect(code).toBe(0);
    expect(out).toContain("gate re-armed");
    expect(out).toContain("Cleared:");
    expect(out).toContain("pending findings");
    expect(out).toContain("Preserved: FP-ledger & brain");
    expect(existsSync(join(root, ".reviewgate", "pending.md"))).toBe(false);
  });

  it("prints 'nothing to clear' on an already-clean .reviewgate", async () => {
    const root = mkdtempSync(join(tmpdir(), "rg-reset-clean-"));
    mkdirSync(join(root, ".reviewgate"), { recursive: true });
    let out = "";
    const code = await runReset({ repoRoot: root, write: (s) => (out += s) });
    expect(code).toBe(0);
    expect(out).toContain("nothing to clear");
  });

  it("prints a gentle hint and exits 0 when .reviewgate is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "rg-reset-noinit-"));
    let out = "";
    const code = await runReset({ repoRoot: root, write: (s) => (out += s) });
    expect(code).toBe(0);
    expect(out).toContain("doesn't look like a Reviewgate");
  });

  it("clears the same artifacts as the gate --hook reset path (parity)", async () => {
    // Both runReset and the SessionStart hook drive the SAME handleReset, so a
    // freshly seeded tree must end up identically empty either way.
    const viaCommand = seedRepo();
    await runReset({ repoRoot: viaCommand, write: () => {} });
    const viaHook = seedRepo();
    await handleReset({ repoRoot: viaHook });
    for (const p of ["state.json", "pending.md", "pending.json", "decisions", "ESCALATION.md"]) {
      expect(existsSync(join(viaCommand, ".reviewgate", p))).toBe(false);
      expect(existsSync(join(viaHook, ".reviewgate", p))).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/reset-command.test.ts`
Expected: FAIL — `Cannot find module '../../src/cli/commands/reset.ts'`.

- [ ] **Step 3: Write the command**

Create `src/cli/commands/reset.ts`:

```ts
// src/cli/commands/reset.ts
import { existsSync } from "node:fs";
import { handleReset } from "../../hooks/handlers.ts";
import { reviewgateDir } from "../../utils/paths.ts";

export interface ResetCommandInput {
  repoRoot: string;
  // Injectable for tests; defaults to process.stdout (matches the fp/stats commands).
  write?: (s: string) => void;
}

/**
 * User-facing `reviewgate reset`: re-arm the gate by clearing this session's
 * review state. Shares handleReset with the SessionStart hook (1:1 parity) and
 * reads NO stdin, so it cannot hang on an interactive TTY. Always exits 0 —
 * reset is idempotent and best-effort.
 */
export async function runReset(input: ResetCommandInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  if (!existsSync(reviewgateDir(input.repoRoot))) {
    out(
      "🔄 Reviewgate reset — this directory doesn't look like a Reviewgate-initialised repo (no .reviewgate/). Nothing to do.\n",
    );
    return 0;
  }
  const { cleared } = await handleReset({ repoRoot: input.repoRoot });
  if (cleared.length === 0) {
    out("🔄 Reviewgate reset — gate re-armed (nothing to clear).\n");
    return 0;
  }
  out("🔄 Reviewgate reset — gate re-armed.\n");
  out(`   Cleared: ${cleared.join(", ")}.\n`);
  out("   Preserved: FP-ledger & brain.\n");
  return 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/reset-command.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/reset.ts tests/unit/reset-command.test.ts
git commit -m "feat(reset): add runReset command (write-injection, no stdin)"
```

---

## Task 3: Register the `reset` subcommand

**Files:**
- Modify: `src/cli/index.ts` (import block + a new `defineCommand` + `main.subCommands`)

- [ ] **Step 1: Add the import**

In `src/cli/index.ts`, add to the command imports (alphabetical neighbours: after the `runReport` import, before `runReviewPlan`, or wherever fits the existing order):

```ts
import { runReset } from "./commands/reset.ts";
```

- [ ] **Step 2: Define the subcommand**

Add near the other `defineCommand` blocks (e.g. just after the `doctor` command):

```ts
const reset = defineCommand({
  meta: {
    name: "reset",
    description:
      "Re-arm the gate: clear this session's review state (pending findings, decisions, escalation, session state). Learned memory (FP-ledger, brain) is preserved.",
  },
  async run() {
    // No stdin read, no --hook: this is the user-facing alias for the
    // SessionStart reset path. Shares handleReset → 1:1 parity.
    process.exit(await runReset({ repoRoot: process.cwd() }));
  },
});
```

- [ ] **Step 3: Register it in `main.subCommands`**

In the `main` `defineCommand`'s `subCommands` object, add `reset` (place it after `doctor`):

```ts
  subCommands: {
    init,
    gate,
    "review-plan": reviewPlan,
    doctor,
    reset,
    audit,
    brain,
    fp,
    stats,
    report,
    setup,
    learn,
  },
```

- [ ] **Step 4: Typecheck**

Run: `bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Smoke-test the wired command against a temp repo**

Run:
```bash
TMP=$(mktemp -d) && mkdir -p "$TMP/.reviewgate" && echo '{}' > "$TMP/.reviewgate/state.json" && (cd "$TMP" && bun run "$OLDPWD/src/cli/index.ts" reset) ; rm -rf "$TMP"
```
Expected: prints `🔄 Reviewgate reset — gate re-armed.` with a `Cleared: … session state …` line, exit 0. (If `$OLDPWD` is not the repo root in your shell, substitute the absolute path to `src/cli/index.ts`.)

- [ ] **Step 6: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(reset): register top-level 'reviewgate reset' subcommand"
```

---

## Task 4: Switch user-facing messages to `reviewgate reset`

**Files:**
- Modify: `src/core/loop-driver.ts` (the quota-degraded note ~`:1109` and the escalation block ~`:1153`)

No test asserts these literal strings (verified), so this is a string swap.

- [ ] **Step 1: Update the quota-degraded note**

In `src/core/loop-driver.ts`, find the line containing:

```
Consider waiting for the quota reset, then re-run \`reviewgate gate --hook reset\` before treating these findings as final.
```

Change `reviewgate gate --hook reset` → `reviewgate reset`:

```
Consider waiting for the quota reset, then re-run \`reviewgate reset\` before treating these findings as final.
```

- [ ] **Step 2: Update the escalation block**

In the same file, find:

```
... surface it to the human, and run \`reviewgate gate --hook reset\` (or restart the session) to re-arm. End your turn again to proceed.${suffix}
```

Change `reviewgate gate --hook reset` → `reviewgate reset`:

```
... surface it to the human, and run \`reviewgate reset\` (or restart the session) to re-arm. End your turn again to proceed.${suffix}
```

- [ ] **Step 3: Verify no other user-facing occurrences remain in src/**

Run: `grep -rn "gate --hook reset" src/`
Expected: only INTERNAL references remain — `src/cli/hook-stdin.ts` (comment about TTY), `src/cli/index.ts:47` (comment on the `gate` command), `src/schemas/quota-cooldown.ts:6` (comment noting `--hook reset` wipes state.json). These describe the hook path and are correct to keep. No user-instruction string should still say `gate --hook reset`.

- [ ] **Step 4: Typecheck + loop-driver tests**

Run: `bunx tsc --noEmit && bun test tests/unit/loop-driver.test.ts`
Expected: clean + PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/loop-driver.ts
git commit -m "feat(reset): point escalation + quota-degraded messages at 'reviewgate reset'"
```

---

## Task 5: Documentation

**Files:**
- Modify: `CLAUDE.md` (subcommand list, line ~28)
- Modify: `docs/architecture.md` (reset description, line ~40)
- Modify: `README.md` (manual-usage block, lines ~135-141)

- [ ] **Step 1: CLAUDE.md — add `reset` to the subcommand list**

Find line 28 (`CLI subcommands: …`). After the `init` entry, add a `reset` entry. Replace:

```
CLI subcommands: `init` (install hooks into `.claude/settings.json`), `gate` (hook entry point — see below), `doctor` (health-check provider CLIs), `audit verify`, `brain list|show|revoke`, `review-plan <file…>` (one-shot review of a plan/spec markdown).
```

with:

```
CLI subcommands: `init` (install hooks into `.claude/settings.json`), `gate` (hook entry point — see below), `reset` (user-facing re-arm: clears this session's review state; same effect as the SessionStart hook), `doctor` (health-check provider CLIs), `audit verify`, `brain list|show|revoke`, `review-plan <file…>` (one-shot review of a plan/spec markdown).
```

- [ ] **Step 2: docs/architecture.md — note the user-facing alias**

Find line ~40 (`- **`reset`** (SessionStart) — wipes per-session state.`). Replace it with:

```
- **`reset`** (SessionStart) — wipes per-session state. The same logic is exposed to humans/agents as the top-level `reviewgate reset` command (`src/cli/commands/reset.ts` → `handleReset`), used to re-arm an escalated gate.
```

- [ ] **Step 3: README.md — add `reviewgate reset` to the manual-usage block**

Find the fenced block (lines ~138-141):

```bash
reviewgate gate                      # review current `git diff HEAD`
reviewgate audit verify --file <jsonl>   # verify an audit-log hash chain
```

Replace with:

```bash
reviewgate gate                      # review current `git diff HEAD`
reviewgate reset                     # re-arm the gate (clear this session's review state)
reviewgate audit verify --file <jsonl>   # verify an audit-log hash chain
```

- [ ] **Step 4: Verify docs build/lint is unaffected (markdown only)**

Run: `bun run lint`
Expected: clean (Biome lints `src tests`; markdown edits are out of its path, so this confirms nothing in code regressed).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs/architecture.md README.md
git commit -m "docs(reset): document 'reviewgate reset' as the user-facing re-arm command"
```

---

## Task 6: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 2: Lint**

Run: `bun run lint`
Expected: clean.

- [ ] **Step 3: Full test suite**

Run: `bun test`
Expected: all pass (including the new `tests/unit/reset-command.test.ts`).

- [ ] **Step 4: Build the binary**

Run: `bun run build`
Expected: builds `dist/reviewgate` without error.

- [ ] **Step 5: Live smoke on the compiled binary**

Run:
```bash
TMP=$(mktemp -d) && mkdir -p "$TMP/.reviewgate/decisions" && echo '{}' > "$TMP/.reviewgate/state.json" && echo '# f' > "$TMP/.reviewgate/pending.md" && (cd "$TMP" && "$OLDPWD/dist/reviewgate" reset) ; echo "exit=$?" ; ls "$TMP/.reviewgate" ; rm -rf "$TMP"
```
Expected: prints the re-armed summary with `Cleared: … pending findings … session state …`, `exit=0`, and the `ls` shows `state.json`/`pending.md` gone. (Substitute the absolute repo path for `$OLDPWD` if needed.)

- [ ] **Step 6: Final commit (if any uncommitted verification fixups)**

```bash
git add -A
git commit -m "chore(reset): verification pass (typecheck/lint/test/build green)" || echo "nothing to commit"
```

---

## Self-Review notes (already applied)

- **Spec coverage:** scope=1:1 SessionStart (Task 1 shares `handleReset`, Task 2 adds no extra clearing); immediate+summary behaviour (Task 2 output, no confirmation); discoverability (Task 4 messages + Task 5 docs); alias preserved (Task 3 adds `reset`, `gate --hook reset` untouched). No-flock / accepted-edge documented in spec; no code change needed. `--hard`/confirmation/bin-wrapper/global-CLAUDE.md explicitly out of scope — no tasks, by design.
- **Type consistency:** `ResetSummary { cleared: string[] }` defined in Task 1 and consumed in Task 2; `runReset({ repoRoot, write? }): Promise<number>` consistent between Task 2 (definition) and Task 3 (call site, no `write` → defaults to stdout).
- **No placeholders:** every code/edit step shows full content and exact commands with expected output.
