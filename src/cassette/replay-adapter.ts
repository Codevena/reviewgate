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
  // `embed`/`complete` are instance fields present ONLY when the cassette holds
  // matching entries for this provider, so `typeof adapter.embed`/`typeof
  // adapter.complete === "function"` mirror the real adapter's capability. The
  // brain + judges feature-detect these — if absent, they skip gracefully (as
  // today) instead of taking the replay-miss path.
  embed?: (text: string, opts: EmbedOptions) => Promise<number[]>;
  complete?: (prompt: string) => Promise<string>;

  constructor(entries: CassetteEntry[], provider: ProviderId, opts: ReplayOpts = {}) {
    this.id = provider;
    this.strict = opts.strict ?? false;
    let hasEmbed = false;
    let hasComplete = false;
    for (const e of entries) {
      if (e.provider !== provider) continue; // filter by explicit provider field
      if (e.method === "embed") {
        this.embedMap.set(e.key, e);
        hasEmbed = true;
      } else {
        if (e.method === "complete") hasComplete = true;
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
    if (hasComplete) {
      this.complete = async (prompt: string) => {
        const entry = this.pop(completeKey(this.id), "complete");
        this.checkDrift(entry, sha256(prompt));
        return (entry.result as { text: string }).text;
      };
    }
  }

  async preflight(): Promise<Preflight> {
    return { available: true, version: "replay", authMode: "oauth", error: null };
  }

  async review(
    input: ReviewInput & { cfg: ProviderConfig; reviewerId: string },
  ): Promise<ReviewResult> {
    const entry = this.pop(reviewKey(input.reviewerId), "review");
    this.checkDrift(entry, this.readPromptHash(input.promptFile));
    return entry.result as ReviewResult;
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
