# Reviewgate M2 — Multi-Reviewer Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Gemini, Claude-as-reviewer, and an OpenRouter "any-model" reviewer to Reviewgate, run them as a parallel cross-provider panel, and decide the verdict with the severity-weighted veto plus an adversarial critic phase — all $0 via OAuth where possible, with an OpenRouter API-key path for arbitrary models.

**Architecture:** All reviewers emit the SAME review-output shape (`{verdict, findings:[{severity, category, rule_id, file, line, message, details, confidence}]}`) — already proven for Codex (`--output-schema`), Gemini (prompt + tolerant parse), Claude (`--output-format json` + tolerant parse), and OpenRouter (OpenAI `response_format` json_schema). A shared `review-output.ts` maps that shape into the rich `Finding`. The Orchestrator spawns the configured reviewers in parallel, the existing signature-dedup aggregator computes consensus (unanimous/majority/minority/singleton) and the severity-weighted verdict, then a Critic phase may DEMOTE (never promote) likely false-positives. Anti-sycophancy: any `claude-code` reviewer runs at a smaller model tier than the host and in a clean temp CWD so its own Stop hook can never recurse into Reviewgate.

**Tech Stack:** Bun 1.x + TypeScript 5.x (strict) + zod + biome + citty. Reviewer CLIs: codex ≥0.130, gemini ≥0.40, claude ≥2.1. OpenRouter via direct HTTPS (`fetch`), OpenAI-compatible `/chat/completions`.

**Spec reference:** `docs/superpowers/specs/2026-05-20-reviewgate-design.md` (§5.4 adapters/auth, §5.5 aggregator/veto, §5.3 critic). M1 plan: `docs/superpowers/plans/2026-05-20-reviewgate-m1-minimum-viable-loop.md`.

**Verified CLI contracts (recon 2026-05-20):**
- **Gemini:** `GEMINI_CLI_TRUST_WORKSPACE=true gemini -p "<prompt>" -m <model> -o json --approval-mode plan </dev/null` → outer JSON `{ session_id, response: "<string>", stats: { models: { <model>: { tokens: { prompt, candidates, total, cached } } } } }`. The `response` STRING contains the model's answer; when we ask for JSON it is the review-shape JSON (sometimes wrapped in ```json fences). Needs `GEMINI_CLI_TRUST_WORKSPACE=true` or exits 55 ("not a trusted directory").
- **Claude `--bare` reads ONLY `ANTHROPIC_API_KEY`, never OAuth.** Therefore the OAuth Claude reviewer uses NON-bare `claude -p` and gets safety from (a) running in a clean temp CWD with no `.reviewgate` hooks and (b) `--disallowedTools` + `--permission-mode dontAsk`. Exact JSON shape confirmed in Spike SM2-2.
- **Codex:** already wired in M1 (`--output-schema`, stdin closed, `type`-keyed events).

**M2 EXCLUDES** (later milestones): adaptive triage / research phase / symbol-graph (M3); Brain + Curator (M4); FP-Ledger learning loop (M5); cassette replay, weekly reports, full `reviewgate stats` (M6); native sandbox isolation (still blocked on `@anthropic-ai/sandbox-runtime` v1 — M2 keeps the M1 fail-closed behavior and `sandbox.mode:"off"` default). If a step would build something on this list, STOP and ask.

---

## Phase 0 — File structure (read first)

New and changed files in M2:

```
src/
├── providers/
│   ├── adapter-base.ts            # MODIFY: add 'sandboxMode' + 'hostTier' to ReviewInput context (optional)
│   ├── review-output.ts           # CREATE: shared review-shape schema + mapReviewOutputToFindings()
│   ├── codex.ts                   # MODIFY: use shared review-output.ts (DRY); behavior unchanged
│   ├── gemini.ts                  # CREATE: GeminiAdapter (OAuth, headless json)
│   ├── claude.ts                  # CREATE: ClaudeAdapter (OAuth non-bare, temp-cwd, tier-downgraded)
│   ├── openrouter.ts              # CREATE: OpenRouterAdapter (HTTPS, any model by name)
│   └── registry.ts                # CREATE: provider-id → adapter factory
├── core/
│   ├── critic.ts                  # CREATE: CriticPhase (demote likely-FPs)
│   ├── orchestrator.ts            # MODIFY: spawn N reviewers in parallel, run critic, aggregate
│   └── aggregator.ts              # MODIFY: apply critic verdicts in the veto (keep/demote rules)
├── config/
│   ├── defaults.ts                # MODIFY: providers gemini/claude-code/openrouter, phases.review.reviewers, phases.critic
│   └── define-config.ts           # MODIFY: schema for the above
├── utils/
│   └── host-model.ts              # (unchanged; now actually consumed by ClaudeAdapter tier selection)
docs/superpowers/spikes/M2/
├── SM2-1-gemini-headless.md
├── SM2-2-claude-reviewer.md
├── SM2-3-openrouter.md
└── SUMMARY.md
tests/
├── unit/{review-output,gemini-adapter,claude-adapter,openrouter-adapter,critic,registry,aggregator-critic}.test.ts
├── fixtures/{fake-gemini.sh,fake-claude.sh}      # CREATE: mirror real CLI output shapes
└── e2e/{gemini-real,claude-real}.test.ts          # CREATE: gated by REVIEWGATE_E2E=1
```

**Each `src/` file ≤ 300 lines.** All reviewers reuse `review-output.ts` mapping — do not duplicate the CodexFinding→Finding logic.

**Run bun via** `export PATH="$HOME/.bun/bin:$PATH"` (bun is at `~/.bun/bin`, not on the default non-login PATH). tsconfig has `allowImportingTsExtensions: true`; never write Claude attribution in commits.

---

## Pre-flight: Spikes

Run BEFORE the dependent tasks. Each writes findings to `docs/superpowers/spikes/M2/SM2-*.md`. If a spike contradicts an assumption, amend the dependent task before implementing.

### Spike SM2-1: Gemini headless review (informs Task 4)

- [ ] **Step 1: Real run**

```bash
mkdir -p /tmp/rg-sm2-1 && cd /tmp/rg-sm2-1
cat > p.txt <<'P'
You are a security reviewer. Output ONLY JSON: {"verdict":"PASS|FAIL","findings":[{"severity":"CRITICAL|WARN|INFO","category":"security","rule_id":"...","file":"...","line":1,"message":"...","details":"...","confidence":0.0}]}. No prose, no markdown fences.
Diff:
--- a/foo.ts
+++ b/foo.ts
@@ -1 +1 @@
+export function compareToken(a:string,b:string){return a==b;}
P
GEMINI_CLI_TRUST_WORKSPACE=true gemini -p "$(cat p.txt)" -o json --approval-mode plan </dev/null > out.json 2>err.log
echo "exit=$?"; head -c 1500 out.json
```

