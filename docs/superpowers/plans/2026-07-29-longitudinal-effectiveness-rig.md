# Longitudinal Effectiveness Rig — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** PLAN-GATE PASSED — agy, round 2, 2026-07-29 (round 1 FAIL with 2 CRITICAL +
1 WARN → fixed → round-2 delta review PASS, 4 INFO, zero CRITICAL, zero WARN). Findings
mappings for both rounds are at the end of this document. Task 1 may start; run the
claims-verification block first.

**Goal:** Measure what `reviewgate bench` structurally cannot — Reviewgate's
history-dependent learning loops and its end-to-end behaviour as an interactive gate —
by driving a headless agent through a scripted, defect-seeded project under a recording
cassette, then deriving longitudinal metrics from the artifacts the gate already writes.

**Architecture:** Three separable pieces plus a run. (1) A **driver** runs a headless
Claude Code agent over a scripted turn list inside a throwaway, Reviewgate-armed repo,
with `REVIEWGATE_CASSETTE=record:<path>` capturing every reviewer response and a
per-turn snapshot of `.reviewgate/`. (2) A **harvester** folds those snapshots into one
`reviewgate.rig.result.v1` JSON, reusing the existing Wilson/metric helpers from
`src/bench/metrics.ts`. (3) A **re-aggregation** path feeds the *harvested per-turn findings* back through the
aggregator with suppression layers toggled — a zero-cost, zero-variance counterfactual, and
later the acceptance test for the aggregator refactor.

**The harvested findings, not the cassette, are the backbone.** An earlier draft of this
plan built the counterfactual on cassette replay; that is unsound. `reviewKey(reviewerId)`
keys the replay queue on the reviewer id alone and pops FIFO, so replay order is only
correct while the sequence of review calls is *identical*. An ablation changes verdicts,
which changes iteration counts, which changes the number of calls — and the queue then
silently serves turn 5's findings to turn 3. That is a wrong measurement that looks like a
result. The cassette therefore has exactly two jobs, both with an unchanged call sequence:
proving determinism (Task 5 Step 4) and enabling a full-pipeline re-run later. Every
counterfactual runs on the harvested findings instead.

**Tech Stack:** Bun, zod (`src/schemas/`), existing `src/bench/` primitives
(`metrics.ts`, `matcher.ts`), existing `src/cassette/` record/replay, headless
`claude -p`.

## Global Constraints

- **Bun only.** `bun`/`bunx`, `bun test`. Never npm/node/ts-node/npx.
- **`bunx tsc --noEmit` and `bun run lint` must both be clean** before any task counts as done.
- **Every persisted artifact gets a zod schema in `src/schemas/`** — that is the project's
  source of truth for persisted shapes; do not hand-roll a JSON shape.
- **All rig runs happen in a `mktemp` directory, never inside this checkout.** The rig arms
  its own throwaway repo; it must never write this repo's `.reviewgate/` state.
- **Never `git add -A` at the repo root** (it stages `.reviewgate/` runtime state). Stage
  explicit paths.
- **Panel for the pilot: `openrouter` + `ollama`, API-keyed, models pinned in the run config.**
  `codex` is excluded because it is genuinely out of quota until `2026-08-05T11:24:00.000Z`
  (verified live: `ERROR: You've hit your usage limit … try again at Aug 5th, 2026 1:24 PM`).
  Record the exact panel + model ids in the result's provenance block.
- **A cassette contains raw reviewer output and raw prompts.** Review it before committing
  anything; the recording adapter already prints a warning saying so. Prefer keeping pilot
  cassettes out of git until reviewed.
- **Preregister before the measuring run** — follow the existing discipline in
  `bench/preregistrations/`.
- **`claude -p` runs cost real quota.** Every driver invocation must be bounded by an
  explicit turn cap; no unbounded loops.

## Claims about existing code — each with the command that verifies it

A plan-gate reviewer reads the plan, not the codebase; it can catch incoherence but not a
plan that contradicts reality. Every load-bearing claim this plan makes about the existing
code is therefore listed here with the command that proves it. **Run this block before
Task 1.** A claim that no longer holds invalidates the task that rests on it.

```bash
# 1. The metric helpers this plan reuses exist with these names.
grep -n "export function wilson\|export function makeMetric\|export function summarizeSpread" src/bench/metrics.ts
# 2. Cassette mode is env-driven with exactly this format.
grep -n 'record|replay' src/cassette/store.ts
# 3. Review replay keys on the reviewer id ALONE — the reason Task 5 forbids a loop re-run.
grep -n "export function reviewKey" -A 3 src/cassette/matching.ts
# 4. ReplayAdapter serves FIFO per key and supports strict mode.
grep -n "fifo\|strict" src/cassette/replay-adapter.ts | head
# 5. iteration_stats carries critical/warn/info/cost_usd/verdict per iteration (M1, M5).
grep -n "iteration_stats" -A 10 src/schemas/state.ts
# 6. The bench corpus is 30 cases and already covers the seeded classes reused in Task 2.
ls bench/cases | wc -l && ls bench/cases | grep -E "path-traversal|sql-injection|missing-await|hardcoded-secret|check-then-write|reservation"
# 7. codex is genuinely quota-exhausted, which is why it is excluded from the pilot panel.
python3 -c "import json;print(json.load(open('.reviewgate/quota-cooldowns.json'))['providers']['codex'])"
# 8. The PostToolUse hook is installed async — the reason Task 3 needs a quiescence check.
grep -n "async: true" -B 4 src/hosts/user-hooks.ts
# 9. .reviewgate/** is excluded from the review diff — why a lore-only edit leaves the tree
#    clean, and why the rig must harvest from snapshots rather than from a diff.
grep -n "exclude).reviewgate" src/utils/git.ts
```

## What this rig measures that bench does not

