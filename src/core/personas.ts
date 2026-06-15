import { neutralizeInjectionMarkers, redactHighEntropy } from "../diff/sanitizer.ts";
import { personaFilePath } from "../utils/paths.ts";
import { safeReadContained } from "../utils/safe-read.ts";

export const PERSONA_FILE_CAP = 8_000;

export const PERSONA_REAFFIRM: Record<string, string> = {
  security:
    "You are a hostile senior security auditor. Assume the author was overconfident. Find real bugs.",
  architecture: "You are a senior software architect. Judge design, coupling, and maintainability.",
  adversarial: "You are an adversarial critic. Attack assumptions; find what others miss.",
  plan: "You are a meticulous staff engineer reviewing an implementation plan. Find gaps, contradictions, untestable steps, and unstated assumptions before code is written.",
  quality:
    "You are a senior engineer reviewing for code quality, correctness, and maintainability. Find real defects, not style nits.",
  correctness:
    "You are a senior engineer focused on correctness. Trace the changed code paths and find real logic bugs.",
  performance:
    "You are a performance engineer. Find real inefficiencies, hot-path allocations, and algorithmic regressions.",
  testing:
    "You are a test engineer. Judge test correctness and coverage; find missing edge cases and weak assertions.",
};

export const DEFAULT_REAFFIRM =
  "You are a meticulous senior code reviewer. Assume the author was overconfident. Find real bugs, correctness issues, and risks.";

function readPersonaFile(repoRoot: string, id: string): string | null {
  // Symlink-safe, realpath-contained, size-capped read: an agent-under-review can
  // plant `.reviewgate/personas/<id>.md` as a symlink to `~/.ssh/id_rsa` / `.env`,
  // and `security` is the DEFAULT persona so this path IS consulted. safeReadContained
  // refuses any final/intermediate symlink that escapes the repo and any file > cap.
  const raw = safeReadContained(repoRoot, personaFilePath(repoRoot, id), PERSONA_FILE_CAP);
  if (raw === null) return null;
  // Defence in depth: even a contained-but-sensitive file gets injection markers
  // neutralised AND high-entropy tokens (keys/tokens) redacted before it reaches the
  // network-bound reviewer prompt.
  const text = neutralizeInjectionMarkers(redactHighEntropy(raw.trim()).out);
  return text.length > 0 ? text : null;
}

export function resolvePersonas(
  repoRoot: string,
  inUse: string[],
  configPersonas?: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of new Set(inUse)) {
    const cfg = configPersonas?.[id];
    if (cfg !== undefined) {
      out[id] = neutralizeInjectionMarkers(cfg);
      continue;
    }
    out[id] = readPersonaFile(repoRoot, id) ?? PERSONA_REAFFIRM[id] ?? DEFAULT_REAFFIRM;
  }
  return out;
}

export function reaffirmFor(persona: string, personas: Record<string, string>): string {
  const r = personas[persona];
  if (r !== undefined) return r;
  console.warn(
    `[reviewgate] unknown reviewer persona "${persona}" — using the generic reviewer reaffirmation (not security-specific)`,
  );
  return DEFAULT_REAFFIRM;
}