- [ ] **Step 2: Record** `docs/superpowers/spikes/M2/SM2-1-gemini-headless.md`:
  - Confirm outer shape `{ response: string, stats.models.<m>.tokens.{prompt,candidates,total} }`.
  - Confirm `JSON.parse(outer.response)` (after stripping any ```json fences) yields `{verdict, findings:[…]}`.
  - Note the default model name observed (e.g. `gemini-3.1-pro-preview`) and that `-m` overrides it.
  - Confirm `GEMINI_CLI_TRUST_WORKSPACE=true` is required (exit 55 without it).

**Pass criteria:** the `response` string parses to the review-shape on ≥ 4 of 5 trials. If flakier, the GeminiAdapter's tolerant parser (fence-strip + first-`{`-to-last-`}` slice) is the fallback.

### Spike SM2-2: Claude-as-reviewer, OAuth, safe (informs Task 5 + Task 9)

- [ ] **Step 1: Confirm OAuth works non-bare and produces JSON**

```bash
mkdir -p /tmp/rg-sm2-2 && cd /tmp/rg-sm2-2
printf 'export function compareToken(a:string,b:string){return a==b;}\n' > foo.ts
claude -p 'You are a hostile security reviewer. Review foo.ts. Output ONLY JSON {"verdict":"PASS|FAIL","findings":[{"severity":"CRITICAL|WARN|INFO","category":"security","rule_id":"...","file":"...","line":1,"message":"...","details":"...","confidence":0.0}]}.' \
  --model claude-sonnet-4-6 \
  --output-format json \
  --disallowedTools "Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,TodoWrite,Task" \
  --permission-mode dontAsk </dev/null > out.json 2>err.log
echo "exit=$?"; head -c 1500 out.json
```

- [ ] **Step 2: Confirm the result JSON shape.** `--output-format json` returns an envelope (commonly `{ "type":"result", "result":"<assistant text>", "total_cost_usd":…, "usage":{…}, "session_id":… }`). Record the EXACT top-level keys and which one holds the assistant's text (the review JSON). The adapter parses that field then tolerant-parses the review-shape inside.

- [ ] **Step 3: Confirm tool restriction.** Ask it to write a file:

```bash
claude -p 'Write the text HACKED to ./hacked.txt' --model claude-sonnet-4-6 \
  --disallowedTools "Bash,Edit,Write,MultiEdit,NotebookEdit" --permission-mode dontAsk </dev/null
ls hacked.txt 2>&1 || echo "NO HACKED FILE — restriction works"
```

- [ ] **Step 4: Confirm anti-recursion.** Create a `.claude/settings.json` in the temp dir with a Stop hook that writes a sentinel file; run `claude -p` in that dir; verify whether the Stop hook fires. This tells us whether the adapter MUST run the reviewer in a hook-free temp CWD (expected: yes).

- [ ] **Step 5: Record** `docs/superpowers/spikes/M2/SM2-2-claude-reviewer.md`: exact JSON envelope key for the text, whether OAuth was used (no `ANTHROPIC_API_KEY` set, still works), whether tools were blocked, whether Stop hooks fire non-bare, and the chosen safe-invocation recipe.

**Pass criteria:** OAuth review works non-bare AND file-writes are blocked AND a hook-free temp CWD prevents recursion. If non-bare cannot be made safe, fall back to `--bare` + `ANTHROPIC_API_KEY` and document the cost implication.

### Spike SM2-3: OpenRouter any-model (informs Task 6)

- [ ] **Step 1: Real call (needs `OPENROUTER_API_KEY`)**

```bash
export OPENROUTER_API_KEY=...   # user-provided
curl -s https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "google/gemini-2.0-flash-001",
    "messages": [{"role":"user","content":"Output ONLY JSON {\"verdict\":\"FAIL\",\"findings\":[{\"severity\":\"CRITICAL\",\"category\":\"security\",\"rule_id\":\"x\",\"file\":\"foo.ts\",\"line\":1,\"message\":\"m\",\"details\":\"d\",\"confidence\":0.9}]} for: a==b token compare"}],
    "response_format": {"type":"json_schema","json_schema":{"name":"review","strict":true,"schema":{"type":"object","additionalProperties":false,"required":["verdict","findings"],"properties":{"verdict":{"type":"string","enum":["PASS","FAIL"]},"findings":{"type":"array","items":{"type":"object","additionalProperties":false,"required":["severity","category","rule_id","file","line","message","details","confidence"],"properties":{"severity":{"type":"string"},"category":{"type":"string"},"rule_id":{"type":"string"},"file":{"type":"string"},"line":{"type":"integer"},"message":{"type":"string"},"details":{"type":"string"},"confidence":{"type":"number"}}}}}}}}' | head -c 1500
```

- [ ] **Step 2: Record** `docs/superpowers/spikes/M2/SM2-3-openrouter.md`: confirm response shape `{ choices:[{message:{content:"<json string>"}}], usage:{prompt_tokens,completion_tokens} }`; whether `response_format json_schema` is honored for the given model (some models ignore it → tolerant parse fallback); note that the model name is passed through verbatim.

**Pass criteria:** a chat completion with `response_format` returns the review-shape in `choices[0].message.content`. If a model ignores `response_format`, the tolerant parser recovers it.

**After all spikes:** write `docs/superpowers/spikes/M2/SUMMARY.md` and commit before Task 1.

---

## Phase 1 — Shared review-output mapping

### Task 1: `review-output.ts` (shape + mapping), refactor Codex to use it

**Files:**
- Create: `src/providers/review-output.ts`
- Modify: `src/providers/codex.ts` (replace inline schema + extractFindings mapping with the shared module)
- Test: `tests/unit/review-output.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/review-output.test.ts
import { describe, expect, it } from "bun:test";
import {
  REVIEW_OUTPUT_SCHEMA,
  parseReviewOutput,
  mapReviewOutputToFindings,
} from "../../src/providers/review-output.ts";

describe("review-output", () => {
  it("exposes a strict all-required JSON schema", () => {
    const items = REVIEW_OUTPUT_SCHEMA.properties.findings.items;
    expect(items.required).toEqual([
      "severity",
      "category",
      "rule_id",
      "file",
      "line",
      "message",
      "details",
      "confidence",
    ]);
    expect(items.additionalProperties).toBe(false);
  });

  it("parses a clean JSON string", () => {
    const r = parseReviewOutput('{"verdict":"FAIL","findings":[]}');
    expect(r?.verdict).toBe("FAIL");
  });

  it("strips ```json fences and surrounding prose before parsing", () => {
    const r = parseReviewOutput('here:\n```json\n{"verdict":"PASS","findings":[]}\n```\nthanks');
    expect(r?.verdict).toBe("PASS");
  });

  it("returns null on unrecoverable garbage", () => {
    expect(parseReviewOutput("not json at all")).toBeNull();
  });

  it("maps review findings into Finding with stable ids, signatures, pinned reviewer", () => {
    const findings = mapReviewOutputToFindings(
      {
        verdict: "FAIL",
        findings: [
          {
            severity: "CRITICAL",
            category: "security",
            rule_id: "insecure-compare",
            file: "/repo/src/auth.ts",
            line: 5,
            message: "m",
            details: "d",
            confidence: 0.9,
          },
        ],
      },
      { provider: "gemini", model: "gemini-3-pro", persona: "architecture", workingDir: "/repo" },
    );
    expect(findings.length).toBe(1);
    expect(findings[0]!.id).toBe("F-001");
    expect(findings[0]!.file).toBe("src/auth.ts"); // relativized
    expect(findings[0]!.reviewer.provider).toBe("gemini");
    expect(findings[0]!.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(findings[0]!.consensus).toBe("singleton");
  });

  it("drops findings whose severity/category fail the Finding schema", () => {
    const findings = mapReviewOutputToFindings(
      {
        verdict: "FAIL",
        findings: [{ severity: "BOGUS", category: "x", rule_id: "r", file: "a.ts", line: 1, message: "m", details: "d", confidence: 0.5 } as never],
      },
      { provider: "codex", model: "m", persona: "security", workingDir: "/repo" },
    );
    expect(findings.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/review-output.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/providers/review-output.ts
import { isAbsolute, relative } from "node:path";
import { computeSignature } from "../diff/signature.ts";
import { type Finding, type FindingCategory, FindingSchema } from "../schemas/finding.ts";

// Strict JSON Schema for providers that support structured output (Codex
// --output-schema, OpenRouter response_format). OpenAI strict mode requires
// every property in `required` and additionalProperties:false at each level.
export const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings"],
  properties: {
    verdict: { type: "string", enum: ["PASS", "FAIL"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["severity", "category", "rule_id", "file", "line", "message", "details", "confidence"],
        properties: {
          severity: { type: "string", enum: ["CRITICAL", "WARN", "INFO"] },
          category: {
            type: "string",
            enum: ["security", "correctness", "quality", "architecture", "performance", "testing", "docs"],
          },
          rule_id: { type: "string" },
          file: { type: "string" },
          line: { type: "integer" },
          message: { type: "string" },
          details: { type: "string" },
          confidence: { type: "number" },
        },
      },
    },
  },
} as const;

export interface ReviewFinding {
  severity: "CRITICAL" | "WARN" | "INFO";
  category: string;
  rule_id: string;
  file: string;
  line: number;
  message: string;
  details: string;
  confidence: number;
}

export interface ReviewOutput {
  verdict: "PASS" | "FAIL";
  findings: ReviewFinding[];
}

// Tolerant parse: accepts clean JSON, ```json-fenced JSON, or JSON embedded in
// prose. Returns null if no JSON object with a `findings` array can be found.
export function parseReviewOutput(text: string): ReviewOutput | null {
  const tryParse = (s: string): ReviewOutput | null => {
    try {
      const o = JSON.parse(s) as Partial<ReviewOutput>;
      if (Array.isArray(o.findings)) {
        return { verdict: o.verdict === "PASS" ? "PASS" : "FAIL", findings: o.findings as ReviewFinding[] };
      }
    } catch {
      // fall through
    }
    return null;
  };
  const direct = tryParse(text.trim());
  if (direct) return direct;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    const f = tryParse(fence[1].trim());
    if (f) return f;
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const sliced = tryParse(text.slice(first, last + 1));
    if (sliced) return sliced;
  }
  return null;
}

export interface MapContext {
  provider: string;
  model: string;
  persona: string;
  workingDir: string;
}

export function mapReviewOutputToFindings(out: ReviewOutput, ctx: MapContext): Finding[] {
  const result: Finding[] = [];
  let n = 0;
  for (const cf of out.findings) {
    if (
      typeof cf?.severity !== "string" ||
      typeof cf?.category !== "string" ||
      typeof cf?.file !== "string" ||
      typeof cf?.line !== "number" ||
      typeof cf?.message !== "string"
    ) {
      continue;
    }
    n += 1;
    const file = isAbsolute(cf.file) ? relative(ctx.workingDir, cf.file) || cf.file : cf.file;
    const line = Math.max(1, Math.trunc(cf.line));
    const candidate = {
      id: `F-${String(n).padStart(3, "0")}`,
      signature: computeSignature({
        file,
        ruleId: cf.rule_id ?? cf.severity,
        category: cf.category as FindingCategory,
        lineStart: line,
        lineEnd: line,
      }),
      severity: cf.severity,
      category: cf.category,
      rule_id: cf.rule_id && cf.rule_id.length > 0 ? cf.rule_id : "unspecified",
      file,
      line_start: line,
      line_end: line,
      message: cf.message.slice(0, 200),
      details: (cf.details ?? cf.message).slice(0, 2000),
      reviewer: { provider: ctx.provider, model: ctx.model, persona: ctx.persona },
      confidence: typeof cf.confidence === "number" ? Math.min(1, Math.max(0, cf.confidence)) : 0.7,
      consensus: "singleton" as const,
    };
    const parsed = FindingSchema.safeParse(candidate);
    if (parsed.success) result.push(parsed.data);
  }
  return result;
}
```

- [ ] **Step 4: Refactor `codex.ts`** to import `REVIEW_OUTPUT_SCHEMA`, `parseReviewOutput`, and `mapReviewOutputToFindings` instead of its private copies. Replace the inline `REVIEW_OUTPUT_SCHEMA`, the `CodexFinding` interface, and the body of `extractFindings` with:

```ts
// inside CodexAdapter.extractFindings(lastMsgFile, model, persona, workingDir):
let raw: string;
try {
  raw = readFileSync(lastMsgFile, "utf8");
} catch {
  return [];
}
const out = parseReviewOutput(raw);
if (!out) return [];
return mapReviewOutputToFindings(out, { provider: "codex", model, persona, workingDir });
```

Remove the now-unused `computeSignature`, `FindingSchema`, `FindingCategory`, `isAbsolute`, `relative` imports from `codex.ts` (they live in `review-output.ts` now). Keep `writeFileSync(schemaPath, JSON.stringify(REVIEW_OUTPUT_SCHEMA))`.

- [ ] **Step 5: Run review-output + the existing codex-adapter test (must still pass)**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/review-output.test.ts tests/unit/codex-adapter.test.ts
```

- [ ] **Step 6: typecheck + commit**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun run typecheck && bun run lint
git add src/providers/review-output.ts src/providers/codex.ts tests/unit/review-output.test.ts
git commit -m "refactor(providers): shared review-output schema + mapping; codex reuses it"
```

---

## Phase 2 — Gemini adapter

### Task 2: GeminiAdapter

**Files:**
- Create: `src/providers/gemini.ts`
- Create: `tests/fixtures/fake-gemini.sh`
- Test: `tests/unit/gemini-adapter.test.ts`

The Gemini CLI buffers output (like codex) and needs `GEMINI_CLI_TRUST_WORKSPACE=true`. Output is `{ response: "<text>", stats: { models: { <m>: { tokens: { prompt, candidates } } } } }`. We pass the persona+instructions+sanitised diff as the `-p` prompt and parse `response` with `parseReviewOutput`.

- [ ] **Step 1: Create the fake fixture (mirrors real shape)**

```bash
mkdir -p tests/fixtures
cat > tests/fixtures/fake-gemini.sh <<'SH'
#!/usr/bin/env bash
# Fake gemini: emits the real outer JSON envelope with a `response` string
# containing the review-shape JSON, and a stats.models.tokens block.
set -u
cat <<'JSON'
{
  "session_id": "fake",
  "response": "{\"verdict\":\"FAIL\",\"findings\":[{\"severity\":\"WARN\",\"category\":\"security\",\"rule_id\":\"gem-rule\",\"file\":\"x.ts\",\"line\":1,\"message\":\"gemini finding\",\"details\":\"d\",\"confidence\":0.8}]}",
  "stats": { "models": { "gemini-3-pro": { "tokens": { "prompt": 200, "candidates": 30, "total": 230, "cached": 0 } } } }
}
JSON
exit 0
SH
chmod +x tests/fixtures/fake-gemini.sh
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/gemini-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiAdapter } from "../../src/providers/gemini.ts";

const FAKE = join(process.cwd(), "tests/fixtures/fake-gemini.sh");

describe("GeminiAdapter (mocked)", () => {
  it("parses findings + usage from the response envelope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-gem-"));
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    const adapter = new GeminiAdapter({ binPath: FAKE });
    const res = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "gemini-3-pro", timeoutMs: 60_000 },
      reviewerId: "gemini-architecture",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "architecture",
      diffPath: join(dir, "d.patch"),
    });
    expect(res.status).toBe("ok");
    expect(res.findings.length).toBe(1);
    expect(res.findings[0]!.reviewer.provider).toBe("gemini");
    expect(res.usage.inputTokens).toBe(200);
    expect(res.usage.outputTokens).toBe(30);
  });
});
```

- [ ] **Step 3: Run, expect fail**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/gemini-adapter.test.ts
```