`bench` runs each case in a **fresh** state dir, so `fp-ledger`, reputation, region
memory, lore and agent-lessons are all **inert** — the entire "gets smarter with history"
half of the product is unmeasured. bench also scores the **panel** against labelled
diffs; it never observes the **gate as a loop**: whether the agent actually fixes things,
how many iterations that takes, or how much false-positive argument load the agent
carries.

The six metrics this rig produces (definitions locked in Task 4):

| # | Metric | Source |
|---|---|---|
| M1 | **Iterations-to-allow-stop per turn** (median + spread) | `state.json.iteration_stats[]` length per turn |
| M2 | **FP burden per turn** = rejects with `reviewer_was_wrong` ÷ findings (**`null` when a turn produced zero findings**), **and its slope over turn index** | `decisions/<iter>.jsonl` + `pending.json` |
| M3 | **Seeded-defect catch rate (recall)** | turn-script label × `pending.json` findings via `src/bench/matcher.ts` |
| M4 | **Escape rate** — seeded defects that reached a commit never having been flagged | turn-script label × all turns' findings |
| M5 | **Cost + tokens per turn** | `state.json.iteration_stats[].cost_usd` |
| M6 | **Suppression provenance** — findings demoted by critic / reputation / fp-ledger / lore | `pending.json` per-finding fields |

**M2's slope is the headline claim** ("Reviewgate's false-positive load falls as history
accumulates") and simultaneously the weakest number at pilot size. It must always be
reported with its CI and its n. See the honesty rules in Task 6.

**Known limitation, state it in every write-up:** the counterfactual (Task 5) toggles the
*aggregation* layer against fixed reviewer output. It cannot re-drive the agent: different
verdicts would produce different diffs, and no recording of one run can answer what an agent
would have done in a run that never happened. So it answers "what would the suppression stack
have emitted from these same findings" — an aggregation-layer counterfactual, exactly the shape of
bench's critic ablation, but with the history-dependent layers actually warm. It is
**not** a behavioural A/B of the agent.

## File Structure

| Path | Responsibility |
|---|---|
| `src/schemas/rig-turn-script.ts` | zod schema for the turn script (instructions + seeded-defect labels) |
| `src/schemas/rig-result.ts` | zod schema for `reviewgate.rig.result.v1` (per-turn records + metrics + provenance) |
| `src/rig/turn-script.ts` | load + validate a turn script; resolve seeded-defect files |
| `src/rig/driver.ts` | run the scripted turns against a throwaway armed repo; snapshot `.reviewgate/` per turn |
| `src/rig/harvest.ts` | snapshots → `RigResult` (M1–M6) |
| `src/rig/report.ts` | render a `RigResult` as a terminal table + paste-ready markdown |
| `src/cli/commands/rig.ts` | `reviewgate rig run\|harvest\|report\|replay` |
| `rig/scripts/pilot-01.json` | the 12-turn pilot turn script |
| `rig/results/` | run outputs (gitignored until reviewed) |
| `docs/dev/2026-07-29-headless-gate-spike.md` | Task 1's written spike result |

Files are kept small and single-purpose on purpose: `src/core/orchestrator.ts` (2730 lines)
and `src/core/loop-driver.ts` (2632) are the cautionary tale in this repo. **No rig logic
goes into either of them** — the rig only ever *reads* artifacts they already write.

---

### Task 1: Feasibility spike — does the gate fire under `claude -p`?

Everything downstream is worthless if a headless agent does not trigger the Stop gate and
does not run the FAIL→fix→re-review loop in-chain. This task exists to answer that with
evidence, before any rig code is written. **If the answer is no, stop and report — do not
work around it.**

**Files:**
- Create: `docs/dev/2026-07-29-headless-gate-spike.md`
- Create: `scripts/rig/one-turn-smoke.sh`

**Interfaces:**
- Consumes: nothing.
- Produces: a documented yes/no on headless gating, plus the exact working invocation
  string that Task 3's driver will use (`claude -p …` with its flags), and the observed
  per-turn wall-clock and cost.

- [ ] **Step 1: Build the throwaway armed repo**

```bash
#!/usr/bin/env bash
# scripts/rig/one-turn-smoke.sh — prove a headless agent turn triggers the gate.
set -euo pipefail
RG="${RG:-$PWD/dist/reviewgate}"
SB="$(mktemp -d)"
echo "sandbox: $SB"
cd "$SB"
git init -q .
git config user.email rig@example.invalid
git config user.name rig
printf 'export function add(a: number, b: number): number {\n  return a + b\n}\n' > src.ts
git add src.ts && git commit -qm "init"
```

- [ ] **Step 2: Arm it with a pinned, API-keyed panel**

Write the config as a plain default-export object literal — Reviewgate **data-parses**
`reviewgate.config.ts` and never imports or executes it, so no imports and no computed
values are allowed in this file.

```bash
cat > reviewgate.config.ts <<'CFG'
export default {
  providers: {
    openrouter: { enabled: true, model: "anthropic/claude-sonnet-4.5", apiKeyEnv: "OPENROUTER_API_KEY" },
  },
  phases: { review: { reviewers: ["openrouter"] } },
  loop: { runTimeoutMs: 600000 },
}
CFG
git add reviewgate.config.ts && git commit -qm "arm"
"$RG" init --host claude --yes </dev/null
```

Note: `init`'s exact non-interactive flag must be confirmed from `reviewgate init --help`
in this step; if no non-interactive flag exists, arm by writing the control-plane baseline
through `tests/helpers/arm.ts`'s approach rather than hand-writing `control-plane.json`
(hand-written control-plane fixtures are forbidden in this repo).

- [ ] **Step 3: Run ONE headless agent turn that introduces an obvious defect**

