"""Prompt safety pre-filter (SPEC §8.5) — local blocklist on top of fal's own safety.

Blocks CSAM-adjacent and real-person sexual content patterns with a clear error.
Full moderation stack is out of scope for v1.
"""
# MODERATION-HOOK: replace/augment with a real moderation service call

from __future__ import annotations

import re

_BLOCK_PATTERNS = [
    # CSAM-adjacent: minors in any sexual context
    r"\b(child|children|kid|kids|minor|minors|teen|teens|underage|preteen|"
    r"toddler|infant|baby|schoolgirl|schoolboy|loli|shota)\b"
    r"(?:[^.\n]{0,80})?\b(nude|naked|nsfw|sexual|sexy|erotic|porn|explicit|"
    r"undress|lingerie|intimate)\b",
    r"\b(nude|naked|nsfw|sexual|sexy|erotic|porn|explicit|undress)\b"
    r"(?:[^.\n]{0,80})?\b(child|children|kid|kids|minor|minors|underage|"
    r"preteen|toddler|infant|schoolgirl|schoolboy|loli|shota)\b",
    # real-person sexual deepfakes
    r"\b(nude|naked|nsfw|topless|porn|sex|undress(?:ed|ing)?)\b"
    r"(?:[^.\n]{0,60})?\b(celebrity|actress|actor|politician|real person|"
    r"my (?:ex|neighbor|coworker|colleague|teacher|boss))\b",
    r"\bdeepfake\b(?:[^.\n]{0,60})?\b(nude|porn|sexual|nsfw)\b",
]

_COMPILED = [re.compile(p, re.IGNORECASE) for p in _BLOCK_PATTERNS]


class BlockedPromptError(ValueError):
    """Raised when a prompt trips the local safety blocklist."""


def check_prompt(prompt: str) -> None:
    """Raises BlockedPromptError with a clear message when blocked."""
    for pattern in _COMPILED:
        if pattern.search(prompt):
            raise BlockedPromptError(
                "This prompt was blocked by the content safety filter. "
                "Prompts involving minors in any sexual context or sexual imagery "
                "of real people are not allowed."
            )