- [ ] **Step 4: Implement**

```ts
// src/providers/gemini.ts
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSafely } from "../utils/spawn.ts";
import type { Finding } from "../schemas/finding.ts";
import { mapReviewOutputToFindings, parseReviewOutput } from "./review-output.ts";
import type {
  Preflight,
  ProviderAdapter,
  ProviderConfig,
  ReviewInput,
  ReviewResult,
  ReviewStatus,
} from "./adapter-base.ts";

export interface GeminiAdapterOptions {
  binPath?: string;
}

interface GeminiEnvelope {
  response?: string;
  stats?: { models?: Record<string, { tokens?: { prompt?: number; candidates?: number; cached?: number } }> };
}

export class GeminiAdapter implements ProviderAdapter {
  readonly id = "gemini" as const;
  private readonly binPath: string;
  constructor(opts: GeminiAdapterOptions = {}) {
    this.binPath = opts.binPath ?? "gemini";
  }

  async preflight(cfg: ProviderConfig): Promise<Preflight> {
    const tmp = mkdtempSync(join(tmpdir(), "rg-gem-pf-"));
    try {
      const res = await spawnSafely({
        command: this.binPath,
        args: ["--version"],
        stdoutFile: join(tmp, "o"),
        stderrFile: join(tmp, "e"),
        timeoutMs: 5_000,
      });
      if (res.exitCode !== 0) return { available: false, version: null, authMode: cfg.auth, error: `gemini --version exit=${res.exitCode}` };
      return { available: true, version: readFileSync(join(tmp, "o"), "utf8").trim(), authMode: cfg.auth, error: null };
    } catch (err) {
      return { available: false, version: null, authMode: cfg.auth, error: (err as Error).message };
    }
  }

  async review(input: ReviewInput & { cfg: ProviderConfig; reviewerId: string }): Promise<ReviewResult> {
    const run = mkdtempSync(join(tmpdir(), "rg-gem-run-"));
    const outFile = join(run, "out.json");
    const errFile = join(run, "err.log");
    const args = [
      "-p",
      readFileSync(input.promptFile, "utf8"),
      "-m",
      input.cfg.model,
      "-o",
      "json",
      "--approval-mode",
      "plan",
      "--include-directories",
      input.workingDir,
    ];
    const env = { ...process.env, GEMINI_CLI_TRUST_WORKSPACE: "true" } as Record<string, string>;
    if (input.cfg.auth === "apikey" && input.cfg.apiKeyEnv) {
      const key = process.env[input.cfg.apiKeyEnv];
      if (key) env.GEMINI_API_KEY = key;
    }
    const res = await spawnSafely({
      command: this.binPath,
      args,
      env,
      cwd: input.workingDir,
      stdoutFile: outFile,
      stderrFile: errFile,
      timeoutMs: input.cfg.timeoutMs,
    });
    const status: ReviewStatus = res.killedByTimeout || res.killedByWatchdog ? "timeout" : res.exitCode === 0 ? "ok" : "error";
    if (status !== "ok") {
      return {
        reviewerId: input.reviewerId,
        verdict: "ERROR",
        findings: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
        durationMs: res.durationMs,
        exitCode: res.exitCode,
        rawEventsPath: outFile,
        status,
        statusDetail: readFileSync(errFile, "utf8").slice(0, 1000),
      };
    }
    const { findings, usage } = this.parse(outFile, input.cfg.model, input.persona, input.workingDir);
    return {
      reviewerId: input.reviewerId,
      verdict: findings.some((f) => f.severity === "CRITICAL" || f.severity === "WARN") ? "FAIL" : "PASS",
      findings,
      usage,
      durationMs: res.durationMs,
      exitCode: 0,
      rawEventsPath: outFile,
      status: "ok",
    };
  }

  private parse(outFile: string, model: string, persona: string, workingDir: string): { findings: Finding[]; usage: ReviewResult["usage"] } {
    let env: GeminiEnvelope = {};
    try {
      env = JSON.parse(readFileSync(outFile, "utf8")) as GeminiEnvelope;
    } catch {
      return { findings: [], usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null } };
    }
    const out = env.response ? parseReviewOutput(env.response) : null;
    const findings = out ? mapReviewOutputToFindings(out, { provider: "gemini", model, persona, workingDir }) : [];
    let inputTokens = 0;
    let outputTokens = 0;
    for (const m of Object.values(env.stats?.models ?? {})) {
      inputTokens += m.tokens?.prompt ?? 0;
      outputTokens += m.tokens?.candidates ?? 0;
    }
    return { findings, usage: { inputTokens, outputTokens, costUsd: 0, quotaUsedPct: null } };
  }
}
```

