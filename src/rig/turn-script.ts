// src/rig/turn-script.ts
// Load + validate a rig turn script. Deliberately thin: validation lives in the zod
// schema (the project's source of truth for persisted shapes) and parse errors are left
// to throw — a malformed script must stop a run before it burns agent quota, not be
// repaired into something that measures a different experiment than the one preregistered.
import { readFileSync } from "node:fs";
import { type RigTurnScript, RigTurnScriptSchema } from "../schemas/rig-turn-script.ts";

export function loadTurnScript(path: string): RigTurnScript {
  return RigTurnScriptSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
