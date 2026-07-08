// src/cassette/recording-adapter.ts
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve, sep } from "node:path";
import type { EmbedOptions } from "../core/brain/embeddings.ts";
import { redactHighEntropy } from "../diff/sanitizer.ts";
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

// True when `child` is the same path as, or a descendant of, `parent`. A trailing
// separator on the parent prevents a sibling-prefix false match (`/repo` would
// otherwise "contain" `/repo-evil`).
function isContainedIn(child: string, parent: string): boolean {
  const p = parent.endsWith(sep) ? parent : parent + sep;
  return child === parent || child.startsWith(p);
}

// Canonicalize a path for containment, following symlinks as far as the path
// exists (the cassette file itself usually does NOT exist yet at construction).
// Walk up to the nearest existing ancestor, realpath THAT (resolving any symlinked
// intermediate dir to its real location), then re-append the non-existent tail —
// so a `..`/symlink that escapes the allowed roots is detected before any write.
export function canonicalizeForContainment(p: string): string {
  let abs = isAbsolute(p) ? resolve(p) : resolve(process.cwd(), p);
  const tail: string[] = [];
  for (let i = 0; i < 4096; i++) {
    try {
      const real = realpathSync(abs);
      return tail.length > 0 ? resolve(real, ...[...tail].reverse()) : real;
    } catch {
      const parent = resolve(abs, "..");
      if (parent === abs) return resolve(abs, ...[...tail].reverse()); // hit the FS root
      tail.push(abs.slice(parent.length + 1));
      abs = parent;
    }
  }
  return abs;
}

// Reject a cassette path that escapes the allowed roots (the repo/cwd or the OS
// tmp dir). REVIEWGATE_CASSETTE is attacker-influenced (env) and we write raw
// reviewer output to it, so an unconstrained path is an arbitrary-file-write
// primitive (`record:/etc/cron.d/x`, `record:../../.ssh/authorized_keys`). The
// canonicalized path (symlinks + `..` resolved) must sit under cwd or tmp.
export function assertContainedCassettePath(path: string): void {
  const canonical = canonicalizeForContainment(path);
  const cwd = canonicalizeForContainment(process.cwd());
  const tmp = canonicalizeForContainment(tmpdir());
  if (isContainedIn(canonical, cwd) || isContainedIn(canonical, tmp)) return;
  throw new Error(
    `cassette: refusing to record to '${path}' — resolves outside the repo and tmp dir (path traversal / symlink). Point REVIEWGATE_CASSETTE at a path inside the repo or ${tmp}.`,
  );
}

// Run a recorded result body through entropy redaction before it lands on disk.
// The cassette is a secret-leak-at-rest surface (raw reviewer output + prompts),
// so any high-entropy token a reviewer echoed (a leaked key in a diff snippet, a
// session token in its reasoning) is scrubbed. Only string LEAVES are touched, so
// the schema shape (findings[]/text/vector + every required key) is preserved; the
// redaction marker is shorter than any matched token so length caps still hold.
function redactStrings(value: unknown): unknown {
  if (typeof value === "string") return redactHighEntropy(value).out;
  if (Array.isArray(value)) return value.map(redactStrings);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactStrings(v);
    }
    return out;
  }
  return value;
}

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
    // Fail fast on an out-of-bounds cassette path (env-supplied) BEFORE any write.
    assertContainedCassettePath(path);
    // real.id is typed as ProviderAdapter["id"], which can be AHEAD of the registry's
    // ProviderId during an in-flight provider rollout — adapter-base.ts's id union
    // widens in the same commit that adds the new adapter (e.g. "ollama"), while
    // registry.ts's ProviderId (and the persisted CassetteEntry["provider"] schema,
    // src/schemas/cassette.ts) only widen once that provider is wired into the
    // registry/config. Recording/replay only supports registry-known providers today,
    // so narrow here rather than widen the field (which would just push the same
    // mismatch into the CassetteEntry schema write below).
    this.id = real.id as ProviderId;
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
        const promptSha256 = sha256(prompt);
        await this.append({
          method: "complete",
          // Key by the prompt hash so each judge phase replays the response
          // recorded for ITS exact prompt — a shared per-provider FIFO returned
          // a sibling phase's response when pop-order skewed across phases.
          // (Replay must match: replay-adapter pops `completeKey(id, sha256(prompt))`.)
          key: completeKey(this.id, promptSha256),
          promptSha256,
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
        // Redact secrets from the stored body (leak-at-rest defense). Cast: the
        // shape is preserved (only string leaves change) so it still satisfies
        // CassetteEntry["result"]; loadCassette re-validates against the schema.
        result: redactStrings(partial.result) as CassetteEntry["result"],
      });
    } catch (err) {
      console.warn(
        `cassette: failed to record ${partial.method} for ${partial.key}: ${(err as Error).message}`,
      );
    }
  }
}
