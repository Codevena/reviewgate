# Qwen Overhead Reduction + Bench `--provider-model` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find out whether the ~24 K-token opencode harness overhead per review call can be pushed under the 20-credit/case stop condition, and give `reviewgate bench` the ability to pin a reviewer's model so any resulting number is attributable.

**Architecture:** Two independent workstreams that meet at the end. Tasks 1–3 are *measurement*: they instrument `opencode run` itself, using opencode's own SQLite session DB as a free, per-call token oracle instead of round-tripping through the Bailian console. Task 4 is a small TDD'd CLI addition to the bench (`--provider-model`), mirroring the `--critic-model` plumbing that already exists. Task 5 spends the tuned configuration on one real bench case and records the decision.

**Tech Stack:** Bun (runtime + `bun:test` + `bun:sqlite`), TypeScript, zod (config schema), citty (CLI), opencode CLI 1.18.10, Alibaba token-plan endpoint (`ap-southeast-1`).

## Global Constraints

- **Credit coefficient: 1.21 credits per 1 K tokens** (measured 2026-08-07, on a sample that was ~99.6 % input). Baseline: one `opencode run` ≈ 24 K tokens ≈ **30 credits**.
- **Alibaba list pricing for `qwen3.8-max`** (pay-per-token, Alibaba Cloud Int.), the reference the credit weighting is presumed — **not proven** — to track:

  | | $/1M |
  | --- | --- |
  | input | 2.00 |
  | output | 6.00 (**3× input**) |
  | cache read | **0.25 (⅛ input)** |
  | cache create, 5 m TTL | 2.50 |
  | cache read, 5 m TTL | 0.17 |

  Cross-check: 1.21 credits/1 K at Lite's $0.0006/credit = **$0.73 per 1 M tokens** against a $2.00 list input price — a 2.7× advantage, matching Alibaba's own "≈3× more usage than pay-as-you-go" claim. The per-credit price across tiers ($0.00060 Lite / $0.00045 Standard / $0.000425 Pro) reproduces the advertised "25 % / 29 % savings" exactly, which confirms the credits-per-month figures are the right denominator.

  **Two consequences this plan is built around:**
  1. **Cache read costs ⅛ of input.** If credits track list pricing, a 90 %-cached call drops from ~30 to **~6 credits** — a 5× reduction that clears the 20-credit stop condition on its own. **Task 3 is therefore the decisive task, not Task 2.** Whether the credit ledger actually discounts cached tokens is unverified and is exactly what Task 3 Step 4 measures.
  2. **Output weighs 3× input.** The sample behind the coefficient produced 213 output tokens total; a real review is reasoning-heavy. At a realistic 1–2 K output that is **+5 to +7 credits per call** on top of the input cost. Task 5 is the only step that measures a realistic mix.
- **Budget depends on Task 1b's outcome.** If pay-per-token access works, this plan costs the credit window **~120 credits** (Task 3 Step 4 only, which is a question *about* the plan's billing) plus **~$0.20** metered. If it does not, the plan costs **~250 credits ≈ 10 %** of the 2,500-credit 7-day window (Task 2 ~90, Task 3 ~120, Task 5 ~30–40). Per-task costs are stated in each task. If a task's measured cost exceeds its stated estimate by more than 2×, stop and report — do not continue spending.
- **Stop condition (from spec §5, Phase 0b):** if per-case cost cannot be brought under **20 credits**, stop and escalate to spec §5a. Do not proceed to Task 5.
- **Never run measurement calls in parallel.** The Lite plan allows 1–2 concurrent agents; parallel calls will throttle and look like model defects.
- **Token numbers come from the opencode DB, never from a claim.** `~/.local/share/opencode/opencode.db`, table `message`, column `data` (JSON), field `tokens`.
- **Never run the full test suite inside a measurement task.** Static gates (`bun run typecheck`, `bun run lint`, `bun test`) run once, in Task 4's final step.
- Commits are **local only**. Never push. No AI attribution in commit messages.
- The repo is `~/Developer/reviewgate`, branch `master`. A parallel session has committed here today — check `git status` before every commit and `git add` **named paths only**, never `-A`.

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `scripts/measure-opencode-tokens.ts` | Read per-call token usage for a model out of the opencode session DB; convert tokens → credits. Pure functions plus a thin CLI entry. | 1 |
| `tests/unit/measure-opencode-tokens.test.ts` | Unit tests for the above against a seeded temp DB. | 1 |
| `bench/results/qwen-overhead/metered-access.json` | Evidence artifact: whether pay-per-token DashScope serves `qwen3.8-max`; routes the meter used by every later task. | 1b |
| `bench/results/qwen-overhead/tool-surface.json` | Evidence artifact: baseline vs. `--pure` vs. reduced-tool agent. | 2 |
| `~/.config/opencode/agent/rg-reviewer.md` | Minimal reviewer agent (read + execute, no write surface). Outside the repo — user-global opencode config. | 2 |
| `bench/results/qwen-overhead/caching.json` | Evidence artifact: cache-read fraction across three identical calls. | 3 |
| `src/bench/runner.ts` | `BenchConfigOptions.providerModels` + application in `buildBenchConfig`. | 4 |
| `src/cli/commands/bench.ts` | `parseProviderModels` helper; thread `providerModels` through `BenchRunInput`. | 4 |
| `src/cli/index.ts` | Parse `--provider-model` off argv into `providerModels`. | 4 |
| `tests/unit/bench-provider-model.test.ts` | Parser tests + the provenance guard test. | 4 |
| `bench/results/qwen-overhead/DECISION.md` | The per-case figure and the go/no-go against the 20-credit stop condition. | 5 |