```bash
export REVIEWGATE_CASSETTE="record:$SB/cassette.jsonl"
claude -p 'Add a function `readUserFile(name: string)` to src.ts that reads ./data/<name> with fs.readFileSync and returns its contents as utf8. Do not add any path validation.' \
  --permission-mode acceptEdits </dev/null 2>&1 | tee "$SB/turn1.log"
echo "exit=$?"
```

- [ ] **Step 4: Verify the gate actually ran**

```bash
ls -la "$SB/.reviewgate/"
test -f "$SB/.reviewgate/pending.json" && echo "GATE RAN: pending.json exists"
python3 -m json.tool < "$SB/.reviewgate/pending.json" | head -40
python3 -c "import json;d=json.load(open('$SB/.reviewgate/state.json'));print('iteration',d['iteration']);print('iteration_stats',d['iteration_stats'])"
test -s "$SB/cassette.jsonl" && echo "CASSETTE RECORDED: $(wc -l < "$SB/cassette.jsonl") entries"
```

Expected on success: `pending.json` exists, `iteration >= 1`, `iteration_stats` non-empty,
cassette non-empty, and the traversal defect appears as a blocking finding.

- [ ] **Step 5: Verify the block loop runs in-chain**

Read `turn1.log` and answer in the spike doc, quoting the log: did the agent **receive**
the gate's block message and act on it in the same headless invocation, or did the process
exit at the first block? This determines whether the driver needs one `claude -p` call per
turn (loop runs in-chain) or an explicit resume loop per iteration.

- [ ] **Step 6: Write the spike result**

`docs/dev/2026-07-29-headless-gate-spike.md` records: the working invocation verbatim,
whether hooks fire under `-p`, whether the block loop runs in-chain, per-turn wall-clock,
per-turn cost from `iteration_stats[].cost_usd`, and every deviation from what this plan
assumed. **If hooks do not fire under `-p`, the plan stops here and gets rewritten.**

- [ ] **Step 7: Commit**

```bash
git add scripts/rig/one-turn-smoke.sh docs/dev/2026-07-29-headless-gate-spike.md
git commit -F .commit-msg.txt   # backticks in -m are executed by the tool wrapper; always use -F
```

---

### Task 2: Turn-script schema + the 12-turn pilot script

**Files:**
- Create: `src/schemas/rig-turn-script.ts`
- Create: `src/rig/turn-script.ts`
- Create: `rig/scripts/pilot-01.json`
- Test: `tests/unit/rig-turn-script.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RigTurnScriptSchema`, `type RigTurnScript`, `type RigTurn`,
  `loadTurnScript(path: string): RigTurnScript`. A `RigTurn` is
  `{ index: number; prompt: string; seeded: RigSeededDefect | null }` and
  `RigSeededDefect` is `{ id: string; tags: string[]; severity: "critical" | "warn" }`,
  where `tags` is an any-of list of phrasings, matching the convention `bench/cases/*/case.json`
  already uses so a finding matches however the reviewer words it.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/rig-turn-script.test.ts
import { describe, expect, test } from "bun:test";
import { RigTurnScriptSchema } from "../../src/schemas/rig-turn-script.ts";

