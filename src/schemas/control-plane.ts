import { z } from "zod";
import { ConfigSchema } from "../config/define-config.ts";

export const PolicyChangeClassSchema = z.enum([
  "equivalent",
  "strengthening",
  "approval-required",
  "invalid",
]);

export const ControlPlanePendingSchema = z.object({
  source_fingerprint: z.string().min(64).max(64),
  effective_fingerprint: z.string().min(64).max(64).nullable(),
  classification: PolicyChangeClassSchema,
  changed_paths: z.array(z.string()),
  reasons: z.array(z.string()),
  error: z.string().nullable(),
  first_seen_at: z.string(),
  reviewed_under_lkg_at: z.string().nullable(),
});

export const ControlPlaneStateSchema = z.object({
  schema: z.literal("reviewgate.control-plane.v1"),
  approved_source_fingerprint: z.string().min(64).max(64),
  approved_effective_fingerprint: z.string().min(64).max(64),
  approved_config: ConfigSchema,
  approved_at: z.string(),
  approved_via: z.enum(["defaults", "init", "human", "automatic-strengthening"]),
  pending: ControlPlanePendingSchema.nullable().default(null),
});

export type PolicyChangeClass = z.infer<typeof PolicyChangeClassSchema>;
export type ControlPlanePending = z.infer<typeof ControlPlanePendingSchema>;
export type ControlPlaneState = z.infer<typeof ControlPlaneStateSchema>;
