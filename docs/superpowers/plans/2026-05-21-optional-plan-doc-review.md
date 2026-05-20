# Optional Plan-/Doc Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Reviewgate optionally review plan/spec markdown — opt-in, default off — via an auto path (Stop-hook on uncommitted doc-only diffs matching globs) and an explicit one-shot CLI command (`reviewgate review-plan <file…>`).

**Architecture:** A new default-off `docReview` config block carries `{ enabled, globs, persona }`. The deterministic triage (`matrix.ts`) turns a doc-only diff whose files match the globs into a new `riskClass: "docs"` with `runReview: true`. The Orchestrator gains two optional inputs — `forcePersona` (CLI forces review past the skip) and `reportMode` (`"gate" | "one-shot"`) — and overrides the reviewer persona to `docReview.persona` (plus a doc-oriented prompt preamble) whenever it is doing a doc review. The CLI synthesizes a full-content diff via `git diff --no-index` and runs one orchestrator iteration.

**Tech Stack:** Bun, TypeScript, Zod, `citty` (CLI), `bun:test`. Glob matching uses the built-in `Bun.Glob` — no new dependency.

**Important runtime fact (verified against the code):** `.reviewgate/personas/*.md` files are **not read at runtime** in this milestone. Reviewer behavior is driven entirely by the inline `PERSONA_REAFFIRM` map and `REVIEW_PROMPT_PREAMBLE` in `src/core/orchestrator.ts`. Therefore the substantive plan-review criteria MUST live in `PERSONA_REAFFIRM["plan"]` and the doc preamble. We still create `.reviewgate/personas/plan.md` for parity with `security.md` and future use, but it does not change behavior on its own.

**Budget-tier note:** The doc path reuses the existing `budgetTier: "minimal"` — we do NOT add a new tier, so `TIER_RANK` in `triage-engine.ts` is untouched. Only `RiskClass` gains `"docs"`.

---

### Task 1: Config — add `docReview` block

**Files:**
- Modify: `src/config/defaults.ts:1-83` (add `docReview` to the exported object)
- Modify: `src/config/define-config.ts:17-71` (add `docReview` to `ConfigSchema`)
- Test: `tests/unit/config-docreview.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/config-docreview.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";
import { defaultConfig } from "../../src/config/defaults.ts";

describe("docReview config", () => {
  it("defaults to disabled with a plan persona and non-empty globs", () => {
    expect(defaultConfig.docReview.enabled).toBe(false);
    expect(defaultConfig.docReview.persona).toBe("plan");
    expect(defaultConfig.docReview.globs.length).toBeGreaterThan(0);
  });

  it("parses and lets a user enable it via defineConfig", () => {
    const cfg = defineConfig({ docReview: { enabled: true, globs: ["docs/**"], persona: "plan" } });
    expect(cfg.docReview.enabled).toBe(true);
    expect(cfg.docReview.globs).toEqual(["docs/**"]);
  });

  it("applies the schema default when the user omits docReview", () => {
    const cfg = defineConfig({});
    expect(cfg.docReview.enabled).toBe(false);
    expect(cfg.docReview.persona).toBe("plan");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/config-docreview.test.ts`
Expected: FAIL — `defaultConfig.docReview` is `undefined` (property does not exist yet).

- [ ] **Step 3: Add the default config block**

In `src/config/defaults.ts`, add this block right after the `output: { … }` block (before the closing `};` of `defaultConfig`):

```ts
  // Optional plan/spec review. Default OFF = today's doc-skip behavior (no
  // change for existing repos). When enabled, a doc-ONLY working-tree diff whose
  // files match `globs` is reviewed with the `persona` reviewer instead of
  // skipped. Glob matching uses Bun.Glob, repo-relative.
  docReview: {
    enabled: false,
    globs: ["docs/superpowers/specs/**", "docs/**/plan*.md", "docs/**/*spec*.md"],
    persona: "plan",
  },
```

- [ ] **Step 4: Add the schema entry**

In `src/config/define-config.ts`, add this property inside the `ConfigSchema` `z.object({ … })` (e.g. right after the `output: z.object({ … })` block):

```ts
  docReview: z
    .object({
      enabled: z.boolean(),
      globs: z.array(z.string()),
      persona: z.string(),
    })
    .default({
      enabled: false,
      globs: ["docs/superpowers/specs/**", "docs/**/plan*.md", "docs/**/*spec*.md"],
      persona: "plan",
    }),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test tests/unit/config-docreview.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Type-check + commit**

```bash
bunx tsc --noEmit
git add src/config/defaults.ts src/config/define-config.ts tests/unit/config-docreview.test.ts
git commit -m "feat(config): add default-off docReview block"
```

---

### Task 2: Schema — add `"docs"` to `RiskClass`

**Files:**
- Modify: `src/schemas/triage.ts:4` (extend the enum)
- Test: `tests/unit/triage-schema.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/triage-schema.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { RiskClass, TriageDecisionSchema } from "../../src/schemas/triage.ts";

