import type { AgentLessonsIndex, LessonEntry } from "../../schemas/agent-lessons.ts";

export interface SurfacedLesson {
  entry: LessonEntry;
  count: number; // derived: occurrences.length
  sessions: number; // derived: distinct session_ids
  files: number; // derived: distinct files
}

// count / distinct_* are DERIVED here, never stored (mirrors FP-ledger deriving
// distinct_providers). A lesson surfaces when count >= minRecurrence.
export function surfacedLessons(idx: AgentLessonsIndex, minRecurrence: number): SurfacedLesson[] {
  const out: SurfacedLesson[] = [];
  for (const e of idx.entries) {
    const count = e.occurrences.length;
    if (count < minRecurrence) continue;
    out.push({
      entry: e,
      count,
      sessions: new Set(e.occurrences.map((o) => o.session_id)).size,
      files: new Set(e.occurrences.map((o) => o.file)).size,
    });
  }
  out.sort(
    (a, b) =>
      b.count - a.count || Date.parse(b.entry.last_seen_at) - Date.parse(a.entry.last_seen_at),
  );
  return out;
}

export function renderLesson(l: SurfacedLesson): string {
  const { entry, count, sessions, files } = l;
  const fw = files === 1 ? "file" : "files";
  const sw = sessions === 1 ? "session" : "sessions";
  // ASCII only (no em dash / multiplication sign) — keeps the source and the injected
  // text plain, consistent with the learn-status renderer (plan-gate INFO).
  return (
    `- [${entry.category}] rule "${entry.display_rule_id ?? entry.rule_id}" - caught ${count}x in this repo ` +
    `(${files} ${fw}, ${sessions} ${sw}). ` +
    `Last: "${entry.exemplar_message}". Check for this before ending your turn.`
  );
}