**Note, not a task:** `buildRoster` (`src/cli/commands/bench.ts:499`) records `providerCfg?.model`, ignoring a per-reviewer `r.model` override (`src/config/define-config.ts:54`). A run that used a reviewer-level override would therefore write a *different* model into provenance than it ran. Out of scope here — this plan sets the provider-level model, which `buildRoster` reads correctly. Report it separately.

---

### Task 0: Plan-Gate

Per the global CLAUDE.md rule, this plan must be reviewed by an **executing** reviewer before the first line of code.

- [ ] **Step 1: Write the gate prompt**

```bash
cd ~/Developer/reviewgate && mkdir -p .review
cat > .review/plan-gate-prompt.txt <<'PROMPT'
Review the implementation plan at
docs/superpowers/plans/2026-08-07-qwen-overhead-and-provider-model.md
against its spec at
docs/superpowers/specs/2026-08-07-qwen-reviewer-measurement-design.md

You MAY read repo files and RUN the specific functions this plan makes claims
about (tsx/node/bun one-off scripts, single tests). Recompute every number quoted
at you. Do NOT run the full build/lint/test suite and do not explore the whole repo.

Severity rubric:
- CRITICAL = the plan produces wrong or non-executable code, or violates an
  existing contract.
- WARN = a gap that NO later gate will catch.
- Everything else is INFO.

This is an implementation plan, not code. Implementation depth that legitimately
emerges only while coding is NOT a finding. If only such points remain: PASS with INFO.

Name the minimal fix for every finding.

Write your findings to /Users/markus/Developer/reviewgate/.review/plan-gate-findings.md
using EXACTLY this format, and do not output findings to stdout:

## FINDINGS
- [CRITICAL] one line per item
- [WARN] one line per item
- [INFO] one line per item
## VERDICT
PASS | FAIL

PASS requires zero CRITICAL and zero WARN.
PROMPT
```

- [ ] **Step 2: Run the gate**

Codex is normally at quota — check first, and note the reset date if it is:

```bash
codex exec --skip-git-repo-check "Hello" </dev/null
```

If it answers in <10 s, run the gate in the background under a PTY:

```bash
cd ~/Developer/reviewgate && script -q .review/plan-gate.log \
  codex exec --sandbox workspace-write "$(<.review/plan-gate-prompt.txt)" < /dev/null
```

If Codex is at quota, use a Claude reviewer subagent with the same prompt instead — it executes, which is the condition that matters. Do **not** substitute a non-executing model here.

- [ ] **Step 3: Verify the reviewer actually ran**

```bash
cd ~/Developer/reviewgate && ls -l .review/plan-gate-findings.md .review/plan-gate.log
```

Expected: findings file exists, log is > 0 bytes, findings mtime is **after** the round started. `rc=0` proves nothing.

- [ ] **Step 4: Address findings, append the mapping**

Append a `## Findings mapping — round N` section to the end of this plan: finding → minimal fix → task it changes. Re-run the gate on the deltas only. Round limit 3, then escalate to Markus.

---

### Task 1: Token oracle

Free (no model calls). Everything downstream reads its numbers from here, so this is built and tested first.

**Files:**
- Create: `scripts/measure-opencode-tokens.ts`
- Test: `tests/unit/measure-opencode-tokens.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `readLatestUsage(model: string, limit?: number, dbPath?: string): TokenUsage | null` and `creditsFor(usage: TokenUsage, perThousand?: number): number`, where `TokenUsage = { total: number; input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }`. Tasks 2, 3 and 5 call both.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/measure-opencode-tokens.test.ts`:

