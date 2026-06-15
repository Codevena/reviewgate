// src/core/brain/engine.ts
import { neutralizeFences, neutralizeInjectionMarkers } from "../../diff/sanitizer.ts";
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
    // Brain title/body/scope originate from reviewer `memory_proposals` (authored
    // while reading the attacker-controlled diff) and web-fetched bodies, but this
    // string is pushed into the TRUSTED prompt block BEFORE the untrusted-diff fence
    // — unlike the diff (sanitizeDiff) and Context7 docs (neutralizeInjectionMarkers).
    // Neutralize injection markers in all three; strip newlines from title/scope so a
    // single entry can't forge extra prompt lines, and collapse code fences in the body.
    return sel
      .map((e) => {
        const title = neutralizeInjectionMarkers(e.title).replace(/[\r\n]+/g, " ");
        const scope = neutralizeInjectionMarkers(e.scope).replace(/[\r\n]+/g, " ");
        const body = neutralizeFences(neutralizeInjectionMarkers(e.body));
        return `- ${title}: ${body}  [Source: ${e.id} · ${e.type} · ${scope}]`;
      })
      .join("\n");
  }
}
