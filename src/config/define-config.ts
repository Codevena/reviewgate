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
        .array(
          z.object({ provider: ProviderId, persona: z.string(), model: z.string().optional() }),
        )
        .min(1),
    }),
    critic: z
      .object({ provider: ProviderId, model: z.string().optional(), persona: z.string() })
      .nullable()
      .default(null),
    triage: z
      .object({ provider: ProviderId, model: z.string().optional() })
      .nullable()
      .default(null),
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
});

export type ReviewgateConfig = z.infer<typeof ConfigSchema>;

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

function deepMerge<T>(base: T, override: DeepPartial<T>): T {
  const out = Array.isArray(base) ? [...(base as unknown[])] : { ...(base as object) };
  for (const k of Object.keys(override) as Array<keyof T>) {
    const v = override[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      (out as Record<string, unknown>)[k as string] = deepMerge(
        (base as Record<string, unknown>)[k as string],
        v as DeepPartial<unknown>,
      );
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
