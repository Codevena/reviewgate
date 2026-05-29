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
    if (!Number.isFinite(ageMs)) {
      // Unparseable/corrupt ts is no evidence — contribute zero so a bad
      // entry can never pin a reviewer below the trust floor forever.
      continue;
    }
    // Decay by the MAGNITUDE of the age. A future (clock-skewed) ts gets a
    // negative ageMs; using |ageMs| makes it decay by how far off it is and
    // fade as real time advances, instead of being held at weight 1 forever.
    sum += 0.5 ** (Math.abs(ageMs) / halfLifeMs);
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
