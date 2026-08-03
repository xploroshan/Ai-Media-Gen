/**
 * Prompt safety pre-filter (SPEC §8.5) — web-side mirror of worker/lib/safety.py.
 * Fail fast at the API before credits are touched; the worker re-checks.
 */
// MODERATION-HOOK: replace/augment with a real moderation service call

const BLOCK_PATTERNS: RegExp[] = [
  /\b(child|children|kid|kids|minor|minors|teen|teens|underage|preteen|toddler|infant|baby|schoolgirl|schoolboy|loli|shota)\b(?:[^.\n]{0,80})?\b(nude|naked|nsfw|sexual|sexy|erotic|porn|explicit|undress|lingerie|intimate)\b/i,
  /\b(nude|naked|nsfw|sexual|sexy|erotic|porn|explicit|undress)\b(?:[^.\n]{0,80})?\b(child|children|kid|kids|minor|minors|underage|preteen|toddler|infant|schoolgirl|schoolboy|loli|shota)\b/i,
  /\b(nude|naked|nsfw|topless|porn|sex|undress(?:ed|ing)?)\b(?:[^.\n]{0,60})?\b(celebrity|actress|actor|politician|real person|my (?:ex|neighbor|coworker|colleague|teacher|boss))\b/i,
  /\bdeepfake\b(?:[^.\n]{0,60})?\b(nude|porn|sexual|nsfw)\b/i,
];

export const SAFETY_BLOCK_MESSAGE =
  "This prompt was blocked by the content safety filter. Prompts involving minors in any " +
  "sexual context or sexual imagery of real people are not allowed.";

export function isPromptBlocked(prompt: string): boolean {
  return BLOCK_PATTERNS.some((p) => p.test(prompt));
}
