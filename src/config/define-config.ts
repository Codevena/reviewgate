import { z } from "zod";
import { defaultConfig } from "./defaults.ts";

export const ProviderConfigSchema = z.object({
  enabled: z.boolean(),
  auth: z.enum(["oauth", "apikey", "openrouter"]),
  apiKeyEnv: z.string().optional(),
  model: z.string(),
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive(),
  costPerMTokensUsd: z.number().nonnegative().optional(),
});

const ProviderId = z.enum(["codex", "gemini", "claude-code", "openrouter", "opencode"]);

export const ConfigSchema = z.object({
  version: z.literal(1),
  providers: z.object({
    codex: ProviderConfigSchema,
    gemini: ProviderConfigSchema.optional(),
    "claude-code": ProviderConfigSchema.optional(),
    openrouter: ProviderConfigSchema.optional(),
    opencode: ProviderConfigSchema.optional(),
  }),
  phases: z.object({
    review: z.object({
      reviewers: z
        .array(
          z.object({ provider: ProviderId, persona: z.string(), model: z.string().optional() }),
        )
        .min(1),
      // Max bytes of full changed-file content fed to each reviewer alongside the
      // diff (for symbol verification). Smaller = smaller prompts = faster reviews
      // and fewer timeouts on slow remote models; larger = more context.
      fileContextBudgetBytes: z.number().int().positive().optional(),
      // M5 Part A: demote findings outside the changed hunks to INFO (advisory).
      // Default ON via defaults.ts (deep-merged) — the gate primarily reviews the change.
      scopeToDiff: z.boolean().optional(),
    }),
    critic: z
      .object({ provider: ProviderId, model: z.string().optional(), persona: z.string() })
      .nullable()
      .default(null),
    triage: z
      .object({ provider: ProviderId, model: z.string().optional() })
      .nullable()
      .default(null),
    brain: z
      .object({
        enabled: z.boolean(),
        maxPromptTokens: z.number().int().positive().default(1500),
        curator: z
          .object({ provider: ProviderId, model: z.string().optional(), persona: z.string() })
          .optional(), // hybrid: optional LLM judge
        embeddings: z.object({
          provider: z.literal("openrouter"),
          model: z.string().default("baai/bge-base-en-v1.5"),
          apiKeyEnv: z.string().default("OPENROUTER_API_KEY"),
        }),
        egressAllowlist: z.array(z.string()).default([]),
        curatorTimeoutMs: z.number().int().positive().default(20_000),
      })
      .nullable()
      .default(null)
      .optional(),
    // M5 Part B1: FP-ledger (signature-keyed false-positive learning). Opt-in.
    fpLedger: z.object({ enabled: z.boolean() }).nullable().default(null).optional(),
    // M6: Context7 library-docs injection into the research phase. Opt-in.
    contextDocs: z
      .object({
        enabled: z.boolean(),
        apiKeyEnv: z.string().default("CONTEXT7_API_KEY"),
        host: z.string().default("context7.com"),
        budgetBytes: z.number().int().positive().default(8000),
        perLibBytes: z.number().int().positive().default(2500),
        maxLibs: z.number().int().positive().default(5),
        ttlDays: z.number().int().positive().default(30),
      })
      .nullable()
      .default(null)
      .optional(),
  }),
  cache: z
    .object({ enabled: z.boolean(), reviewTtlDays: z.number().int().positive() })
    .default({ enabled: true, reviewTtlDays: 7 }),
  research: z
    .object({ languages: z.array(z.string()) })
    .default({ languages: ["typescript", "tsx", "python"] }),
  notify: z.object({ desktop: z.boolean() }).default({ desktop: false }),
  loop: z.object({
    maxIterations: z.number().int().positive(),
    costCapUsd: z.number().nonnegative(),
    stuckThreshold: z.number().int().positive(),
    rejectRateEscalation: z.number().min(0).max(1),
    softPassPolicy: z.enum(["allow", "block", "ask-once"]),
    acknowledgePass: z.boolean().default(false),
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
  output: z.object({
    pendingPath: z.string(),
    pendingJsonPath: z.string(),
  }),
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
  // Weekly report auto-snapshot-on-rollover. Opt-in.
  weeklyReport: z.object({ autoSnapshot: z.boolean() }).nullable().default(null).optional(),
});

export type ReviewgateConfig = z.infer<typeof ConfigSchema>;

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function deepMerge<T>(base: T, override: DeepPartial<T>): T {
  const out = Array.isArray(base) ? [...(base as unknown[])] : { ...(base as object) };
  for (const k of Object.keys(override) as Array<keyof T>) {
    const v = override[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const baseVal = (base as Record<string, unknown>)[k as string];
      (out as Record<string, unknown>)[k as string] =
        baseVal != null && typeof baseVal === "object"
          ? deepMerge(baseVal, v as DeepPartial<unknown>)
          : v;
    } else if (v !== undefined) {
      (out as Record<string, unknown>)[k as string] = v as unknown;
    }
  }
  return out as T;
}

export function defineConfig(user: DeepPartial<ReviewgateConfig>): ReviewgateConfig {
  const merged = deepMerge(defaultConfig as ReviewgateConfig, user);
  return ConfigSchema.parse(merged);
}
