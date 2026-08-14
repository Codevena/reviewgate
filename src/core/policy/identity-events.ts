/**
 * The canonical, unit-level representation of an identity outcome.  Aggregate outcome rows are
 * merely a readable projection of these events; they are never an independent authority.
 */
export type PolicyIdentityEventLane = "stateless-bench" | "stateful-rig";
export type PolicyIdentityEventDirection = "worsened" | "improved";

export interface PolicyIdentityEventBinding {
  readonly ref: string;
  readonly sha256: string;
}

export interface PolicyIdentityEvent {
  readonly lane: PolicyIdentityEventLane;
  /** A Bench case/repeat or a Rig scenario/turn, stable within the registered source. */
  readonly unit: string;
  readonly identity: string;
  readonly direction: PolicyIdentityEventDirection;
  readonly count: number;
  /** The closed verified source whose paired observation produced this exact event. */
  readonly source: PolicyIdentityEventBinding;
  /** Rig group observations are independently recorded for their applicable target member. */
  readonly member_pass_id?: PolicyPassId | undefined;
}

export interface PolicyIdentityDirection {
  readonly lane: PolicyIdentityEventLane;
  readonly units: number;
  readonly worsened: number;
  readonly improved: number;
}

export interface PolicyIdentityOutcome {
  readonly identity: string;
  readonly worsened: number;
  readonly improved: number;
}

/** A direct singleton ablation observation, kept separate from an unallocated group event. */
export interface PolicySingletonIdentityEvent {
  readonly lane: PolicyIdentityEventLane;
  readonly unit: string;
  readonly identity: string;
  readonly direction: PolicyIdentityEventDirection;
  readonly count: number;
  readonly pass_id: PolicyPassId;
  readonly source: PolicyIdentityEventBinding;
}

/** A baseline evaluation that proves a catalog protection/backstop for one singleton identity. */
export interface PolicyBaselineProtectionEvent {
  readonly lane: PolicyIdentityEventLane;
  readonly unit: string;
  readonly identity: string;
  readonly pass_id: PolicyPassId;
  readonly result: "protected";
  readonly source: PolicyIdentityEventBinding;
  readonly reason_code: string;
  readonly protected_by: string;
  readonly before: "INFO" | "WARN" | "ERROR" | "CRITICAL";
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function identityEventKey(event: PolicyIdentityEvent): string {
  return [
    event.lane,
    event.member_pass_id ?? "",
    event.unit,
    event.identity,
    event.direction,
    event.count.toString(),
    event.source.ref,
    event.source.sha256,
  ].join("\u0000");
}

export function sortIdentityEvents<T extends PolicyIdentityEvent>(events: readonly T[]): T[] {
  return [...events].sort((left, right) =>
    compareCodeUnits(identityEventKey(left), identityEventKey(right)),
  );
}

export function singletonIdentityEventKey(event: PolicySingletonIdentityEvent): string {
  return [
    event.lane,
    event.pass_id,
    event.unit,
    event.identity,
    event.direction,
    event.count.toString(),
    event.source.ref,
    event.source.sha256,
  ].join("\u0000");
}

export function sortSingletonIdentityEvents<T extends PolicySingletonIdentityEvent>(
  events: readonly T[],
): T[] {
  return [...events].sort((left, right) =>
    compareCodeUnits(singletonIdentityEventKey(left), singletonIdentityEventKey(right)),
  );
}

export function baselineProtectionEventKey(event: PolicyBaselineProtectionEvent): string {
  return [
    event.lane,
    event.pass_id,
    event.unit,
    event.identity,
    event.result,
    event.source.ref,
    event.source.sha256,
    event.reason_code,
    event.protected_by,
    event.before,
  ].join("\u0000");
}

export function sortBaselineProtectionEvents<T extends PolicyBaselineProtectionEvent>(
  events: readonly T[],
): T[] {
  return [...events].sort((left, right) =>
    compareCodeUnits(baselineProtectionEventKey(left), baselineProtectionEventKey(right)),
  );
}

export function identityOutcomesFromEvents(
  events: readonly PolicyIdentityEvent[],
): PolicyIdentityOutcome[] {
  const totals = new Map<string, { worsened: number; improved: number }>();
  for (const event of events) {
    const total = totals.get(event.identity) ?? { worsened: 0, improved: 0 };
    if (event.direction === "worsened") total.worsened += event.count;
    else total.improved += event.count;
    totals.set(event.identity, total);
  }
  return [...totals.entries()]
    .map(([identity, total]) => ({ identity, ...total }))
    .filter((row) => row.worsened > 0 || row.improved > 0)
    .sort((left, right) => compareCodeUnits(left.identity, right.identity));
}

export function identityDirectionFromEvents(input: {
  events: readonly PolicyIdentityEvent[];
  identity: string;
  lane: PolicyIdentityEventLane;
  memberPassId?: PolicyPassId | undefined;
}): PolicyIdentityDirection {
  let units = 0;
  let worsened = 0;
  let improved = 0;
  const observedUnits = new Set<string>();
  for (const event of input.events) {
    if (
      event.identity !== input.identity ||
      event.lane !== input.lane ||
      event.member_pass_id !== input.memberPassId
    ) {
      continue;
    }
    observedUnits.add(event.unit);
    if (event.direction === "worsened") worsened += event.count;
    else improved += event.count;
  }
  units = observedUnits.size;
  return { lane: input.lane, units, worsened, improved };
}

export function singletonIdentityDirectionFromEvents(input: {
  events: readonly PolicySingletonIdentityEvent[];
  identity: string;
  lane: PolicyIdentityEventLane;
  passId: PolicyPassId;
}): PolicyIdentityDirection {
  let worsened = 0;
  let improved = 0;
  const observedUnits = new Set<string>();
  for (const event of input.events) {
    if (
      event.identity !== input.identity ||
      event.lane !== input.lane ||
      event.pass_id !== input.passId
    ) {
      continue;
    }
    observedUnits.add(event.unit);
    if (event.direction === "worsened") worsened += event.count;
    else improved += event.count;
  }
  return { lane: input.lane, units: observedUnits.size, worsened, improved };
}

/** Bench needs two repeat observations; an exact Rig scenario/turn is independently valid. */
export function isStableWorsening(direction: PolicyIdentityDirection): boolean {
  return (
    direction.improved === 0 &&
    (direction.lane === "stateless-bench" ? direction.worsened >= 2 : direction.worsened >= 1)
  );
}
import type { PolicyPassId } from "./catalog.ts";
