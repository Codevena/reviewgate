// src/core/brain/engine.ts
import { selectBrainEntries } from "./select.ts";
import type { BrainSnapshot, BrainStore } from "./store.ts";

export interface BrainEngineOpts {
  maxTokens: number;
}

export class BrainEngine {
  private pinned: BrainSnapshot | null = null;
  constructor(
    private readonly store: BrainStore,
    private readonly opts: BrainEngineOpts,
  ) {}

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