```typescript
// tests/unit/measure-opencode-tokens.test.ts
// The token oracle for Qwen cost measurements: reads per-call token usage out of
// opencode's own session DB, so a cost claim is never a guess. Seeded temp DB —
// never touches the real ~/.local/share/opencode/opencode.db.
import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { creditsFor, readLatestUsage } from "../../scripts/measure-opencode-tokens.ts";

function seedDb(messages: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-octok-"));
  const path = join(dir, "opencode.db");
  const db = new Database(path);
  db.run(
    "create table message (id text, session_id text, time_created integer, time_updated integer, data text)",
  );
  for (const m of messages) db.run("insert into message (data) values (?)", [JSON.stringify(m)]);
  db.close();
  return path;
}

// The two real calls measured on 2026-08-07 (design spec §5, Phase 0a).
const REAL_CALL_2 = {
  modelID: "qwen3.8-max",
  tokens: { total: 23414, input: 23238, output: 13, reasoning: 163, cache: { read: 0, write: 0 } },
};
const REAL_CALL_1 = {
  modelID: "qwen3.8-max",
  tokens: {
    total: 25629,
    input: 23544,
    output: 15,
    reasoning: 22,
    cache: { read: 2048, write: 0 },
  },
};

describe("readLatestUsage", () => {
  it("returns the most recent usage for the requested model", () => {
    const path = seedDb([REAL_CALL_2, REAL_CALL_1]);
    expect(readLatestUsage("qwen3.8-max", 50, path)).toEqual({
      total: 25629,
      input: 23544,
      output: 15,
      reasoning: 22,
      cacheRead: 2048,
      cacheWrite: 0,
    });
  });

  it("skips messages from other models", () => {
    const path = seedDb([
      REAL_CALL_1,
      { modelID: "glm-5.2:cloud", tokens: { total: 999, input: 999, output: 0 } },
    ]);
    expect(readLatestUsage("qwen3.8-max", 50, path)?.total).toBe(25629);
  });

  it("returns null when the model never ran", () => {
    expect(readLatestUsage("qwen3.8-max", 50, seedDb([]))).toBeNull();
  });

  it("tolerates rows whose data is not valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-octok-bad-"));
    const path = join(dir, "opencode.db");
    const db = new Database(path);
    db.run("create table message (id text, data text)");
    db.run("insert into message (data) values (?)", ["{not json"]);
    db.run("insert into message (data) values (?)", [JSON.stringify(REAL_CALL_1)]);
    db.close();
    expect(readLatestUsage("qwen3.8-max", 50, path)?.total).toBe(25629);
  });
});

describe("creditsFor", () => {
  it("converts tokens at the measured 1.21 credits/1K coefficient", () => {
    const usage = readLatestUsage("qwen3.8-max", 50, seedDb([REAL_CALL_1]));
    expect(usage).not.toBeNull();
    // 25629 tokens / 1000 * 1.21 = 31.01 credits
    expect(creditsFor(usage as NonNullable<typeof usage>)).toBeCloseTo(31.01, 2);
  });

  it("crosses the two real calls against the console reading that produced the coefficient", () => {
    // Console: 2.38% of the 2500-credit weekly window = 59.5 credits for both calls.
    const a = readLatestUsage("qwen3.8-max", 50, seedDb([REAL_CALL_1]));
    const b = readLatestUsage("qwen3.8-max", 50, seedDb([REAL_CALL_2]));
    const total =
      creditsFor(a as NonNullable<typeof a>) + creditsFor(b as NonNullable<typeof b>);
    expect(total).toBeCloseTo(59.5, 0);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

```bash
cd ~/Developer/reviewgate && bun test tests/unit/measure-opencode-tokens.test.ts
```

Expected: FAIL — `Cannot find module '../../scripts/measure-opencode-tokens.ts'`.

- [ ] **Step 3: Write the minimal implementation**

Create `scripts/measure-opencode-tokens.ts`:

```typescript
// scripts/measure-opencode-tokens.ts
// Token oracle for Qwen cost measurements. opencode records per-call token usage
// in its own session DB; reading it is free and immediate, where the Bailian
// console is a manual round-trip that only aggregates by the hour.
//
// Coefficient measured 2026-08-07: 2.38% of the 2500-credit weekly window for
// 49,043 tokens = 1.21 credits per 1K tokens. `total` already includes cached
// input, and the credit weighting of cached vs. uncached input is unknown — so
// this is an upper-bound estimate whenever the cache is hot.
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TokenUsage {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
}

export const DEFAULT_DB_PATH = join(homedir(), ".local/share/opencode/opencode.db");
export const CREDITS_PER_1K_TOKENS = 1.21;

export function readLatestUsage(
  model: string,
  limit = 50,
  dbPath: string = DEFAULT_DB_PATH,
): TokenUsage | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query("select data from message order by rowid desc limit ?")
      .all(limit) as Array<{ data: string }>;
    for (const row of rows) {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(row.data) as Record<string, unknown>;
      } catch {
        continue; // a malformed row is not a reason to lose the measurement
      }
      const id = (message.modelID ?? message.model) as string | undefined;
      if (id !== model) continue;
      const t = message.tokens as
        | { total?: number; input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
        | undefined;
      if (!t) continue;
      return {
        total: t.total ?? 0,
        input: t.input ?? 0,
        output: t.output ?? 0,
        reasoning: t.reasoning ?? 0,
        cacheRead: t.cache?.read ?? 0,
        cacheWrite: t.cache?.write ?? 0,
      };
    }
    return null;
  } finally {
    db.close();
  }
}

export function creditsFor(usage: TokenUsage, perThousand = CREDITS_PER_1K_TOKENS): number {
  return (usage.total / 1000) * perThousand;
}

