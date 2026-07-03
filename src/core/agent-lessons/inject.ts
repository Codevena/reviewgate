import { neutralizeFences, neutralizeInjectionMarkers } from "../../diff/sanitizer.ts";
import { renderLesson, surfacedLessons } from "./distill.ts";
import { AgentLessonsStore } from "./store.ts";

export interface AgentLessonsCfg {
  enabled: boolean;
  minRecurrence: number;
  topK: number;
  maxInjectChars: number;
  ttlDays: number;
}

const HEADER =
  "Reviewgate — recurring mistakes it has caught in this repo (advisory, not blocking):";

// Build the SessionStart hook stdout: the hookSpecificOutput JSON, or "" (a guaranteed
// no-op). NEVER throws — any error, missing/corrupt store, or empty result → "" so
// SessionStart can never break (verified: exit 0 + empty stdout = silent no-op).
export async function buildSessionStartInjection(input: {
  repoRoot: string;
  cfg: AgentLessonsCfg | null | undefined;
  source: string | null;
}): Promise<string> {
  try {
    const cfg = input.cfg;
    if (!cfg?.enabled) return "";
    // Only prime a fresh/resumed session — never re-inject mid-session on clear/compact.
    if (input.source !== "startup" && input.source !== "resume") return "";

    // Pure read (backupCorrupt:false): SessionStart must NEVER mutate the store, even to
    // back up a corrupt file. A corrupt store → EMPTY → "" (fail-safe, no fs write).
    const idx = await new AgentLessonsStore(input.repoRoot).snapshot({ backupCorrupt: false });
    const surfaced = surfacedLessons(idx, cfg.minRecurrence).slice(0, cfg.topK);
    if (surfaced.length === 0) return "";

    // Defense in depth: sanitize each rendered line even though the exemplar was
    // sanitized on write.
    const lines = surfaced.map((l) =>
      neutralizeFences(neutralizeInjectionMarkers(renderLesson(l))),
    );

    // Size cap: drop lowest-ranked lines until the block fits (keep the header).
    const kept = [...lines];
    while (kept.length > 0 && [HEADER, ...kept].join("\n").length > cfg.maxInjectChars) {
      kept.pop();
    }
    if (kept.length === 0) return "";
    const block = [HEADER, ...kept].join("\n");

    return JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: block },
    });
  } catch {
    return "";
  }
}
