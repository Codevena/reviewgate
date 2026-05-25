// src/core/reputation/score.ts
export interface RepEvent {
  ts: string; // ISO timestamp
  eid: string; // idempotency id
}

/** Exponential time-decayed sum of events: weight = 0.5 ^ (ageDays / halfLifeDays). */
export function decayedCount(events: RepEvent[], now: Date, halfLifeDays: number): number {
  const halfLifeMs = halfLifeDays * 24 * 60 * 60 * 1000;
  let sum = 0;
  for (const e of events) {
    const ageMs = now.getTime() - Date.parse(e.ts);
    if (!Number.isFinite(ageMs) || ageMs < 0) {
      sum += 1; // future/unparseable ts → treat as fresh (no negative decay)
      continue;
    }
    sum += 0.5 ** (ageMs / halfLifeMs);
  }
  return sum;
}

/** Beta(1,1)-smoothed trust in [0,1]: (c+1)/(c+w+2). Neutral 0.5 at zero data. */
export function trustScore(
  correct: RepEvent[],
  wrong: RepEvent[],
  now: Date,
  halfLifeDays: number,
): number {
  const c = decayedCount(correct, now, halfLifeDays);
  const w = decayedCount(wrong, now, halfLifeDays);
  return (c + 1) / (c + w + 2);
}

export interface RepDerived {
  trust: number;
  samples: number; // decayed c + w
}

export function isUnreliable(d: RepDerived, minSamples: number, trustFloor: number): boolean {
  return d.samples >= minSamples && d.trust < trustFloor;
}
