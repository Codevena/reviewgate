# Reviewgate M4 — Brain + Curator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Reviewgate a committed, self-curating per-repo memory ("brain"): reviewers read relevant brain entries before reviewing, may propose new entries, and a non-blocking Curator phase validates proposals against seven hard rules before any enter the brain.

**Architecture:** Three additions to the existing M1–M3 pipeline. (1) **Read path** — a `BrainEngine` pins an immutable per-run snapshot of the active brain at run start, selects ≤1500 tokens by triage-tags + file-globs + category, and injects it into each reviewer prompt next to `research.md`. (2) **Write path** — reviewers emit `memory_proposals[]`; a new `kind:'web-fetch'` evidence form is *cited* (source_url only) by reviewers and *enriched* (body_sha256 + fetched_at) by Reviewgate's own SSRF-resistant fetcher. (3) **Curator** — a non-blocking Phase 4 that runs synchronously after the verdict, hard-timeout-bounded and best-effort, validates proposals (7 rules incl. OpenRouter-embedding dedup, fail-closed), and writes the brain through the same locked/atomic discipline as `StateStore`. Lifecycle candidate→active→stale→archived. CLI: `reviewgate brain list|show|revoke`.

**Tech Stack:** Bun 1.x + TypeScript 5.x (strict: exactOptionalPropertyTypes, noUncheckedIndexedAccess, verbatimModuleSyntax) + zod + biome. Reuses M1–M3 infra: orchestrator phases, critic-phase template, OpenRouter adapter, `StateStore` flock+atomic discipline, `review-output` tolerant parser, `define-config`, `AuditLogger`, citty CLI.

**Spec references:** scope/decisions `docs/superpowers/specs/2026-05-21-reviewgate-m4-brain-curator-design.md`; semantics `docs/superpowers/specs/2026-05-20-reviewgate-design.md` §5.6 + the `MemoryProposal` schema (§5, lines ~886–909).

