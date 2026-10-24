// Shared types, zod schemas, reason codes and constants from final_contracts.md.

/** Must equal the version line at the top of final_contracts.md. */
export const CONTRACTS_VERSION = '1.2';

export type * from './types.js';
export type * from './api.js';
export * from './enums.js';
export * from './reasons.js';
export * from './constants.js';
export * from './normalize.js';
export * from './schemas.js';

// JudgeInput validation is the missing Chunk 3 boundary export.
export { judgeInputSchema, judgeInputSchema as JudgeInputSchema } from './judge-input.js';
export { JudgeOutputSchema as judgeOutputSchema } from './schemas.js';
