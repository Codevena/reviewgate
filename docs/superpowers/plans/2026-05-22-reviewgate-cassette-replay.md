# Cassette Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record reviewer-panel interactions (`review()` + `complete()` + OpenRouter `embed()`) to a JSONL cassette and replay them deterministically, so FP-ledger demote / Phase-A / critic / Brain curation can be tested without the LLM lottery (and a real session can be replayed offline).

**Architecture:** VCR-style decorators at the adapter boundary. `RecordingAdapter` wraps a real `ProviderAdapter` and appends each interaction; `ReplayAdapter` is bound to one provider id and serves recorded results (review/complete FIFO by key, embed by content-hash). A shared `buildAdapters` helper wires record/replay via `REVIEWGATE_CASSETTE` into both `gate.ts` and `review-plan.ts`, building the full consumed provider set (reviewers ∪ critic ∪ brain embeddings ∪ brain curator). Real adapters untouched.

**Tech Stack:** Bun + TS, zod, `bun test`, biome. `export PATH="$HOME/.bun/bin:$PATH"`. Worktree from local `master` HEAD. Spec: `docs/superpowers/specs/2026-05-22-reviewgate-cassette-replay-design.md`.

---

## File structure
- **Create** `src/schemas/cassette.ts` — `ReviewResultSchema`, `CassetteEntrySchema`, types.
- **Create** `src/cassette/matching.ts` — pure key functions + `sha256`.
- **Create** `src/cassette/store.ts` — JSONL `appendEntry` / `loadCassette` / `cassetteFromEnv`.
- **Create** `src/cassette/replay-adapter.ts` — `ReplayAdapter`.
- **Create** `src/cassette/recording-adapter.ts` — `RecordingAdapter`.
- **Create** `src/cli/build-adapters.ts` — shared `buildAdapters` + `consumedProviders` + `assertUniqueReviewerIds`.
- **Modify** `src/cli/commands/gate.ts`, `src/cli/commands/review-plan.ts` — use `buildAdapters`.
- **Tests** under `tests/unit/` + `tests/integration/` + `tests/fixtures/cassettes/`.

Key existing types (do NOT redefine): `Finding`/`FindingSchema` (`src/schemas/finding.ts`), `ReviewResult`/`ReviewStatus`/`ProviderAdapter`/`ProviderConfig`/`ReviewInput` (`src/providers/adapter-base.ts`), `ProviderId`/`createAdapter` (`src/providers/registry.ts`), `EmbedOptions` (`src/core/brain/embeddings.ts`).

---

## Task 1: cassette schema (`src/schemas/cassette.ts`)

**Files:** Create `src/schemas/cassette.ts`; Test `tests/unit/cassette-schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/cassette-schema.test.ts
import { describe, expect, it } from "bun:test";
import { CassetteEntrySchema, ReviewResultSchema } from "../../src/schemas/cassette.ts";

const reviewResult = {
  reviewerId: "codex-security",
  verdict: "FAIL",
  findings: [],
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
  durationMs: 1,
  exitCode: 0,
  rawEventsPath: "", // MAY be empty — must validate
  status: "ok",
};

describe("cassette schema", () => {
  it("validates a review entry with an empty rawEventsPath", () => {
    const entry = {
      schema: "reviewgate.cassette.entry.v1",
      provider: "codex",
      key: "codex-security",
      method: "review",
      promptSha256: "a".repeat(64),
      result: reviewResult,
    };
    expect(CassetteEntrySchema.parse(entry).result).toEqual(reviewResult);
  });

  it("validates complete + embed entries", () => {
    const c = CassetteEntrySchema.parse({
      schema: "reviewgate.cassette.entry.v1",
      provider: "openrouter",
      key: "openrouter:complete",
      method: "complete",
      promptSha256: "b".repeat(64),
      result: { text: "{\"accept\":true}" },
    });
    expect((c.result as { text: string }).text).toContain("accept");
    const e = CassetteEntrySchema.parse({
      schema: "reviewgate.cassette.entry.v1",
      provider: "openrouter",
      key: "openrouter:embed:" + "c".repeat(64),
      method: "embed",
      promptSha256: "c".repeat(64),
      result: { vector: [0.1, 0.2, 0.3] },
    });
    expect((e.result as { vector: number[] }).vector).toHaveLength(3);
  });

  it("rejects an unknown provider", () => {
    expect(() =>
      CassetteEntrySchema.parse({
        schema: "reviewgate.cassette.entry.v1",
        provider: "nope",
        key: "x",
        method: "review",
        promptSha256: "d".repeat(64),
        result: reviewResult,
      }),
    ).toThrow();
  });

  it("ReviewResultSchema accepts optional rawText/statusDetail", () => {
    expect(ReviewResultSchema.parse({ ...reviewResult, rawText: "hi", statusDetail: "x" }).rawText).toBe("hi");
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `bun test tests/unit/cassette-schema.test.ts` → module not found.

- [ ] **Step 3: Implement**

```typescript
// src/schemas/cassette.ts
import { z } from "zod";
import { FindingSchema } from "./finding.ts";

