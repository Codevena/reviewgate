// src/core/brain/constants.ts
/** In-run grouping threshold — proposals with cosine ≥ this merge into one
 *  cluster. Also reused by the CandidateStore for dedup-by-(embedding, provider). */
export const GROUP_THRESHOLD = 0.78;
