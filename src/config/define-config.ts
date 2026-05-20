import { z } from 'zod';
import { defaultConfig } from './defaults.ts';

export const ProviderConfigSchema = z.object({
  enabled: z.boolean(),
  auth: z.enum(['oauth', 'apikey', 'openrouter']),
  apiKeyEnv: z.string().optional(),
  model: z.string(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive(),
});

export const ConfigSchema = z.object({
  version: z.literal(1),
  providers: z.object({ codex: ProviderConfigSchema }),
  phases: z.object({
    review: z.object({
      reviewers: z
        .array(
          z.object({
            provider: z.enum(['codex', 'claude-code', 'gemini', 'opencode']),
            persona: z.string(),
          }),
        )
        .min(1),
    }),
  }),
  loop: z.object({
    maxIterations: z.number().int().positive(),
    costCapUsd: z.number().nonnegative(),
    stuckThreshold: z.number().int().positive(),
    rejectRateEscalation: z.number().min(0).max(1),
    softPassPolicy: z.enum(['allow', 'block', 'ask-once']),
  }),
  sandbox: z.object({
    mode: z.enum(['strict', 'permissive', 'off']),
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
    if (v && typeof v === 'object' && !Array.isArray(v)) {
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
