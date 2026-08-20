/**
 * The renderer's German error text.
 *
 * The table itself moved to `src/shared/errors.ts` in Task 12: the tray shows
 * the same failures from the main process, which cannot import renderer code,
 * and a second translation table would let the two drift apart
 * This module stays as the renderer-facing name so the
 * components and their tests keep one import path.
 */

export { describeActionError, describeStaleReason } from '@shared/errors'