- [ ] **Step 5: Pass + typecheck + commit**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/gemini-adapter.test.ts && bun run typecheck && bun run lint
git add src/providers/gemini.ts tests/fixtures/fake-gemini.sh tests/unit/gemini-adapter.test.ts
git commit -m "feat(providers): Gemini adapter (OAuth headless, tolerant JSON parse)"
```

---

## Phase 3 — Claude-as-reviewer adapter

### Task 3: ClaudeAdapter (OAuth, non-bare, safe temp CWD, tier-downgraded)

**Files:**
- Create: `src/providers/claude.ts`
- Create: `tests/fixtures/fake-claude.sh`
- Test: `tests/unit/claude-adapter.test.ts`

Per Spike SM2-2, run `claude -p` NON-bare (OAuth) with `--output-format json`, `--disallowedTools`, `--permission-mode dontAsk`, and **cwd = a hook-free temp dir** so the reviewer's own Stop hook cannot recurse into Reviewgate. The diff is provided in the prompt; the adapter does not run inside the target repo. The model tier is chosen by the caller (Orchestrator) from `host-model.ts` — the adapter just receives `cfg.model`. Parse the envelope's text field (key confirmed in SM2-2; the implementation uses `result` with a fallback scan) then `parseReviewOutput`.

- [ ] **Step 1: Create the fake fixture**

```bash
cat > tests/fixtures/fake-claude.sh <<'SH'
#!/usr/bin/env bash
# Fake claude -p --output-format json: emits the result envelope with the
# review-shape JSON inside `result`, plus a usage block.
set -u
cat <<'JSON'
{
  "type": "result",
  "subtype": "success",
  "result": "{\"verdict\":\"FAIL\",\"findings\":[{\"severity\":\"CRITICAL\",\"category\":\"correctness\",\"rule_id\":\"cl-rule\",\"file\":\"x.ts\",\"line\":1,\"message\":\"claude finding\",\"details\":\"d\",\"confidence\":0.92}]}",
  "total_cost_usd": 0,
  "usage": { "input_tokens": 300, "output_tokens": 40 },
  "session_id": "fake"
}
JSON
exit 0
SH
chmod +x tests/fixtures/fake-claude.sh
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/claude-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../../src/providers/claude.ts";

const FAKE = join(process.cwd(), "tests/fixtures/fake-claude.sh");

describe("ClaudeAdapter (mocked)", () => {
  it("parses findings + usage from the result envelope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-cl-"));
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    const adapter = new ClaudeAdapter({ binPath: FAKE });
    const res = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "claude-sonnet-4-6", timeoutMs: 60_000 },
      reviewerId: "claude-adversarial",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "adversarial",
      diffPath: join(dir, "d.patch"),
    });
    expect(res.status).toBe("ok");
    expect(res.findings.length).toBe(1);
    expect(res.findings[0]!.reviewer.provider).toBe("claude-code");
    expect(res.usage.inputTokens).toBe(300);
    expect(res.usage.outputTokens).toBe(40);
  });
});
```

- [ ] **Step 3: Run, expect fail**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/claude-adapter.test.ts
```

- [ ] **Step 4: Implement**

```ts
// src/providers/claude.ts
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSafely } from "../utils/spawn.ts";
import type { Finding } from "../schemas/finding.ts";
import { mapReviewOutputToFindings, parseReviewOutput } from "./review-output.ts";
import type {
  Preflight,
  ProviderAdapter,
  ProviderConfig,
  ReviewInput,
  ReviewResult,
  ReviewStatus,
} from "./adapter-base.ts";

const DISALLOWED = "Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,TodoWrite,Task";

export interface ClaudeAdapterOptions {
  binPath?: string;
}

interface ClaudeEnvelope {
  result?: string;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  total_cost_usd?: number;
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly id = "claude-code" as const;
  private readonly binPath: string;
  constructor(opts: ClaudeAdapterOptions = {}) {
    this.binPath = opts.binPath ?? "claude";
  }

  async preflight(cfg: ProviderConfig): Promise<Preflight> {
    const tmp = mkdtempSync(join(tmpdir(), "rg-cl-pf-"));
    try {
      const res = await spawnSafely({
        command: this.binPath,
        args: ["--version"],
        stdoutFile: join(tmp, "o"),
        stderrFile: join(tmp, "e"),
        timeoutMs: 5_000,
      });
      if (res.exitCode !== 0) return { available: false, version: null, authMode: cfg.auth, error: `claude --version exit=${res.exitCode}` };
      return { available: true, version: readFileSync(join(tmp, "o"), "utf8").trim(), authMode: cfg.auth, error: null };
    } catch (err) {
      return { available: false, version: null, authMode: cfg.auth, error: (err as Error).message };
    }
  }

  async review(input: ReviewInput & { cfg: ProviderConfig; reviewerId: string }): Promise<ReviewResult> {
    // Run in a hook-free temp CWD so the reviewer's own Stop hook can never
    // recurse into Reviewgate. The diff is supplied via the prompt, so the
    // reviewer does not need the real repo tree.
    const run = mkdtempSync(join(tmpdir(), "rg-cl-run-"));
    const outFile = join(run, "out.json");
    const errFile = join(run, "err.log");

    const args = [
      "-p",
      readFileSync(input.promptFile, "utf8"),
      "--model",
      input.cfg.model,
      "--output-format",
      "json",
      "--disallowedTools",
      DISALLOWED,
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
    ];
    // OAuth (non-bare) inherits the user's logged-in session; no env injection.
    const env = { ...process.env } as Record<string, string>;
    if (input.cfg.auth === "apikey" && input.cfg.apiKeyEnv) {
      const key = process.env[input.cfg.apiKeyEnv];
      if (key) env.ANTHROPIC_API_KEY = key;
    }
    const res = await spawnSafely({
      command: this.binPath,
      args,
      env,
      cwd: run, // hook-free temp dir
      stdoutFile: outFile,
      stderrFile: errFile,
      timeoutMs: input.cfg.timeoutMs,
    });
    const status: ReviewStatus = res.killedByTimeout || res.killedByWatchdog ? "timeout" : res.exitCode === 0 ? "ok" : "error";
    if (status !== "ok") {
      return {
        reviewerId: input.reviewerId,
        verdict: "ERROR",
        findings: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
        durationMs: res.durationMs,
        exitCode: res.exitCode,
        rawEventsPath: outFile,
        status,
        statusDetail: readFileSync(errFile, "utf8").slice(0, 1000),
      };
    }
    const { findings, usage } = this.parse(outFile, input.cfg.model, input.persona, input.workingDir);
    return {
      reviewerId: input.reviewerId,
      verdict: findings.some((f) => f.severity === "CRITICAL" || f.severity === "WARN") ? "FAIL" : "PASS",
      findings,
      usage,
      durationMs: res.durationMs,
      exitCode: 0,
      rawEventsPath: outFile,
      status: "ok",
    };
  }

  private parse(outFile: string, model: string, persona: string, workingDir: string): { findings: Finding[]; usage: ReviewResult["usage"] } {
    let env: ClaudeEnvelope = {};
    let rawText = "";
    try {
      rawText = readFileSync(outFile, "utf8");
      env = JSON.parse(rawText) as ClaudeEnvelope;
    } catch {
      env = {};
    }
    // Prefer the documented `result` field; fall back to the whole file text.
    const text = env.result ?? rawText;
    const out = parseReviewOutput(text);
    const findings = out ? mapReviewOutputToFindings(out, { provider: "claude-code", model, persona, workingDir }) : [];
    return {
      findings,
      usage: {
        inputTokens: env.usage?.input_tokens ?? 0,
        outputTokens: env.usage?.output_tokens ?? 0,
        costUsd: 0,
        quotaUsedPct: null,
      },
    };
  }
}
```

Note: `cpSync` import is reserved for a future "stage changed files into temp CWD" enhancement; if biome flags it as unused, remove it. M2 supplies the diff via prompt only.

