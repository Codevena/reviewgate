import { neutralizeFences, neutralizeInjectionMarkers } from "../../diff/sanitizer.ts";
import type { Finding } from "../../schemas/finding.ts";
import { surfacedLessons } from "./distill.ts";
import type { AgentLessonsCfg } from "./inject.ts";
import { AgentLessonsStore, lessonKey } from "./store.ts";

// Advisory notes for findings in the CURRENT review round that match a recurring accepted+fixed
// lesson (count >= minRecurrence). Contextual — only lessons matching this round's findings, not a
// generic top-K dump. NEVER throws (single try/catch → []); returns [] when disabled, no finding
// matches, or on any error. The reviewer-authored embeds (exemplar_message, raw rule_id) are
// sanitized; the trusted banner markup is not (mirrors report-writer's fragmentationBanner).
export async function recurrenceNotesForFindings(
  repoRoot: string,
  cfg: AgentLessonsCfg | null | undefined,
  findings: Finding[],
): Promise<string[]> {
  try {
    if (!cfg?.enabled || findings.length === 0) return [];
    // Pure read — SessionStart/report paths must never mutate the store.
    const idx = await new AgentLessonsStore(repoRoot).snapshot({ backupCorrupt: false });
    const surfaced = surfacedLessons(idx, cfg.minRecurrence);
    if (surfaced.length === 0) return [];
    const surfacedKeys = new Set(surfaced.map((s) => s.entry.key));
    const matchedKeys = new Set<string>();
    for (const f of findings) {
      const k = lessonKey(f.category, f.rule_id);
      if (surfacedKeys.has(k)) matchedKeys.add(k);
    }
    if (matchedKeys.size === 0) return [];
    // surfaced is already sorted count-desc; emit one note per matched lesson (deduped by key),
    // capped at cfg.topK so a review touching many recurring classes can't produce a huge banner
    // (plan-gate INFO).
    const notes: string[] = [];
    for (const s of surfaced) {
      if (notes.length >= cfg.topK) break;
      if (!matchedKeys.has(s.entry.key)) continue;
      // display_rule_id is already defanged at write; the `?? rule_id` fallback is normalized
      // ([a-z0-9-], safe). exemplar_message was sanitized on write too — re-sanitize as belt.
      const rule = s.entry.display_rule_id ?? s.entry.rule_id;
      const msg = neutralizeFences(neutralizeInjectionMarkers(s.entry.exemplar_message));
      const fw = s.files === 1 ? "file" : "files";
      const sw = s.sessions === 1 ? "session" : "sessions";
      notes.push(
        `> ⚠️ **Recurring mistake:** rule \`${rule}\` [${s.entry.category}] — caught ${s.count}x in this repo before (${s.files} ${fw}, ${s.sessions} ${sw}). Last: "${msg}". You have fixed this class here before — double-check this finding against it.`,
      );
    }
    return notes;
  } catch {
    return [];
  }
}