// Mirror of providers/registry.ts ProviderId (kept local to avoid a zod import there).
export const ProviderIdSchema = z.enum(["codex", "gemini", "claude-code", "openrouter", "opencode"]);

const ReviewStatusSchema = z.enum(["ok", "error", "abstain", "timeout", "quota-exhausted"]);

// zod mirror of ReviewResult (src/providers/adapter-base.ts). rawEventsPath MAY be ""
// (several adapters return empty) → plain z.string(), never non-empty.
export const ReviewResultSchema = z.object({
  reviewerId: z.string(),
  verdict: z.enum(["PASS", "FAIL", "ERROR"]),
  findings: z.array(FindingSchema),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cachedInputTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
    costUsd: z.number(),
    quotaUsedPct: z.number().nullable(),
  }),
  durationMs: z.number(),
  exitCode: z.number(),
  rawEventsPath: z.string(),
  rawText: z.string().optional(),
  status: ReviewStatusSchema,
  statusDetail: z.string().optional(),
});

export const CassetteEntrySchema = z.object({
  schema: z.literal("reviewgate.cassette.entry.v1"),
  provider: ProviderIdSchema, // ReplayAdapter filters on THIS, not on parsing the key
  key: z.string(),
  method: z.enum(["review", "complete", "embed"]),
  promptSha256: z.string(),
  result: z.union([
    ReviewResultSchema,
    z.object({ text: z.string() }),
    z.object({ vector: z.array(z.number()) }),
  ]),
});

export type CassetteEntry = z.infer<typeof CassetteEntrySchema>;
```

- [ ] **Step 4: Pass** — `bun test tests/unit/cassette-schema.test.ts`. Then `bunx tsc --noEmit && bun run lint` (run `bun run format` first; fix `organizeImports` manually if lint still flags it).
- [ ] **Step 5: Commit** — `git commit -m "feat(cassette): zod schema (ReviewResult + CassetteEntry)"`

---

## Task 2: matching keys (`src/cassette/matching.ts`)

**Files:** Create `src/cassette/matching.ts`; Test `tests/unit/cassette-matching.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/cassette-matching.test.ts
import { describe, expect, it } from "bun:test";
import { completeKey, embedKey, reviewKey, sha256 } from "../../src/cassette/matching.ts";

