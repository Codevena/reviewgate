// src/cassette/recording-adapter.ts
import { readFileSync } from "node:fs";
import type { EmbedOptions } from "../core/brain/embeddings.ts";
import type {
  CompleteOptions,
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
type CompleteFn = (prompt: string, opts: CompleteOptions) => Promise<string>;

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
        await this.append({
          method: "embed",
          key: embedKey(this.id, sha256(text)),
          promptSha256: sha256(text),
          result: { vector },
        });
        return vector;
      };
    }
    const realComplete = real.complete?.bind(real);
    if (typeof realComplete === "function") {
      this.complete = async (prompt, opts) => {
        const text = await realComplete(prompt, opts);
        await this.append({
          method: "complete",
          key: completeKey(this.id),
          promptSha256: sha256(prompt),
          result: { text },
        });
        return text;
      };
    }
  }

  preflight(cfg: ProviderConfig): Promise<Preflight> {
    return this.real.preflight(cfg);
  }

  async review(
    input: ReviewInput & { cfg: ProviderConfig; reviewerId: string },
  ): Promise<ReviewResult> {
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

  private async append(
    partial: Pick<CassetteEntry, "method" | "key" | "promptSha256" | "result">,
  ): Promise<void> {
    try {
      await appendEntry(this.path, {
        schema: "reviewgate.cassette.entry.v1",
        provider: this.id,
        ...partial,
      });
    } catch (err) {
      console.warn(
        `cassette: failed to record ${partial.method} for ${partial.key}: ${(err as Error).message}`,
      );
    }
  }
}
