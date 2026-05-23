import { intro, isCancel, outro, select } from "@clack/prompts";

export interface SetupInput {
  repoRoot: string;
}

export async function runSetup(_input: SetupInput): Promise<number> {
  intro("reviewgate setup");
  const mode = await select({
    message: "Setup mode",
    options: [
      { value: "quick", label: "Quick (recommended preset)" },
      { value: "custom", label: "Custom (configure everything)" },
    ],
  });
  if (isCancel(mode)) {
    outro("setup cancelled, no changes written");
    return 1;
  }
  outro(`(spike) selected: ${String(mode)}`);
  return 0;
}