describe("cassette matching keys", () => {
  it("review key is the reviewerId (critic disambiguated from a same-provider reviewer)", () => {
    expect(reviewKey("codex-security")).toBe("codex-security");
    expect(reviewKey("critic-codex")).toBe("critic-codex");
    expect(reviewKey("codex-security")).not.toBe(reviewKey("critic-codex"));
  });
  it("complete key is provider-scoped", () => {
    expect(completeKey("openrouter")).toBe("openrouter:complete");
  });
  it("embed key is content-addressed by text hash", () => {
    const h = sha256("hello");
    expect(embedKey("openrouter", h)).toBe(`openrouter:embed:${h}`);
    expect(sha256("hello")).toBe(sha256("hello"));
    expect(sha256("hello")).not.toBe(sha256("world"));
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```typescript
// src/cassette/matching.ts
import { createHash } from "node:crypto";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// review() entries are keyed by the reviewerId the orchestrator passes
// ("<provider>-<persona>" for the panel, "critic-<provider>" for the critic) →
// FIFO per key. complete() has no persona → one queue per provider. embed() is a
// pure function of its text → content-addressed (order-independent, dedup-friendly).
export function reviewKey(reviewerId: string): string {
  return reviewerId;
}
export function completeKey(provider: string): string {
  return `${provider}:complete`;
}
export function embedKey(provider: string, textSha256: string): string {
  return `${provider}:embed:${textSha256}`;
}
```

- [ ] **Step 4: Pass**, typecheck + lint.
- [ ] **Step 5: Commit** — `git commit -m "feat(cassette): match-key functions (reviewerId / provider:complete / provider:embed:hash)"`

---

## Task 3: JSONL store (`src/cassette/store.ts`)

**Files:** Create `src/cassette/store.ts`; Test `tests/unit/cassette-store.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/cassette-store.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CassetteEntry } from "../../src/schemas/cassette.ts";
import { appendEntry, cassetteFromEnv, loadCassette } from "../../src/cassette/store.ts";

function entry(key: string): CassetteEntry {
  return {
    schema: "reviewgate.cassette.entry.v1",
    provider: "codex",
    key,
    method: "review",
    promptSha256: "a".repeat(64),
    result: {
      reviewerId: key,
      verdict: "PASS",
      findings: [],
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
      durationMs: 1,
      exitCode: 0,
      rawEventsPath: "",
      status: "ok",
    },
  };
}

describe("cassette store (JSONL)", () => {
  it("appends entries one-per-line and loads them back in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-cas-"));
    const p = join(dir, "c.jsonl");
    await appendEntry(p, entry("a"));
    await appendEntry(p, entry("b"));
    expect(readFileSync(p, "utf8").trim().split("\n")).toHaveLength(2);
    const loaded = loadCassette(p);
    expect(loaded.map((e) => e.key)).toEqual(["a", "b"]);
  });

  it("skips a malformed line without aborting", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-cas2-"));
    const p = join(dir, "c.jsonl");
    writeFileSync(p, `${JSON.stringify(entry("a"))}\n{not json}\n${JSON.stringify(entry("b"))}\n`);
    expect(loadCassette(p).map((e) => e.key)).toEqual(["a", "b"]);
  });

  it("parses REVIEWGATE_CASSETTE record/replay forms", () => {
    expect(cassetteFromEnv("record:/tmp/x.jsonl")).toEqual({ mode: "record", path: "/tmp/x.jsonl" });
    expect(cassetteFromEnv("replay:/tmp/y.jsonl")).toEqual({ mode: "replay", path: "/tmp/y.jsonl" });
    expect(cassetteFromEnv("garbage")).toBeNull();
    expect(cassetteFromEnv(undefined)).toBeNull();
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```typescript
// src/cassette/store.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type CassetteEntry, CassetteEntrySchema } from "../schemas/cassette.ts";

// Append-only JSONL: a single appendFileSync of one line is atomic on POSIX, so the
// concurrent panel (Promise.allSettled) can record without a lock or lost entries.
// Single-process only — cross-process recording to one cassette is unsupported.
export async function appendEntry(path: string, entry: CassetteEntry): Promise<void> {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
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
export function cassetteFromEnv(value: string | undefined = process.env.REVIEWGATE_CASSETTE): CassetteEnv | null {
  if (!value) return null;
  const m = value.match(/^(record|replay):(.+)$/);
  if (!m) return null;
  return { mode: m[1] as "record" | "replay", path: m[2] as string };
}
```

- [ ] **Step 4: Pass**, typecheck + lint.
- [ ] **Step 5: Commit** — `git commit -m "feat(cassette): JSONL store + REVIEWGATE_CASSETTE env parsing"`

---

## Task 4: ReplayAdapter (`src/cassette/replay-adapter.ts`)

**Files:** Create `src/cassette/replay-adapter.ts`; Test `tests/unit/cassette-replay-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/cassette-replay-adapter.test.ts
import { describe, expect, it } from "bun:test";
import type { CassetteEntry } from "../../src/schemas/cassette.ts";
import { ReplayAdapter } from "../../src/cassette/replay-adapter.ts";
import { embedKey, sha256 } from "../../src/cassette/matching.ts";

function review(provider: "codex" | "openrouter", reviewerId: string, verdict: "PASS" | "FAIL"): CassetteEntry {
  return {
    schema: "reviewgate.cassette.entry.v1",
    provider,
    key: reviewerId,
    method: "review",
    promptSha256: "a".repeat(64),
    result: {
      reviewerId,
      verdict,
      findings: [],
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
      durationMs: 1,
      exitCode: 0,
      rawEventsPath: "",
      status: "ok",
    },
  };
}
const baseInput = (reviewerId: string) => ({
  promptFile: "/dev/null",
  workingDir: "/tmp",
  findingsPath: "/tmp/f",
  persona: "security",
  diffPath: "/tmp/d",
  cfg: { enabled: true, auth: "oauth" as const, model: "m", timeoutMs: 1000 },
  reviewerId,
});

describe("ReplayAdapter", () => {
  it("serves review entries by reviewerId, scoped to its provider (critic not stolen)", async () => {
    const entries = [
      review("codex", "codex-security", "FAIL"),
      review("codex", "critic-codex", "PASS"),
    ];
    const codex = new ReplayAdapter(entries, "codex");
    // critic-codex and codex-security are distinct keys on the same provider
    expect((await codex.review(baseInput("codex-security"))).verdict).toBe("FAIL");
    expect((await codex.review(baseInput("critic-codex"))).verdict).toBe("PASS");
  });

  it("consumes the same reviewerId FIFO across iterations", async () => {
    const entries = [review("codex", "codex-security", "FAIL"), review("codex", "codex-security", "PASS")];
    const codex = new ReplayAdapter(entries, "codex");
    expect((await codex.review(baseInput("codex-security"))).verdict).toBe("FAIL");
    expect((await codex.review(baseInput("codex-security"))).verdict).toBe("PASS");
  });

  it("throws on a miss", async () => {
    const codex = new ReplayAdapter([], "codex");
    await expect(codex.review(baseInput("codex-security"))).rejects.toThrow(/no recorded/);
  });

  it("exposes embed() only when embed entries exist; serves by text hash", async () => {
    const text = "embed me";
    const e: CassetteEntry = {
      schema: "reviewgate.cassette.entry.v1",
      provider: "openrouter",
      key: embedKey("openrouter", sha256(text)),
      method: "embed",
      promptSha256: sha256(text),
      result: { vector: [1, 2, 3] },
    };
    const withEmbed = new ReplayAdapter([e], "openrouter") as ReplayAdapter & {
      embed?: (t: string, o: unknown) => Promise<number[]>;
    };
    expect(typeof withEmbed.embed).toBe("function");
    expect(await withEmbed.embed?.(text, {})).toEqual([1, 2, 3]);
    const noEmbed = new ReplayAdapter([], "openrouter") as ReplayAdapter & { embed?: unknown };
    expect(typeof noEmbed.embed).toBe("undefined");
  });

  it("strict mode throws on prompt drift; default warns", async () => {
    const entries = [review("codex", "codex-security", "PASS")]; // recorded promptSha256 = "a"*64
    const strict = new ReplayAdapter(entries, "codex", { strict: true });
    // baseInput points promptFile at /dev/null → sha differs from "a"*64 → drift
    await expect(strict.review(baseInput("codex-security"))).rejects.toThrow(/drift/);
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```typescript
// src/cassette/replay-adapter.ts
import { readFileSync } from "node:fs";
import type { EmbedOptions } from "../core/brain/embeddings.ts";
import type {
  Preflight,
  ProviderAdapter,
  ProviderConfig,
  ReviewInput,
  ReviewResult,
} from "../providers/adapter-base.ts";
import type { ProviderId } from "../providers/registry.ts";
import type { CassetteEntry } from "../schemas/cassette.ts";
import { completeKey, embedKey, reviewKey, sha256 } from "./matching.ts";

export interface ReplayOpts {
  strict?: boolean; // throw (not warn) on prompt drift — for regression fixtures
}

export class ReplayAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  private readonly strict: boolean;
  private readonly fifo = new Map<string, CassetteEntry[]>(); // review + complete queues
  private readonly embedMap = new Map<string, CassetteEntry>(); // embed by content key
  // `embed` is an instance field present ONLY when embed entries exist, so
  // buildEmbedder's `typeof adapter.embed === "function"` check mirrors the real
  // OpenRouter adapter (no embed entries → Brain skips gracefully, as today).
  embed?: (text: string, opts: EmbedOptions) => Promise<number[]>;

  constructor(entries: CassetteEntry[], provider: ProviderId, opts: ReplayOpts = {}) {
    this.id = provider;
    this.strict = opts.strict ?? false;
    let hasEmbed = false;
    for (const e of entries) {
      if (e.provider !== provider) continue; // filter by explicit provider field
      if (e.method === "embed") {
        this.embedMap.set(e.key, e);
        hasEmbed = true;
      } else {
        const q = this.fifo.get(e.key) ?? [];
        q.push(e);
        this.fifo.set(e.key, q);
      }
    }
    if (hasEmbed) {
      this.embed = async (text: string) => {
        const key = embedKey(this.id, sha256(text));
        const entry = this.embedMap.get(key);
        if (!entry) throw new Error(`cassette: no recorded embed for ${this.id} (text hash miss)`);
        return (entry.result as { vector: number[] }).vector;
      };
    }
  }

  async preflight(): Promise<Preflight> {
    return { available: true, version: "replay", authMode: "oauth", error: null };
  }

  async review(input: ReviewInput & { cfg: ProviderConfig; reviewerId: string }): Promise<ReviewResult> {
    const entry = this.pop(reviewKey(input.reviewerId), "review");
    this.checkDrift(entry, this.readPromptHash(input.promptFile));
    return entry.result as ReviewResult;
  }

  async complete(prompt: string): Promise<string> {
    const entry = this.pop(completeKey(this.id), "complete");
    this.checkDrift(entry, sha256(prompt));
    return (entry.result as { text: string }).text;
  }

  private pop(key: string, method: string): CassetteEntry {
    const q = this.fifo.get(key);
    if (!q || q.length === 0) {
      const msg = `cassette: no recorded ${method} for ${key}`;
      console.error(msg); // surfaced even when the orchestrator's allSettled swallows the throw
      throw new Error(msg);
    }
    return q.shift() as CassetteEntry;
  }

  private readPromptHash(promptFile: string): string {
    try {
      return sha256(readFileSync(promptFile, "utf8"));
    } catch {
      return "";
    }
  }

  private checkDrift(entry: CassetteEntry, liveHash: string): void {
    if (liveHash && liveHash !== entry.promptSha256) {
      const msg = `cassette: prompt drift for ${entry.key} (recorded ${entry.promptSha256.slice(0, 8)} != live ${liveHash.slice(0, 8)})`;
      if (this.strict) throw new Error(msg);
      console.warn(msg);
    }
  }
}
```

- [ ] **Step 4: Pass**, typecheck + lint.
- [ ] **Step 5: Commit** — `git commit -m "feat(cassette): ReplayAdapter (provider-bound, FIFO review/complete, content-keyed embed, strict drift)"`

---

## Task 5: RecordingAdapter (`src/cassette/recording-adapter.ts`)

**Files:** Create `src/cassette/recording-adapter.ts`; Test `tests/unit/cassette-recording-adapter.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/cassette-recording-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingAdapter } from "../../src/cassette/recording-adapter.ts";
import { loadCassette } from "../../src/cassette/store.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

function realAdapter(): ProviderAdapter & { embed: (t: string, o: unknown) => Promise<number[]> } {
  return {
    id: "openrouter",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
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
    async complete() {
      return "{\"accept\":true}";
    },
    async embed() {
      return [0.1, 0.2];
    },
  };
}

describe("RecordingAdapter", () => {
  it("delegates review/complete/embed and records each (forwarding non-interface embed)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-rec-"));
    const p = join(dir, "c.jsonl");
    const prompt = join(dir, "prompt.txt");
    writeFileSync(prompt, "the prompt");
    const rec = new RecordingAdapter(realAdapter(), p) as RecordingAdapter & {
      embed?: (t: string, o: unknown) => Promise<number[]>;
    };
    await rec.review({
      promptFile: prompt,
      workingDir: dir,
      findingsPath: join(dir, "f"),
      persona: "security",
      diffPath: join(dir, "d"),
      cfg: { enabled: true, auth: "oauth", model: "m", timeoutMs: 1000 },
      reviewerId: "openrouter-security",
    });
    await rec.complete?.("judge prompt", { model: "m", apiKeyEnv: "X" });
    expect(typeof rec.embed).toBe("function");
    await rec.embed?.("embed text", {});
    const entries = loadCassette(p);
    expect(entries.map((e) => e.method).sort()).toEqual(["complete", "embed", "review"]);
    expect(entries.find((e) => e.method === "review")?.key).toBe("openrouter-security");
  });

  it("does NOT expose embed when the wrapped adapter has none", () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-rec2-"));
    const noEmbed: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(inp) {
        return {
          reviewerId: inp.reviewerId,
          verdict: "PASS",
          findings: [],
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
          durationMs: 1,
          exitCode: 0,
          rawEventsPath: "",
          status: "ok",
        };
      },
    };
    const rec = new RecordingAdapter(noEmbed, join(dir, "c.jsonl")) as RecordingAdapter & { embed?: unknown };
    expect(typeof rec.embed).toBe("undefined");
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement**

```typescript
// src/cassette/recording-adapter.ts
import { readFileSync } from "node:fs";
import type { EmbedOptions } from "../core/brain/embeddings.ts";
import type {
  Preflight,
  ProviderAdapter,
  ProviderConfig,
  ReviewInput,
  ReviewResult,
} from "../providers/adapter-base.ts";
import type { ProviderId } from "../providers/registry.ts";
import type { CassetteEntry } from "../schemas/cassette.ts";
import { completeKey, embedKey, reviewKey, sha256 } from "./matching.ts";
import { appendEntry } from "./store.ts";

type EmbedFn = (text: string, opts: EmbedOptions) => Promise<number[]>;
type CompleteFn = (prompt: string, opts: { model: string; apiKeyEnv: string; timeoutMs?: number }) => Promise<string>;

export class RecordingAdapter implements ProviderAdapter {
  readonly id: ProviderId;
  // `embed`/`complete` are present ONLY when the wrapped adapter has them, so
  // `typeof rec.embed`/`typeof rec.complete` mirror the wrapped adapter (the brain
  // + judges feature-detect these).
  embed?: EmbedFn;
  complete?: CompleteFn;

  constructor(
    private readonly real: ProviderAdapter,
    private readonly path: string,
  ) {
    this.id = real.id;
    const realEmbed = (real as { embed?: EmbedFn }).embed;
    if (typeof realEmbed === "function") {
      this.embed = async (text, opts) => {
        const vector = await realEmbed.call(real, text, opts);
        await this.append({ method: "embed", key: embedKey(this.id, sha256(text)), promptSha256: sha256(text), result: { vector } });
        return vector;
      };
    }
    const realComplete = real.complete?.bind(real);
    if (typeof realComplete === "function") {
      this.complete = async (prompt, opts) => {
        const text = await realComplete(prompt, opts);
        await this.append({ method: "complete", key: completeKey(this.id), promptSha256: sha256(prompt), result: { text } });
        return text;
      };
    }
  }

  preflight(cfg: ProviderConfig): Promise<Preflight> {
    return this.real.preflight(cfg);
  }

  async review(input: ReviewInput & { cfg: ProviderConfig; reviewerId: string }): Promise<ReviewResult> {
    const result = await this.real.review(input);
    await this.append({
      method: "review",
      key: reviewKey(input.reviewerId),
      promptSha256: this.hashFile(input.promptFile),
      result,
    });
    return result;
  }

  private hashFile(p: string): string {
    try {
      return sha256(readFileSync(p, "utf8"));
    } catch {
      return "";
    }
  }

  private async append(partial: Pick<CassetteEntry, "method" | "key" | "promptSha256" | "result">): Promise<void> {
    try {
      await appendEntry(this.path, { schema: "reviewgate.cassette.entry.v1", provider: this.id, ...partial });
    } catch (err) {
      console.warn(`cassette: failed to record ${partial.method} for ${partial.key}: ${(err as Error).message}`);
    }
  }
}
```

- [ ] **Step 4: Pass**, typecheck + lint.
- [ ] **Step 5: Commit** — `git commit -m "feat(cassette): RecordingAdapter (delegates + records review/complete/embed)"`

---

## Task 6: shared `buildAdapters` + wire gate.ts & review-plan.ts

**Files:** Create `src/cli/build-adapters.ts`; Modify `src/cli/commands/gate.ts`, `src/cli/commands/review-plan.ts`; Test `tests/unit/build-adapters.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/unit/build-adapters.test.ts
import { describe, expect, it } from "bun:test";
import { buildAdapters, consumedProviders } from "../../src/cli/build-adapters.ts";
import { defaultConfig } from "../../src/config/defaults.ts";

const cfgWithBrainEmbedderNotReviewer = {
  ...defaultConfig,
  phases: {
    review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
    critic: null,
    triage: null,
    brain: {
      enabled: true,
      maxPromptTokens: 1500,
      embeddings: { provider: "openrouter" as const, model: "m", apiKeyEnv: "X" },
      egressAllowlist: [],
      curatorTimeoutMs: 20000,
    },
  },
};

describe("buildAdapters", () => {
  it("includes the brain embeddings provider even when it is not a reviewer", () => {
    const provs = consumedProviders(cfgWithBrainEmbedderNotReviewer as never);
    expect(provs).toContain("codex");
    expect(provs).toContain("openrouter"); // embeddings provider, not a reviewer
  });

  it("explicit providerOverrides win over cassette/createAdapter", () => {
    const fake = { id: "codex" } as never;
    const adapters = buildAdapters(cfgWithBrainEmbedderNotReviewer as never, { codex: fake }, null);
    expect(adapters.codex).toBe(fake);
  });

  it("replay mode binds a ReplayAdapter per consumed provider", () => {
    const adapters = buildAdapters(cfgWithBrainEmbedderNotReviewer as never, undefined, {
      mode: "replay",
      path: "/dev/null", // loadCassette of empty → []
    });
    expect(adapters.codex?.id).toBe("codex");
    expect(adapters.openrouter?.id).toBe("openrouter");
  });
});
```

- [ ] **Step 2: Run → fail.**

- [ ] **Step 3: Implement** `src/cli/build-adapters.ts`

```typescript
// src/cli/build-adapters.ts
import { existsSync } from "node:fs";
import type { ReviewgateConfig } from "../config/define-config.ts";
import { RecordingAdapter } from "../cassette/recording-adapter.ts";
import { ReplayAdapter } from "../cassette/replay-adapter.ts";
import { type CassetteEnv, cassetteFromEnv, loadCassette } from "../cassette/store.ts";
import type { ProviderAdapter } from "../providers/adapter-base.ts";
import { type ProviderId, createAdapter } from "../providers/registry.ts";

// The COMPLETE set of providers the orchestrator consumes: reviewers, critic,
// brain embeddings provider, brain curator provider. (gate.ts/review-plan.ts
// historically built only reviewers[+critic], so the embeddings/curator adapters
// existed only by coincidence of also being reviewers — fixed here.)
export function consumedProviders(cfg: ReviewgateConfig): ProviderId[] {
  const set = new Set<ProviderId>();
  for (const r of cfg.phases.review.reviewers) set.add(r.provider);
  if (cfg.phases.critic) set.add(cfg.phases.critic.provider);
  const brain = cfg.phases.brain;
  if (brain) {
    set.add(brain.embeddings.provider);
    if (brain.curator) set.add(brain.curator.provider);
  }
  return [...set];
}

// Hard preflight error when a cassette is active and two reviewers collapse to the
// same reviewerId (FIFO under concurrency can't disambiguate them).
function assertUniqueReviewerIds(cfg: ReviewgateConfig): void {
  const seen = new Set<string>();
  for (const r of cfg.phases.review.reviewers) {
    const id = `${r.provider}-${r.persona}`;
    if (seen.has(id)) throw new Error(`cassette: duplicate reviewerId "${id}" — reviewer ids must be unique`);
    seen.add(id);
  }
}

export function buildAdapters(
  cfg: ReviewgateConfig,
  providerOverrides?: Partial<Record<ProviderId, ProviderAdapter>>,
  cassette: CassetteEnv | null = cassetteFromEnv(),
): Partial<Record<ProviderId, ProviderAdapter>> {
  if (cassette) assertUniqueReviewerIds(cfg);
  const entries =
    cassette?.mode === "replay" && existsSync(cassette.path) ? loadCassette(cassette.path) : [];
  if (cassette?.mode === "record") {
    console.warn(`Reviewgate cassette: RECORDING to ${cassette.path} — contains raw reviewer output + prompts; review before committing.`);
  }
  const adapters: Partial<Record<ProviderId, ProviderAdapter>> = {};
  for (const id of consumedProviders(cfg)) {
    const override = providerOverrides?.[id];
    if (override) {
      adapters[id] = override; // explicit injection always wins
    } else if (cassette?.mode === "replay") {
      adapters[id] = new ReplayAdapter(entries, id);
    } else if (cassette?.mode === "record") {
      adapters[id] = new RecordingAdapter(createAdapter(id), cassette.path);
    } else {
      adapters[id] = createAdapter(id);
    }
  }
  return adapters;
}
```

- [ ] **Step 4: Wire gate.ts** — replace the inline adapter-building loop (the `for (const r of cfg.phases.review.reviewers) { if (!adapters[r.provider]) … }` block + the critic addition) with:

```typescript
import { buildAdapters } from "../build-adapters.ts";
// …
const adapters = buildAdapters(cfg, input.providerOverrides);
```

(Remove the now-dead local `adapters` loop + critic block; keep the rest of `runGate` unchanged. Verify `cfg` and `input.providerOverrides` are in scope.)

- [ ] **Step 5: Wire review-plan.ts** — replace its `adapters[r.provider] = input.providerOverrides?.[r.provider] ?? createAdapter(r.provider)` loop (around line 93) with the same `const adapters = buildAdapters(cfg, input.providerOverrides);`. Drop the now-unused `createAdapter` import if nothing else uses it.

- [ ] **Step 6: Run** `bun test tests/unit/build-adapters.test.ts` + the full suite `bun test` (gate/review-plan integration tests must still pass), typecheck + lint.
- [ ] **Step 7: Commit** — `git commit -m "feat(cassette): shared buildAdapters (full provider set + env wiring) in gate + review-plan"`

---

## Task 7: fixture-driven integration tests + round-trip + secret guard

**Files:** Create `tests/integration/cassette-pipeline.test.ts`, `tests/integration/cassette-roundtrip.test.ts`, `tests/unit/cassette-secret-guard.test.ts`, fixtures under `tests/fixtures/cassettes/`.

- [ ] **Step 1: Round-trip test** — a stub real adapter (with `embed`) → `RecordingAdapter` writes a cassette → `ReplayAdapter` reads it → identical results.

```typescript
// tests/integration/cassette-roundtrip.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingAdapter } from "../../src/cassette/recording-adapter.ts";
import { ReplayAdapter } from "../../src/cassette/replay-adapter.ts";
import { loadCassette } from "../../src/cassette/store.ts";
import type { ProviderAdapter } from "../../src/providers/adapter-base.ts";

describe("cassette round-trip", () => {
  it("record then replay yields the same review result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-rt-"));
    const p = join(dir, "c.jsonl");
    const prompt = join(dir, "prompt.txt");
    writeFileSync(prompt, "prompt body");
    const real: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(inp) {
        return {
          reviewerId: inp.reviewerId,
          verdict: "FAIL",
          findings: [],
          usage: { inputTokens: 2, outputTokens: 3, costUsd: 0.01, quotaUsedPct: null },
          durationMs: 5,
          exitCode: 0,
          rawEventsPath: "",
          status: "ok",
        };
      },
    };
    const input = {
      promptFile: prompt,
      workingDir: dir,
      findingsPath: join(dir, "f"),
      persona: "security",
      diffPath: join(dir, "d"),
      cfg: { enabled: true, auth: "oauth" as const, model: "m", timeoutMs: 1000 },
      reviewerId: "codex-security",
    };
    const recorded = await new RecordingAdapter(real, p).review(input);
    const replayed = await new ReplayAdapter(loadCassette(p), "codex").review(input);
    expect(replayed).toEqual(recorded);
  });
});
```

- [ ] **Step 2: Pipeline test (the payoff)** — drive the Orchestrator with an injected `ReplayAdapter` whose fixture cassette makes a finding land out-of-diff → Phase-A demotes it to INFO (deterministic). Build on `tests/integration/fp-ledger-pipeline.test.ts` for the Orchestrator-construction pattern. Control pre-adapter state: `cache.enabled:false`, brain `null`, fpLedger off (for the Phase-A case), `contextDocs` off.

```typescript
// tests/integration/cassette-pipeline.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplayAdapter } from "../../src/cassette/replay-adapter.ts";
import type { CassetteEntry } from "../../src/schemas/cassette.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";

// diff changes line 1 of a.ts; the recorded finding sits on line 50 (OUT of the hunk)
const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";

function cassetteEntry(): CassetteEntry {
  return {
    schema: "reviewgate.cassette.entry.v1",
    provider: "codex",
    key: "codex-security",
    method: "review",
    promptSha256: "0".repeat(64),
    result: {
      reviewerId: "codex-security",
      verdict: "FAIL",
      findings: [
        {
          id: "F-1",
          signature: "sigOOD",
          severity: "CRITICAL",
          category: "security",
          rule_id: "r",
          file: "a.ts",
          line_start: 50,
          line_end: 50, // out-of-diff
          message: "m",
          details: "d",
          reviewer: { provider: "codex", model: "m", persona: "security" },
          confidence: 0.9,
          consensus: "singleton",
        },
      ],
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
      durationMs: 1,
      exitCode: 0,
      rawEventsPath: "",
      status: "ok",
    },
  };
}

describe("cassette → orchestrator pipeline (deterministic)", () => {
  it("Phase-A demotes a recorded out-of-diff finding to INFO (no LLM)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-caspipe-"));
    const config = {
      ...defaultConfig,
      cache: { enabled: false, reviewTtlDays: 7 },
      phases: {
        review: { reviewers: [{ provider: "codex" as const, persona: "security" }], scopeToDiff: true },
        critic: null,
        triage: null,
      },
    };
    const orch = new Orchestrator({
      repoRoot: repo,
      config,
      adapters: { codex: new ReplayAdapter([cassetteEntry()], "codex") },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(result.verdict).toBe("PASS"); // CRITICAL demoted to INFO → no blocking findings
    const report = JSON.parse(readFileSync(join(repo, ".reviewgate", "pending.json"), "utf8"));
    expect(report.findings[0].severity).toBe("INFO");
  });
});
```

- [ ] **Step 3: Secret guard** — fail if any committed cassette contains a high-entropy token. Scan `tests/fixtures/cassettes/**` AND `.reviewgate/cassettes/golden/**`.

```typescript
// tests/unit/cassette-secret-guard.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Reuse the diff sanitizer's high-entropy heuristic shape: base64/hex-like >= 24 chars.
const HIGH_ENTROPY = /[A-Za-z0-9+/=_-]{32,}/g;
function shannon(s: string): number {
  const counts: Record<string, number> = {};
  for (const ch of s) counts[ch] = (counts[ch] ?? 0) + 1;
  let h = 0;
  for (const c of Object.values(counts)) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const ROOTS = ["tests/fixtures/cassettes", ".reviewgate/cassettes/golden"];

describe("committed cassette secret guard", () => {
  it("no committed cassette contains a high-entropy secret-like token", async () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      if (!existsSync(root)) continue;
      for await (const f of new Glob("**/*.jsonl").scan(root)) {
        const text = readFileSync(join(root, f), "utf8");
        for (const m of text.match(HIGH_ENTROPY) ?? []) {
          // sha256 hashes (exactly 64 hex) are expected in cassettes → allow them
          if (/^[0-9a-f]{64}$/.test(m)) continue;
          if (shannon(m) >= 4.0) offenders.push(`${root}/${f}: ${m.slice(0, 12)}…`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 4: Run** all three + full suite, typecheck + lint.
- [ ] **Step 5: Commit** — `git commit -m "test(cassette): round-trip + deterministic Phase-A pipeline + committed-fixture secret guard"`

---

## Task 8: full-suite gate + DoD + compiled-binary smoke + merge

- [ ] **Step 1:** `bun test && bunx tsc --noEmit && bun run lint` → all pass / clean.
- [ ] **Step 2: Compiled-binary smoke** — `bun run build`, then in a scratch repo set `REVIEWGATE_CASSETTE=replay:<a hand-written fixture>.jsonl` and drive `dist/reviewgate gate --hook stop </dev/null` (trigger first); confirm the replayed reviewer output drives the pipeline (no CLI/network) — i.e. `cassetteFromEnv` + JSONL load work in the compiled binary.
- [ ] **Step 3: DoD** — Codex Agent A (or OpenCode fallback) reviewing `git diff master...HEAD`, run typecheck+lint itself → PASS = 0 CRITICAL/WARN; fix + re-run; then Claude Agent A → PASS. `rm -rf .review/`.
- [ ] **Step 4:** FF-merge to master, rebuild binary, remove worktree, delete branch. Ask before pushing.

---

## Self-review (spec coverage)
- JSONL append-only store (concurrency-safe, single-process) → Task 3. ✓
- Granularity = parsed ReviewResult + complete() text + embed() vectors → Tasks 1, 4, 5. ✓
- Matching: review→reviewerId (FIFO), complete→provider:complete (FIFO), embed→content-hash; explicit `provider` field for filtering (critic not stolen) → Tasks 1, 2, 4. ✓
- Decorators at the adapter seam; embed forwarded/exposed only when present → Tasks 4, 5. ✓
- Shared buildAdapters over the FULL consumed provider set (reviewers ∪ critic ∪ brain embeddings ∪ curator); explicit overrides win; record warning w/ path; duplicate-reviewerId hard error → Task 6. ✓
- Wired into BOTH gate.ts and review-plan.ts → Task 6. ✓
- strict drift mode; miss→throw (+console.error for allSettled visibility) → Task 4. ✓
- Deterministic pipeline test (Phase-A shown; FP-ledger/Brain/critic follow the same injected-ReplayAdapter pattern with seeded state) + round-trip + committed-fixture secret guard (fixtures + golden) → Task 7. ✓
- Compiled-binary smoke → Task 8. ✓
- Out of scope: Context7 recording, raw-stdout, auto-redaction, config field, dedicated CLI subcommand. ✓