- [ ] **Step 5: Pass + typecheck + commit**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/claude-adapter.test.ts && bun run typecheck && bun run lint
git add src/providers/claude.ts tests/fixtures/fake-claude.sh tests/unit/claude-adapter.test.ts
git commit -m "feat(providers): Claude-as-reviewer adapter (OAuth non-bare, hook-free temp cwd)"
```

---

## Phase 4 — OpenRouter adapter (any model by name)

### Task 4: OpenRouterAdapter

**Files:**
- Create: `src/providers/openrouter.ts`
- Test: `tests/unit/openrouter-adapter.test.ts`

Direct HTTPS to OpenAI-compatible `/chat/completions` with `response_format` json_schema (the shared `REVIEW_OUTPUT_SCHEMA`). The user configures only the model name + API-key env var. The adapter is injected with a `fetchImpl` for testing (no real network in unit tests).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/openrouter-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenRouterAdapter } from "../../src/providers/openrouter.ts";

function fakeFetch(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                '{"verdict":"FAIL","findings":[{"severity":"WARN","category":"quality","rule_id":"or-rule","file":"x.ts","line":1,"message":"or finding","details":"d","confidence":0.7}]}',
            },
          },
        ],
        usage: { prompt_tokens: 150, completion_tokens: 25 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

describe("OpenRouterAdapter (mocked fetch)", () => {
  it("sends model + schema and maps the response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-or-"));
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    process.env.OPENROUTER_API_KEY = "test-key";
    const adapter = new OpenRouterAdapter({ fetchImpl: fakeFetch() });
    const res = await adapter.review({
      cfg: { enabled: true, auth: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", model: "google/gemini-3.5-flash", timeoutMs: 60_000 },
      reviewerId: "openrouter-security",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "security",
      diffPath: join(dir, "d.patch"),
    });
    expect(res.status).toBe("ok");
    expect(res.findings.length).toBe(1);
    expect(res.findings[0]!.reviewer.model).toBe("google/gemini-3.5-flash");
    expect(res.usage.inputTokens).toBe(150);
    expect(res.usage.outputTokens).toBe(25);
  });

  it("returns ERROR + abstains when the API key env is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-or2-"));
    writeFileSync(join(dir, "prompt.txt"), "x");
    process.env.OPENROUTER_API_KEY = "";
    const adapter = new OpenRouterAdapter({ fetchImpl: fakeFetch() });
    const res = await adapter.review({
      cfg: { enabled: true, auth: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", model: "x/y", timeoutMs: 1000 },
      reviewerId: "openrouter-security",
      promptFile: join(dir, "prompt.txt"),
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "security",
      diffPath: join(dir, "d.patch"),
    });
    expect(res.status).toBe("error");
    expect(res.verdict).toBe("ERROR");
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/openrouter-adapter.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/providers/openrouter.ts
import { readFileSync } from "node:fs";
import type { Finding } from "../schemas/finding.ts";
import { REVIEW_OUTPUT_SCHEMA, mapReviewOutputToFindings, parseReviewOutput } from "./review-output.ts";
import type {
  Preflight,
  ProviderAdapter,
  ProviderConfig,
  ReviewInput,
  ReviewResult,
} from "./adapter-base.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterAdapterOptions {
  fetchImpl?: typeof fetch;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class OpenRouterAdapter implements ProviderAdapter {
  readonly id = "openrouter" as const;
  private readonly fetchImpl: typeof fetch;
  constructor(opts: OpenRouterAdapterOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async preflight(cfg: ProviderConfig): Promise<Preflight> {
    const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
    if (!key) return { available: false, version: null, authMode: "openrouter", error: `env ${cfg.apiKeyEnv} not set` };
    return { available: true, version: "openrouter-v1", authMode: "openrouter", error: null };
  }

  async review(input: ReviewInput & { cfg: ProviderConfig; reviewerId: string }): Promise<ReviewResult> {
    const start = Date.now();
    const key = input.cfg.apiKeyEnv ? process.env[input.cfg.apiKeyEnv] : undefined;
    const errorResult = (detail: string): ReviewResult => ({
      reviewerId: input.reviewerId,
      verdict: "ERROR",
      findings: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
      durationMs: Date.now() - start,
      exitCode: -1,
      rawEventsPath: "",
      status: "error",
      statusDetail: detail.slice(0, 1000),
    });
    if (!key) return errorResult(`OpenRouter API key env '${input.cfg.apiKeyEnv}' is not set`);

    const prompt = readFileSync(input.promptFile, "utf8");
    const body = {
      model: input.cfg.model,
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "review", strict: true, schema: REVIEW_OUTPUT_SCHEMA },
      },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.cfg.timeoutMs);
    let json: ChatResponse;
    try {
      const resp = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) return errorResult(`OpenRouter HTTP ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
      json = (await resp.json()) as ChatResponse;
    } catch (err) {
      return errorResult(`OpenRouter request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (json.error?.message) return errorResult(`OpenRouter error: ${json.error.message}`);

    const content = json.choices?.[0]?.message?.content ?? "";
    const out = parseReviewOutput(content);
    const findings: Finding[] = out
      ? mapReviewOutputToFindings(out, {
          provider: "openrouter",
          model: input.cfg.model,
          persona: input.persona,
          workingDir: input.workingDir,
        })
      : [];
    return {
      reviewerId: input.reviewerId,
      verdict: findings.some((f) => f.severity === "CRITICAL" || f.severity === "WARN") ? "FAIL" : "PASS",
      findings,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
        costUsd: 0,
        quotaUsedPct: null,
      },
      durationMs: Date.now() - start,
      exitCode: 0,
      rawEventsPath: "",
      status: "ok",
    };
  }
}
```

- [ ] **Step 4: Allow `'openrouter'` as a ProviderAdapter id.** In `src/providers/adapter-base.ts`, the `ProviderAdapter.id` union is `'codex' | 'claude-code' | 'gemini' | 'opencode'`. Replace `'opencode'` with `'openrouter'` (opencode is not used in M2):

```ts
export interface ProviderAdapter {
  readonly id: "codex" | "claude-code" | "gemini" | "openrouter";
  preflight(cfg: ProviderConfig): Promise<Preflight>;
  review(input: ReviewInput & { cfg: ProviderConfig; reviewerId: string }): Promise<ReviewResult>;
}
```

- [ ] **Step 5: Pass + typecheck + commit**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/openrouter-adapter.test.ts && bun run typecheck && bun run lint
git add src/providers/openrouter.ts src/providers/adapter-base.ts tests/unit/openrouter-adapter.test.ts
git commit -m "feat(providers): OpenRouter adapter — any model by name via response_format"
```

---

## Phase 5 — Config: multi-reviewer panel + provider auth

### Task 5: Extend config schema + defaults

**Files:**
- Modify: `src/config/defaults.ts`, `src/config/define-config.ts`
- Test: `tests/unit/config-loader.test.ts` (extend)

M2 config supports up to four providers and a `phases.review.reviewers` list of `{provider, persona, model?}` plus an optional `phases.critic`. The downgrade for `claude-code` host-tier collisions is applied at runtime (Task 8), not in config.

- [ ] **Step 1: Add the failing test (append to existing file)**

```ts
// tests/unit/config-loader.test.ts  (add inside the existing describe)
import { defineConfig } from "../../src/config/define-config.ts";

it("accepts a multi-reviewer panel with gemini + claude + openrouter", () => {
  const cfg = defineConfig({
    providers: {
      gemini: { enabled: true, auth: "oauth", model: "gemini-3-pro", timeoutMs: 300_000 },
      "claude-code": { enabled: true, auth: "oauth", model: "claude-sonnet-4-6", timeoutMs: 300_000 },
      openrouter: { enabled: true, auth: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", model: "google/gemini-3.5-flash", timeoutMs: 300_000 },
    },
    phases: {
      review: {
        reviewers: [
          { provider: "codex", persona: "security" },
          { provider: "gemini", persona: "architecture" },
          { provider: "claude-code", persona: "adversarial" },
          { provider: "openrouter", persona: "security" },
        ],
      },
      critic: { provider: "gemini", model: "gemini-3-flash", persona: "fp-filter" },
    },
  });
  expect(cfg.phases.review.reviewers.length).toBe(4);
  expect(cfg.providers.gemini?.enabled).toBe(true);
  expect(cfg.phases.critic?.provider).toBe("gemini");
});

it("rejects an unknown provider in reviewers", () => {
  expect(() =>
    defineConfig({ phases: { review: { reviewers: [{ provider: "bogus" as never, persona: "x" }] } } }),
  ).toThrow();
});
```

- [ ] **Step 2: Run, expect fail**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/config-loader.test.ts
```

- [ ] **Step 3: Update `defaults.ts`** — make all four providers present (codex enabled, others disabled by default), and add the critic default:

```ts
// src/config/defaults.ts  (replace providers + phases blocks)
  providers: {
    codex: { enabled: true, auth: "oauth" as const, model: "gpt-5.4", timeoutMs: 300_000 },
    gemini: { enabled: false, auth: "oauth" as const, model: "gemini-3-pro", timeoutMs: 300_000 },
    "claude-code": { enabled: false, auth: "oauth" as const, model: "claude-sonnet-4-6", timeoutMs: 300_000 },
    openrouter: {
      enabled: false,
      auth: "openrouter" as const,
      apiKeyEnv: "OPENROUTER_API_KEY",
      model: "google/gemini-3.5-flash",
      timeoutMs: 300_000,
    },
  },
  phases: {
    review: {
      reviewers: [{ provider: "codex" as const, persona: "security" }],
    },
    critic: null as null | { provider: "codex" | "gemini" | "claude-code" | "openrouter"; model?: string; persona: string },
  },
```

- [ ] **Step 4: Update `define-config.ts` schema** — providers becomes an object of OPTIONAL provider configs (codex required, the rest optional); reviewers `provider` enum includes `openrouter`; add optional `model` per reviewer; add optional `critic`:

```ts
// src/config/define-config.ts  (replace the providers + phases parts of ConfigSchema)
const ProviderId = z.enum(["codex", "gemini", "claude-code", "openrouter"]);

export const ConfigSchema = z.object({
  version: z.literal(1),
  providers: z.object({
    codex: ProviderConfigSchema,
    gemini: ProviderConfigSchema.optional(),
    "claude-code": ProviderConfigSchema.optional(),
    openrouter: ProviderConfigSchema.optional(),
  }),
  phases: z.object({
    review: z.object({
      reviewers: z
        .array(z.object({ provider: ProviderId, persona: z.string(), model: z.string().optional() }))
        .min(1),
    }),
    critic: z
      .object({ provider: ProviderId, model: z.string().optional(), persona: z.string() })
      .nullable()
      .default(null),
  }),
  // ...loop, sandbox, audit, output unchanged
  loop: /* unchanged */ z.object({
    maxIterations: z.number().int().positive(),
    costCapUsd: z.number().nonnegative(),
    stuckThreshold: z.number().int().positive(),
    rejectRateEscalation: z.number().min(0).max(1),
    softPassPolicy: z.enum(["allow", "block", "ask-once"]),
  }),
  sandbox: z.object({
    mode: z.enum(["strict", "permissive", "off"]),
    writablePaths: z.array(z.string()),
    deniedReads: z.array(z.string()),
  }),
  audit: z.object({
    retentionDays: z.number().int().positive(),
    compressAfterDays: z.number().int().positive(),
    remoteExporter: z.string().nullable(),
  }),
  output: z.object({ pendingPath: z.string(), pendingJsonPath: z.string() }),
});
```

Keep `deepMerge` and `defineConfig` as-is. (Arrays replace wholesale on merge — documented M1 behavior — so a user-supplied `reviewers` list overrides the default.)

- [ ] **Step 5: Pass + typecheck + commit**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/config-loader.test.ts && bun run typecheck && bun run lint
git add src/config/defaults.ts src/config/define-config.ts tests/unit/config-loader.test.ts
git commit -m "feat(config): multi-reviewer panel + gemini/claude/openrouter providers"
```

---

## Phase 6 — Provider registry

### Task 6: registry.ts (provider id → adapter)

**Files:**
- Create: `src/providers/registry.ts`
- Test: `tests/unit/registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/registry.test.ts
import { describe, expect, it } from "bun:test";
import { createAdapter } from "../../src/providers/registry.ts";
import { CodexAdapter } from "../../src/providers/codex.ts";
import { GeminiAdapter } from "../../src/providers/gemini.ts";
import { ClaudeAdapter } from "../../src/providers/claude.ts";
import { OpenRouterAdapter } from "../../src/providers/openrouter.ts";

describe("createAdapter", () => {
  it("builds the right adapter per provider id", () => {
    expect(createAdapter("codex")).toBeInstanceOf(CodexAdapter);
    expect(createAdapter("gemini")).toBeInstanceOf(GeminiAdapter);
    expect(createAdapter("claude-code")).toBeInstanceOf(ClaudeAdapter);
    expect(createAdapter("openrouter")).toBeInstanceOf(OpenRouterAdapter);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/registry.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/providers/registry.ts
import type { ProviderAdapter } from "./adapter-base.ts";
import { CodexAdapter } from "./codex.ts";
import { GeminiAdapter } from "./gemini.ts";
import { ClaudeAdapter } from "./claude.ts";
import { OpenRouterAdapter } from "./openrouter.ts";

export type ProviderId = "codex" | "gemini" | "claude-code" | "openrouter";

export function createAdapter(id: ProviderId): ProviderAdapter {
  switch (id) {
    case "codex":
      return new CodexAdapter();
    case "gemini":
      return new GeminiAdapter();
    case "claude-code":
      return new ClaudeAdapter();
    case "openrouter":
      return new OpenRouterAdapter();
  }
}
```

- [ ] **Step 4: Pass + typecheck + commit**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/registry.test.ts && bun run typecheck && bun run lint
git add src/providers/registry.ts tests/unit/registry.test.ts
git commit -m "feat(providers): adapter registry"
```

---

## Phase 7 — Critic phase

### Task 7: CriticPhase (demote likely false-positives)

**Files:**
- Create: `src/core/critic.ts`
- Test: `tests/unit/critic.test.ts`

The critic is one extra reviewer call (cheap model) that, given the deduped findings, returns a verdict per finding signature: `keep` or `likely_fp`. Per spec §5.5 the AGGREGATOR applies it (Task 8): a `likely_fp` may DEMOTE one severity level, EXCEPT it can never veto a CRITICAL security/correctness finding or a unanimous-panel finding. The critic itself only classifies.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/critic.test.ts
import { describe, expect, it } from "bun:test";
import { parseCriticOutput } from "../../src/core/critic.ts";

describe("parseCriticOutput", () => {
  it("maps signatures to keep/likely_fp", () => {
    const m = parseCriticOutput(
      '{"verdicts":[{"signature":"sigA","verdict":"likely_fp","reason":"style only"},{"signature":"sigB","verdict":"keep"}]}',
    );
    expect(m.get("sigA")).toEqual({ verdict: "likely_fp", reason: "style only" });
    expect(m.get("sigB")?.verdict).toBe("keep");
  });

  it("returns an empty map on garbage (fail-open: nothing demoted)", () => {
    expect(parseCriticOutput("not json").size).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/critic.test.ts
```

- [ ] **Step 3: Implement** (the prompt builder + the parse; the actual spawn reuses an adapter via the registry, wired in Task 8)

```ts
// src/core/critic.ts
import type { Finding } from "../schemas/finding.ts";

export interface CriticVerdict {
  verdict: "keep" | "likely_fp";
  reason?: string;
}

// Critic output schema (for providers that support it) and prompt.
export const CRITIC_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdicts"],
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["signature", "verdict"],
        properties: {
          signature: { type: "string" },
          verdict: { type: "string", enum: ["keep", "likely_fp"] },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

export function buildCriticPrompt(findings: Finding[]): string {
  const list = findings
    .map((f) => `- signature=${f.signature} [${f.severity}/${f.category}] ${f.file}:${f.line_start} ${f.message}`)
    .join("\n");
  return [
    "You are an adversarial false-positive filter. For each finding below decide",
    "whether to KEEP it (a real issue) or mark it likely_fp (probably a false",
    "positive: stylistic, speculative, or out of scope). You may ONLY demote, never",
    "invent new findings. Output ONLY JSON matching the schema: ",
    '{"verdicts":[{"signature":"<sig>","verdict":"keep|likely_fp","reason":"..."}]}',
    "",
    "Findings:",
    list,
  ].join("\n");
}

export function parseCriticOutput(text: string): Map<string, CriticVerdict> {
  const map = new Map<string, CriticVerdict>();
  let parsed: { verdicts?: Array<{ signature?: string; verdict?: string; reason?: string }> };
  try {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    parsed = JSON.parse(first >= 0 && last > first ? text.slice(first, last + 1) : text) as typeof parsed;
  } catch {
    return map; // fail-open: no demotions
  }
  for (const v of parsed.verdicts ?? []) {
    if (typeof v.signature === "string" && (v.verdict === "keep" || v.verdict === "likely_fp")) {
      map.set(v.signature, { verdict: v.verdict, ...(v.reason ? { reason: v.reason } : {}) });
    }
  }
  return map;
}
```

- [ ] **Step 4: Pass + typecheck + commit**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/critic.test.ts && bun run typecheck && bun run lint
git add src/core/critic.ts tests/unit/critic.test.ts
git commit -m "feat(core): critic phase prompt + output parser (demote-only)"
```

---

## Phase 8 — Aggregator applies critic verdicts

### Task 8: extend `aggregate()` with critic demotion

**Files:**
- Modify: `src/core/aggregator.ts`
- Test: `tests/unit/aggregator-critic.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/aggregator-critic.test.ts
import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function fin(over: Partial<Finding>): Finding {
  return {
    id: "F-x", signature: "s", severity: "WARN", category: "quality", rule_id: "r",
    file: "a.ts", line_start: 1, line_end: 1, message: "m", details: "d",
    reviewer: { provider: "codex", model: "m", persona: "security" }, confidence: 0.5, consensus: "singleton",
    ...over,
  };
}

describe("aggregate with critic", () => {
  it("demotes a likely_fp WARN singleton to INFO → PASS", () => {
    const f = fin({ signature: "sigA", severity: "WARN", category: "quality" });
    const r = aggregate({ findings: [f], reviewersTotal: 1, critic: new Map([["sigA", { verdict: "likely_fp" }]]) });
    expect(r.dedupedFindings[0]!.severity).toBe("INFO");
    expect(r.verdict).toBe("PASS");
  });

  it("never demotes a CRITICAL security finding even if critic says likely_fp", () => {
    const f = fin({ signature: "sigB", severity: "CRITICAL", category: "security" });
    const r = aggregate({ findings: [f], reviewersTotal: 1, critic: new Map([["sigB", { verdict: "likely_fp" }]]) });
    expect(r.dedupedFindings[0]!.severity).toBe("CRITICAL");
    expect(r.verdict).toBe("FAIL");
  });

  it("never demotes a unanimous-panel finding", () => {
    const a = fin({ signature: "sigC", severity: "WARN", reviewer: { provider: "codex", model: "m", persona: "security" } });
    const b = fin({ signature: "sigC", severity: "WARN", reviewer: { provider: "gemini", model: "m", persona: "architecture" } });
    const c = fin({ signature: "sigC", severity: "WARN", reviewer: { provider: "claude-code", model: "m", persona: "adversarial" } });
    const r = aggregate({ findings: [a, b, c], reviewersTotal: 3, critic: new Map([["sigC", { verdict: "likely_fp" }]]) });
    expect(r.dedupedFindings[0]!.severity).toBe("WARN");
    expect(r.dedupedFindings[0]!.consensus).toBe("unanimous");
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/aggregator-critic.test.ts
```

- [ ] **Step 3: Implement** — add an optional `critic` map to `AggregateInput` and apply demotion AFTER consensus is computed, BEFORE counting. Insert into `src/core/aggregator.ts`:

```ts
import type { CriticVerdict } from "./critic.ts";

export interface AggregateInput {
  findings: Finding[];
  reviewersTotal: number;
  critic?: Map<string, CriticVerdict>;
}

const DEMOTE: Record<Finding["severity"], Finding["severity"] | "drop"> = {
  CRITICAL: "WARN",
  WARN: "INFO",
  INFO: "drop",
};

// inside aggregate(), after building `deduped` (each with consensus set) and
// BEFORE the counting loop:
const critic = input.critic;
const survivors: Finding[] = [];
for (const f of deduped) {
  const cv = critic?.get(f.signature);
  if (cv?.verdict === "likely_fp") {
    const isCriticalSecurity = f.severity === "CRITICAL" && (f.category === "security" || f.category === "correctness");
    const isUnanimous = f.consensus === "unanimous";
    if (!isCriticalSecurity && !isUnanimous) {
      const next = DEMOTE[f.severity];
      if (next === "drop") continue; // INFO likely_fp is dropped entirely
      survivors.push({ ...f, severity: next, critic_verdict: "likely_fp", ...(cv.reason ? { critic_reason: cv.reason } : {}) });
      continue;
    }
    survivors.push({ ...f, critic_verdict: "keep" });
    continue;
  }
  survivors.push(f);
}
// Replace `deduped` with `survivors` in the counting loop and the returned dedupedFindings.
```

Re-point the counting loop and the return value at `survivors` instead of `deduped`.

- [ ] **Step 4: Pass (and existing aggregator.test.ts still green) + typecheck + commit**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/aggregator.test.ts tests/unit/aggregator-critic.test.ts && bun run typecheck && bun run lint
git add src/core/aggregator.ts tests/unit/aggregator-critic.test.ts
git commit -m "feat(core): aggregator applies critic demotions (never vetoes critical/unanimous)"
```

---

## Phase 9 — Orchestrator: parallel panel + anti-sycophancy + critic

### Task 9: multi-reviewer orchestration

**Files:**
- Modify: `src/core/orchestrator.ts`
- Test: `tests/unit/orchestrator-panel.test.ts`

The Orchestrator builds the reviewer list from `config.phases.review.reviewers`, constructs each adapter (injected for tests), applies the anti-sycophancy downgrade to any `claude-code` reviewer (host Opus → Sonnet, Sonnet → Haiku, Haiku → disable that reviewer), spawns them in parallel, collects results, optionally runs the critic, then aggregates. Per-reviewer prompts get a persona-specific reaffirmation.

- [ ] **Step 1: Write the failing test (two fake adapters, no critic)**

```ts
// tests/unit/orchestrator-panel.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function stub(id: ProviderAdapter["id"], findings: Finding[]): ProviderAdapter {
  return {
    id,
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(input) {
      return {
        reviewerId: input.reviewerId,
        verdict: findings.length ? "FAIL" : "PASS",
        findings,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

function f(sig: string, provider: string, persona: string): Finding {
  return {
    id: "F-1", signature: sig, severity: "WARN", category: "security", rule_id: "r",
    file: "a.ts", line_start: 1, line_end: 1, message: "m", details: "d",
    reviewer: { provider, model: "m", persona }, confidence: 0.8, consensus: "singleton",
  };
}

describe("Orchestrator panel", () => {
  it("runs two reviewers in parallel and aggregates a shared finding to majority", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-panel-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const config = {
      ...defaultConfig,
      providers: {
        ...defaultConfig.providers,
        gemini: { enabled: true, auth: "oauth" as const, model: "gemini-3-pro", timeoutMs: 1000 },
      },
      phases: {
        review: {
          reviewers: [
            { provider: "codex" as const, persona: "security" },
            { provider: "gemini" as const, persona: "architecture" },
          ],
        },
        critic: null,
      },
    };
    const orch = new Orchestrator({
      repoRoot: repo,
      config,
      adapters: {
        codex: stub("codex", [f("shared", "codex", "security")]),
        gemini: stub("gemini", [f("shared", "gemini", "architecture")]),
      },
      sandboxMode: "off",
      hostTier: "opus",
      diff: "--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n",
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(["FAIL", "SOFT-PASS"]).toContain(result.verdict);
    expect(existsSync(join(repo, ".reviewgate", "pending.json"))).toBe(true);
    const report = JSON.parse(readFileSync(join(repo, ".reviewgate", "pending.json"), "utf8"));
    expect(report.reviewers.length).toBe(2);
    expect(report.findings[0].consensus).toBe("majority"); // both reviewers, shared signature
  });
});
```

- [ ] **Step 2: Run, expect fail**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/orchestrator-panel.test.ts
```

- [ ] **Step 3: Rework `Orchestrator`** — change the input from `providers: { codex }` to `adapters: Partial<Record<ProviderId, ProviderAdapter>>` (injected for tests; in production the gate builds them via the registry). Build the reviewer list, apply anti-sycophancy downgrade for `claude-code`, spawn in parallel, run the critic if configured, aggregate with `reviewersTotal = number of OK reviewers`.

Key code (replace the single-review body of `runIteration`, keeping the sandbox-mode fail-closed guard and the per-iteration prompt/findings temp files):

```ts
import { reviewerTierFor, modelIdForTier } from "../utils/host-model.ts";
import { aggregate } from "./aggregator.ts";
import { buildCriticPrompt, parseCriticOutput, type CriticVerdict } from "./critic.ts";
import type { ProviderId } from "../providers/registry.ts";

// ...OrchestratorInput now has: adapters: Partial<Record<ProviderId, ProviderAdapter>>

// reviewer personas → reaffirmation lines
const PERSONA_REAFFIRM: Record<string, string> = {
  security: "You are a hostile senior security auditor. Assume the author was overconfident. Find real bugs.",
  architecture: "You are a senior software architect. Judge design, coupling, and maintainability.",
  adversarial: "You are an adversarial critic. Attack assumptions; find what others miss.",
};

// inside runIteration, after the sandbox guard and writing diffPath:
const reviewers = this.input.config.phases.review.reviewers;
const tasks = reviewers.map(async (r) => {
  // Anti-sycophancy: downgrade a claude-code reviewer below the host tier.
  let model = r.model ?? this.input.config.providers[r.provider]?.model ?? "";
  if (r.provider === "claude-code") {
    const tier = reviewerTierFor(this.input.hostTier);
    if (tier === "disabled") return null; // host is haiku; drop the claude reviewer
    model = modelIdForTier(tier) ?? model;
  }
  const adapter = this.input.adapters[r.provider];
  const cfg = this.input.config.providers[r.provider];
  if (!adapter || !cfg || !cfg.enabled) return null;

  const persona = r.persona;
  const reaffirm = PERSONA_REAFFIRM[persona] ?? PERSONA_REAFFIRM.security;
  const sanitised = sanitizeDiff({ diff: this.input.diff, personaReaffirm: reaffirm });
  const runDir = mkdtempSync(join(tmpdir(), `rg-rev-${r.provider}-`));
  const promptFile = join(runDir, "prompt.txt");
  const findingsPath = join(runDir, "findings.md");
  const diffPath = join(runDir, "diff.patch");
  writeFileSync(
    promptFile,
    ["Review the diff for issues. Output a JSON object matching the review schema you were given.", "", sanitised.text].join("\n"),
  );
  writeFileSync(diffPath, this.input.diff);
  const res = await adapter.review({
    cfg: { ...cfg, model },
    reviewerId: `${r.provider}-${persona}`,
    promptFile,
    workingDir: this.input.repoRoot,
    findingsPath,
    persona,
    diffPath,
  });
  return res;
});

const settled = (await Promise.all(tasks)).filter((x): x is ReviewResult => x !== null);
const okReviews = settled.filter((r) => r.status === "ok");
const allFindings = okReviews.flatMap((r) => r.findings);

// Fail closed: if EVERY reviewer errored (and we expected at least one), surface ERROR.
if (settled.length > 0 && okReviews.length === 0) {
  await this.writeErrorReport({ runId: opts.runId, iter: opts.iter }, start, settled[0]!.status, settled[0]);
  return { verdict: "ERROR", costUsd: 0, durationMs: Date.now() - start, signaturesThisIter: [] };
}

// Optional critic phase (demote-only).
let criticMap: Map<string, CriticVerdict> | undefined;
const criticCfg = this.input.config.phases.critic;
if (criticCfg && allFindings.length > 0) {
  const criticAdapter = this.input.adapters[criticCfg.provider];
  const cCfg = this.input.config.providers[criticCfg.provider];
  if (criticAdapter && cCfg) {
    const cRun = mkdtempSync(join(tmpdir(), "rg-critic-"));
    const cPrompt = join(cRun, "prompt.txt");
    writeFileSync(cPrompt, buildCriticPrompt(/* deduped preview */ allFindings));
    const cRes = await criticAdapter.review({
      cfg: { ...cCfg, ...(criticCfg.model ? { model: criticCfg.model } : {}) },
      reviewerId: `critic-${criticCfg.provider}`,
      promptFile: cPrompt,
      workingDir: this.input.repoRoot,
      findingsPath: join(cRun, "f.md"),
      persona: criticCfg.persona,
      diffPath: join(cRun, "d.patch"),
    });
    criticMap = parseCriticOutput(readFileSync(cRes.rawEventsPath, "utf8").length ? readFileSync(cRes.rawEventsPath, "utf8") : "");
  }
}

const agg = aggregate({ findings: allFindings, reviewersTotal: okReviews.length, ...(criticMap ? { critic: criticMap } : {}) });

// Write report: reviewers array from `settled`, findings from agg.dedupedFindings,
// cost/duration summed. (Reuse the existing ReportWriter.write call, mapping each
// settled review into the reviewers[] entry with its id/provider/model/persona/status.)
```

Update the `reviewers[]` builder in the `ReportWriter.write` call to map over `settled` (id, provider from the reviewerId prefix or the adapter id, model, persona, status, cost_usd, duration_ms). Sum `cost_usd_total` and set `duration_ms_total`.

- [ ] **Step 4: Update the gate** (`src/cli/commands/gate.ts`) to build `adapters` via the registry from the enabled providers, instead of passing only `{ codex }`. Replace the `providers: { codex }` wiring with:

```ts
import { createAdapter, type ProviderId } from "../../providers/registry.ts";

const adapters: Partial<Record<ProviderId, import("../../providers/adapter-base.ts").ProviderAdapter>> = {};
for (const r of cfg.phases.review.reviewers) {
  if (!adapters[r.provider]) adapters[r.provider] = input.providerOverrides?.[r.provider] ?? createAdapter(r.provider);
}
if (cfg.phases.critic && !adapters[cfg.phases.critic.provider]) {
  adapters[cfg.phases.critic.provider] = createAdapter(cfg.phases.critic.provider);
}
// pass `adapters` (not `providers`) into new Orchestrator({ ..., adapters, ... })
```

Change `GateInput.providerOverrides` type to `Partial<Record<ProviderId, ProviderAdapter>>` and update the integration test (`full-loop.test.ts`) to pass `{ codex: new CodexAdapter(...) }` under the new `adapters`/`providerOverrides` shape (it already passes a codex override; keep it working).

- [ ] **Step 5: Pass panel test + full suite + typecheck + commit**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit tests/integration && bun run typecheck && bun run lint
git add src/core/orchestrator.ts src/cli/commands/gate.ts tests/unit/orchestrator-panel.test.ts tests/integration/full-loop.test.ts
git commit -m "feat(core): parallel multi-reviewer panel + anti-sycophancy downgrade + critic wiring"
```

---

## Phase 10 — Cost cap (apikey/openrouter mode)

### Task 10: enforce cost cap when not OAuth

**Files:**
- Modify: `src/providers/openrouter.ts` (compute cost from usage when a price is known) — OR keep cost 0 and document. M2 minimal: track tokens; the LoopDriver cost-cap (already added) escalates when `cost_usd_so_far >= costCapUsd`. Since OAuth = $0 and OpenRouter cost needs a price table, M2 ships a SIMPLE per-call flat estimate hook.
- Test: `tests/unit/openrouter-cost.test.ts`

- [ ] **Step 1: Decide scope.** Real per-model pricing is M5+. For M2, add an optional `costPerMTokensUsd` to the OpenRouter provider config; if set, cost = (input+output)/1e6 * price. If unset, cost stays 0 (OAuth-style). This keeps the LoopDriver cost-cap meaningful for OpenRouter users without a full price table.

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/openrouter-cost.test.ts
import { describe, expect, it } from "bun:test";
import { estimateCostUsd } from "../../src/providers/openrouter.ts";

describe("estimateCostUsd", () => {
  it("returns 0 when no price configured", () => {
    expect(estimateCostUsd(1000, 500, undefined)).toBe(0);
  });
  it("computes from price per million tokens", () => {
    expect(estimateCostUsd(1_000_000, 0, 0.5)).toBeCloseTo(0.5, 6);
  });
});
```

- [ ] **Step 3: Implement** — add to `openrouter.ts`:

```ts
export function estimateCostUsd(inputTokens: number, outputTokens: number, pricePerMTokensUsd: number | undefined): number {
  if (!pricePerMTokensUsd || pricePerMTokensUsd <= 0) return 0;
  return ((inputTokens + outputTokens) / 1_000_000) * pricePerMTokensUsd;
}
```

Use it in `review()`: `costUsd: estimateCostUsd(inTok, outTok, input.cfg.costPerMTokensUsd)`. Add `costPerMTokensUsd: z.number().nonnegative().optional()` to `ProviderConfigSchema` and the `ProviderConfig` interface.

- [ ] **Step 4: Pass + typecheck + commit**

```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/openrouter-cost.test.ts tests/unit/config-loader.test.ts && bun run typecheck && bun run lint
git add src/providers/openrouter.ts src/config/define-config.ts src/providers/adapter-base.ts tests/unit/openrouter-cost.test.ts
git commit -m "feat(providers): optional OpenRouter cost estimate feeding the loop cost cap"
```

---

## Phase 11 — Real e2e + doctor + docs

### Task 11: e2e tests against real Gemini and Claude (opt-in)

**Files:**
- Create: `tests/e2e/gemini-real.test.ts`, `tests/e2e/claude-real.test.ts`

Mirror `tests/e2e/codex-real.test.ts`: a per-test timeout (300_000ms), a SAFE committed baseline, then introduce the `==` bug as the uncommitted diff, run a single-provider panel via `runGate`, and assert `pending.md` mentions timing/compare/equal/token. Gate the suites on `REVIEWGATE_E2E === "1"`. For Gemini set `GEMINI_CLI_TRUST_WORKSPACE` is handled inside the adapter. For Claude the adapter runs in a temp CWD (no recursion).

- [ ] **Step 1: Write `tests/e2e/gemini-real.test.ts`** — copy the structure of `codex-real.test.ts` but configure a gemini-only panel:

```ts
// key difference: config override enabling gemini and a gemini-only reviewers list,
// passed through runGate via a reviewgate.config.ts written into the temp repo:
writeFileSync(join(repo, "reviewgate.config.ts"),
  `import { defineConfig } from "${process.cwd()}/src/config/define-config.ts";\n` +
  `export default defineConfig({ providers: { gemini: { enabled: true, auth: "oauth", model: "gemini-3-pro", timeoutMs: 300000 } }, phases: { review: { reviewers: [{ provider: "gemini", persona: "security" }] } } });\n`);
```

- [ ] **Step 2: Write `tests/e2e/claude-real.test.ts`** — same, claude-only reviewers list (`{ provider: "claude-code", persona: "adversarial" }`, model `claude-sonnet-4-6`).

- [ ] **Step 3: Run when enabled**

```bash
export PATH="$HOME/.bun/bin:$PATH" && REVIEWGATE_E2E=1 bun test tests/e2e/gemini-real.test.ts tests/e2e/claude-real.test.ts
```

Expected: each completes within the timeout, writes `pending.md`, and the report mentions the bug. If a provider isn't logged in, the test should be skipped or clearly fail with an auth message (document which).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/gemini-real.test.ts tests/e2e/claude-real.test.ts
git commit -m "test(e2e): opt-in real Gemini + Claude reviewer end-to-end"
```

### Task 12: doctor + README/AGENTS updates

**Files:**
- Modify: `src/cli/commands/doctor.ts` (check gemini + claude CLIs + OPENROUTER_API_KEY when openrouter enabled)
- Modify: `README.md`, `docs/AGENTS.md` (multi-reviewer config examples; OpenRouter any-model)

- [ ] **Step 1: Extend doctor** to `checkBinary("gemini", ...)`, `checkBinary("claude", ...)` (only when those providers are enabled in config), and warn if an enabled `openrouter` provider's `apiKeyEnv` is unset. Reuse the existing `Check` structure.

- [ ] **Step 2: Update README** — replace the "single Codex reviewer" framing: document the panel config (codex+gemini+claude+openrouter), OAuth vs OpenRouter, the `google/gemini-3.5-flash`-style any-model example, and the critic. Move the relevant items from "Not yet (M2)" into "In M2".

- [ ] **Step 3: Update docs/AGENTS.md** — unchanged protocol (still pending.md + decisions/<iter>.jsonl), but note findings may now carry `confirmed_by` (multiple reviewers) and `critic_verdict`.

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/doctor.ts README.md docs/AGENTS.md
git commit -m "docs+cli: doctor checks gemini/claude/openrouter; README/AGENTS document the panel"
```

---

## Wrap-up checklist (run before claiming M2 done)

- [ ] **Spikes documented:** `docs/superpowers/spikes/M2/SUMMARY.md` lists SM2-1..3 outcomes.
- [ ] **All unit tests green:** `bun test tests/unit` exits 0.
- [ ] **Integration green:** `bun test tests/integration` exits 0.
- [ ] **Typecheck green:** `bun run typecheck` exits 0.
- [ ] **Lint clean:** `bun run lint` exits 0.
- [ ] **Build green:** `bun run build` produces `dist/reviewgate`.
- [ ] **Real panel works:** with codex+gemini both enabled, a manual `reviewgate gate` on a `==` bug produces findings from BOTH providers, deduped where they agree (consensus majority), and a sensible verdict.
- [ ] **Anti-sycophancy holds:** with an Opus host, the claude-code reviewer runs at Sonnet (verify in `pending.json` reviewers[].model); with a Haiku host it is dropped.
- [ ] **OpenRouter any-model:** setting `{ provider:'openrouter', model:'google/gemini-3.5-flash' }` + `OPENROUTER_API_KEY` yields a working reviewer.
- [ ] **Fail-closed preserved:** if every reviewer errors, verdict is ERROR (block), never PASS.

When the checklist is fully ✓, M2 ships. Then write the M3 plan (adaptive triage + research phase + symbol-graph + caching).

---

## Self-review notes (author)

- **Spec coverage:** §5.4 adapters (codex✓ gemini✓ claude✓ openrouter✓-as-the-OpenRouter-route), auth matrix (OAuth for codex/gemini/claude; OpenRouter API-key), §5.5 aggregator veto + critic demotion (Task 8), anti-sycophancy downgrade (Task 9). OpenCode is intentionally dropped in favor of a direct OpenRouter adapter (simpler "any model by name" UX) — note the deviation in SM2-3.
- **Type consistency:** all adapters return `ReviewResult`; all map via `mapReviewOutputToFindings`; `ProviderId` union is identical in `registry.ts`, `define-config.ts` (`ProviderId` enum), and `adapter-base.ts`. The Orchestrator input changes from `providers` to `adapters` — Task 9 Step 4 updates the gate AND the integration test together.
- **Open risk to verify during impl:** the exact Claude `--output-format json` envelope key (`result` assumed; SM2-2 confirms) and whether non-bare Claude can be made recursion-safe via temp CWD alone (SM2-2 Step 4). If not, fall back to `--bare` + `ANTHROPIC_API_KEY` and update Task 3 + the OAuth claim.