describe("triage schema", () => {
  it("accepts the docs risk class", () => {
    expect(RiskClass.parse("docs")).toBe("docs");
  });

  it("validates a full docs triage decision", () => {
    const d = TriageDecisionSchema.parse({
      schema: "reviewgate.triage.v1",
      riskClass: "docs",
      runReview: true,
      budgetTier: "minimal",
      loopCap: 3,
      reviewerHint: [],
      justification: "Plan/doc review.",
    });
    expect(d.riskClass).toBe("docs");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/triage-schema.test.ts`
Expected: FAIL — `RiskClass.parse("docs")` throws (invalid enum value).

- [ ] **Step 3: Extend the enum**

In `src/schemas/triage.ts`, change line 4 from:

```ts
export const RiskClass = z.enum(["trivial", "minimal", "standard", "sensitive", "default"]);
```

to:

```ts
export const RiskClass = z.enum(["trivial", "minimal", "standard", "sensitive", "default", "docs"]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/triage-schema.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/schemas/triage.ts tests/unit/triage-schema.test.ts
git commit -m "feat(schema): add docs risk class"
```

---

### Task 3: Triage — glob matcher + doc-review branch in `matrix.ts`

**Files:**
- Modify: `src/triage/matrix.ts:1-38` (add `DocReviewPolicy`, glob helper, branch)
- Test: `tests/unit/triage-matrix.test.ts:1-39` (add cases)

- [ ] **Step 1: Write the failing tests**

Append these cases inside the `describe("triageFromFacts (deterministic)", …)` block in `tests/unit/triage-matrix.test.ts` (before its closing `});`):

```ts
  const docDiff =
    "diff --git a/docs/superpowers/specs/x.md b/docs/superpowers/specs/x.md\n--- a/docs/superpowers/specs/x.md\n+++ b/docs/superpowers/specs/x.md\n@@ -1 +1 @@\n-a\n+b\n";

  it("docReview disabled → doc-only still skipped", () => {
    const d = triageFromFacts(facts(docDiff), {
      enabled: false,
      globs: ["docs/superpowers/specs/**"],
      persona: "plan",
    });
    expect(d.runReview).toBe(false);
    expect(d.riskClass).toBe("trivial");
  });

  it("docReview enabled + glob match → reviewed as docs", () => {
    const d = triageFromFacts(facts(docDiff), {
      enabled: true,
      globs: ["docs/superpowers/specs/**"],
      persona: "plan",
    });
    expect(d.runReview).toBe(true);
    expect(d.riskClass).toBe("docs");
    expect(d.budgetTier).toBe("minimal");
  });

  it("docReview enabled + no glob match → skipped", () => {
    const d = triageFromFacts(facts(docDiff), {
      enabled: true,
      globs: ["docs/other/**"],
      persona: "plan",
    });
    expect(d.runReview).toBe(false);
  });

  it("invalid glob fails open (no match → skip), does not throw", () => {
    const d = triageFromFacts(facts(docDiff), {
      enabled: true,
      globs: ["["],
      persona: "plan",
    });
    expect(d.runReview).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/triage-matrix.test.ts`
Expected: FAIL — `triageFromFacts` ignores the second arg; the "enabled + glob match" case gets `riskClass: "trivial"`, `runReview: false`.

- [ ] **Step 3: Implement the policy type, glob helper, and branch**

In `src/triage/matrix.ts`, replace the import/signature region (lines 1-14) and the `docOnly` branch (lines 28-38).

First, the top of the file — add the `DocReviewPolicy` interface and the glob helper after the existing imports:

```ts
// src/triage/matrix.ts
import type { DiffFacts } from "../research/diff-facts.ts";
import type { TriageDecision } from "../schemas/triage.ts";

export interface DocReviewPolicy {
  enabled: boolean;
  globs: string[];
  persona: string;
}

// True when any changed path matches any glob. Uses Bun.Glob (built-in). An
// invalid glob is skipped with a warning and never throws — matching fails open
// to "no match" so a bad pattern can never crash the gate.
function matchesAnyGlob(paths: string[], globs: string[]): boolean {
  for (const g of globs) {
    let glob: Bun.Glob;
    try {
      glob = new Bun.Glob(g);
    } catch {
      console.warn(`reviewgate: invalid docReview glob ignored: ${g}`);
      continue;
    }
    for (const p of paths) {
      if (glob.match(p)) return true;
    }
  }
  return false;
}
```

Then change the function signature (line 13) to accept the optional policy:

```ts
export function triageFromFacts(facts: DiffFacts, docReview?: DocReviewPolicy): TriageDecision {
```

Then replace the `docOnly` branch (the existing `if (facts.docOnly) { … }`) with:

```ts
  if (facts.docOnly) {
    if (docReview?.enabled && matchesAnyGlob(facts.files.map((f) => f.path), docReview.globs)) {
      return {
        ...base,
        riskClass: "docs",
        runReview: true,
        budgetTier: "minimal",
        loopCap: 3,
        reviewerHint: [],
        justification: "Plan/doc review (matched docReview globs).",
      };
    }
    return {
      ...base,
      riskClass: "trivial",
      runReview: false,
      budgetTier: "trivial",
      loopCap: 1,
      reviewerHint: [],
      justification: "Doc-only diff; review skipped.",
    };
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/unit/triage-matrix.test.ts`
Expected: PASS — original 3 cases plus the 4 new ones.

- [ ] **Step 5: Type-check + commit**

```bash
bunx tsc --noEmit
git add src/triage/matrix.ts tests/unit/triage-matrix.test.ts
git commit -m "feat(triage): review doc-only diffs matching docReview globs"
```

---

### Task 4: Regression — `refineTriage` preserves the `docs` class

No code change — `refineTriage` spreads `...det`, so `riskClass: "docs"` already survives. This task locks that in with a test.

**Files:**
- Test: `tests/unit/triage-engine.test.ts` (add one case)

- [ ] **Step 1: Write the test**

Append inside the existing top-level `describe(...)` block in `tests/unit/triage-engine.test.ts` (before its closing `});`):

```ts
  it("preserves the docs risk class through refinement (llm: null)", async () => {
    const det = {
      schema: "reviewgate.triage.v1" as const,
      riskClass: "docs" as const,
      runReview: true,
      budgetTier: "minimal" as const,
      loopCap: 3,
      reviewerHint: [],
      justification: "Plan/doc review.",
    };
    const out = await refineTriage(det, { llm: null });
    expect(out.riskClass).toBe("docs");
    expect(out.runReview).toBe(true);
  });
```

If `refineTriage` is not yet imported in this test file, add it to the existing import from `../../src/triage/triage-engine.ts`.

- [ ] **Step 2: Run test to verify it passes immediately**

Run: `bun test tests/unit/triage-engine.test.ts`
Expected: PASS (refineTriage with `llm: null` returns `det` unchanged).

- [ ] **Step 3: Commit**

```bash
git add tests/unit/triage-engine.test.ts
git commit -m "test(triage): lock docs class survival through refineTriage"
```

---

### Task 5: Orchestrator — `forcePersona`, persona/preamble override, `plan` reaffirm

**Files:**
- Modify: `src/core/orchestrator.ts:25-62` (input type, preamble, reaffirm map)
- Modify: `src/core/orchestrator.ts:90-103` (triage call + forced skip guard)
- Modify: `src/core/orchestrator.ts:147-189` (persona/preamble override in reviewer loop)
- Modify: `src/core/orchestrator.ts:290-339` (writeReport passes reportMode)
- Create: `.reviewgate/personas/plan.md`
- Test: `tests/unit/orchestrator-docreview.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/orchestrator-docreview.test.ts`. The stub adapter records the persona and the prompt-file text it was given, so we can assert the override and the doc preamble:

```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "../../src/config/define-config.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

function recordingStub(seen: { persona?: string; prompt?: string }): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      seen.persona = inp.persona;
      seen.prompt = readFileSync(inp.promptFile, "utf8");
      return {
        reviewerId: inp.reviewerId,
        verdict: "PASS",
        findings: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

const docDiff =
  "diff --git a/docs/superpowers/specs/x.md b/docs/superpowers/specs/x.md\n--- a/docs/superpowers/specs/x.md\n+++ b/docs/superpowers/specs/x.md\n@@ -1 +1 @@\n-a\n+b\n";

describe("Orchestrator doc review", () => {
  it("forcePersona forces a review on a doc-only diff and uses that persona", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-doc1-"));
    writeFileSync(join(repo, "x.md"), "x");
    const seen: { persona?: string; prompt?: string } = {};
    const orch = new Orchestrator({
      repoRoot: repo,
      config: defineConfig({ cache: { enabled: false, reviewTtlDays: 7 } }),
      adapters: { codex: recordingStub(seen) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: docDiff,
      reasonOnFailEnabled: true,
      forcePersona: "plan",
    });
    const r = await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(r.verdict).toBe("PASS");
    expect(seen.persona).toBe("plan"); // reviewer ran with the plan persona
    expect(seen.prompt).toContain("implementation plan"); // doc-oriented preamble
  });

  it("auto path: docReview-enabled config reviews matching doc-only diff with the configured persona", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-doc2-"));
    writeFileSync(join(repo, "x.md"), "x");
    const seen: { persona?: string; prompt?: string } = {};
    const orch = new Orchestrator({
      repoRoot: repo,
      config: defineConfig({
        cache: { enabled: false, reviewTtlDays: 7 },
        docReview: { enabled: true, globs: ["docs/superpowers/specs/**"], persona: "plan" },
      }),
      adapters: { codex: recordingStub(seen) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: docDiff,
      reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(seen.persona).toBe("plan");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/orchestrator-docreview.test.ts`
Expected: FAIL — `forcePersona` is not a known input (TS error) and/or the reviewer is never spawned (doc-only diff skipped), so `seen.persona` is `undefined`.

- [ ] **Step 3: Add the input fields, doc preamble, and `plan` reaffirm**

In `src/core/orchestrator.ts`, add two optional fields to `OrchestratorInput` (after `reasonOnFailEnabled: boolean;` at line 35):

```ts
  // Doc/plan review hooks. forcePersona (set by the `review-plan` CLI) forces a
  // review even when triage would skip, and pins the reviewer persona. reportMode
  // "one-shot" tells the report writer to omit the decisions-loop instructions.
  forcePersona?: string;
  reportMode?: "gate" | "one-shot";
```

Add the doc-oriented preamble right after the `REVIEW_PROMPT_PREAMBLE` constant (after line 54). It keeps the IDENTICAL JSON output shape so parsing is unchanged — only the framing differs:

```ts
const DOC_REVIEW_PROMPT_PREAMBLE = [
  "You are reviewing an implementation plan / spec document (prose, not code).",
  "Output ONLY a single JSON object — no prose, no markdown fences — of exactly",
  "this shape:",
  '{"verdict":"PASS|FAIL","findings":[{"severity":"CRITICAL|WARN|INFO",',
  '"category":"security|correctness|quality|architecture|performance|testing|docs",',
  '"rule_id":"<short-kebab-id>","file":"<repo-relative path>","line":<integer>,',
  '"message":"<one line>","details":"<explanation>","confidence":<number 0..1>}]}',
  "Judge the plan on: completeness, internal contradictions, missing edge cases,",
  "verifiability/testability, unrealistic assumptions, missing migration/rollback,",
  "and wrong file/symbol references. Report every real issue. Use verdict PASS",
  "with an empty findings array only if the plan is genuinely sound.",
].join("\n");
```

Add a `plan` entry to `PERSONA_REAFFIRM` (inside the object at lines 56-61):

```ts
  plan: "You are a meticulous staff engineer reviewing an implementation plan. Find gaps, contradictions, untestable steps, and unstated assumptions before code is written.",
```

- [ ] **Step 4: Pass the policy to triage and guard the skip with `forcePersona`**

In `runIteration`, change the triage call (line 92) to pass the policy:

```ts
    const triage = await refineTriage(triageFromFacts(facts, this.input.config.docReview), {
      llm: null,
    });
```

Immediately after that line, compute the doc persona:

```ts
    const docPersona =
      this.input.forcePersona ??
      (triage.riskClass === "docs" ? this.input.config.docReview.persona : null);
```

Change the skip guard (line 94) from `if (!triage.runReview) {` to:

```ts
    if (!triage.runReview && !this.input.forcePersona) {
```

- [ ] **Step 5: Override persona + preamble in the reviewer loop**

In the `activeReviewers.map(async (r) => { … })` callback (around lines 155-189), make the persona and preamble doc-aware.

Replace the reaffirm/sanitize/prompt lines (167-177) so they use a local `persona` and the right preamble:

```ts
      const persona = docPersona ?? r.persona;
      const reaffirm = PERSONA_REAFFIRM[persona] ?? DEFAULT_REAFFIRM;
      const sanitised = sanitizeDiff({ diff: this.input.diff, personaReaffirm: reaffirm });
      const runDir = mkdtempSync(join(tmpdir(), `rg-rev-${r.provider}-`));
      const promptFile = join(runDir, "prompt.txt");
      const findingsPath = join(runDir, "findings.md");
      const diffPath = join(runDir, "diff.patch");
      // research.md goes BEFORE the untrusted-diff fence (trusted context).
      const promptParts = [docPersona ? DOC_REVIEW_PROMPT_PREAMBLE : REVIEW_PROMPT_PREAMBLE, ""];
```

Then in the `adapter.review({ … })` call and the returned object, replace `persona: r.persona` with `persona` (the local), in BOTH places:

```ts
        reviewerId: `${r.provider}-${persona}`,
```
```ts
        persona,
```
```ts
      return { res, provider: r.provider, persona, model };
```

(The `reviewerId` line uses `persona` instead of `r.persona`; the `adapter.review` `persona:` field and the returned `persona` field both use the local `persona`.)

- [ ] **Step 6: Thread `reportMode` through `writeReport`**

In `writeReport` (line 321), change the `writer.write({ … })` call so it passes the mode. Change:

```ts
    await writer.write({
```

to capture the report object and pass options:

```ts
    await writer.write(
      {
```

and at the end of the `write({...})` object (after the closing `},` of the `git` field, line 337), close with the options arg:

```ts
      },
      { mode: this.input.reportMode ?? "gate" },
    );
```

(This depends on Task 6 adding the second parameter to `ReportWriter.write`. Implement Task 6 before running this test, or temporarily ignore the extra arg — TypeScript will accept it once Task 6 lands. Recommended order: do Task 6 Step 3 first, then return here. The commit at the end of this task assumes both are in place.)

- [ ] **Step 7: Create the (decorative) plan persona file**

Create `.reviewgate/personas/plan.md`:

```markdown
You are a meticulous staff engineer reviewing an implementation plan or spec.
Assume the author was optimistic. Look for:
- Incomplete or hand-wavy steps ("handle errors", "add validation") with no concrete how
- Internal contradictions between sections (types, names, signatures that disagree)
- Missing edge cases, failure modes, and rollback/migration paths
- Steps that cannot be verified or tested as written
- Unstated assumptions and unrealistic effort/scope claims
- References to files, functions, or symbols that do not exist

Output ONLY a JSON object matching the schema you were given. No prose.
```

> NOTE: This file is documentation/parity only — the runtime does not read it in this milestone (criteria live in `PERSONA_REAFFIRM["plan"]` and the doc preamble).

- [ ] **Step 8: Run test to verify it passes**

Run: `bun test tests/unit/orchestrator-docreview.test.ts`
Expected: PASS (2 tests) — reviewer ran with persona `plan` and the prompt contains "implementation plan".

- [ ] **Step 9: Type-check + commit**

```bash
bunx tsc --noEmit
git add src/core/orchestrator.ts .reviewgate/personas/plan.md tests/unit/orchestrator-docreview.test.ts
git commit -m "feat(orchestrator): forcePersona + doc preamble + plan reaffirm"
```

---

### Task 6: Report writer — one-shot mode (no decisions instructions)

**Files:**
- Modify: `src/core/report-writer.ts:31-110` (`renderMd` takes a mode; `write` accepts opts)
- Test: `tests/unit/report-writer-oneshot.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/report-writer-oneshot.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportWriter } from "../../src/core/report-writer.ts";
import { pendingMdPath } from "../../src/utils/paths.ts";
import type { PendingReport } from "../../src/schemas/pending-report.ts";

function report(): PendingReport {
  return {
    schema: "reviewgate.pending.v1",
    run_id: "RUN",
    iter: 1,
    max_iter: 3,
    verdict: "PASS",
    counts: { critical: 0, warn: 0, info: 0 },
    reviewers: [
      { id: "codex-plan", provider: "codex", model: "gpt-5.4", persona: "plan", status: "ok", cost_usd: 0, duration_ms: 1 },
    ],
    findings: [],
    cost_usd_total: 0,
    duration_ms_total: 1,
    generated_at: new Date().toISOString(),
    git: { sha: "0".repeat(40), branch: "main", dirty_files: [] },
  };
}

describe("ReportWriter one-shot mode", () => {
  it("gate mode (default) keeps the decisions-loop instructions", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rep1-"));
    await new ReportWriter(repo).write(report());
    const md = readFileSync(pendingMdPath(repo), "utf8");
    expect(md).toContain("Required actions");
  });

  it("one-shot mode omits the decisions-loop instructions", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rep2-"));
    await new ReportWriter(repo).write(report(), { mode: "one-shot" });
    const md = readFileSync(pendingMdPath(repo), "utf8");
    expect(md).not.toContain("Required actions");
    expect(md).not.toContain("decisions/");
    expect(md).toContain("Reviewgate Report"); // header still present
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/report-writer-oneshot.test.ts`
Expected: FAIL — `write` ignores the second arg; one-shot output still contains "Required actions".

- [ ] **Step 3: Add the `mode` parameter to `renderMd` and `write`**

In `src/core/report-writer.ts`, change `renderMd` (line 31) to take a mode and conditionally include the actions block. Change the signature:

```ts
function renderMd(r: PendingReport, mode: "gate" | "one-shot"): string {
```

Within `renderMd`, the `head` array currently always includes the "## Required actions" block (lines 56-63). Replace the fixed `head` array's actions lines with a conditional. Build the actions block separately:

```ts
  const actions =
    mode === "one-shot"
      ? []
      : [
          "## Required actions",
          "",
          `For each finding below, append ONE line to \`.reviewgate/decisions/${r.iter}.jsonl\`:`,
          '- `{"schema":"reviewgate.decision.v1","finding_id":"F-XYZ","verdict":"accepted","action":"fixed","files_touched":[...]}`',
          '- `{"schema":"reviewgate.decision.v1","finding_id":"F-XYZ","verdict":"rejected","reason":"...","reviewer_was_wrong":true}`',
          "",
          "Reviewgate refuses to unblock until every finding ID has a decision.",
          "",
        ];
```

Then change the `head` array so the actions block is spliced in via `...actions` in place of those removed lines, keeping the trailing `"---", "", ` separator. The resulting `head` tail should read:

```ts
    ...coverageBanner,
    ...actions,
    "---",
    "",
  ].join("\n");
```

Update the `write` method (line 104) to accept and forward the mode:

```ts
  async write(report: PendingReport, opts?: { mode?: "gate" | "one-shot" }): Promise<void> {
    const md = pendingMdPath(this.repoRoot);
    const json = pendingJsonPath(this.repoRoot);
    ensureDir(md);
    writeFileSync(md, renderMd(report, opts?.mode ?? "gate"), { mode: 0o600 });
    writeFileSync(json, JSON.stringify(report, null, 2), { mode: 0o600 });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/report-writer-oneshot.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Type-check + commit**

```bash
bunx tsc --noEmit
git add src/core/report-writer.ts tests/unit/report-writer-oneshot.test.ts
git commit -m "feat(report): one-shot mode omits decisions-loop instructions"
```

---

### Task 7: CLI — `reviewgate review-plan <file…>`

**Files:**
- Create: `src/cli/commands/review-plan.ts`
- Modify: `src/cli/index.ts:1-65` (register subcommand)
- Test: `tests/integration/review-plan.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/integration/review-plan.test.ts`. It uses a stub adapter via `providerOverrides` so no real codex is needed; the real-codex run is the separate Task 8 verification.

```ts
import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import { runReviewPlan } from "../../src/cli/commands/review-plan.ts";

function gitInit(repo: string) {
  execSync("git init -q && git config user.email t@t.t && git config user.name t", {
    cwd: repo,
    shell: "/bin/bash",
  });
}

function stub(verdict: "PASS" | "FAIL"): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp): Promise<ReviewResult> {
      return {
        reviewerId: inp.reviewerId,
        verdict,
        findings:
          verdict === "FAIL"
            ? [
                {
                  id: "F-001",
                  severity: "CRITICAL",
                  category: "correctness",
                  rule_id: "x",
                  file: inp.persona, // not asserted; just non-empty
                  line_start: 1,
                  line_end: 1,
                  message: "m",
                  details: "d",
                  confidence: 0.9,
                  consensus: "single",
                  signature: "sig",
                } as ReviewResult["findings"][number],
              ]
            : [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      };
    },
  };
}

describe("review-plan CLI", () => {
  it("reviews a plan file and returns exit 0 on PASS", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rp1-"));
    gitInit(repo);
    writeFileSync(join(repo, "plan.md"), "# Plan\nStep 1: do the thing.\n");
    const res = await runReviewPlan({
      repoRoot: repo,
      files: ["plan.md"],
      providerOverrides: { codex: stub("PASS") },
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("PASS");
  });

  it("returns non-zero exit on FAIL", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rp2-"));
    gitInit(repo);
    writeFileSync(join(repo, "plan.md"), "# Plan\n");
    const res = await runReviewPlan({
      repoRoot: repo,
      files: ["plan.md"],
      providerOverrides: { codex: stub("FAIL") },
    });
    expect(res.exitCode).not.toBe(0);
  });

  it("errors clearly on a missing file", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rp3-"));
    gitInit(repo);
    const res = await runReviewPlan({
      repoRoot: repo,
      files: ["nope.md"],
      providerOverrides: { codex: stub("PASS") },
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr.toLowerCase()).toContain("not found");
  });

  it("rejects a path outside the repo", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rp4-"));
    gitInit(repo);
    const res = await runReviewPlan({
      repoRoot: repo,
      files: ["../escape.md"],
      providerOverrides: { codex: stub("PASS") },
    });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr.toLowerCase()).toContain("outside");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/integration/review-plan.test.ts`
Expected: FAIL — `src/cli/commands/review-plan.ts` does not exist (import error).

- [ ] **Step 3: Implement the command**

Create `src/cli/commands/review-plan.ts`:

```ts
// src/cli/commands/review-plan.ts
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { ulid } from "ulid";
import type { ReviewgateConfig } from "../../config/define-config.ts";
import { defaultConfigPath, loadConfig } from "../../config/loader.ts";
import { Orchestrator } from "../../core/orchestrator.ts";
import type { ProviderAdapter } from "../../providers/adapter-base.ts";
import { type ProviderId, createAdapter } from "../../providers/registry.ts";
import { collectGitInfo } from "../../utils/git.ts";
import { detectHostModel } from "../../utils/host-model.ts";
import { pendingMdPath } from "../../utils/paths.ts";
import { readFileSync } from "node:fs";

export interface ReviewPlanInput {
  repoRoot: string;
  files: string[];
  providerOverrides?: Partial<Record<ProviderId, ProviderAdapter>>;
  sandboxModeOverride?: "strict" | "permissive" | "off";
}

export interface ReviewPlanOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function loadEffectiveConfig(repoRoot: string): Promise<ReviewgateConfig> {
  const p = defaultConfigPath(repoRoot);
  if (existsSync(p)) {
    try {
      return await loadConfig(p);
    } catch {
      // fall through to defaults
    }
  }
  return loadConfig(null);
}

// Normalize a user-supplied path to a repo-relative path. Rejects paths that
// escape the repo (relative starts with "..") — git diff --no-index on an
// absolute/escaping path would emit non-repo-relative headers and broken findings.
function toRepoRelative(repoRoot: string, file: string): { rel: string } | { error: string } {
  const abs = resolve(repoRoot, file);
  const rel = relative(repoRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return { error: `path is outside the repository: ${file}` };
  }
  if (!existsSync(abs)) {
    return { error: `file not found: ${file}` };
  }
  return { rel };
}

// Synthesize a full-content diff for a single file via `git diff --no-index`.
// Exit code 1 means "differences exist" (always true vs /dev/null) and is success.
function synthDiff(repoRoot: string, rel: string): { diff: string } | { error: string } {
  const r = spawnSync("git", ["diff", "--no-color", "--no-index", "/dev/null", rel], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  // status null/0/1 are fine; >1 is a real git error.
  if (r.status !== null && r.status > 1) {
    return { error: `git diff failed for ${rel}: ${r.stderr ?? ""}` };
  }
  const out = r.stdout ?? "";
  if (out.includes("Binary files")) {
    return { error: `cannot review binary file: ${rel}` };
  }
  if (!out.trim()) {
    return { error: `no content to review in ${rel}` };
  }
  return { diff: out };
}

export async function runReviewPlan(input: ReviewPlanInput): Promise<ReviewPlanOutput> {
  if (input.files.length === 0) {
    return { exitCode: 2, stdout: "", stderr: "review-plan: no files given\n" };
  }
  const cfg = await loadEffectiveConfig(input.repoRoot);

  const diffs: string[] = [];
  for (const f of input.files) {
    const norm = toRepoRelative(input.repoRoot, f);
    if ("error" in norm) return { exitCode: 2, stdout: "", stderr: `review-plan: ${norm.error}\n` };
    const d = synthDiff(input.repoRoot, norm.rel);
    if ("error" in d) return { exitCode: 2, stdout: "", stderr: `review-plan: ${d.error}\n` };
    diffs.push(d.diff);
  }
  const diff = diffs.join("\n");

  const adapters: Partial<Record<ProviderId, ProviderAdapter>> = {};
  for (const r of cfg.phases.review.reviewers) {
    if (!adapters[r.provider]) {
      adapters[r.provider] = input.providerOverrides?.[r.provider] ?? createAdapter(r.provider);
    }
  }

  const host = detectHostModel({ env: process.env as Record<string, string>, hookStdin: null });
  const gitInfo = collectGitInfo(input.repoRoot);
  const orchestrator = new Orchestrator({
    repoRoot: input.repoRoot,
    config: cfg,
    adapters,
    sandboxMode: input.sandboxModeOverride ?? cfg.sandbox.mode,
    hostTier: host.tier,
    diff,
    gitInfo,
    reasonOnFailEnabled: true,
    forcePersona: cfg.docReview.persona,
    reportMode: "one-shot",
  });

  const result = await orchestrator.runIteration({ runId: ulid(), iter: 1 });

  let report = "";
  try {
    report = readFileSync(pendingMdPath(input.repoRoot), "utf8");
  } catch {
    report = "";
  }
  const pass = result.verdict === "PASS" || result.verdict === "SOFT-PASS";
  const summary = `\nReviewgate review-plan: ${result.verdict}\n`;
  return {
    exitCode: pass ? 0 : 1,
    stdout: `${report}${summary}`,
    stderr: result.verdict === "ERROR" ? "review-plan: reviewer error (no reviewer completed)\n" : "",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/integration/review-plan.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Register the subcommand in the CLI**

In `src/cli/index.ts`, add the import (after the other command imports, line 5):

```ts
import { runReviewPlan } from "./commands/review-plan.ts";
```

Add the command definition (after the `gate` command, before `doctor`):

```ts
const reviewPlan = defineCommand({
  meta: {
    name: "review-plan",
    description: "Review a plan/spec markdown file (one-shot, committed or not)",
  },
  args: { file: { type: "positional", required: true, description: "Path(s) to plan file(s)" } },
  async run({ args }) {
    // citty collects all positionals in args._
    const files = (args._ ?? []).filter((s) => typeof s === "string" && s.length > 0);
    const res = await runReviewPlan({ repoRoot: process.cwd(), files });
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr) process.stderr.write(res.stderr);
    process.exit(res.exitCode);
  },
});
```

Add it to `subCommands` (line 62):

```ts
  subCommands: { init, gate, "review-plan": reviewPlan, doctor, audit },
```

- [ ] **Step 6: Verify the command is wired (smoke test)**

```bash
bun run src/cli/index.ts review-plan --help
```
Expected: help text showing `review-plan` and the positional `file` argument (exit 0).

- [ ] **Step 7: Type-check + commit**

```bash
bunx tsc --noEmit
git add src/cli/commands/review-plan.ts src/cli/index.ts tests/integration/review-plan.test.ts
git commit -m "feat(cli): add review-plan one-shot command"
```

---

### Task 8: Full-suite + real end-to-end verification

No new production code — this task proves the feature works against the real toolchain (per project rule: real CLI verification, not fakes).

**Files:**
- Create (temporary, deleted at end): `/tmp/rg-plan-sample.md` is NOT used — we review a real in-repo spec.

- [ ] **Step 1: Run the entire test suite + static checks**

Run:
```bash
bunx tsc --noEmit && bun test
```
Expected: all tests pass (including the new files from Tasks 1-7). If any pre-existing test broke, fix the regression before continuing.

- [ ] **Step 2: Confirm codex is reachable**

Run: `codex exec "Hello"`
Expected: a short reply within ~10s. If it hangs, fall back per CLAUDE.md (OpenCode) is NOT applicable here — this is a runtime reviewer check; if codex is down, note it and skip Step 3 with an explicit warning rather than claiming success.

- [ ] **Step 3: Real review of an in-repo spec via codex**

Run (reviews this very design spec with the real codex reviewer):
```bash
bun run src/cli/index.ts review-plan docs/superpowers/specs/2026-05-21-optional-plan-doc-review-design.md
echo "EXIT=$?"
```
Expected: a rendered Reviewgate report on stdout WITHOUT a "Required actions" section, ending with `Reviewgate review-plan: PASS` (or `FAIL` with real findings). A real verdict — not a $0 skip — confirms the doc path actually spawned the plan-persona reviewer. `EXIT` is 0 on PASS, 1 on FAIL.

- [ ] **Step 4: Confirm the auto-path skip still holds when docReview is OFF**

Run:
```bash
bun test tests/unit/triage-matrix.test.ts tests/unit/orchestrator-triage.test.ts
```
Expected: PASS — the default-off behavior (doc-only diffs skipped) is unchanged.

- [ ] **Step 5: Commit any verification-driven fixes (if needed)**

If Steps 1-4 surfaced a fix, commit it:
```bash
git add -A
git commit -m "fix: address review-plan end-to-end verification findings"
```
If nothing changed, skip this step.

---

## Self-Review (completed during planning)

**1. Spec coverage:**
- Config block (Decision: default off, validated, cache-invalidating) → Task 1. ✓
- New `riskClass: "docs"` → Task 2 + Task 3. ✓
- Glob match via `Bun.Glob`, fail-open on invalid → Task 3. ✓
- Persona override threading (Decision 1) → Task 5 (`docPersona`, reviewer-loop override). ✓
- CLI bypass via `forcePersona` (Decision 2) → Task 5 (skip guard) + Task 7 (CLI sets it). ✓
- `plan` persona + reaffirm + doc preamble (Decision 3) → Task 5. ✓ (Corrected: criteria live in reaffirm+preamble, NOT the unread `.md` file.)
- Loop semantics: auto = blocking via existing decisions loop (no code change needed); CLI = one-shot (Decision 4) → Task 6 + Task 7. ✓
- CLI diff hardening: repo-relative normalization, exit-1-as-success, binary rejection, missing-file error (Decision 5) → Task 7. ✓
- One-shot report mode (Decision 6) → Task 6. ✓
- Tests incl. real end-to-end → Tasks 1-8. ✓

**2. Placeholder scan:** No "TBD"/"handle errors"-style placeholders; every code step shows full code.

**3. Type consistency:** `DocReviewPolicy` (matrix.ts) shape matches the config block and `cfg.docReview`; `forcePersona`/`reportMode` names consistent across orchestrator, report-writer, and CLI; `riskClass: "docs"` and `budgetTier: "minimal"` consistent between matrix.ts and tests; `runReviewPlan`/`ReviewPlanInput`/`ReviewPlanOutput` names consistent between command and test.

**Cross-task ordering note:** Task 5 Step 6 (writeReport passes `{ mode }`) depends on Task 6 Step 3 (`write` accepts opts). If executing strictly in order, the Task 5 type-check at Step 9 will only pass once Task 6 is also applied — do Task 6 immediately after Task 5's edits, or run the combined `tsc` after both. Subagent-driven execution should treat Tasks 5 and 6 as a paired unit.
```