**Out of scope (later milestones):** live persona-bias *surfacing* (M6 — M4 only RECORDS acceptance data); FP-Ledger learning loop (M5); detached/durable background curator executor; aggressive cross-run research-cache reuse; native sandbox isolation (stays `sandbox.mode:"off"`, egress enforced in Reviewgate's own fetch code). If a step would build something on this list, STOP and ask.

---

## File Structure

**New files:**
- `src/schemas/brain.ts` — `BrainEntrySchema`, `MemoryProposalSchema`, `CuratorDecisionSchema`, `EvidenceItemSchema`, and the `BrainEntryStatus` enum. One responsibility: brain data shapes.
- `src/core/brain/store.ts` — `BrainStore` class: locked/atomic read+write of `brain.json` (index), `brain.md` (render), `sources.jsonl` (provenance), `archive.md`; content-addressed web-fetch snapshots. Mirrors `StateStore`.
- `src/core/brain/engine.ts` — `BrainEngine`: read-path snapshot pin + relevance selection + token-budgeted injection text.
- `src/core/brain/select.ts` — pure selection/ranking helpers (tag/glob/category match, priority order, token budget). Pure functions = easy to test.
- `src/core/brain/curator.ts` — `runCurator()`: the 7-rule validation engine + lifecycle promotion + decay. Pure-ish (takes a store + embedder + fetcher as deps).
- `src/core/brain/embeddings.ts` — `cosineSimilarity()` + the `Embedder` interface; the OpenRouter embedding client lives on the adapter (Task 6).
- `src/core/brain/fetcher.ts` — `safeFetch()`: SSRF-resistant web fetch (canonicalize, allowlist, IP block, DNS pin, redirect re-validation, limits, egress log record).
- `src/cli/commands/brain.ts` — `runBrainList`, `runBrainShow`, `runBrainRevoke`.
- Tests under `tests/unit/brain-*.test.ts` and `tests/integration/brain-curator.test.ts`; real e2e under `tests/e2e/brain-embeddings-real.test.ts` + `tests/e2e/brain-fetch-real.test.ts` (gated by `REVIEWGATE_E2E=1`).

**Modified files:**
- `src/utils/paths.ts` — add brain path helpers.
- `src/providers/review-output.ts` — parse `memory_proposals[]`.
- `src/core/orchestrator.ts` — brain injection (line ~175) + post-verdict curator call (line ~247).
- `src/providers/openrouter.ts` — add `embed()` method.
- `src/config/define-config.ts` + `src/config/defaults.ts` — `phases.brain` block.
- `src/schemas/audit-event.ts` — add `curator.start`, `curator.complete`, `brain.egress` event types.
- `src/cli/index.ts` — register `brain` command.
- `src/cli/commands/init.ts` — add brain gitignore lines (`proposals/`).

---

## Spikes (do FIRST — they gate the risky slices)

### Spike SM4-1 — OpenRouter embedding model + threshold (dev-runnable)

**Goal:** pick a small/cheap embedding model and confirm the API + threshold.

- [ ] Run, with a valid `OPENROUTER_API_KEY` in env:
```bash
curl -sS https://openrouter.ai/api/v1/embeddings \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"<candidate>","input":["src/cart.ts null-guards are intentional","cart.ts intentionally null-guards its Promise.all"]}' | jq '.data[].embedding | length'
```
Try candidates (e.g. `qwen/qwen3-embedding-8b`, then a smaller one). Record: which model id returns 200, vector dim, and the cosine similarity of the two near-duplicate strings above (must be ≥ 0.85) vs two unrelated strings (must be < 0.85).
- [ ] **Output:** the chosen model id + confirmed dim, written into the M4 design doc's "Decisions" and used as the default in Task 13. If NO candidate gives a clean 0.85 separation on near-dupes, raise to the user before proceeding (the dedup rule depends on it).

### Spike SM4-2 — Egress hardening acceptance gates (dev-runnable, BLOCKS the web-fetch path)

**Goal:** prove the SSRF controls before the web-fetch evidence path ships.

- [ ] Implement Task 7 (`safeFetch`), then verify each gate with a unit test (Task 7 contains them) AND a manual check from the compiled binary:
```bash
bun run build
# allowed docs host → OK; private IP, link-local, metadata IP, http://, a redirect to a
# private host, an oversize body, and a non-allowlisted host must ALL be rejected.
```
- [ ] **Acceptance (all must hold or M4 does not ship the web-fetch path):** final-host allowlist after canonicalization; block private/loopback/link-local/CGNAT/`169.254.169.254`; resolve-then-pin (no DNS rebinding); per-hop redirect re-validation with a small cap; no credential/header forwarding; timeout + max-body + content-type allowlist; query stripped + URL/path length caps; per-run egress log written. If any gate cannot be met cleanly, ship M4 with ONLY the LLM-citation quorum and defer web-fetch (raise to user).

### Spike SM4-3 — Curator default provider (dev-runnable)

**Goal:** pick a default curator provider that is NOT an active reviewer and runs without colliding with the host session.

- [ ] With the production panel (codex/gemini/claude-code reviewers + openrouter), confirm one non-reviewer provider can run a single curator call (reuse the critic-phase invocation path) and returns parseable JSON within `timeoutMs`. Record the default in Task 13.

---

## Spike results (resolved 2026-05-21)

- **SM4-1 → embedding default = `baai/bge-base-en-v1.5`** (OpenRouter, 768-dim). Confirmed clean 0.85 separation: near-dup cosine 0.924, unrelated 0.588. (Alternatives that also separate: `google/gemini-embedding-001` 0.942/0.549, `qwen/qwen3-embedding-8b` 0.870/0.437.) Use as the Task 12 config default.
- **Curator type = HYBRID** (resolved with user): the deterministic 7-rule gates ALWAYS run (Task 9 core); an OPTIONAL final LLM accept/reject judgment runs only when `phases.brain.curator` is configured (a non-reviewer provider), covering the judgment-heavy rules 3 (consistency) + 5 (scope/quality). Brain works out-of-the-box deterministically; the LLM curator is opt-in and design-faithful (§5.6).
- **SM4-2** (egress hardening) is validated by Task 7's unit tests + the post-Task-7 binary check (it IS the implementation). **SM4-3** (curator provider) only matters for the opt-in LLM judge; confirmed via Task 17 real e2e + the integration test's fake judge.

---

## Task 1: Brain schemas

**Files:**
- Create: `src/schemas/brain.ts`
- Test: `tests/unit/brain-schema.test.ts`

- [ ] **Step 1: Write the failing test**
```typescript
// tests/unit/brain-schema.test.ts
import { describe, expect, it } from "bun:test";
import {
  BrainEntrySchema,
  MemoryProposalSchema,
  EvidenceItemSchema,
} from "../../src/schemas/brain.ts";

describe("brain schemas", () => {
  it("accepts a minimal valid brain entry and defaults lifecycle fields", () => {
    const e = BrainEntrySchema.parse({
      id: "B-001",
      type: "convention",
      scope: "this-repo",
      title: "cart null-guards are intentional",
      body: "src/cart.ts Promise.all null-guard is deliberate.",
      tags: ["cart"],
      file_globs: ["src/cart.ts"],
      confidence: 0.9,
      evidence: [{ kind: "reviewer-finding", run_id: "r1", reviewer_id: "codex-security" }],
      created_at: "2026-05-21T00:00:00Z",
      source_run_id: "r1",
    });
    expect(e.status).toBe("candidate");
    expect(e.referenced_count).toBe(1);
    expect(e.referencing_reviewers).toEqual([]);
    expect(e.embedding).toBeNull();
  });

  it("requires body_sha256 + fetched_at on a web-fetch evidence item", () => {
    expect(() => EvidenceItemSchema.parse({ kind: "web-fetch", source_url: "https://x/y" })).toThrow();
    expect(
      EvidenceItemSchema.parse({
        kind: "web-fetch",
        source_url: "https://x/y",
        body_sha256: "a".repeat(64),
        fetched_at: "2026-05-21T00:00:00Z",
      }).kind,
    ).toBe("web-fetch");
  });

  it("rejects a proposal whose body exceeds 500 chars", () => {
    expect(() =>
      MemoryProposalSchema.parse({
        type: "convention",
        scope: "this-repo",
        title: "t",
        body: "x".repeat(501),
        evidence: [{ kind: "reviewer-observation", run_id: "r", reviewer_id: "codex" }],
        confidence: 0.6,
        tags: [],
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test tests/unit/brain-schema.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**
```typescript
// src/schemas/brain.ts
import { z } from "zod";

export const BrainEntryType = z.enum([
  "convention",
  "anti-pattern",
  "external-knowledge",
  "disagreement",
  "research-cache",
]);

export const BrainEntryStatus = z.enum(["candidate", "active", "stale", "archived"]);
export type BrainEntryStatus = z.infer<typeof BrainEntryStatus>;

export const EvidenceItemSchema = z
  .object({
    kind: z.enum(["reviewer-finding", "web-fetch", "deterministic", "reviewer-observation"]),
    source_url: z.string().url().optional(),
    body_sha256: z.string().length(64).optional(),
    fetched_at: z.string().optional(),
    run_id: z.string().optional(),
    reviewer_id: z.string().optional(),
    from_diff: z
      .object({ file: z.string(), line_start: z.number().int(), line_end: z.number().int() })
      .optional(),
    snippet: z.string().max(200).optional(),
  })
  .superRefine((e, ctx) => {
    if (e.kind === "web-fetch" && (!e.source_url || !e.body_sha256 || !e.fetched_at)) {
      ctx.addIssue({ code: "custom", message: "web-fetch evidence needs source_url+body_sha256+fetched_at" });
    }
    if (
      (e.kind === "reviewer-finding" || e.kind === "reviewer-observation") &&
      (!e.run_id || !e.reviewer_id)
    ) {
      ctx.addIssue({ code: "custom", message: "reviewer evidence needs run_id+reviewer_id" });
    }
  });
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

// Reviewer-submitted proposal (pre-enrichment). source_url citations are allowed
// on non-web-fetch evidence; Reviewgate enriches them into web-fetch records.
export const MemoryProposalSchema = z.object({
  type: BrainEntryType,
  scope: z.string(),
  title: z.string().max(80),
  body: z.string().max(500),
  evidence: z.array(EvidenceItemSchema).min(1),
  confidence: z.number().min(0).max(1),
  tags: z.array(z.string()),
});
export type MemoryProposal = z.infer<typeof MemoryProposalSchema>;

export const BrainEntrySchema = z.object({
  id: z.string(),
  type: BrainEntryType,
  scope: z.string(),
  title: z.string().max(80),
  body: z.string().max(500),
  tags: z.array(z.string()),
  file_globs: z.array(z.string()),
  status: BrainEntryStatus.default("candidate"),
  referenced_count: z.number().int().nonnegative().default(1),
  referencing_reviewers: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
  embedding: z.array(z.number()).nullable().default(null),
  evidence: z.array(EvidenceItemSchema),
  provenance: z.enum(["diff-derived"]).optional(),
  created_at: z.string(),
  last_referenced_at: z.string().optional(),
  source_run_id: z.string(),
});
export type BrainEntry = z.infer<typeof BrainEntrySchema>;

export const CuratorDecisionSchema = z.object({
  schema: z.literal("reviewgate.curator.v1"),
  run_id: z.string(),
  proposal_title: z.string(),
  decision: z.enum(["promoted", "rejected", "queued", "merged-duplicate"]),
  rule_failed: z.string().optional(),
  entry_id: z.string().optional(),
  provider: z.string(),
  ts: z.string(),
});
export type CuratorDecision = z.infer<typeof CuratorDecisionSchema>;
```

- [ ] **Step 4: Run to verify it passes** — `bun test tests/unit/brain-schema.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git add src/schemas/brain.ts tests/unit/brain-schema.test.ts && git commit -m "feat(brain): M4 brain/proposal/evidence schemas"`

---

## Task 2: Brain path helpers

**Files:**
- Modify: `src/utils/paths.ts`
- Test: `tests/unit/brain-paths.test.ts`

- [ ] **Step 1: Write the failing test**
```typescript
// tests/unit/brain-paths.test.ts
import { describe, expect, it } from "bun:test";
import {
  brainDir, brainJsonPath, brainMdPath, brainSourcesPath, brainArchivePath,
  brainLockPath, brainSnapshotsDir, curatorDecisionsPath,
} from "../../src/utils/paths.ts";

describe("brain paths", () => {
  it("derives all brain paths under .reviewgate/brain", () => {
    const r = "/repo";
    expect(brainDir(r)).toBe("/repo/.reviewgate/brain");
    expect(brainJsonPath(r)).toBe("/repo/.reviewgate/brain/brain.json");
    expect(brainMdPath(r)).toBe("/repo/.reviewgate/brain/brain.md");
    expect(brainSourcesPath(r)).toBe("/repo/.reviewgate/brain/sources.jsonl");
    expect(brainArchivePath(r)).toBe("/repo/.reviewgate/brain/archive.md");
    expect(brainLockPath(r)).toBe("/repo/.reviewgate/brain/.lock");
    expect(brainSnapshotsDir(r)).toBe("/repo/.reviewgate/brain/snapshots");
    expect(curatorDecisionsPath(r, "RUN1")).toBe(
      "/repo/.reviewgate/brain/proposals/curator-decisions/RUN1.jsonl",
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test tests/unit/brain-paths.test.ts` → FAIL.

- [ ] **Step 3: Implement** — append to `src/utils/paths.ts` (uses the existing `join`/`reviewgateDir`):
```typescript
export function brainDir(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "brain");
}
export function brainJsonPath(repoRoot: string): string {
  return join(brainDir(repoRoot), "brain.json");
}
export function brainMdPath(repoRoot: string): string {
  return join(brainDir(repoRoot), "brain.md");
}
export function brainSourcesPath(repoRoot: string): string {
  return join(brainDir(repoRoot), "sources.jsonl");
}
export function brainArchivePath(repoRoot: string): string {
  return join(brainDir(repoRoot), "archive.md");
}
export function brainLockPath(repoRoot: string): string {
  return join(brainDir(repoRoot), ".lock");
}
export function brainSnapshotsDir(repoRoot: string): string {
  return join(brainDir(repoRoot), "snapshots");
}
export function curatorDecisionsPath(repoRoot: string, runId: string): string {
  return join(brainDir(repoRoot), "proposals", "curator-decisions", `${runId}.jsonl`);
}
```

- [ ] **Step 4: Run to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(brain): brain path helpers"`

---

## Task 3: BrainStore (locked, atomic CRUD + snapshot read)

**Files:**
- Create: `src/core/brain/store.ts`
- Test: `tests/unit/brain-store.test.ts`

**Discipline (mirror `StateStore`):** all mutations go through `flock(brainLockPath(repo))` then temp-write-then-rename (`writeFileSync(tmp,{mode:0o600}); renameSync(tmp,p)`); `brain.json` is the canonical index (`{schema, entries: BrainEntry[]}`), `brain.md` is a derived human render, `sources.jsonl` is append-only provenance.

- [ ] **Step 1: Write the failing test**
```typescript
// tests/unit/brain-store.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainStore } from "../../src/core/brain/store.ts";
import { brainJsonPath, brainMdPath } from "../../src/utils/paths.ts";
import type { BrainEntry } from "../../src/schemas/brain.ts";

function entry(over: Partial<BrainEntry> = {}): BrainEntry {
  return {
    id: "B-001", type: "convention", scope: "this-repo", title: "t", body: "b",
    tags: ["x"], file_globs: ["src/*.ts"], status: "candidate", referenced_count: 1,
    referencing_reviewers: [], confidence: 0.9, embedding: null,
    evidence: [{ kind: "reviewer-finding", run_id: "r1", reviewer_id: "codex" }],
    created_at: "2026-05-21T00:00:00Z", source_run_id: "r1", ...over,
  };
}

describe("BrainStore", () => {
  it("starts empty, adds an entry atomically, and renders brain.md", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-brain-"));
    const store = new BrainStore(repo);
    expect((await store.snapshot()).entries).toEqual([]);
    await store.add(entry());
    const snap = await store.snapshot();
    expect(snap.entries.map((e) => e.id)).toEqual(["B-001"]);
    expect(existsSync(brainJsonPath(repo))).toBe(true);
    expect(readFileSync(brainMdPath(repo), "utf8")).toContain("B-001");
  });

  it("revoke removes an entry and snapshot() is immutable across mutations", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-brain2-"));
    const store = new BrainStore(repo);
    await store.add(entry({ id: "B-001" }));
    const pinned = await store.snapshot();
    await store.add(entry({ id: "B-002" }));
    expect(pinned.entries.map((e) => e.id)).toEqual(["B-001"]); // pinned snapshot unchanged
    expect(await store.revoke("B-001")).toBe(true);
    expect((await store.snapshot()).entries.map((e) => e.id)).toEqual(["B-002"]);
  });

  it("nextId increments based on existing entries", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-brain3-"));
    const store = new BrainStore(repo);
    await store.add(entry({ id: await store.nextId() }));
    expect(await store.nextId()).toBe("B-002");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (module not found).

- [ ] **Step 3: Implement**
```typescript
// src/core/brain/store.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { BrainEntrySchema, type BrainEntry } from "../../schemas/brain.ts";
import { flock } from "../../utils/flock.ts";
import { brainDir, brainJsonPath, brainLockPath, brainMdPath } from "../../utils/paths.ts";

const BrainIndexSchema = z.object({
  schema: z.literal("reviewgate.brain.v1"),
  entries: z.array(BrainEntrySchema),
});
export type BrainSnapshot = z.infer<typeof BrainIndexSchema>;

function renderMd(snap: BrainSnapshot): string {
  const lines = ["# Reviewgate Brain", ""];
  for (const e of snap.entries) {
    lines.push(`### ${e.id} · ${e.type} · ${e.status} (${e.scope})`);
    lines.push(`**${e.title}** — refs ${e.referenced_count}`);
    lines.push(e.body, "");
  }
  return lines.join("\n");
}

export class BrainStore {
  constructor(private readonly repoRoot: string) {}

  private writeAtomic(path: string, body: string): void {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
  }

  // Reads a fresh, immutable copy of the index. Callers pin this once per run.
  async snapshot(): Promise<BrainSnapshot> {
    const p = brainJsonPath(this.repoRoot);
    if (!existsSync(p)) return { schema: "reviewgate.brain.v1", entries: [] };
    try {
      return BrainIndexSchema.parse(JSON.parse(readFileSync(p, "utf8")));
    } catch {
      return { schema: "reviewgate.brain.v1", entries: [] };
    }
  }

  private persist(snap: BrainSnapshot): void {
    this.writeAtomic(brainJsonPath(this.repoRoot), JSON.stringify(snap, null, 2));
    this.writeAtomic(brainMdPath(this.repoRoot), renderMd(snap));
  }

  // Single guarded mutation: lock → read → mutate → atomic write → unlock.
  async mutate<T>(fn: (snap: BrainSnapshot) => { next: BrainSnapshot; result: T }): Promise<T> {
    if (!existsSync(brainDir(this.repoRoot))) mkdirSync(brainDir(this.repoRoot), { recursive: true });
    const lock = await flock(brainLockPath(this.repoRoot));
    try {
      const cur = await this.snapshot();
      const { next, result } = fn(structuredClone(cur));
      BrainIndexSchema.parse(next);
      this.persist(next);
      return result;
    } finally {
      await lock.release();
    }
  }

  async add(e: BrainEntry): Promise<void> {
    await this.mutate((snap) => {
      snap.entries.push(BrainEntrySchema.parse(e));
      return { next: snap, result: undefined };
    });
  }

  async revoke(id: string): Promise<boolean> {
    return this.mutate((snap) => {
      const before = snap.entries.length;
      snap.entries = snap.entries.filter((x) => x.id !== id);
      return { next: snap, result: snap.entries.length < before };
    });
  }

  async nextId(): Promise<string> {
    const snap = await this.snapshot();
    const max = snap.entries
      .map((e) => Number.parseInt(e.id.replace(/^B-/, ""), 10))
      .filter((n) => Number.isFinite(n))
      .reduce((a, b) => Math.max(a, b), 0);
    return `B-${String(max + 1).padStart(3, "0")}`;
  }
}
```

- [ ] **Step 4: Run to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add src/core/brain/store.ts tests/unit/brain-store.test.ts && git commit -m "feat(brain): locked/atomic BrainStore + per-run snapshot"`

---

## Task 4: Relevance selection (pure helpers)

**Files:**
- Create: `src/core/brain/select.ts`
- Test: `tests/unit/brain-select.test.ts`

**Rules (§5.6):** only `active` + `candidate` entries are eligible (NOT `stale`/`archived`); match by triage tags ∪ changed-file globs ∪ category; priority order conventions > anti-patterns > external-knowledge > research-cache > disagreement; cap by an approximate token budget (≈ 4 chars/token over `title`+`body`).

- [ ] **Step 1: Write the failing test**
```typescript
// tests/unit/brain-select.test.ts
import { describe, expect, it } from "bun:test";
import { selectBrainEntries } from "../../src/core/brain/select.ts";
import type { BrainEntry } from "../../src/schemas/brain.ts";

const base: Omit<BrainEntry, "id" | "type" | "title" | "body" | "tags" | "file_globs"> = {
  scope: "this-repo", status: "active", referenced_count: 3, referencing_reviewers: [],
  confidence: 0.9, embedding: null,
  evidence: [{ kind: "reviewer-finding", run_id: "r", reviewer_id: "codex" }],
  created_at: "2026-05-21T00:00:00Z", source_run_id: "r",
};
const mk = (o: Partial<BrainEntry>): BrainEntry =>
  ({ ...base, id: "B", type: "convention", title: "t", body: "b", tags: [], file_globs: [], ...o }) as BrainEntry;

describe("selectBrainEntries", () => {
  it("matches by tag, glob, or category and excludes stale/archived", () => {
    const entries = [
      mk({ id: "B-1", tags: ["auth"] }),
      mk({ id: "B-2", file_globs: ["src/cart.ts"] }),
      mk({ id: "B-3", type: "anti-pattern", tags: ["nope"] }),
      mk({ id: "B-4", tags: ["auth"], status: "stale" }),
    ];
    const sel = selectBrainEntries(entries, {
      tags: ["auth"], changedFiles: ["src/cart.ts"], categories: [], maxTokens: 9999,
    });
    expect(sel.map((e) => e.id).sort()).toEqual(["B-1", "B-2"]);
  });

  it("orders by priority (convention before anti-pattern) and respects the token budget", () => {
    const entries = [
      mk({ id: "B-ap", type: "anti-pattern", tags: ["t"], body: "x".repeat(40) }),
      mk({ id: "B-cv", type: "convention", tags: ["t"], body: "y".repeat(40) }),
    ];
    const sel = selectBrainEntries(entries, { tags: ["t"], changedFiles: [], categories: [], maxTokens: 20 });
    expect(sel[0]?.id).toBe("B-cv"); // convention first
    expect(sel.length).toBe(1); // budget cut the second
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**
```typescript
// src/core/brain/select.ts
import { minimatch } from "minimatch";
import type { BrainEntry } from "../../schemas/brain.ts";

export interface SelectInput {
  tags: string[];
  changedFiles: string[];
  categories: string[];
  maxTokens: number;
}

const PRIORITY: Record<BrainEntry["type"], number> = {
  convention: 0,
  "anti-pattern": 1,
  "external-knowledge": 2,
  "research-cache": 3,
  disagreement: 4,
};

const approxTokens = (s: string): number => Math.ceil(s.length / 4);

function matches(e: BrainEntry, input: SelectInput): boolean {
  if (e.tags.some((t) => input.tags.includes(t))) return true;
  if (e.file_globs.some((g) => input.changedFiles.some((f) => minimatch(f, g)))) return true;
  if (input.categories.includes(e.type)) return true;
  return false;
}

export function selectBrainEntries(entries: BrainEntry[], input: SelectInput): BrainEntry[] {
  const eligible = entries
    .filter((e) => e.status === "active" || e.status === "candidate")
    .filter((e) => matches(e, input))
    .sort((a, b) => PRIORITY[a.type] - PRIORITY[b.type] || b.referenced_count - a.referenced_count);
  const out: BrainEntry[] = [];
  let used = 0;
  for (const e of eligible) {
    const cost = approxTokens(`${e.title}\n${e.body}`);
    if (used + cost > input.maxTokens) continue;
    used += cost;
    out.push(e);
  }
  return out;
}
```
> `minimatch` is already a transitive dep via biome/tooling; if `bun add minimatch` is needed, the implementer adds it. (Verify with `bun pm ls | grep minimatch`; if absent, `bun add minimatch`.)

- [ ] **Step 4: Run to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add src/core/brain/select.ts tests/unit/brain-select.test.ts && git commit -m "feat(brain): relevance selection (tag/glob/category priority + token budget)"`

---

## Task 5: BrainEngine (snapshot pin + injection text)

**Files:**
- Create: `src/core/brain/engine.ts`
- Test: `tests/unit/brain-engine.test.ts`

- [ ] **Step 1: Write the failing test**
```typescript
// tests/unit/brain-engine.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainStore } from "../../src/core/brain/store.ts";
import { BrainEngine } from "../../src/core/brain/engine.ts";

describe("BrainEngine", () => {
  it("pins a snapshot and renders [Source: …]-annotated injection text", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-be-"));
    const store = new BrainStore(repo);
    await store.add({
      id: "B-001", type: "convention", scope: "this-repo", title: "cart null-guards",
      body: "Promise.all null-guard intentional.", tags: ["cart"], file_globs: ["src/cart.ts"],
      status: "active", referenced_count: 3, referencing_reviewers: [], confidence: 0.9,
      embedding: null, evidence: [{ kind: "reviewer-finding", run_id: "r", reviewer_id: "codex" }],
      created_at: "2026-05-21T00:00:00Z", source_run_id: "r",
    });
    const engine = new BrainEngine(store, { maxTokens: 1500 });
    await engine.pin(); // snapshot pinned at run start
    const text = engine.inject({ tags: ["cart"], changedFiles: ["src/cart.ts"], categories: [] });
    expect(text).toContain("cart null-guards");
    expect(text).toContain("[Source: B-001");
  });

  it("returns empty string when nothing matches", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-be2-"));
    const engine = new BrainEngine(new BrainStore(repo), { maxTokens: 1500 });
    await engine.pin();
    expect(engine.inject({ tags: ["none"], changedFiles: [], categories: [] })).toBe("");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**
```typescript
// src/core/brain/engine.ts
import type { BrainStore, BrainSnapshot } from "./store.ts";
import { selectBrainEntries } from "./select.ts";

export interface BrainEngineOpts {
  maxTokens: number;
}

export class BrainEngine {
  private pinned: BrainSnapshot | null = null;
  constructor(private readonly store: BrainStore, private readonly opts: BrainEngineOpts) {}

  // Pin the active brain ONCE at run start. The cache key and every reviewer's
  // injected context use this snapshot; Curator mutations land after and are
  // visible only to the next run.
  async pin(): Promise<void> {
    this.pinned = await this.store.snapshot();
  }

  snapshotEntries(): BrainSnapshot["entries"] {
    return this.pinned?.entries ?? [];
  }

  inject(ctx: { tags: string[]; changedFiles: string[]; categories: string[] }): string {
    const entries = this.snapshotEntries();
    const sel = selectBrainEntries(entries, { ...ctx, maxTokens: this.opts.maxTokens });
    if (sel.length === 0) return "";
    return sel
      .map((e) => `- ${e.title}: ${e.body}  [Source: ${e.id} · ${e.type} · ${e.scope}]`)
      .join("\n");
  }
}
```

- [ ] **Step 4: Run to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add src/core/brain/engine.ts tests/unit/brain-engine.test.ts && git commit -m "feat(brain): BrainEngine snapshot pin + injection text"`

---

## Task 6: OpenRouter embeddings + cosine + Embedder interface

**Files:**
- Create: `src/core/brain/embeddings.ts`
- Modify: `src/providers/openrouter.ts`
- Test: `tests/unit/brain-embeddings.test.ts`

- [ ] **Step 1: Write the failing test** (cosine is pure; the adapter `embed()` is tested with an injected fake `fetchImpl`)
```typescript
// tests/unit/brain-embeddings.test.ts
import { describe, expect, it } from "bun:test";
import { cosineSimilarity } from "../../src/core/brain/embeddings.ts";
import { OpenRouterAdapter } from "../../src/providers/openrouter.ts";

describe("embeddings", () => {
  it("cosineSimilarity is 1 for identical, ~0 for orthogonal", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it("OpenRouterAdapter.embed posts to /embeddings and returns vectors", async () => {
    const fake = (async (url: string, init: RequestInit) => {
      expect(String(url)).toContain("/api/v1/embeddings");
      expect(JSON.parse(String(init.body)).input).toEqual(["a", "b"]);
      return new Response(JSON.stringify({ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const a = new OpenRouterAdapter({ fetchImpl: fake });
    const vecs = await a.embed(["a", "b"], { model: "m", apiKeyEnv: "OPENROUTER_API_KEY", timeoutMs: 5000 });
    expect(vecs).toEqual([[1, 2], [3, 4]]);
  });

  it("embed throws on non-200 (fail-closed: caller must treat as undeduplicatable)", async () => {
    const fake = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const a = new OpenRouterAdapter({ fetchImpl: fake });
    await expect(a.embed(["x"], { model: "m", apiKeyEnv: "OPENROUTER_API_KEY", timeoutMs: 5000 })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3a: Implement cosine + interface**
```typescript
// src/core/brain/embeddings.ts
export interface Embedder {
  embed(texts: string[], cfg: { model: string; apiKeyEnv?: string; timeoutMs: number }): Promise<number[][]>;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
```

- [ ] **Step 3b: Add `embed()` to OpenRouterAdapter** (`src/providers/openrouter.ts`) — reuse `this.fetchImpl` + the same auth pattern as `review()`:
```typescript
// add near the class top:
const EMBEDDINGS_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";

// add as a public method on OpenRouterAdapter:
async embed(
  texts: string[],
  cfg: { model: string; apiKeyEnv?: string; timeoutMs: number },
): Promise<number[][]> {
  const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
  if (!key) throw new Error("OpenRouter embed: missing API key");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const resp = await this.fetchImpl(EMBEDDINGS_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: cfg.model, input: texts }),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`OpenRouter embeddings HTTP ${resp.status}`);
    const json = (await resp.json()) as { data?: Array<{ embedding?: number[] }> };
    const vecs = (json.data ?? []).map((d) => d.embedding ?? []);
    if (vecs.length !== texts.length || vecs.some((v) => v.length === 0)) {
      throw new Error("OpenRouter embeddings: malformed/empty response");
    }
    return vecs;
  } finally {
    clearTimeout(timer);
  }
}
```
> `OpenRouterAdapter` now implements `Embedder` structurally. Keep `implements ProviderAdapter`; do NOT add `implements Embedder` (avoid an import cycle) — the curator accepts an `Embedder`.

- [ ] **Step 4: Run to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add src/core/brain/embeddings.ts src/providers/openrouter.ts tests/unit/brain-embeddings.test.ts && git commit -m "feat(brain): OpenRouter embeddings + cosine similarity"`

---

## Task 7: SSRF-resistant fetcher (Spike SM4-2 acceptance gates)

**Files:**
- Create: `src/core/brain/fetcher.ts`
- Test: `tests/unit/brain-fetcher.test.ts`

**Contract:** `safeFetch(rawUrl, opts) → { ok: true, body, sha256, finalUrl, log } | { ok: false, reason, log }`. Never throws. Enforces every SM4-2 gate.

- [ ] **Step 1: Write the failing test** (inject a fake `fetchImpl` + a fake DNS resolver so no real network is hit)
```typescript
// tests/unit/brain-fetcher.test.ts
import { describe, expect, it } from "bun:test";
import { safeFetch } from "../../src/core/brain/fetcher.ts";

const allow = ["docs.example.com"];
const okFetch = (async () =>
  new Response("hello docs", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;

describe("safeFetch SSRF gates", () => {
  it("rejects non-HTTPS", async () => {
    const r = await safeFetch("http://docs.example.com/x", { allow, fetchImpl: okFetch, resolve: async () => ["1.2.3.4"] });
    expect(r.ok).toBe(false);
  });
  it("rejects a host not on the allowlist", async () => {
    const r = await safeFetch("https://evil.com/x", { allow, fetchImpl: okFetch, resolve: async () => ["1.2.3.4"] });
    expect(r.ok).toBe(false);
  });
  it("rejects when DNS resolves to a private/metadata IP", async () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "192.168.1.1", "::1"]) {
      const r = await safeFetch("https://docs.example.com/x", { allow, fetchImpl: okFetch, resolve: async () => [ip] });
      expect(r.ok).toBe(false);
    }
  });
  it("strips query and caps length, fetches an allowed public host, returns sha256", async () => {
    const r = await safeFetch("https://docs.example.com/page?leak=secret", {
      allow, fetchImpl: okFetch, resolve: async () => ["93.184.216.34"],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.finalUrl).toBe("https://docs.example.com/page"); // query stripped
      expect(r.sha256).toHaveLength(64);
      expect(r.body).toContain("hello docs");
    }
  });
  it("rejects oversize / disallowed content-type", async () => {
    const big = (async () =>
      new Response("x".repeat(10_000_000), { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    const r = await safeFetch("https://docs.example.com/x", { allow, fetchImpl: big, resolve: async () => ["93.184.216.34"], maxBytes: 1000 });
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**
```typescript
// src/core/brain/fetcher.ts
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export interface EgressLog {
  url: string;
  final_url?: string;
  resolved_ip?: string;
  status?: number;
  bytes?: number;
  sha256?: string;
  decision: "allow" | "deny";
  reason?: string;
}
export type SafeFetchResult =
  | { ok: true; body: string; sha256: string; finalUrl: string; log: EgressLog }
  | { ok: false; reason: string; log: EgressLog };

export interface SafeFetchOpts {
  allow: string[]; // exact host allowlist
  fetchImpl?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
}

const ALLOWED_CT = ["text/html", "text/plain", "application/json"];
const MAX_URL = 512;

function isBlockedIp(ip: string): boolean {
  if (ip === "::1") return true;
  if (ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true; // link-local / ULA
  const m = ip.split(".").map((n) => Number.parseInt(n, 10));
  if (m.length !== 4 || m.some((n) => Number.isNaN(n))) return isIP(ip) === 6 ? true : true; // unknown → block
  const [a, b] = m as [number, number, number, number];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local + metadata
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

export async function safeFetch(rawUrl: string, opts: SafeFetchOpts): Promise<SafeFetchResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const resolve = opts.resolve ?? (async (h: string) => (await lookup(h, { all: true })).map((r) => r.address));
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const deny = (reason: string): SafeFetchResult => ({ ok: false, reason, log: { url: rawUrl, decision: "deny", reason } });

  if (rawUrl.length > MAX_URL) return deny("url too long");
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return deny("unparseable url");
  }
  if (u.protocol !== "https:") return deny("non-https");
  if (!opts.allow.includes(u.hostname)) return deny(`host not allowlisted: ${u.hostname}`);
  u.search = ""; // strip query (egress content channel)
  u.hash = "";

  let ips: string[];
  try {
    ips = await resolve(u.hostname);
  } catch {
    return deny("dns failure");
  }
  if (ips.length === 0 || ips.some(isBlockedIp)) return deny("resolves to blocked ip");
  const pinnedIp = ips[0] as string;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(u.toString(), {
      method: "GET",
      redirect: "manual", // we re-validate each hop ourselves
      headers: { Accept: ALLOWED_CT.join(",") },
      signal: controller.signal,
    });
    if (resp.status >= 300 && resp.status < 400) {
      return deny("redirect not followed (re-validate disabled in M4 single-hop)"); // see note
    }
    if (!resp.ok) return deny(`http ${resp.status}`);
    const ct = (resp.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    if (!ALLOWED_CT.includes(ct)) return deny(`content-type ${ct}`);
    const body = await resp.text();
    if (body.length > maxBytes) return deny("body too large");
    const sha256 = createHash("sha256").update(body).digest("hex");
    return {
      ok: true,
      body,
      sha256,
      finalUrl: u.toString(),
      log: { url: rawUrl, final_url: u.toString(), resolved_ip: pinnedIp, status: resp.status, bytes: body.length, sha256, decision: "allow" },
    };
  } catch (err) {
    return deny(`fetch failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}
```
> **Redirect note:** M4 uses `redirect:"manual"` and treats ANY 3xx as a deny (simplest safe default — docs pages we allowlist are stable canonical URLs). If a later iteration needs redirect-following, add per-hop re-validation (re-run the allowlist + IP checks on each `Location`, capped at `maxRedirects`). This satisfies SM4-2's "per-hop re-validation" by denying rather than blindly following.

- [ ] **Step 4: Run to verify it passes** — PASS. Then run the SM4-2 manual binary checks.
- [ ] **Step 5: Commit** — `git add src/core/brain/fetcher.ts tests/unit/brain-fetcher.test.ts && git commit -m "feat(brain): SSRF-resistant safeFetch (SM4-2 gates)"`

---

## Task 8: Two-stage web-fetch evidence enrichment

**Files:**
- Create: `src/core/brain/enrich.ts`
- Test: `tests/unit/brain-enrich.test.ts`

**Behavior:** for each proposal, any evidence item carrying a `source_url` but not yet a `body_sha256` is a *citation*. `enrichProposal()` calls `safeFetch`; on success it rewrites that item to a schema-valid `kind:'web-fetch'` record (adds `body_sha256` + `fetched_at`), persists the body as a content-addressed snapshot under `brainSnapshotsDir`, and appends an egress log line. On failure it DROPS the item. The enriched proposal is then schema-validated (rule 1 in Task 9).

- [ ] **Step 1: Write the failing test**
```typescript
// tests/unit/brain-enrich.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enrichProposal } from "../../src/core/brain/enrich.ts";
import type { MemoryProposal } from "../../src/schemas/brain.ts";

const okFetch = (async () =>
  new Response("doc body", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;

function proposal(): MemoryProposal {
  return {
    type: "external-knowledge", scope: "framework-next", title: "use cache directive",
    body: "Next 16 uses `use cache`.", confidence: 0.7, tags: ["next"],
    evidence: [
      { kind: "reviewer-observation", run_id: "r", reviewer_id: "codex", source_url: "https://docs.example.com/use-cache" },
    ],
  };
}

describe("enrichProposal", () => {
  it("turns a cited source_url into a web-fetch evidence record with hash + snapshot", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-enr-"));
    const { enriched, egress } = await enrichProposal(repo, proposal(), {
      allow: ["docs.example.com"], fetchImpl: okFetch, resolve: async () => ["93.184.216.34"],
    });
    const web = enriched.evidence.find((e) => e.kind === "web-fetch");
    expect(web?.body_sha256).toHaveLength(64);
    expect(web?.fetched_at).toBeTruthy();
    expect(egress.length).toBe(1);
    expect(existsSync(join(repo, ".reviewgate/brain/snapshots", `${web?.body_sha256}`))).toBe(true);
  });

  it("drops the citation when the fetch is denied", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-enr2-"));
    const p = proposal();
    p.evidence[0]!.source_url = "https://evil.com/x";
    const { enriched } = await enrichProposal(repo, p, { allow: ["docs.example.com"], fetchImpl: okFetch, resolve: async () => ["1.2.3.4"] });
    expect(enriched.evidence.some((e) => e.kind === "web-fetch")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**
```typescript
// src/core/brain/enrich.ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryProposal } from "../../schemas/brain.ts";
import { brainSnapshotsDir } from "../../utils/paths.ts";
import { safeFetch, type EgressLog, type SafeFetchOpts } from "./fetcher.ts";

export async function enrichProposal(
  repoRoot: string,
  proposal: MemoryProposal,
  fetchOpts: SafeFetchOpts,
): Promise<{ enriched: MemoryProposal; egress: EgressLog[] }> {
  const egress: EgressLog[] = [];
  const evidence = [];
  for (const item of proposal.evidence) {
    const isCitation = item.source_url && item.kind !== "web-fetch" && !item.body_sha256;
    if (!isCitation) {
      evidence.push(item);
      continue;
    }
    const res = await safeFetch(item.source_url as string, fetchOpts);
    egress.push(res.log);
    if (!res.ok) continue; // drop the citation; fall back to LLM quorum
    const dir = brainSnapshotsDir(repoRoot);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, res.sha256), res.body, { mode: 0o600 });
    evidence.push({
      kind: "web-fetch" as const,
      source_url: res.finalUrl,
      body_sha256: res.sha256,
      fetched_at: new Date().toISOString(),
      ...(item.snippet ? { snippet: item.snippet } : {}),
    });
  }
  return { enriched: { ...proposal, evidence }, egress };
}
```

- [ ] **Step 4: Run to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add src/core/brain/enrich.ts tests/unit/brain-enrich.test.ts && git commit -m "feat(brain): two-stage web-fetch evidence enrichment + content-addressed snapshots"`

---

## Task 9: Curator — the seven rules + lifecycle promotion

**Files:**
- Create: `src/core/brain/curator.ts`
- Test: `tests/unit/brain-curator.test.ts`

**`runCurator(input)` evaluates each enriched proposal against §5.6 rules 1–7, in order, and returns promotions + decisions. Deps are injected (store, embedder, nowIso) for testability. Fail-closed on embedding errors (rule 4).**

Rules:
1. Schema-conform (`MemoryProposalSchema.safeParse`).
2. Source quorum: ≥1 `web-fetch` evidence (deterministic) OR ≥3 `reviewer-*` evidence spanning ≥2 distinct providers (provider = `reviewer_id` prefix before `-`).
3. Consistency: no existing active entry with the same `title` and a *contradictory* body (M4: reject if an active entry has the same normalized title — contradiction resolution needs the user, §5.6).
4. Dedup: embed `title+body`, cosine ≥ 0.85 vs any existing entry's embedding → duplicate (merge: bump `referenced_count`). **Embedding failure → queue (do not promote).**
5. Scope plausibility: reject `universal`/`language-*` scope when all reviewer evidence is from one language sample (M4 heuristic: reject scope starting with `universal`).
6. Diff-derived: if any evidence has `from_diff`, require DOUBLED quorum (rule 2 thresholds ×2: ≥2 web-fetch OR ≥6 reviewer evidence / ≥2 providers) and tag `provenance:'diff-derived'`.
7. Rate limit: at most 3 promotions per run; excess → queued.

- [ ] **Step 1: Write the failing test**
```typescript
// tests/unit/brain-curator.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainStore } from "../../src/core/brain/store.ts";
import { runCurator } from "../../src/core/brain/curator.ts";
import type { MemoryProposal } from "../../src/schemas/brain.ts";
import type { Embedder } from "../../src/core/brain/embeddings.ts";

const fakeEmbedder = (vec: number[]): Embedder => ({ embed: async (t) => t.map(() => vec) });

function p(over: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    type: "convention", scope: "this-repo", title: "t", body: "b", confidence: 0.8, tags: [],
    evidence: [
      { kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-security" },
      { kind: "reviewer-finding", run_id: "r", reviewer_id: "gemini-architecture" },
      { kind: "reviewer-finding", run_id: "r", reviewer_id: "claude-adversarial" },
    ],
    ...over,
  };
}

describe("runCurator", () => {
  it("promotes a 3-citation / ≥2-provider proposal as a candidate", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur-"));
    const store = new BrainStore(repo);
    const res = await runCurator({ repoRoot: repo, runId: "r", proposals: [p()], store, embedder: fakeEmbedder([1, 0]), nowIso: "2026-05-21T00:00:00Z" });
    expect(res.promoted).toBe(1);
    expect((await store.snapshot()).entries[0]?.status).toBe("candidate");
  });

  it("rejects a single-provider quorum (anti-collusion rule 2)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur2-"));
    const store = new BrainStore(repo);
    const single = p({ evidence: [
      { kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-security" },
      { kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-architecture" },
      { kind: "reviewer-finding", run_id: "r", reviewer_id: "codex-adversarial" },
    ]});
    const res = await runCurator({ repoRoot: repo, runId: "r", proposals: [single], store, embedder: fakeEmbedder([1, 0]), nowIso: "t" });
    expect(res.promoted).toBe(0);
  });

  it("merges a near-duplicate (cosine ≥ 0.85) instead of adding a new entry", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur3-"));
    const store = new BrainStore(repo);
    await runCurator({ repoRoot: repo, runId: "r1", proposals: [p({ title: "x" })], store, embedder: fakeEmbedder([1, 0]), nowIso: "t" });
    const res = await runCurator({ repoRoot: repo, runId: "r2", proposals: [p({ title: "x2" })], store, embedder: fakeEmbedder([1, 0]), nowIso: "t" });
    expect(res.promoted).toBe(0);
    expect((await store.snapshot()).entries.length).toBe(1);
    expect((await store.snapshot()).entries[0]?.referenced_count).toBe(2);
  });

  it("caps promotions at 3 per run and queues the rest", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur4-"));
    const store = new BrainStore(repo);
    // 4 distinct (orthogonal vectors so no dedup) proposals
    const embedder: Embedder = { embed: async (t) => t.map((s) => (s.includes("p4") ? [0, 1] : [1, 0])) };
    const props = [0,1,2,3].map((i) => p({ title: `p${i}`, body: `body ${i}` }));
    const res = await runCurator({ repoRoot: repo, runId: "r", proposals: props, store, embedder, nowIso: "t" });
    expect(res.promoted).toBeLessThanOrEqual(3);
    expect(res.queued).toBeGreaterThanOrEqual(1);
  });

  it("fails closed when embedding errors (queues, does not promote)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur5-"));
    const store = new BrainStore(repo);
    const boom: Embedder = { embed: async () => { throw new Error("embeddings down"); } };
    const res = await runCurator({ repoRoot: repo, runId: "r", proposals: [p()], store, embedder: boom, nowIso: "t" });
    expect(res.promoted).toBe(0);
    expect(res.queued).toBe(1);
  });

  it("hybrid: a configured LLM judge can reject a proposal that passed the deterministic gates", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur-judge-"));
    const store = new BrainStore(repo);
    const rejectJudge = async () => ({ accept: false, reason: "contradicts existing convention" });
    const res = await runCurator({ repoRoot: repo, runId: "r", proposals: [p()], store, embedder: fakeEmbedder([1, 0]), nowIso: "t", judge: rejectJudge });
    expect(res.promoted).toBe(0);
    expect(res.rejected).toBe(1);
  });

  it("requires doubled quorum for diff-derived proposals", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cur6-"));
    const store = new BrainStore(repo);
    const diffDerived = p({ evidence: [
      { kind: "reviewer-observation", run_id: "r", reviewer_id: "codex-security", from_diff: { file: "a.ts", line_start: 1, line_end: 2 } },
      { kind: "reviewer-observation", run_id: "r", reviewer_id: "gemini-arch", from_diff: { file: "a.ts", line_start: 1, line_end: 2 } },
      { kind: "reviewer-observation", run_id: "r", reviewer_id: "claude-x", from_diff: { file: "a.ts", line_start: 1, line_end: 2 } },
    ]});
    const res = await runCurator({ repoRoot: repo, runId: "r", proposals: [diffDerived], store, embedder: fakeEmbedder([1, 0]), nowIso: "t" });
    expect(res.promoted).toBe(0); // 3 < doubled threshold (6)
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**
```typescript
// src/core/brain/curator.ts
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BrainEntrySchema, MemoryProposalSchema, type BrainEntry, type MemoryProposal } from "../../schemas/brain.ts";
import { curatorDecisionsPath } from "../../utils/paths.ts";
import type { BrainStore } from "./store.ts";
import { cosineSimilarity, type Embedder } from "./embeddings.ts";

const DEDUP_THRESHOLD = 0.85;
const MAX_PROMOTIONS = 3;

export interface CuratorInput {
  repoRoot: string;
  runId: string;
  proposals: MemoryProposal[];
  store: BrainStore;
  embedder: Embedder;
  embedCfg?: { model: string; apiKeyEnv?: string; timeoutMs: number };
  nowIso: string;
  // Hybrid: optional LLM judgment (only when phases.brain.curator is configured).
  // Runs AFTER the deterministic gates pass, on rules 3 (consistency) + 5 (scope/
  // quality). Rejecting drops the proposal; a judge error fails closed (queue).
  judge?: (proposal: MemoryProposal) => Promise<{ accept: boolean; reason?: string }>;
}
export interface CuratorResult {
  promoted: number;
  rejected: number;
  queued: number;
  merged: number;
}

function providers(p: MemoryProposal): Set<string> {
  const s = new Set<string>();
  for (const e of p.evidence) if (e.reviewer_id) s.add(e.reviewer_id.split("-")[0] ?? e.reviewer_id);
  return s;
}
function quorumOk(p: MemoryProposal, doubled: boolean): boolean {
  const web = p.evidence.filter((e) => e.kind === "web-fetch").length;
  const reviewerEv = p.evidence.filter((e) => e.kind === "reviewer-finding" || e.kind === "reviewer-observation").length;
  const provs = providers(p).size;
  const webNeed = doubled ? 2 : 1;
  const revNeed = doubled ? 6 : 3;
  if (web >= webNeed) return true;
  return reviewerEv >= revNeed && provs >= 2;
}
function isDiffDerived(p: MemoryProposal): boolean {
  return p.evidence.some((e) => e.from_diff);
}
function logDecision(repoRoot: string, line: object): void {
  const path = curatorDecisionsPath(repoRoot, (line as { run_id: string }).run_id);
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
}

export async function runCurator(input: CuratorInput): Promise<CuratorResult> {
  const res: CuratorResult = { promoted: 0, rejected: 0, queued: 0, merged: 0 };
  const cfg = input.embedCfg ?? { model: "embed", timeoutMs: 8000 };
  const log = (decision: string, title: string, extra: Record<string, unknown> = {}) =>
    logDecision(input.repoRoot, { schema: "reviewgate.curator.v1", run_id: input.runId, proposal_title: title, decision, provider: "curator", ts: input.nowIso, ...extra });

  for (const proposal of input.proposals) {
    if (res.promoted >= MAX_PROMOTIONS) {
      res.queued++; log("queued", proposal.title, { rule_failed: "rate-limit" }); continue;
    }
    // Rule 1: schema
    if (!MemoryProposalSchema.safeParse(proposal).success) {
      res.rejected++; log("rejected", proposal.title, { rule_failed: "schema" }); continue;
    }
    // Rule 5: scope plausibility (M4 heuristic)
    if (proposal.scope.startsWith("universal")) {
      res.rejected++; log("rejected", proposal.title, { rule_failed: "scope" }); continue;
    }
    // Rule 6 + 2: (doubled) quorum
    const doubled = isDiffDerived(proposal);
    if (!quorumOk(proposal, doubled)) {
      res.rejected++; log("rejected", proposal.title, { rule_failed: doubled ? "diff-quorum" : "quorum" }); continue;
    }
    // Rule 4: dedup (fail-closed)
    let vec: number[];
    try {
      [vec] = await input.embedder.embed([`${proposal.title}\n${proposal.body}`], cfg) as [number[]];
    } catch {
      res.queued++; log("queued", proposal.title, { rule_failed: "embed-error" }); continue;
    }
    const snap = await input.store.snapshot();
    // Rule 3: consistency (same title already active)
    if (snap.entries.some((e) => e.status === "active" && e.title === proposal.title)) {
      res.rejected++; log("rejected", proposal.title, { rule_failed: "consistency" }); continue;
    }
    const dup = snap.entries.find((e) => e.embedding && cosineSimilarity(e.embedding, vec ?? []) >= DEDUP_THRESHOLD);
    if (dup) {
      await input.store.mutate((s) => {
        const t = s.entries.find((x) => x.id === dup.id);
        if (t) { t.referenced_count += 1; t.last_referenced_at = input.nowIso; }
        return { next: s, result: undefined };
      });
      res.merged++; log("merged-duplicate", proposal.title, { entry_id: dup.id }); continue;
    }
    // Hybrid: optional LLM judgment on the fuzzy rules (consistency/scope/quality).
    if (input.judge) {
      let verdict: { accept: boolean; reason?: string };
      try {
        verdict = await input.judge(proposal);
      } catch {
        res.queued++; log("queued", proposal.title, { rule_failed: "judge-error" }); continue;
      }
      if (!verdict.accept) {
        res.rejected++; log("rejected", proposal.title, { rule_failed: "llm-judge" }); continue;
      }
    }
    // Promote as candidate
    const id = await input.store.nextId();
    const entry: BrainEntry = BrainEntrySchema.parse({
      id, type: proposal.type, scope: proposal.scope, title: proposal.title, body: proposal.body,
      tags: proposal.tags, file_globs: proposal.evidence.flatMap((e) => (e.from_diff ? [e.from_diff.file] : [])),
      status: "candidate", referenced_count: 1, referencing_reviewers: [], confidence: proposal.confidence,
      embedding: vec ?? null, evidence: proposal.evidence, created_at: input.nowIso, source_run_id: input.runId,
      ...(doubled ? { provenance: "diff-derived" as const } : {}),
    });
    await input.store.add(entry);
    res.promoted++; log("promoted", proposal.title, { entry_id: id });
  }
  return res;
}
```

- [ ] **Step 4: Run to verify it passes** — PASS (all 6 tests).
- [ ] **Step 5: Commit** — `git add src/core/brain/curator.ts tests/unit/brain-curator.test.ts && git commit -m "feat(brain): Curator 7-rule validation (anti-collusion, diff-quorum, fail-closed dedup, rate-limit)"`

---

## Task 10: Lifecycle decay (candidate→active→stale→archived)

**Files:**
- Modify: `src/core/brain/curator.ts` (add `decayPass`) — or `src/core/brain/lifecycle.ts`
- Test: `tests/unit/brain-lifecycle.test.ts`

**Rules:** promotion to `active` after `referenced_count ≥ 3` AND `referencing_reviewers.length ≥ 3`; `active`/`candidate` → `stale` after 90 days since `last_referenced_at` (or `created_at`); `stale` → `archived` (moved out of `brain.json`, appended to `archive.md`) after 180 more days. `decayPass(nowIso)` runs at the start of the Curator phase.

- [ ] **Step 1: Write the failing test**
```typescript
// tests/unit/brain-lifecycle.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainStore } from "../../src/core/brain/store.ts";
import { decayPass } from "../../src/core/brain/lifecycle.ts";
import { brainArchivePath } from "../../src/utils/paths.ts";
import type { BrainEntry } from "../../src/schemas/brain.ts";

const mk = (o: Partial<BrainEntry>): BrainEntry => ({
  id: "B-1", type: "convention", scope: "this-repo", title: "t", body: "b", tags: [], file_globs: [],
  status: "candidate", referenced_count: 1, referencing_reviewers: [], confidence: 0.9, embedding: null,
  evidence: [{ kind: "reviewer-finding", run_id: "r", reviewer_id: "codex" }],
  created_at: "2026-01-01T00:00:00Z", source_run_id: "r", ...o,
});

describe("decayPass", () => {
  it("stales an entry untouched for >90 days and archives a stale one >180 more", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-life-"));
    const store = new BrainStore(repo);
    await store.add(mk({ id: "B-1", status: "active", last_referenced_at: "2026-01-01T00:00:00Z" }));
    await store.add(mk({ id: "B-2", status: "stale", last_referenced_at: "2025-06-01T00:00:00Z" }));
    await decayPass(store, repo, "2026-05-21T00:00:00Z");
    const snap = await store.snapshot();
    expect(snap.entries.find((e) => e.id === "B-1")?.status).toBe("stale");
    expect(snap.entries.find((e) => e.id === "B-2")).toBeUndefined(); // archived out
    expect(existsSync(brainArchivePath(repo)) && readFileSync(brainArchivePath(repo), "utf8")).toContain("B-2");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**
```typescript
// src/core/brain/lifecycle.ts
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { BrainEntry } from "../../schemas/brain.ts";
import { brainArchivePath } from "../../utils/paths.ts";
import type { BrainStore } from "./store.ts";

const DAY = 86_400_000;

export function promoteIfReferenced(e: BrainEntry): BrainEntry {
  if (e.status === "candidate" && e.referenced_count >= 3 && e.referencing_reviewers.length >= 3) {
    return { ...e, status: "active" };
  }
  return e;
}

export async function decayPass(store: BrainStore, repoRoot: string, nowIso: string): Promise<void> {
  const now = Date.parse(nowIso);
  await store.mutate((snap) => {
    const archived: BrainEntry[] = [];
    const kept: BrainEntry[] = [];
    for (const e of snap.entries) {
      const last = Date.parse(e.last_referenced_at ?? e.created_at);
      const ageDays = (now - last) / DAY;
      let next = promoteIfReferenced(e);
      if ((next.status === "active" || next.status === "candidate") && ageDays > 90) next = { ...next, status: "stale" };
      if (next.status === "stale" && ageDays > 270) { archived.push(next); continue; }
      kept.push(next);
    }
    if (archived.length > 0) {
      const p = brainArchivePath(repoRoot);
      if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
      appendFileSync(p, archived.map((e) => `- ${e.id} (${e.type}) ${e.title}\n`).join(""), { mode: 0o600 });
    }
    snap.entries = kept;
    return { next: snap, result: undefined };
  });
}
```
> Note `decayPass` performs file I/O (archive append) inside `mutate`'s lock — acceptable (the lock guards brain.json; archive.md append is additive). The 270-day total = 90 (to stale) + 180 (more) matches §5.6.

- [ ] **Step 4: Run to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add src/core/brain/lifecycle.ts tests/unit/brain-lifecycle.test.ts && git commit -m "feat(brain): lifecycle decay (candidate→active→stale→archived)"`

---

## Task 11: memory_proposals[] on review output

**Files:**
- Modify: `src/providers/review-output.ts`, `src/schemas/finding.ts` (no change needed — proposals ride alongside, not on Finding), `src/core/orchestrator.ts` (REVIEW_PROMPT_PREAMBLE)
- Test: `tests/unit/review-output-proposals.test.ts`

**Approach:** add an optional `memory_proposals` to the parsed `ReviewOutput`; the orchestrator collects them per reviewer (tagging each evidence item with `run_id` + `reviewer_id`). Update the preamble so reviewers know the optional shape.

- [ ] **Step 1: Write the failing test**
```typescript
// tests/unit/review-output-proposals.test.ts
import { describe, expect, it } from "bun:test";
import { parseReviewOutput } from "../../src/providers/review-output.ts";

describe("parseReviewOutput memory_proposals", () => {
  it("parses an optional memory_proposals array", () => {
    const out = parseReviewOutput(JSON.stringify({
      verdict: "PASS", findings: [],
      memory_proposals: [{ type: "convention", scope: "this-repo", title: "t", body: "b", confidence: 0.7, tags: ["x"], evidence: [{ kind: "reviewer-observation" }] }],
    }));
    expect(out?.memory_proposals?.length).toBe(1);
    expect(out?.memory_proposals?.[0]?.title).toBe("t");
  });
  it("tolerates missing memory_proposals (undefined, not error)", () => {
    const out = parseReviewOutput(JSON.stringify({ verdict: "PASS", findings: [] }));
    expect(out?.memory_proposals).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement** — in `src/providers/review-output.ts`:
  - Add to `ReviewOutput`: `memory_proposals?: RawProposal[];` where `RawProposal` mirrors the reviewer-submitted (pre-enrichment) proposal shape (`{type,scope,title,body,confidence,tags,evidence:Array<{kind,source_url?,snippet?,from_diff?}>}`).
  - In `tryParse`, after building findings: `const mp = Array.isArray(o.memory_proposals) ? o.memory_proposals : undefined;` and include it in the return when present.
  - Append to `REVIEW_PROMPT_PREAMBLE` (orchestrator.ts): a short optional block:
```typescript
// appended lines:
'You MAY also include an optional "memory_proposals" array of repo-knowledge you',
'are confident about (≥0.5). Each: {"type":"convention|anti-pattern|external-knowledge|disagreement",',
'"scope":"this-repo|language-<x>|framework-<x>","title":"<=80","body":"<=500","confidence":0..1,',
'"tags":[...],"evidence":[{"kind":"reviewer-observation","snippet":"..."}|{"kind":"reviewer-observation","source_url":"https://..."}]}.',
'Cite a source_url for external facts; do NOT fabricate hashes.',
```

- [ ] **Step 4: Run to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add src/providers/review-output.ts src/core/orchestrator.ts tests/unit/review-output-proposals.test.ts && git commit -m "feat(brain): parse memory_proposals[] + preamble"`

---

## Task 12: Config — phases.brain block

**Files:**
- Modify: `src/config/define-config.ts`, `src/config/defaults.ts`
- Test: `tests/unit/config-brain.test.ts`

- [ ] **Step 1: Write the failing test**
```typescript
// tests/unit/config-brain.test.ts
import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";

describe("brain config", () => {
  it("defaults brain to null (off)", () => {
    expect(defineConfig({}).phases.brain).toBeNull();
  });
  it("accepts a brain block with curator + embeddings", () => {
    const c = defineConfig({
      phases: { brain: {
        enabled: true, maxPromptTokens: 1500,
        curator: { provider: "claude-code", persona: "curator" },
        embeddings: { provider: "openrouter", model: "qwen/qwen3-embedding-8b" },
        egressAllowlist: ["docs.example.com"],
      } },
    } as Parameters<typeof defineConfig>[0]);
    expect(c.phases.brain?.enabled).toBe(true);
    expect(c.phases.brain?.embeddings?.model).toContain("embedding");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement** — add to the `phases` zod object in `define-config.ts`:
```typescript
brain: z
  .object({
    enabled: z.boolean(),
    maxPromptTokens: z.number().int().positive().default(1500),
    curator: z.object({ provider: ProviderId, model: z.string().optional(), persona: z.string() }).optional(), // hybrid: optional LLM judge
    embeddings: z.object({ provider: z.literal("openrouter"), model: z.string().default("baai/bge-base-en-v1.5"), apiKeyEnv: z.string().default("OPENROUTER_API_KEY") }),
    egressAllowlist: z.array(z.string()).default([]),
    curatorTimeoutMs: z.number().int().positive().default(20_000),
  })
  .nullable()
  .default(null),
```
  And add the matching `brain: null as null | { … }` shape to `defaults.ts`'s `phases` block (mirror the inline type).

- [ ] **Step 4: Run to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add src/config/define-config.ts src/config/defaults.ts tests/unit/config-brain.test.ts && git commit -m "feat(brain): phases.brain config (curator + embeddings + egress allowlist)"`

---

## Task 13: Audit events

**Files:**
- Modify: `src/schemas/audit-event.ts`
- Test: `tests/unit/audit-brain-events.test.ts`

- [ ] **Step 1: Write the failing test**
```typescript
// tests/unit/audit-brain-events.test.ts
import { describe, expect, it } from "bun:test";
import { EventType } from "../../src/schemas/audit-event.ts";

describe("audit brain events", () => {
  it("includes curator + egress event types", () => {
    expect(EventType.options).toContain("curator.start");
    expect(EventType.options).toContain("curator.complete");
    expect(EventType.options).toContain("brain.egress");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.
- [ ] **Step 3: Implement** — add `"curator.start"`, `"curator.complete"`, `"brain.egress"` to the `EventType` enum in `src/schemas/audit-event.ts`.
- [ ] **Step 4: Run to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(brain): curator + egress audit event types"`

---

## Task 14: Wire the Curator phase + brain injection into the orchestrator

**Files:**
- Modify: `src/core/orchestrator.ts`
- Test: extend `tests/integration/brain-curator.test.ts` (Task 15 holds the full integration test; this task makes it green)

**14a — Brain injection (read path).** At the prompt-assembly point (after `if (researchText)`, before `promptParts.push(sanitised.text)`):
```typescript
if (this.brainText) promptParts.push("## Brain context", this.brainText, "");
```
Where `this.brainText` is computed once per `runIteration` (before the reviewer loop) when `config.phases.brain?.enabled`:
```typescript
let brainText = "";
const brainCfg = this.input.config.phases.brain;
let brainEngine: BrainEngine | undefined;
if (brainCfg?.enabled) {
  brainEngine = new BrainEngine(new BrainStore(repo), { maxTokens: brainCfg.maxPromptTokens });
  await brainEngine.pin();
  brainText = brainEngine.inject({
    tags: triage.tags ?? [],            // from the M3 triage result
    changedFiles: facts.files,          // from computeDiffFacts
    categories: [],
  });
}
```
> The pinned snapshot's active-entry hash should also feed the M3 cache key (add `brainActiveHash` to the cache-key input). If wiring the cache key is non-trivial, the implementer adds `brainEngine.snapshotEntries()` ids+statuses to the existing cache-key string. Keep it deterministic.

**14b — Curator phase (write path).** After `writeReport(...)` and BEFORE the cache store / return, when `brainCfg?.enabled` and there are proposals:
```typescript
if (brainCfg?.enabled && proposals.length > 0) {
  const store = new BrainStore(repo);
  await decayPass(store, repo, new Date().toISOString());
  const embAdapter = this.input.adapters.openrouter as unknown as Embedder | undefined;
  if (embAdapter) {
    const enriched = [];
    for (const p of proposals) {
      const { enriched: e } = await enrichProposal(repo, p, { allow: brainCfg.egressAllowlist });
      enriched.push(e);
    }
    // Hybrid: build the optional LLM judge only when phases.brain.curator is set.
    // It calls the configured non-reviewer provider (critic-phase invocation
    // pattern) with a prompt asking accept/reject on rules 3 (consistency) + 5
    // (scope/quality), and parses {"accept":bool,"reason":"..."}.
    const curatorCfg = brainCfg.curator;
    const judge = curatorCfg
      ? async (prop: MemoryProposal) => {
          const adapter = this.input.adapters[curatorCfg.provider];
          const pcfg = this.input.config.providers[curatorCfg.provider];
          if (!adapter || !pcfg) return { accept: true }; // not available → don't block (gates already passed)
          // build a temp prompt file with the proposal + active brain titles; call adapter.review;
          // parse rawText for {"accept":true|false,"reason":"..."}; default accept on parse failure.
          return parseJudge(/* rawText */);
        }
      : undefined;
    await withTimeout(
      runCurator({
        repoRoot: repo, runId: opts.runId, proposals: enriched, store,
        embedder: embAdapter,
        embedCfg: { model: brainCfg.embeddings.model, apiKeyEnv: brainCfg.embeddings.apiKeyEnv, timeoutMs: brainCfg.curatorTimeoutMs },
        nowIso: new Date().toISOString(),
        ...(judge ? { judge } : {}),
      }),
      brainCfg.curatorTimeoutMs,
    ).catch(() => undefined); // best-effort: never affects the already-returned verdict
  }
}
```
- `proposals` is collected in the reviewer loop: for each OK reviewer result, parse `memory_proposals` from its `rawText`, stamp each evidence item with `run_id=opts.runId` + `reviewer_id=<reviewerId>`, drop any below confidence 0.5, and push.
- `withTimeout(promise, ms)` is a tiny helper (add to `src/utils/`): `Promise.race([p, new Promise((_,rej)=>setTimeout(()=>rej(new Error("curator timeout")), ms))])`.

- [ ] **Step 1–5:** Write a focused orchestrator test asserting (a) brain injection text appears in the assembled reviewer prompt when an active entry matches, and (b) a proposal emitted by a fake reviewer with a 3-provider quorum lands as a candidate in the store after `runIteration`. Use the existing `Orchestrator` test harness (fake adapters returning `rawText` with `memory_proposals`). Implement until green. Commit: `git commit -am "feat(brain): wire BrainEngine injection + non-blocking Curator P4 into orchestrator"`

---

## Task 15: Brain CLI (list / show / revoke)

**Files:**
- Create: `src/cli/commands/brain.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/unit/brain-cli.test.ts`

- [ ] **Step 1: Write the failing test**
```typescript
// tests/unit/brain-cli.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrainStore } from "../../src/core/brain/store.ts";
import { runBrainList, runBrainRevoke } from "../../src/cli/commands/brain.ts";

describe("brain CLI", () => {
  it("lists entries and revokes one", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cli-"));
    const store = new BrainStore(repo);
    await store.add({ id: "B-001", type: "convention", scope: "this-repo", title: "t", body: "b", tags: [], file_globs: [], status: "active", referenced_count: 1, referencing_reviewers: [], confidence: 0.9, embedding: null, evidence: [{ kind: "reviewer-finding", run_id: "r", reviewer_id: "codex" }], created_at: "2026-05-21T00:00:00Z", source_run_id: "r" });
    const lines: string[] = [];
    expect(await runBrainList({ repoRoot: repo, write: (s) => lines.push(s) })).toBe(0);
    expect(lines.join("")).toContain("B-001");
    expect(await runBrainRevoke({ repoRoot: repo, id: "B-001", write: () => {} })).toBe(0);
    expect((await store.snapshot()).entries.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL.
- [ ] **Step 3: Implement** `src/cli/commands/brain.ts` (`runBrainList`/`runBrainShow`/`runBrainRevoke`, each taking `{repoRoot, write?}` and returning an exit code, using `BrainStore`), then register the `brain` command in `src/cli/index.ts` following the `audit` subcommand pattern from the recon.
- [ ] **Step 4: Run to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add src/cli/commands/brain.ts src/cli/index.ts tests/unit/brain-cli.test.ts && git commit -m "feat(brain): reviewgate brain list/show/revoke CLI"`

---

## Task 16: gitignore + integration test + README

**Files:**
- Modify: `src/cli/commands/init.ts` (GITIGNORE_LINES), `README.md`
- Test: `tests/integration/brain-curator.test.ts`

- [ ] **Step 1:** Add to `init.ts` `GITIGNORE_LINES`: `.reviewgate/brain/proposals/` and `.reviewgate/brain/snapshots/` (committed: brain.json, brain.md, sources.jsonl, archive.md; gitignored: proposals/, snapshots/).
- [ ] **Step 2:** Write `tests/integration/brain-curator.test.ts`: a full `runIteration` (fake reviewers emitting a valid 3-provider proposal + a doc-only diff so triage runs the panel) that ends with the proposal promoted to a `candidate` in `brain.json`, and a SECOND `runIteration` whose reviewer prompt now contains the brain entry (read path closes the loop). Also assert a colluding single-provider proposal is NOT promoted.
- [ ] **Step 3:** README: add a "Brain & Curator (M4)" section — how to enable (`phases.brain`), what gets committed, the `reviewgate brain` CLI, and the egress allowlist. Move brain items from "Not yet (M4–M6)" into "In M4".
- [ ] **Step 4:** `bun test && bun run typecheck && bun run lint` all green.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(brain): gitignore, full P0→P4 integration test, README"`

---

## Task 17: Real e2e (gated)

**Files:**
- Create: `tests/e2e/brain-embeddings-real.test.ts`, `tests/e2e/brain-fetch-real.test.ts`

- [ ] Mirror the existing e2e pattern (`const E2E = process.env.REVIEWGATE_E2E === "1"`): one test does a REAL `OpenRouterAdapter.embed()` against the chosen model and asserts near-dupes ≥0.85 / unrelated <0.85; one does a REAL `safeFetch` against a known docs URL and asserts a 64-char sha256 + that a private-IP URL is denied. Skip when `REVIEWGATE_E2E !== "1"`.
- [ ] **Commit** — `git add tests/e2e/brain-*-real.test.ts && git commit -m "test(brain): real OpenRouter embeddings + web-fetch e2e (gated)"`

---

## Self-Review

**Spec coverage (§5.6 + M4 design doc):**
- Read path injection (tags/globs/category, priority, 1500-token budget, [Source:]) → Tasks 4, 5, 14a. ✓
- Per-run snapshot + cache-key consistency → Task 5 (`pin`) + Task 14a note. ✓
- memory_proposals[] + confidence floor 0.5 → Tasks 11, 14b. ✓
- Two-stage web-fetch evidence + Reviewgate-owned SSRF fetch + content-addressed snapshot → Tasks 7, 8. ✓
- 7 curator rules (schema, quorum/≥2 providers, consistency, dedup-0.85 fail-closed, scope, diff-derived doubled quorum, rate-limit-3) → Task 9. ✓
- Embeddings via OpenRouter, dedup-only, fail-closed → Tasks 6, 9. ✓
- Lifecycle candidate→active→stale→archived + decay → Task 10. ✓
- Locked/atomic brain store → Task 3. ✓
- Non-blocking, synchronous, timeout-bounded, best-effort Curator → Task 14b (`withTimeout` + `.catch`). ✓
- CLI list/show/revoke (user veto) → Task 15. ✓
- Storage + gitignore + audit events → Tasks 2, 13, 16. ✓
- Out of scope (persona-bias live, FP-Ledger) → recorded in curator-decisions, not surfaced. ✓

**Placeholder scan:** no TBD/TODO; every code step has runnable code. Task 14 is the one integration-heavy task and intentionally references the M3 triage/facts variables by name (`triage.tags`, `facts.files`) — the implementer confirms the exact local names when wiring (they exist in `runIteration`).

**Type consistency:** `BrainEntry`, `MemoryProposal`, `EvidenceItem`, `Embedder`, `BrainSnapshot`, `safeFetch` result, `runCurator` input/result names are used consistently across Tasks 1, 3, 5, 6, 8, 9, 10, 14. `BrainStore.mutate`/`snapshot`/`add`/`revoke`/`nextId` signatures are stable from Task 3 onward.

**Known wiring confirmations for the implementer (not placeholders — explicit checks):**
- Task 14a: confirm the exact M3 local variable names for triage tags + changed files inside `runIteration` (the recon shows the research/preamble block; the triage result + diff facts are computed earlier in the same method).
- Task 6: confirm `OpenRouterAdapter` is constructed in the gate with the right `apiKeyEnv`; the embedder reuses the same adapter instance the panel already builds.
- Spike SM4-1 result fills the default embeddings model in Task 12.
