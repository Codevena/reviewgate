import type { PolicyPassId } from "./catalog.ts";

export type PolicyTraceMode = "off" | "memory" | "persist";

export interface PolicyIsolatedStateMetadata {
  readonly startingStateSha256: string;
  readonly scratchStateRoot: string;
  readonly productionStateRoot: string;
}

export interface PolicyExecutionOptions {
  readonly trace: PolicyTraceMode;
  readonly policyAblations: ReadonlySet<PolicyPassId>;
  readonly authoritative: boolean;
  readonly isolatedState?: PolicyIsolatedStateMetadata;
}

export const EMPTY_POLICY_ABLATIONS: ReadonlySet<PolicyPassId> = new Set<PolicyPassId>();

const DIRECT_DEFAULT: PolicyExecutionOptions = {
  trace: "off",
  policyAblations: EMPTY_POLICY_ABLATIONS,
  authoritative: false,
};

const AUDITED_DEFAULT: PolicyExecutionOptions = {
  trace: "persist",
  policyAblations: EMPTY_POLICY_ABLATIONS,
  authoritative: false,
};

export function resolvePolicyExecutionOptions(
  options: PolicyExecutionOptions | undefined,
  hasAuditLogger: boolean,
): PolicyExecutionOptions {
  if (options !== undefined) return options;
  return hasAuditLogger ? AUDITED_DEFAULT : DIRECT_DEFAULT;
}
