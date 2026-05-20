// src/schemas/research.ts
import { z } from "zod";

export const ResearchFactsSchema = z.object({
  schema: z.literal("reviewgate.research.v1"),
  files: z.array(
    z.object({ path: z.string(), added: z.number(), removed: z.number(), kind: z.string() }),
  ),
  sensitivityTags: z.array(z.string()),
});
export type ResearchFacts = z.infer<typeof ResearchFactsSchema>;
