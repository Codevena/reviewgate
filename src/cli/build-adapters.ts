// src/cli/build-adapters.ts
import { existsSync } from "node:fs";
import { RecordingAdapter } from "../cassette/recording-adapter.ts";
import { ReplayAdapter } from "../cassette/replay-adapter.ts";
import { type CassetteEnv, cassetteFromEnv, loadCassette } from "../cassette/store.ts";
import type { ReviewgateConfig } from "../config/define-config.ts";
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
    if (seen.has(id))
      throw new Error(`cassette: duplicate reviewerId "${id}" — reviewer ids must be unique`);
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
    console.warn(
      `Reviewgate cassette: RECORDING to ${cassette.path} — contains raw reviewer output + prompts; review before committing.`,
    );
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
