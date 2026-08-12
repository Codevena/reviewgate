// src/rig/turn-script.ts
// Load + validate a rig turn script. Deliberately thin: validation lives in the zod
// schema (the project's source of truth for persisted shapes) and parse errors are left
// to throw — a malformed script must stop a run before it burns agent quota, not be
// repaired into something that measures a different experiment than the one preregistered.
import { readFileSync } from "node:fs";
import { type RigTurnScript, RigTurnScriptSchema } from "../schemas/rig-turn-script.ts";

/** Parse exactly the bytes whose content address is persisted by driver/harvester. */
export function parseTurnScriptBytes(bytes: Buffer): RigTurnScript {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return RigTurnScriptSchema.parse(JSON.parse(text));
}

export function readTurnScript(path: string): { bytes: Buffer; script: RigTurnScript } {
  const bytes = readFileSync(path);
  return { bytes, script: parseTurnScriptBytes(bytes) };
}

export function loadTurnScript(path: string): RigTurnScript {
  return readTurnScript(path).script;
}