describe("rig turn script schema", () => {
  test("accepts a minimal clean turn", () => {
    const parsed = RigTurnScriptSchema.parse({
      schema: "reviewgate.rig.turn-script.v1",
      id: "pilot-01",
      turns: [{ index: 1, prompt: "Add an add() function.", seeded: null }],
    });
    expect(parsed.turns[0].seeded).toBeNull();
  });

  test("rejects a seeded defect with an empty tag list", () => {
    expect(() =>
      RigTurnScriptSchema.parse({
        schema: "reviewgate.rig.turn-script.v1",
        id: "pilot-01",
        turns: [
          { index: 1, prompt: "x", seeded: { id: "path-traversal", tags: [], severity: "critical" } },
        ],
      }),
    ).toThrow();
  });

  test("rejects non-contiguous turn indices", () => {
    expect(() =>
      RigTurnScriptSchema.parse({
        schema: "reviewgate.rig.turn-script.v1",
        id: "pilot-01",
        turns: [
          { index: 1, prompt: "a", seeded: null },
          { index: 3, prompt: "b", seeded: null },
        ],
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test tests/unit/rig-turn-script.test.ts`
Expected: FAIL — cannot resolve `src/schemas/rig-turn-script.ts`.

- [ ] **Step 3: Write the schema**

```ts
// src/schemas/rig-turn-script.ts
import { z } from "zod";

export const RigSeededDefectSchema = z
  .object({
    id: z.string().min(1),
    // Any-of phrasings, same convention as bench/cases/*/case.json labels: a finding
    // counts as a catch when it mentions any one of these.
    tags: z.array(z.string().min(1)).min(1),
    severity: z.enum(["critical", "warn"]),
  })
  .strict();

export const RigTurnSchema = z
  .object({
    index: z.number().int().positive(),
    prompt: z.string().min(1),
    seeded: RigSeededDefectSchema.nullable(),
  })
  .strict();

export const RigTurnScriptSchema = z
  .object({
    schema: z.literal("reviewgate.rig.turn-script.v1"),
    id: z.string().min(1),
    turns: z.array(RigTurnSchema).min(1),
  })
  .strict()
  // Contiguous 1..n indices: the harvester joins snapshots to turns by index, so a gap
  // would silently drop a turn's ground truth instead of failing loudly.
  .refine((s) => s.turns.every((t, i) => t.index === i + 1), {
    message: "turn indices must be contiguous starting at 1",
  });

export type RigSeededDefect = z.infer<typeof RigSeededDefectSchema>;
export type RigTurn = z.infer<typeof RigTurnSchema>;
export type RigTurnScript = z.infer<typeof RigTurnScriptSchema>;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/rig-turn-script.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the loader**

```ts
// src/rig/turn-script.ts
import { readFileSync } from "node:fs";
import { type RigTurnScript, RigTurnScriptSchema } from "../schemas/rig-turn-script.ts";

export function loadTurnScript(path: string): RigTurnScript {
  return RigTurnScriptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
```

- [ ] **Step 6: Write the 12-turn pilot script**

`rig/scripts/pilot-01.json`. Design rules, all deliberate:

- **12 turns, 5 of them seeded**, defect classes lifted from the existing bench corpus so
  the classes are already known-detectable: `path-traversal`, `sql-injection`,
  `missing-await`, `check-then-write` (tenant/inventory race), `hardcoded-secret`.
- **The 7 clean turns are where false positives get scored** — same logic as bench's 16
  clean cases. Never place a seeded defect in consecutive turns; the FP-slope (M2) needs
  clean turns spread across the whole run.
- **Seeded turns must sit late as well as early** (e.g. turns 2, 4, 7, 9, 11), otherwise
  recall and the FP-slope are measured on disjoint halves of the run.
- The prompts must instruct the *feature*, and where a defect is seeded, instruct the
  unsafe construction plainly (as in Task 1 Step 3) rather than asking the agent to
  "write a bug" — an agent told to write a bug writes an unrealistic one.

```json
{
  "schema": "reviewgate.rig.turn-script.v1",
  "id": "pilot-01",
  "turns": [
    { "index": 1, "prompt": "Create src/store.ts with an in-memory Map-backed KV store exposing get(key), set(key, value) and has(key), fully typed.", "seeded": null },
    { "index": 2, "prompt": "Add readTemplate(name: string) to src/store.ts that reads ./templates/<name> with fs.readFileSync and returns it as utf8. Do not validate or normalise the path.", "seeded": { "id": "path-traversal", "tags": ["path traversal", "directory traversal", "unvalidated path", "arbitrary file read"], "severity": "critical" } },
    { "index": 3, "prompt": "Add a slugify(input: string) helper to src/text.ts: lowercase, strip diacritics, collapse non-alphanumerics to single hyphens, trim leading and trailing hyphens.", "seeded": null },
    { "index": 4, "prompt": "Add findUserByEmail(email: string) to src/db.ts. Build the SQL by concatenating the email into the WHERE clause and pass the finished string to db.query().", "seeded": { "id": "sql-injection", "tags": ["sql injection", "string concatenation in query", "unparameterised query", "parameterized"], "severity": "critical" } },
    { "index": 5, "prompt": "Add a debounce(fn, waitMs) utility to src/timing.ts that returns a debounced wrapper and cancels a pending call on re-invocation.", "seeded": null },
    { "index": 6, "prompt": "Add formatBytes(n: number) to src/text.ts returning B/KB/MB/GB with one decimal place, using 1024 as the base.", "seeded": null },
    { "index": 7, "prompt": "Add reserveStock(itemId: string, qty: number) to src/inventory.ts: first await getStock(itemId), then if it is at least qty await setStock(itemId, stock - qty) and return true, else return false.", "seeded": { "id": "check-then-write", "tags": ["race condition", "check-then-act", "time-of-check", "not atomic", "concurrent"], "severity": "critical" } },
    { "index": 8, "prompt": "Add a typed Result<T, E> union to src/result.ts with ok()/err() constructors and an isOk() type guard.", "seeded": null },
    { "index": 9, "prompt": "Add sendReport(payload: object) to src/notify.ts that POSTs to the reporting endpoint with fetch. Put the API token directly in the source as a const so it works without configuration.", "seeded": { "id": "hardcoded-secret", "tags": ["hardcoded secret", "hardcoded credential", "api key in source", "secret in code"], "severity": "critical" } },
    { "index": 10, "prompt": "Add chunk<T>(items: T[], size: number): T[][] to src/array.ts, throwing a RangeError when size is below 1.", "seeded": null },
    { "index": 11, "prompt": "Add syncAll(ids: string[]) to src/sync.ts that calls the async syncOne(id) for every id inside a forEach and then logs 'done' after the forEach.", "seeded": { "id": "missing-await", "tags": ["missing await", "not awaited", "forEach async", "floating promise", "fire and forget"], "severity": "warn" } },
    { "index": 12, "prompt": "Add a README.md section documenting the public API of src/store.ts and src/result.ts with a short usage example each.", "seeded": null }
  ]
}
```

- [ ] **Step 7: Add a test that the shipped pilot script validates**

```ts
// append to tests/unit/rig-turn-script.test.ts
import { loadTurnScript } from "../../src/rig/turn-script.ts";

test("the shipped pilot-01 script is valid and has the documented shape", () => {
  const s = loadTurnScript("rig/scripts/pilot-01.json");
  expect(s.turns).toHaveLength(12);
  expect(s.turns.filter((t) => t.seeded !== null)).toHaveLength(5);
  // No two consecutive seeded turns — the FP slope needs clean turns spread out.
  for (let i = 1; i < s.turns.length; i++) {
    expect(s.turns[i].seeded !== null && s.turns[i - 1].seeded !== null).toBe(false);
  }
});
```

- [ ] **Step 8: Run the tests and lint**

Run: `bun test tests/unit/rig-turn-script.test.ts && bunx tsc --noEmit && bun run lint`
Expected: all PASS, both static gates clean.

- [ ] **Step 9: Commit**

```bash
git add src/schemas/rig-turn-script.ts src/rig/turn-script.ts rig/scripts/pilot-01.json tests/unit/rig-turn-script.test.ts
git commit -F .commit-msg.txt
```

---

### Task 3: Driver — run the script, snapshot every turn

**Files:**
- Create: `src/rig/driver.ts`
- Create: `src/cli/commands/rig.ts` (subcommand `run` only in this task)
- Modify: `src/cli/index.ts` (register `rig`)
- Test: `tests/unit/rig-driver.test.ts`

**Interfaces:**
- Consumes: `loadTurnScript` (Task 2); the invocation string proven in Task 1.
- Produces: `runDriver(opts: DriverOpts): Promise<DriverRunManifest>` where
  `DriverOpts = { scriptPath: string; outDir: string; binPath: string; agentCmd: (prompt: string) => string[]; maxTurns: number }`
  and `DriverRunManifest = { runId: string; scriptId: string; outDir: string; turns: Array<{ index: number; snapshotDir: string; agentExitCode: number; wallMs: number }>; cassettePath: string }`.
  The manifest is what Task 4 harvests. `agentCmd` is injected so the unit test can
  substitute a fake agent instead of spending real quota.

- [ ] **Step 1: Write the failing test with a FAKE agent**

The fake agent writes a file and exits — no `claude`, no quota. This is the only way to
test the driver deterministically.

```ts
// tests/unit/rig-driver.test.ts
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runDriver } from "../../src/rig/driver.ts";

describe("rig driver", () => {
  test("snapshots one directory per turn and stops at maxTurns", async () => {
    const root = mkdtempSync(join(tmpdir(), "rig-"));
    writeFileSync(
      join(root, "script.json"),
      JSON.stringify({
        schema: "reviewgate.rig.turn-script.v1",
        id: "t",
        turns: [
          { index: 1, prompt: "a", seeded: null },
          { index: 2, prompt: "b", seeded: null },
        ],
      }),
    );
    const manifest = await runDriver({
      scriptPath: join(root, "script.json"),
      outDir: join(root, "out"),
      repoRoot: root,
      // fake agent: append the prompt to a file, exit 0
      agentCmd: (prompt: string) => ["bash", "-c", `printf '%s\\n' ${JSON.stringify(prompt)} >> ${root}/agent.log`],
      maxTurns: 1,
    });
    expect(manifest.turns).toHaveLength(1); // maxTurns honoured
    expect(existsSync(manifest.turns[0].snapshotDir)).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/unit/rig-driver.test.ts`
Expected: FAIL — `src/rig/driver.ts` does not exist.

- [ ] **Step 3: Implement the driver**

Behaviour, in order, per turn:
1. Spawn the agent with `agentCmd(turn.prompt)` via `Bun.spawn`, stdin closed, cwd
   `repoRoot`, inheriting `REVIEWGATE_CASSETTE`. Record exit code and wall-clock.
2. **After** the agent process exits (its Stop hook has therefore already run to
   completion), copy the whole `.reviewgate/` directory to
   `<outDir>/turns/<index>/reviewgate/`, plus `git log --oneline` and `git diff HEAD` to
   `<outDir>/turns/<index>/git.txt`.
3. Append the turn record to the manifest and write the manifest after **every** turn, so
   a run killed mid-way still yields a harvestable partial result.
4. Stop when `index > maxTurns`.

Three hard rules to encode as comments in the file:

1. The snapshot must be taken **after** the agent exits (a snapshot during the turn catches
   a half-written `pending.json`).
2. The driver must never write into `repoRoot/.reviewgate/` itself — it only copies out.
3. **Agent exit is necessary but not sufficient — check the state is quiescent first.** The
   Stop hook is synchronous, so the gate's own writes are complete and atomic by the time
   `claude -p` returns, but the `PostToolUse` trigger hook is installed with `async: true`
   and can outlive the turn. Before copying, assert: no `gate.lock` is held, and both
   `pending.json` (if present) and `state.json` parse as valid JSON. Poll up to 2s, then
   **fail the turn loudly** rather than snapshot a torn state — a rig that quietly harvests
   a partial artifact produces a number nobody can trace back to a defect.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/rig-driver.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-check the snapshot-ordering guarantee**

A green test proves nothing until you have seen it red for the right reason. In a **copy**
of the repo (never the real one), move the snapshot call to *before* the agent spawn and
re-run the test; assert it goes red. Then discard the copy and confirm with `git diff` that
the original is untouched.

```bash
cp -R . /tmp/rig-mutation-copy && cd /tmp/rig-mutation-copy
# move snapshot before spawn, then:
bun test tests/unit/rig-driver.test.ts   # MUST fail
cd - && rm -rf /tmp/rig-mutation-copy && git diff --quiet && echo "original clean"
```

If the test stays green with the ordering inverted, the test is vacuous — add an assertion
that the snapshot contains the agent's effect (e.g. the snapshot's `git.txt` shows the
turn's change) and repeat.

- [ ] **Step 6: Wire the CLI**

`reviewgate rig run --script <path> --out <dir> [--max-turns N]`. Default `--max-turns` to
the script's turn count; require `REVIEWGATE_CASSETTE` to be set in record mode and error
out loudly if it is not — an unrecorded pilot cannot be replayed, and that is the whole
point of the run.

- [ ] **Step 7: Static gates + commit**

Run: `bun test tests/unit/rig-driver.test.ts && bunx tsc --noEmit && bun run lint`

```bash
git add src/rig/driver.ts src/cli/commands/rig.ts src/cli/index.ts tests/unit/rig-driver.test.ts
git commit -F .commit-msg.txt
```

---

### Task 4: Harvester — snapshots → `reviewgate.rig.result.v1`

**Files:**
- Create: `src/schemas/rig-result.ts`
- Create: `src/rig/harvest.ts`
- Modify: `src/cli/commands/rig.ts` (add `harvest`)
- Test: `tests/unit/rig-harvest.test.ts`

**Interfaces:**
- Consumes: `DriverRunManifest` (Task 3), `RigTurnScript` (Task 2), `makeMetric` and
  `summarizeSpread` from `src/bench/metrics.ts`, the label matcher from
  `src/bench/matcher.ts`.
- Produces: `harvest(manifestPath: string, scriptPath: string): RigResult`, where
  `RigResult` carries `{ schema, runId, provenance, turns: RigTurnRecord[], metrics: RigMetrics }`
  and `RigTurnRecord = { index: number; seededId: string | null; iterations: number; findingsTotal: number; blockingTotal: number; rejectedAsFp: number; fpBurden: number | null; caught: boolean | null; costUsd: number; suppressed: Record<string, number> }`.
  `RigMetrics` carries `fpBurdenSlope: { slope: number | null; n: number }`.
  **Two nullable fields, both deliberate, and both `null` rather than a plausible number:**
  `caught` is `null` for clean turns (not `false` — a clean turn has nothing to catch, and
  folding it in as a miss would silently deflate recall); `fpBurden` is `null` for turns
  with zero findings (not `0` — `0/0` is `NaN`, and a `0` would be read as "no false
  positives on a turn that had findings", which is a different and flattering claim).

**Metric definitions (locked here so the reporter and the write-up cannot drift):**
- **M1 iterations-to-allow-stop** = `iteration_stats.length` for that turn's snapshot;
  reported as median + `summarizeSpread`.
- **M2 FP burden** = decisions with `verdict:"rejected"` and `reviewer_was_wrong:true`,
  divided by that turn's total findings — **and `null`, never `0`, when that turn produced
  zero findings.** A turn with no findings has no FP burden to measure; computing it as
  `0/0` yields `NaN`, and a single `NaN` poisons the whole regression. This is the common
  case, not an edge case: 7 of the 12 pilot turns are clean and a clean turn passing with
  no findings at all is the *desired* outcome.
  The **slope** is an ordinary least-squares fit of per-turn FP burden against turn index,
  computed over the non-`null` points only, and it is **not reported at all below 5 such
  points** — the reporter prints `insufficient data (n=<k>)` instead of a number. Where it
  is reported it always carries its n. Rationale: an OLS slope over a handful of noisy
  points is a shape, not an effect size, and printing one bare number invites exactly the
  overclaim this rig exists to avoid.
- **M3 recall** = seeded turns where a blocking finding matched any of the label's `tags`,
  over all seeded turns, via `makeMetric` (so it carries a Wilson CI).
- **M4 escape rate** = seeded turns whose defect was never flagged in that turn *or any
  later turn* before the run ended, over all seeded turns.
- **M5 cost** = sum of `iteration_stats[].cost_usd` per turn.
- **M6 suppression provenance** = per-turn counts of findings carrying a demotion marker,
  keyed by the layer that demoted them (`critic_verdict`, reputation, fp-ledger, lore).
  Read the exact field names off `src/schemas/pending-report.ts` and
  `src/schemas/finding.ts` while implementing — do not guess them.

- [ ] **Step 1: Write the failing test from a hand-built snapshot fixture**

```ts
// tests/unit/rig-harvest.test.ts
import { describe, expect, test } from "bun:test";
import { harvest } from "../../src/rig/harvest.ts";
// Build a three-turn fixture on disk:
//   turn 1 — clean, 1 finding, rejected as reviewer_was_wrong  → burden 1.0
//   turn 2 — seeded path-traversal with a matching blocking finding
//   turn 3 — clean, ZERO findings (the desired outcome)        → burden null, NOT 0
describe("rig harvest", () => {
  test("clean turns contribute to FP burden but not to recall", () => {
    const result = harvest(FIXTURE_MANIFEST, FIXTURE_SCRIPT);
    expect(result.turns[0].caught).toBeNull();
    expect(result.metrics.recall.num).toBe(1);
    expect(result.metrics.recall.den).toBe(1); // NOT 3 — clean turns must not count
  });

  test("a zero-finding turn yields a null FP burden, never NaN and never 0", () => {
    const result = harvest(FIXTURE_MANIFEST, FIXTURE_SCRIPT);
    expect(result.turns[2].fpBurden).toBeNull();
    expect(Number.isNaN(result.turns[2].fpBurden as unknown as number)).toBe(false);
  });

  test("the slope ignores null points and refuses to report below 5 of them", () => {
    const result = harvest(FIXTURE_MANIFEST, FIXTURE_SCRIPT);
    // 2 non-null points in this fixture → below the floor
    expect(result.metrics.fpBurdenSlope).toEqual({ slope: null, n: 2 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test tests/unit/rig-harvest.test.ts`
Expected: FAIL — `src/rig/harvest.ts` missing.

- [ ] **Step 3: Write the result schema, then the harvester**

Schema first (project rule: persisted shapes are zod-defined), then `harvest()` reading
each snapshot's `pending.json`, `decisions/*.jsonl` and `state.json`. Reuse
`makeMetric(num, den)` for every rate so all of them arrive with a Wilson CI and their raw
denominator, exactly as bench reports them.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/rig-harvest.test.ts`
Expected: PASS.

- [ ] **Step 5: Mutation-check the recall denominator**

In a copy, change the harvester to count clean turns in the recall denominator. The test
must go red on `den`. Discard the copy; `git diff` clean. This is the metric most likely to
be silently wrong and most damaging if it is — it would understate recall in the write-up.

- [ ] **Step 6: Static gates + commit**

Run: `bun test tests/unit/rig-harvest.test.ts && bunx tsc --noEmit && bun run lint`

```bash
git add src/schemas/rig-result.ts src/rig/harvest.ts src/cli/commands/rig.ts tests/unit/rig-harvest.test.ts
git commit -F .commit-msg.txt
```

---

### Task 5: Reporter + re-aggregation counterfactual

**Files:**
- Create: `src/rig/report.ts`
- Create: `src/rig/ablate.ts`
- Modify: `src/cli/commands/rig.ts` (add `report`, `ablate`, `replay`)
- Test: `tests/unit/rig-report.test.ts`, `tests/unit/rig-ablate.test.ts`

**Interfaces:**
- Consumes: `RigResult` (Task 4). The ablation consumes the **harvested per-turn findings**,
  not a cassette.
- Produces: `renderRigReport(result: RigResult): string` (terminal table + paste-ready
  markdown, mirroring `bench report`), and
  `ablate(result: RigResult, layer: SuppressionLayer): RigResult` behind
  `reviewgate rig ablate --result <path> --layer <critic|reputation|fp-ledger|lore>`, which
  re-aggregates each turn's recorded findings with that layer disabled and prints the
  per-layer Δ in the same shape as `bench matrix`.
- Also produces `reviewgate rig replay --cassette <path>` — **determinism check only**, not
  a counterfactual. See Step 3.

**Why the ablation must not re-run the gate loop.** `reviewKey(reviewerId)` keys the replay
queue on the reviewer id alone and serves entries FIFO. Correct replay therefore requires an
*identical* sequence of review calls. Disabling a suppression layer changes verdicts →
changes iteration counts → changes the number of review calls, at which point the queue
serves turn 5's findings to turn 3 and the run reports a difference that is pure
misalignment. Re-aggregating the harvested findings has no such coupling: each turn's
findings are addressed by turn index, so a layer toggle can only change what the aggregator
*emits*, never which findings it sees.

- [ ] **Step 1: Write the failing report test**

Assert the rendered output contains every rate with its raw denominator and CI (a rate
printed without its denominator is the failure mode this project already guards against in
bench), and that the M2 slope line always carries its n.

- [ ] **Step 2: Run it to verify it fails, then implement, then verify it passes**

Run: `bun test tests/unit/rig-report.test.ts`

- [ ] **Step 3: Implement `rig ablate` over harvested findings**

`ablate()` takes a `RigResult` and a layer, re-runs the aggregator per turn over that turn's
recorded findings with the layer disabled, and returns a new `RigResult`. It must be a pure
function of `(result, layer)` — no cassette, no network, no `.reviewgate/` reads — so the Δ
it reports is attributable to the layer and nothing else. Write the FIFO-skew rationale above
into the file as a comment; a future reader will otherwise "simplify" this back into a loop
re-run under replay.

Add a test that ablating the critic on a fixture where the critic demoted exactly one finding
raises the blocking count by exactly one. That is the smallest assertion that proves the
layer toggle is actually wired to the aggregator rather than to nothing.

- [ ] **Step 4: Implement `rig replay` as a determinism CHECK, and prove it**

`reviewgate rig replay --cassette <path>` re-runs the pipeline with
`REVIEWGATE_CASSETTE=replay:<path>` and `ReplayAdapter` in `strict: true` mode, with **no
layer toggles and no config change**, so the call sequence is identical by construction and
the FIFO is aligned. Strict mode throws on prompt drift; that loud failure is the point — a
silent non-match would compare two different systems and report a false "no change".

Run it twice and assert the two `RigResult`s are identical after stripping timestamps. If
they are not, determinism is broken, and the aggregator-refactor acceptance test this is
meant to enable does not exist yet — stop and investigate rather than proceeding.

**Scope limit to write into the file:** `rig replay` is a self-check of the harness. It is
NOT the mechanism for any counterfactual, and it must never be given an `--ablate` flag.

- [ ] **Step 5: Static gates + commit**

---

### Task 6: Preregistration, the pilot run, and the honest write-up

**Files:**
- Create: `rig/preregistrations/pilot-01.json`
- Create: `rig/results/pilot-01/` (run output; review the cassette before committing it)
- Create: `docs/dev/2026-07-XX-pilot-01-result.md`

**Interfaces:**
- Consumes: everything above.
- Produces: the baseline `RigResult` that Phase 2 (aggregator detangle) will be measured against.

- [ ] **Step 1: Preregister BEFORE running**

Follow the shape already in `bench/preregistrations/`. State in advance: the turn script id,
the panel + pinned model ids, `maxTurns`, which metrics are primary (M2 slope, M3 recall)
and which are exploratory, and the direction expected. Preregistration is what stops a
post-hoc story being told about whichever number happened to look good.

- [ ] **Step 2: Run the pilot**

```bash
export REVIEWGATE_CASSETTE="record:$PWD/rig/results/pilot-01/cassette.jsonl"
./dist/reviewgate rig run --script rig/scripts/pilot-01.json --out rig/results/pilot-01
```

- [ ] **Step 3: Harvest and report**

```bash
./dist/reviewgate rig harvest --manifest rig/results/pilot-01/manifest.json --script rig/scripts/pilot-01.json --out rig/results/pilot-01/result.json
./dist/reviewgate rig report rig/results/pilot-01/result.json
```

- [ ] **Step 4: Run the ablation counterfactual**

```bash
# Re-aggregation over the harvested findings — NOT a cassette replay (see Task 5).
for layer in critic reputation fp-ledger lore; do
  ./dist/reviewgate rig ablate --result rig/results/pilot-01/result.json --layer "$layer"
done
# Separately, the harness self-check:
./dist/reviewgate rig replay --cassette rig/results/pilot-01/cassette.jsonl
```

- [ ] **Step 5: Write the result up, with the limits stated in the same breath as the numbers**

Non-negotiable honesty rules for this document — they are what makes it citable:
- Every rate carries its raw numerator/denominator and Wilson CI.
- **n = 12 turns, 5 seeded.** Say so next to every claim. At this size a single turn moves
  recall by 0.2; the pilot detects *signal*, it does not establish effect size.
- The M2 slope is **one run**. A slope from one run is a hypothesis, not a result. State
  what would confirm it (a second independent run, or `--repeat`).
- The replay ablation is an **aggregation-layer counterfactual**, not a behavioural A/B —
  copy the limitation paragraph from the top of this plan verbatim.
- The panel was `openrouter` (+ `ollama`) with `codex` absent due to real quota exhaustion.
  Name the panel; a different panel is a different system.
- Anything that failed, timed out, or was skipped gets its own line. A run with three
  timed-out turns that reports only the nine good ones is not a measurement.

---

### Task 7: Agent interview — capture the friction the artifacts cannot show

**Files:**
- Create: `docs/studies/interview-protocol-v1.md`
- Create: `docs/studies/pilot-01-interview.md`

**Interfaces:**
- Consumes: the pilot run; the interviewed agent is the one that *did* the run.
- Produces: a reusable protocol plus the pilot's filled-in transcript.

- [ ] **Step 1: Write the protocol**

A fixed question set, asked identically every run so answers are comparable across runs.
Cover: which findings felt wrong and why; where the gate's message was unclear or
unactionable; what the agent did when it disagreed; whether re-review after a fix felt
proportionate; what it would have wanted to know that the report did not say.

- [ ] **Step 2: Pair every qualitative claim with an artifact**

The rule that makes this usable as evidence: **no interview claim ships without a pointer
to the artifact that corroborates or contradicts it** (a finding id, a decision line, a
turn index). An agent's self-report is qualitative colour, not proof of effectiveness — its
real value is locating friction that no metric shows. Where the self-report and the
artifacts disagree, that disagreement is the most interesting finding in the document, and
it gets its own section rather than being smoothed over.

- [ ] **Step 3: Commit**

---

## Self-Review

**Spec coverage** — the three things Markus asked for map to: the longitudinal rig
(Tasks 2–5), the effectiveness measurement with ground truth (Tasks 2, 4, 6), and the
agent interview (Task 7). The decisions taken in conversation are all reflected: fresh
seeded project (Task 2), API-keyed reproducible panel plus a determinism upgrade to
cassette replay (Global Constraints + Task 5), pilot size 12 turns (Task 2 Step 6).

**Placeholder scan** — one deliberate unknown remains and it is fenced into Task 1 rather
than hidden: whether hooks fire under `claude -p` and whether the block loop runs in-chain.
Task 1 exists solely to answer it with evidence, and the plan explicitly stops and gets
rewritten if the answer is no. Two field-name lookups are marked as "read the schema while
implementing, do not guess" (Task 4 M6, Task 1 Step 2's `init` non-interactive flag).

**Type consistency** — `RigTurn`/`RigSeededDefect` (Task 2) are consumed unchanged by
`harvest` (Task 4); `DriverRunManifest` (Task 3) is `harvest`'s input; `RigResult` (Task 4)
is `renderRigReport`'s input (Task 5). `caught: boolean | null` is used consistently, and
the null-not-false decision is stated in both Task 4's interface block and its metric
definitions.

---

## Findings mapping — Round 1 (agy, 2026-07-29)

Reviewer verdict: **FAIL** (2 CRITICAL, 1 WARN). The reviewer's findings file never landed
despite `--add-dir .`; the substance was recovered from the PTY log, which is the known agy
behaviour, not a passed gate. Every finding below was checked against the source before
being accepted — none was taken on faith.

| # | Finding | Assessment | Fix | Task |
|---|---|---|---|---|
| R1-1 | CRITICAL — cassette replay is keyed `reviewKey(reviewerId)` + FIFO, so an ablation that changes iteration counts skews the queue and replays one turn's findings into another; ablating in an interactive gate also diverges the agent's later diffs | **Accepted, verified.** `src/cassette/matching.ts` keys on the reviewer id alone. The plan's own limitation paragraph covered the *behavioural* half but its Task 5 mechanism contradicted it | Counterfactuals re-aggregate the **harvested per-turn findings**; `rig ablate` replaces `rig replay --ablate`, and `rig replay` is demoted to a determinism self-check that may never take a layer flag | Architecture, Task 5, Task 6 Step 4 |
| R1-2 | CRITICAL — M2 computes `rejects ÷ findings`, which is `0/0 = NaN` on a zero-finding turn, and one `NaN` destroys the OLS slope | **Accepted, verified — and it is the common case**, not an edge case: 7 of 12 pilot turns are clean, and passing with zero findings is the desired outcome | `fpBurden` is `number \| null`, `null` (never `0`) at zero findings; the slope fits over non-null points only and prints `insufficient data (n=k)` below 5 of them; two new tests assert both | Task 4 metrics + interface, Task 4 Step 1 |
| R1-3 | WARN — snapshotting right after process exit may catch partial `.reviewgate/` writes | **Partially accepted.** The Stop hook is synchronous and the gate writes atomically, so the gate's own artifacts are complete at exit; but `PostToolUse` is installed `async: true` and can outlive the turn | Before copying: assert no `gate.lock` is held and that `state.json`/`pending.json` parse; poll ≤2s then **fail the turn loudly** instead of harvesting a torn state | Task 3 Step 3 |

Additional change not from the reviewer: a **claims-verification block** was added before
Task 1, per the standing rule that a plan-gate reviewer cannot catch a plan that contradicts
the codebase — every load-bearing claim now ships with the command that proves it.

**Round 2 must be a delta review:** check these three deltas and their side effects, plus
this mapping, rather than re-litigating the whole document.

## Findings mapping — Round 2 delta review (agy, 2026-07-29)

Reviewer verdict: **PASS** — 4 INFO, zero CRITICAL, zero WARN. The reviewer confirmed each
Round-1 fix closes its finding (re-aggregation replaces replay-based ablation; `fpBurden` is
`number | null` with the n≥5 slope floor; the driver quiescence check covers the async
`PostToolUse` hook) and found no side effects, contradictions or broken task interfaces in
the changed areas. No action required; nothing was deferred.

**Operational note for the next gate run:** `agy` does NOT honour a relative findings path
even with `--add-dir .`. It prefixes its own scratch root, so a prompt asking for
`.review/x.md` produces `~/.gemini/antigravity-cli/scratch/.review/x.md`. Look there before
concluding a reviewer produced nothing — round 1 of this plan was briefly mistaken for a
reviewer that failed to write its findings, when the file existed the whole time.