if (import.meta.main) {
  const model = process.argv[2] ?? "qwen3.8-max";
  const usage = readLatestUsage(model);
  if (!usage) {
    console.error(`no usage recorded for model "${model}"`);
    process.exit(1);
  }
  console.log(
    JSON.stringify({ model, ...usage, credits: Number(creditsFor(usage).toFixed(2)) }, null, 2),
  );
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

```bash
cd ~/Developer/reviewgate && bun test tests/unit/measure-opencode-tokens.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Mutation-check the coefficient test in a COPY**

```bash
cp -r ~/Developer/reviewgate /tmp/rg-mut && cd /tmp/rg-mut
sed -i '' 's/export const CREDITS_PER_1K_TOKENS = 1.21;/export const CREDITS_PER_1K_TOKENS = 2.42;/' scripts/measure-opencode-tokens.ts
bun test tests/unit/measure-opencode-tokens.test.ts
```

Expected: **FAIL** on both `creditsFor` tests (31.01 → 62.02, 59.5 → 119.0). If it stays green the test is vacuous — rewrite it.

```bash
rm -rf /tmp/rg-mut && cd ~/Developer/reviewgate && git diff --stat
```

Expected: no changes to the real repo.

- [ ] **Step 6: Commit**

```bash
cd ~/Developer/reviewgate && git status --porcelain
git add scripts/measure-opencode-tokens.ts tests/unit/measure-opencode-tokens.test.ts
git commit -m "test: token oracle for Qwen cost measurements (opencode session DB)"
```

---

### Task 1b: Verify pay-per-token access (routes every task after it)

> **RESOLVED 2026-08-07 — `metered: false`. Do not execute this task; it is kept for the record.**
>
> A DashScope workspace key (`sk-ws-…`, workspace `ws-ax5oceqshzsi9np7`) was created and tested against both
> `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` and the workspace-scoped
> `https://ws-ax5oceqshzsi9np7.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`.
> Both list 156 models including `qwen3.8-max`; both return **`AccessDenied.Unpurchased`** on
> completion. The block is **account-wide, not model-specific** — `qwen-plus`, `qwen-turbo`,
> `qwen3.7-max`, `qwen3-max` and `qwen3.8-max` all fail identically. Root cause is visible in the
> console banner: **`RISK.RISK_CONTROL_REJECTION` — "your order is suspended"**. Pay-as-you-go
> cannot be activated until Alibaba support lifts it.
>
> **Consequence:** Tasks 2, 3 and 5 run on the token plan under the original ~250-credit budget.
> Re-open this task only if the risk-control block is lifted.
>
> **Side finding, feeds Task 2:** the same console exposes an **Anthropic-compatible** endpoint at
> `https://ws-ax5oceqshzsi9np7.ap-southeast-1.maas.aliyuncs.com/apps/anthropic`. Driving Qwen
> through Claude Code instead of opencode is a third overhead lever, untested. Its system-prompt
> size is unknown and may be materially below opencode's ~24 K.

**Cost: ~$0.001** (one tiny metered call). **No plan credits.**

Two independent axes, per spec §5a: the *harness* (opencode, executes) and the *meter* (prepaid credits vs. pay-per-token). Running opencode against a metered DashScope key keeps the executing reviewer and removes both the 7-day window and the 1–2 agent cap. At list pricing the full authoritative benchmark is ~$5.10 — against 108 % of a weekly window, i.e. a blocked gate. If this task succeeds, every measurement below runs metered and this plan costs the credit window **nothing**.

**Files:**
- Modify: `~/.local/share/opencode/auth.json` (user-global; back it up first)
- Create: `bench/results/qwen-overhead/metered-access.json`

**Interfaces:**
- Consumes: nothing.
- Produces: a boolean `metered` plus, if true, the opencode model id `alibaba/qwen3.8-max`. Tasks 2, 3 and 5 read it to choose which `-m` value and which cost accounting to use.

- [ ] **Step 1: Markus creates a DashScope API key**

This needs the Alibaba Cloud Model Studio console and cannot be scripted. Ask him for a pay-per-token DashScope key (**Singapore / International**, distinct from the `sk-sp-…` token-plan key). Do not proceed without it.

- [ ] **Step 2: Verify the endpoint actually serves the model**

```bash
DK='<the dashscope key>'
curl -s --max-time 25 -H "Authorization: Bearer $DK" \
  https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models \
  | python3 -c "import sys,json; d=json.load(sys.stdin); ids=sorted(m['id'] for m in d.get('data',[])); print(len(ids),'models'); print('qwen3.8-max' if 'qwen3.8-max' in ids else 'ABSENT')"
```

Expected: `qwen3.8-max` present. **If it is ABSENT**, this option is dead — record `metered: false` in the artifact, skip Steps 3–5, and run Tasks 2/3/5 on the token plan under the credit budget as originally written. models.dev claims the model is there, but models.dev also claimed 24 token-plan models where the live API returned 11, so this listing is the only evidence that counts.

- [ ] **Step 3: Confirm a real completion, not just a listing**

```bash
curl -s --max-time 30 -H "Authorization: Bearer $DK" -H "Content-Type: application/json" \
  -d '{"model":"qwen3.8-max","messages":[{"role":"user","content":"hi"}],"max_tokens":5}' \
  https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions | head -c 300
```

Expected: a `chat.completion` object. A model that lists but 404s on completion is still ABSENT for our purposes.

- [ ] **Step 4: Add the provider to opencode**

`alibaba` is a known models.dev provider (`@ai-sdk/openai-compatible`, base `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`, env `DASHSCOPE_API_KEY`). Back up first — a parallel session may also be writing this file:

```bash
cd ~/.local/share/opencode && cp auth.json auth.json.bak.$(date +%Y%m%d%H%M%S)
python3 -c "
import json,os
p='auth.json'; d=json.load(open(p))
d['alibaba']={'type':'api','key':os.environ['DK']}
json.dump(d,open(p,'w'),indent=2); print('providers:', list(d))
"
opencode models | grep -c "^alibaba/"
```

- [ ] **Step 5: End-to-end through opencode, and record the artifact**

```bash
cd /tmp && opencode run -m alibaba/qwen3.8-max "Antworte nur mit: OK"
cd ~/Developer/reviewgate && bun run scripts/measure-opencode-tokens.ts qwen3.8-max
```

Write `bench/results/qwen-overhead/metered-access.json`: `{ measuredAt, metered: true|false, modelId, listedModels: number, tokensForProbe: TokenUsage }`.

- [ ] **Step 6: Route the remaining tasks and commit**

- `metered: true` → Tasks 2, 3 and 5 use `-m alibaba/qwen3.8-max` and are costed in **dollars at list price** ($2.00/M input, $6.00/M output, $0.25/M cache read), not in plan credits. The plan's 250-credit budget drops to ~$0.20 and the 20-credit stop condition is replaced by the per-case dollar figure. **Task 3 Step 4 (does the credit ledger discount cached tokens?) still runs on the token plan** — it is a question about the plan's billing, not about the benchmark, and it stays relevant for day-to-day gate traffic. Budget it separately at ~120 credits.
- `metered: false` → everything proceeds exactly as written below, on the plan.

```bash
cd ~/Developer/reviewgate && git status --porcelain
git add bench/results/qwen-overhead/metered-access.json
git commit -m "bench: verify pay-per-token DashScope access for qwen3.8-max"
```

---

### Task 2: Lever A — reduce the tool surface

**Estimated cost: ~90 credits** (3 model calls × ~30). This is the task most likely to end the project; run it before writing any bench code.

**Files:**
- Create: `~/.config/opencode/agent/rg-reviewer.md` (user-global, outside the repo)
- Create: `bench/results/qwen-overhead/tool-surface.json`

**Interfaces:**
- Consumes: `readLatestUsage`, `creditsFor` from Task 1.
- Produces: `bench/results/qwen-overhead/tool-surface.json` with shape `{ measuredAt: string, coefficient: number, variants: Array<{ name: string, args: string[], usage: TokenUsage, credits: number }> }`. Task 5 reads `variants` to pick the cheapest working configuration.

- [ ] **Step 1: Record the baseline**

One call, default agent, exactly the prompt from the spec's Phase 0a so the number is comparable:

```bash
cd /tmp && opencode run -m alibaba-token-plan/qwen3.8-max "Antworte nur mit: OK"
cd ~/Developer/reviewgate && bun run scripts/measure-opencode-tokens.ts qwen3.8-max
```

Expected: `total` ≈ 23,000–26,000, `credits` ≈ 28–32. Write the JSON output down as variant `baseline`.

- [ ] **Step 2: Measure `--pure` (no external plugins)**

```bash
cd /tmp && opencode run --pure -m alibaba-token-plan/qwen3.8-max "Antworte nur mit: OK"
cd ~/Developer/reviewgate && bun run scripts/measure-opencode-tokens.ts qwen3.8-max
```

Record as variant `pure`. Note: `~/.config/opencode/package.json` declares one plugin (`@opencode-ai/plugin`) and `~/.config/opencode/skills/` holds 8 skills (hyperframes×6, media-use, hyperframes-registry) — every skill contributes at least its name and description to the system prompt, so this variant is where that cost shows up.

- [ ] **Step 3: Create the reduced-tool agent**

Create `~/.config/opencode/agent/rg-reviewer.md`:

```markdown
---
description: Minimal reviewer for reviewgate bench measurements — reads and runs, never writes
mode: primary
tools:
  write: false
  edit: false
  patch: false
  todowrite: false
  todoread: false
  webfetch: false
  task: false
---

You review a diff and report findings in the requested format. You may read files
and run commands to verify a claim. You never modify the working tree.
```

- [ ] **Step 4: Verify opencode actually recognises the agent**

```bash
opencode agent list
```

Expected: `rg-reviewer` appears. If it does not, the frontmatter shape is wrong for this opencode version — run `opencode agent create`, inspect the file it writes, and correct `rg-reviewer.md` to match before continuing. Do **not** spend a model call on an agent opencode has not acknowledged.

- [ ] **Step 5: Measure the reduced-tool agent**

```bash
cd /tmp && opencode run --pure --agent rg-reviewer -m alibaba-token-plan/qwen3.8-max "Antworte nur mit: OK"
cd ~/Developer/reviewgate && bun run scripts/measure-opencode-tokens.ts qwen3.8-max
```

Record as variant `pure+rg-reviewer`.

- [ ] **Step 6: Write the evidence artifact**

Create `bench/results/qwen-overhead/tool-surface.json` with all three variants, using the exact JSON the oracle printed. Example shape (fill with the real measured numbers — do not invent them):

```json
{
  "measuredAt": "2026-08-07",
  "coefficient": 1.21,
  "prompt": "Antworte nur mit: OK",
  "model": "alibaba-token-plan/qwen3.8-max",
  "variants": [
    { "name": "baseline", "args": [], "usage": {}, "credits": 0 },
    { "name": "pure", "args": ["--pure"], "usage": {}, "credits": 0 },
    { "name": "pure+rg-reviewer", "args": ["--pure", "--agent", "rg-reviewer"], "usage": {}, "credits": 0 }
  ]
}
```

- [ ] **Step 7: Check against the stop condition and commit**

If the cheapest variant is still **> 20 credits**, stop here. Report the number, do not start Task 3 or Task 4, and escalate to spec §5a.

```bash
cd ~/Developer/reviewgate && git status --porcelain
git add bench/results/qwen-overhead/tool-surface.json
git commit -m "bench: measure opencode harness overhead per tool-surface variant"
```

---

### Task 3: Lever B — prompt caching (**the decisive task**)

**Estimated cost: ~120 credits** (4 model calls). **This task, not Task 2, decides the project** — cache read costs ⅛ of input at list price, so caching is worth ~5× while a smaller tool surface is worth a few K tokens. It has no hard dependency on Task 2: if you want the decisive answer first, run this task before Task 2 using the plain baseline invocation.

The design's hypothesis: 30 bench calls share an identical system prompt, so the cacheable fraction should approach 100 %. Observed so far: call 2 read only 2,048 of 23,238 input tokens from cache (~9 %).

Three separate questions, and the plan must not collapse them:
1. **Does the cache fill at all** across identical calls? (tokens — free to measure)
2. **Does the credit ledger discount cached tokens?** List pricing says ⅛, but the token plan's credit weighting is a different mechanism and is **unverified**. (credits — needs a console reading)
3. **Does the cache survive a full bench run?** The 5-minute TTL is shorter than 30 sequential reviews. Whether a cache *read* refreshes the TTL decides whether the cache stays warm or is re-paid every 5 minutes.

**Files:**
- Create: `bench/results/qwen-overhead/caching.json`

**Interfaces:**
- Consumes: `readLatestUsage`, `creditsFor` (Task 1); the baseline invocation, or Task 2's winning variant if that task has already run.
- Produces: `bench/results/qwen-overhead/caching.json` with `{ measuredAt, variant, consoleCreditsBefore, consoleCreditsAfter, calls: Array<{ n: number, gapSeconds: number, usage: TokenUsage, cacheFraction: number }>, verdicts: { fills: boolean, discounted: boolean | "unknown", survivesTtl: boolean } }`.

- [ ] **Step 1: Read the console credit counter BEFORE anything**

Open the Bailian console subscription page and note the used-percentage. Without a starting number there is no delta, and question 2 cannot be answered at all. Record it.

- [ ] **Step 2: Run the same prompt three times back-to-back**

Sequentially — never in parallel (1–2 agent concurrency limit). Keep the gaps under a minute so the 5-minute TTL cannot expire between them:

```bash
cd /tmp
for i in 1 2 3; do
  opencode run --pure --agent rg-reviewer -m alibaba-token-plan/qwen3.8-max "Antworte nur mit: OK"
  bun run ~/Developer/reviewgate/scripts/measure-opencode-tokens.ts qwen3.8-max
done
```

(Drop `--pure --agent rg-reviewer` if Task 2 has not run yet.)

- [ ] **Step 3: Compute the cache fraction per call**

`cacheFraction = cacheRead / (input + cacheRead)` for each call. **Question 1 passes** if call 3's `cacheFraction ≥ 0.8`.

- [ ] **Step 4: Read the console counter AFTER, and test the discount**

Note the used-percentage again. Convert the delta to credits (`delta% × 2500`), then compare against what the DB tokens predict at the flat coefficient:

```
predictedFlat = (sum of the three calls' total tokens) / 1000 × 1.21
```

- If `actual ≈ predictedFlat` → cached tokens are **not** discounted; `discounted: false`. Caching saves nothing in credits and the ⅛ list ratio does not transfer. This is a project-level finding — say it plainly.
- If `actual` is materially below `predictedFlat` → `discounted: true`. Record the implied ratio; it replaces the flat 1.21 coefficient for cached tokens everywhere downstream.
- If the console's resolution is too coarse to distinguish them (the delta is under ~0.1 %), record `discounted: "unknown"` rather than guessing, and note that Task 5's single case must carry the question instead.

- [ ] **Step 5: Test TTL survival**

Wait **6 minutes** (longer than the 5-minute TTL), then run a fourth identical call:

```bash
sleep 380
cd /tmp && opencode run --pure --agent rg-reviewer -m alibaba-token-plan/qwen3.8-max "Antworte nur mit: OK"
cd ~/Developer/reviewgate && bun run scripts/measure-opencode-tokens.ts qwen3.8-max
```

`survivesTtl: true` if call 4's `cacheFraction` is still ≥ 0.8. If it collapses back toward zero, a 30-case bench run re-pays the full system prompt every 5 minutes, and the effective per-case cost is close to the uncached number regardless of question 1's answer.

- [ ] **Step 6: Write the evidence artifact and commit**

Create `bench/results/qwen-overhead/caching.json` with all four calls, both console readings, and the three verdicts. Record measured values only — never a number you did not read.

```bash
cd ~/Developer/reviewgate && git status --porcelain
git add bench/results/qwen-overhead/caching.json
git commit -m "bench: measure cache fill, credit discount and TTL survival for qwen3.8-max"
```

---

### Task 4: `--provider-model` for `reviewgate bench`

Free (no model calls — tests use in-process stub adapters).

**Files:**
- Modify: `src/bench/runner.ts` (add to `BenchConfigOptions` near `:98`; apply inside `buildBenchConfig` after the `opts.providers` loop at `:125-133`)
- Modify: `src/cli/commands/bench.ts` (add `parseProviderModels`; add `providerModels` to `BenchRunInput` near `:89`; forward at `:577`)
- Modify: `src/cli/index.ts` (parse `--provider-model` near the `critic-model` block at `:830-832`)
- Test: `tests/unit/bench-provider-model.test.ts`

**Interfaces:**
- Consumes: `ProviderId` from `src/providers/registry.ts:10` (`"codex" | "gemini" | "claude-code" | "openrouter" | "opencode" | "ollama"`); `buildBenchConfig` from `src/bench/runner.ts`.
- Produces: `parseProviderModels(raw: string): Partial<Record<ProviderId, string>>` exported from `src/cli/commands/bench.ts`; `BenchConfigOptions.providerModels?: Partial<Record<ProviderId, string>>`. The resolved value lands in provenance via `buildRoster` (`src/cli/commands/bench.ts:499`, which reads `providerCfg?.model`).

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/bench-provider-model.test.ts`:

```typescript
// tests/unit/bench-provider-model.test.ts
// --provider-model pins a reviewer's upstream model for a bench run. Without it,
// providers.opencode.model is the sentinel "default" (src/config/defaults.ts:52),
// which means "whatever ~/.config/opencode/opencode.jsonc happens to say" — a
// benchmark input living outside the repo, invisible to the provenance manifest.
import { describe, expect, it } from "bun:test";
import { parseProviderModels } from "../../src/cli/commands/bench.ts";
import { buildBenchConfig } from "../../src/bench/runner.ts";

const QWEN = "alibaba-token-plan/qwen3.8-max";

describe("parseProviderModels", () => {
  it("parses a single provider=model pair", () => {
    expect(parseProviderModels(`opencode=${QWEN}`)).toEqual({ opencode: QWEN });
  });

  it("parses several comma-separated pairs", () => {
    expect(parseProviderModels(`opencode=${QWEN},ollama=glm-5.2:cloud`)).toEqual({
      opencode: QWEN,
      ollama: "glm-5.2:cloud",
    });
  });

  it("keeps '=' inside the model id (provider/model:tag forms)", () => {
    expect(parseProviderModels("openrouter=deepseek/deepseek-v4-flash=x")).toEqual({
      openrouter: "deepseek/deepseek-v4-flash=x",
    });
  });

  it("rejects an unknown provider", () => {
    expect(() => parseProviderModels("qwen=whatever")).toThrow(/unknown provider "qwen"/);
  });

  it("rejects a pair without '='", () => {
    expect(() => parseProviderModels("opencode")).toThrow(/expects <provider>=<model>/);
  });

  it("rejects an empty model", () => {
    expect(() => parseProviderModels("opencode=")).toThrow(/empty model/);
  });

  it("returns an empty object for an empty string", () => {
    expect(parseProviderModels("")).toEqual({});
  });
});

describe("buildBenchConfig providerModels", () => {
  // The guard's two numbers, stated up front: WITHOUT the mechanism the model is
  // "default"; WITH it, the pinned id. Both differ, so this test is not vacuous.
  it("leaves the model at the 'default' sentinel when no override is given", () => {
    const cfg = buildBenchConfig({ providers: ["opencode"] });
    expect(cfg.providers.opencode?.model).toBe("default");
  });

  it("pins the provider model when an override is given", () => {
    const cfg = buildBenchConfig({
      providers: ["opencode"],
      providerModels: { opencode: QWEN },
    });
    expect(cfg.providers.opencode?.model).toBe(QWEN);
  });

  it("pins a provider that is not in the reviewer panel", () => {
    const cfg = buildBenchConfig({
      providers: ["opencode"],
      providerModels: { ollama: "glm-5.2:cloud" },
    });
    expect(cfg.providers.ollama?.model).toBe("glm-5.2:cloud");
  });

  it("does not disturb the critic model override", () => {
    const cfg = buildBenchConfig({
      providers: ["opencode"],
      providerModels: { opencode: QWEN },
      criticModel: "deepseek/deepseek-v4-flash",
    });
    expect(cfg.providers.opencode?.model).toBe(QWEN);
    expect(cfg.phases.critic?.model).toBe("deepseek/deepseek-v4-flash");
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

```bash
cd ~/Developer/reviewgate && bun test tests/unit/bench-provider-model.test.ts
```

Expected: FAIL — `parseProviderModels` is not exported, and the `providerModels` cases fail because the option is ignored.

- [ ] **Step 3: Add the option to `BenchConfigOptions`**

In `src/bench/runner.ts`, directly after the `criticModel` field (`:97-98`):

```typescript
  /** Pin a provider's upstream model for this run. Recorded by provenance via
   * buildRoster, which reads providers.<id>.model. Without this, a provider whose
   * model is the "default" sentinel resolves against the user's own CLI config —
   * an unversioned benchmark input. */
  providerModels?: Partial<Record<ProviderId, string>>;
```

- [ ] **Step 4: Apply it in `buildBenchConfig`**

In `src/bench/runner.ts`, immediately after the `if (opts.providers && opts.providers.length > 0) { ... }` block closes (after line 133) and before `const s = opts.suppressors;`:

```typescript
  // Applied AFTER the panel loop so a pinned model survives the enable pass, and
  // independently of `providers` so a critic-only or curator-only provider can be
  // pinned too.
  if (opts.providerModels) {
    for (const [provider, model] of Object.entries(opts.providerModels)) {
      const pc = base.providers[provider as ProviderId];
      if (pc) pc.model = model;
    }
  }
```

- [ ] **Step 5: Add the parser to `src/cli/commands/bench.ts`**

Near the other exported helpers, add:

```typescript
const PROVIDER_IDS: readonly ProviderId[] = [
  "codex",
  "gemini",
  "claude-code",
  "openrouter",
  "opencode",
  "ollama",
];

/** Parse `--provider-model opencode=alibaba-token-plan/qwen3.8-max,ollama=glm-5.2:cloud`.
 * Splits on the FIRST `=` only — model ids legitimately contain slashes, colons
 * and occasionally `=`. */
export function parseProviderModels(raw: string): Partial<Record<ProviderId, string>> {
  const out: Partial<Record<ProviderId, string>> = {};
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--provider-model expects <provider>=<model>, got "${pair}"`);
    }
    const provider = pair.slice(0, eq).trim();
    const model = pair.slice(eq + 1).trim();
    if (!model) throw new Error(`--provider-model: empty model for "${provider}"`);
    if (!PROVIDER_IDS.includes(provider as ProviderId)) {
      throw new Error(`--provider-model: unknown provider "${provider}"`);
    }
    out[provider as ProviderId] = model;
  }
  return out;
}
```

Add `providerModels?: Partial<Record<ProviderId, string>>;` to `BenchRunInput` next to `criticModel` (`:89`), and forward it where `criticModel` is forwarded (`:577`):

```typescript
      ...(input.providerModels ? { providerModels: input.providerModels } : {}),
```

- [ ] **Step 6: Wire the CLI flag**

In `src/cli/index.ts`, directly after the `critic-model` block (`:830-832`):

```typescript
          ...(typeof args["provider-model"] === "string" && args["provider-model"].trim()
            ? { providerModels: parseProviderModels(args["provider-model"].trim()) }
            : {}),
```

Import `parseProviderModels` from `./commands/bench.ts` alongside the existing bench imports. Register `provider-model` as a string arg in the same citty args block that declares `critic-model`.

- [ ] **Step 7: Run the tests and make sure they pass**

```bash
cd ~/Developer/reviewgate && bun test tests/unit/bench-provider-model.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 8: Mutation-check the guard in a COPY**

```bash
cp -r ~/Developer/reviewgate /tmp/rg-mut2 && cd /tmp/rg-mut2
# Remove the mechanism the guard exists for.
perl -0pi -e 's/  if \(opts\.providerModels\) \{.*?\n  \}\n//s' src/bench/runner.ts
bun test tests/unit/bench-provider-model.test.ts
```

Expected: **FAIL** on the three `providerModels` pinning cases (they fall back to `"default"`), while the "no override" case still passes. If everything stays green the guard is vacuous — rewrite it.

```bash
rm -rf /tmp/rg-mut2 && cd ~/Developer/reviewgate && git diff --stat
```

Expected: no changes to the real repo.

- [ ] **Step 9: Static gates**

```bash
cd ~/Developer/reviewgate && bun run typecheck && bun run lint && bun test
```

All three must pass before the commit.

- [ ] **Step 10: Commit**

```bash
cd ~/Developer/reviewgate && git status --porcelain
git add src/bench/runner.ts src/cli/commands/bench.ts src/cli/index.ts tests/unit/bench-provider-model.test.ts
git commit -m "feat(bench): --provider-model pins a reviewer's upstream model into provenance"
```

---

### Task 5: One bench case end-to-end + decision

**Estimated cost: ~30–40 credits** (one review call at the tuned configuration; a real review prompt is larger and far more output-heavy than "Antworte nur mit: OK").

Only run this if Task 2 cleared the 20-credit stop condition.

**Files:**
- Create: `bench/results/qwen-overhead/DECISION.md`

**Interfaces:**
- Consumes: the `--provider-model` flag (Task 4), the winning variant (Task 2), the cache verdict (Task 3), `creditsFor` (Task 1).
- Produces: the go/no-go for spec Phase 2.

- [ ] **Step 1: Point the adapter at the tuned invocation**

The adapter hard-codes `["run", "--dangerously-skip-permissions", "--format", "default"]` (`src/providers/opencode.ts:242`). If Task 2's winner needs `--pure` and/or `--agent rg-reviewer`, add them there — a one-line change, and note in the commit that this is measurement scaffolding, not a shipped default.

- [ ] **Step 2: Run exactly one case**

```bash
cd ~/Developer/reviewgate && mkdir -p /tmp/rg-bench-one
cp -r bench/cases/sql-injection-ts /tmp/rg-bench-one/
bun run dev bench run --corpus /tmp/rg-bench-one --providers opencode \
  --provider-model opencode=alibaba-token-plan/qwen3.8-max \
  --out bench/results/qwen-overhead/one-case.json
```

- [ ] **Step 3: Confirm the model landed in provenance**

```bash
cd ~/Developer/reviewgate && bun -e 'console.log(JSON.parse(await Bun.file("bench/results/qwen-overhead/one-case.json").text()).provenance.providers)'
```

Expected: one entry with `"model": "alibaba-token-plan/qwen3.8-max"` — **not** `"default"`. This is the whole point of Task 4; if it reads `"default"`, the flag is not wired and Task 4 is not done.

- [ ] **Step 4: Read the real per-case cost**

```bash
cd ~/Developer/reviewgate && bun run scripts/measure-opencode-tokens.ts qwen3.8-max
```

- [ ] **Step 5: Write the decision record**

Create `bench/results/qwen-overhead/DECISION.md` stating: measured per-case credits, extrapolated cost of 30 cases × 1 repeat and 30 × 3, whether each fits the 2,500-credit weekly window, and the go/no-go for spec Phase 2. If it is a no-go, name which of the three §5a options is recommended and why.

- [ ] **Step 6: Commit**

```bash
cd ~/Developer/reviewgate && git status --porcelain
git add bench/results/qwen-overhead/one-case.json bench/results/qwen-overhead/DECISION.md src/providers/opencode.ts
git commit -m "bench: per-case Qwen cost at tuned invocation + Phase 2 go/no-go"
```

- [ ] **Step 7: Clean up and report**

```bash
cd ~/Developer/reviewgate && rm -rf .review/ /tmp/rg-bench-one
```

Report the decision to Markus. Do not push. Do not start spec Phase 2 without his go-ahead — it costs ~40 % of a weekly window.

---

## Self-review notes

- **Spec coverage.** Phase 0b lever 1 (tool surface) → Task 2. Lever 2 (caching) → Task 3. Phase 0b stop condition → Task 2 Step 7 and Task 5's precondition. Phase 0c (one bench case) → Task 5. Phase 1 (`--provider-model`) → Task 4. Phase 2/3/4 are deliberately out of this plan — they are gated on Task 5's decision. Spec §5a is referenced as the escalation target, not implemented.
- **Type consistency.** `TokenUsage` is defined once (Task 1) and consumed by Tasks 2, 3, 5. `parseProviderModels` and `BenchConfigOptions.providerModels` share one type, `Partial<Record<ProviderId, string>>`, in both the parser and the config. `ProviderId` is imported from `src/providers/registry.ts:10` rather than re-declared.
- **Known limitation, stated rather than hidden.** The 1.21 credits/1 K coefficient was derived from a sample that was ~99.6 % input and 213 output tokens total. List pricing puts output at 3× input and cache read at ⅛ input, but whether the *credit* ledger uses those same ratios is unverified — Task 3 Step 4 tests the cache half of it, and Task 5 Step 4 is the only step that measures a realistic input/output mix. Both supersede every extrapolation made before them.
- **Task ordering.** Task 3 is the decisive one (5× lever vs. Task 2's few K tokens) and carries no hard dependency on Task 2. Running it first gets the go/no-go earliest and is explicitly permitted; the numbering reflects the spec's lever order, not a required sequence.
