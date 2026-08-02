import type { EditSpec, TextClip, VideoClip } from "@reelforge/shared";

/**
 * Pure edit-spec operations for the timeline editor (SPEC §7).
 * Every op returns a NEW spec (never mutates) and keeps §5.1 invariants:
 * video clips contiguous, sorted, non-overlapping; durationSec = last clip end.
 */

export const MIN_CLIP_SEC = 0.3;

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function videoTrack(spec: EditSpec) {
  const track = spec.tracks.find((t) => t.type === "video");
  if (!track || track.type !== "video") throw new Error("no video track");
  return track;
}

export function textTrack(spec: EditSpec) {
  const track = spec.tracks.find((t) => t.type === "text");
  if (!track || track.type !== "text") throw new Error("no text track");
  return track;
}

export function audioTrack(spec: EditSpec) {
  const track = spec.tracks.find((t) => t.type === "audio");
  if (!track || track.type !== "audio") throw new Error("no audio track");
  return track;
}

/** Recompute contiguous timelineStarts + total duration after any video edit. */
export function normalizeTimeline(spec: EditSpec): EditSpec {
  const next = clone(spec);
  const track = videoTrack(next);
  let cursor = 0;
  for (const clip of track.clips) {
    clip.timelineStart = Math.round(cursor * 1000) / 1000;
    cursor += clip.duration;
  }
  if (track.clips.length > 0) {
    next.durationSec = Math.round(cursor * 1000) / 1000;
  }
  // drop transition on the last clip (§5.1: transitionAfter is between clips)
  const last = track.clips[track.clips.length - 1];
  if (last) delete last.transitionAfter;
  return next;
}

export function findClip(spec: EditSpec, clipId: string): VideoClip | undefined {
  return videoTrack(spec).clips.find((c) => c.id === clipId);
}

/** Trim a clip to a new duration. Video clips also adjust srcOut (respecting bounds). */
export function trimClip(
  spec: EditSpec,
  clipId: string,
  newDuration: number,
  assetDuration?: number,
): EditSpec {
  const next = clone(spec);
  const clip = videoTrack(next).clips.find((c) => c.id === clipId);
  if (!clip) return spec;
  const duration = Math.max(MIN_CLIP_SEC, Math.round(newDuration * 1000) / 1000);
  if (clip.kind === "video") {
    const srcIn = clip.srcIn ?? 0;
    let srcOut = srcIn + duration * clip.speed;
    if (assetDuration !== undefined && srcOut > assetDuration) {
      srcOut = assetDuration;
    }
    if (srcOut - srcIn < MIN_CLIP_SEC * clip.speed) return spec;
    clip.srcOut = Math.round(srcOut * 1000) / 1000;
    clip.duration = Math.round(((srcOut - srcIn) / clip.speed) * 1000) / 1000;
  } else {
    clip.duration = duration;
  }
  return normalizeTimeline(next);
}

/** Split the clip under `atTime` (absolute timeline seconds) into two clips. */
export function splitAt(spec: EditSpec, atTime: number): EditSpec {
  const next = clone(spec);
  const track = videoTrack(next);
  const idx = track.clips.findIndex(
    (c) =>
      atTime > c.timelineStart + MIN_CLIP_SEC &&
      atTime < c.timelineStart + c.duration - MIN_CLIP_SEC,
  );
  if (idx === -1) return spec;
  const clip = track.clips[idx]!;
  const offset = atTime - clip.timelineStart;

  const first = clone(clip);
  const second = clone(clip);
  second.id = `${clip.id}-s${Math.floor(offset * 1000)}`;
  first.duration = Math.round(offset * 1000) / 1000;
  second.duration = Math.round((clip.duration - offset) * 1000) / 1000;
  if (clip.kind === "video") {
    const srcSplit = (clip.srcIn ?? 0) + offset * clip.speed;
    first.srcOut = Math.round(srcSplit * 1000) / 1000;
    second.srcIn = Math.round(srcSplit * 1000) / 1000;
  }
  delete first.transitionAfter; // hard cut at the split point
  track.clips.splice(idx, 1, first, second);
  return normalizeTimeline(next);
}

export function deleteClip(spec: EditSpec, clipId: string): EditSpec {
  const next = clone(spec);
  const track = videoTrack(next);
  if (track.clips.length <= 1) return spec; // never leave an empty reel
  const idx = track.clips.findIndex((c) => c.id === clipId);
  if (idx === -1) return spec;
  track.clips.splice(idx, 1);
  return normalizeTimeline(next);
}

export function reorderClip(spec: EditSpec, fromIndex: number, toIndex: number): EditSpec {
  const next = clone(spec);
  const track = videoTrack(next);
  if (
    fromIndex < 0 ||
    fromIndex >= track.clips.length ||
    toIndex < 0 ||
    toIndex >= track.clips.length ||
    fromIndex === toIndex
  ) {
    return spec;
  }
  const [moved] = track.clips.splice(fromIndex, 1);
  track.clips.splice(toIndex, 0, moved!);
  return normalizeTimeline(next);
}

export function updateClip(
  spec: EditSpec,
  clipId: string,
  patch: Partial<Pick<VideoClip, "speed" | "transitionAfter" | "kenBurns" | "transform">>,
): EditSpec {
  const next = clone(spec);
  const clip = videoTrack(next).clips.find((c) => c.id === clipId);
  if (!clip) return spec;
  Object.assign(clip, patch);
  return normalizeTimeline(next);
}

let textSeq = 0;
export function addTextClip(spec: EditSpec, atTime: number, styleId: string): EditSpec {
  const next = clone(spec);
  const track = textTrack(next);
  textSeq += 1;
  const start = Math.max(0, Math.min(atTime, next.durationSec - 0.5));
  track.clips.push({
    id: `text-${Date.now()}-${textSeq}`,
    text: "Your text",
    start: Math.round(start * 100) / 100,
    end: Math.round(Math.min(start + 2, next.durationSec) * 100) / 100,
    styleId,
    pos: "center",
    animate: "pop",
  });
  track.clips.sort((a, b) => a.start - b.start);
  return next;
}

export function updateTextClip(spec: EditSpec, clipId: string, patch: Partial<TextClip>): EditSpec {
  const next = clone(spec);
  const track = textTrack(next);
  const clip = track.clips.find((c) => c.id === clipId);
  if (!clip) return spec;
  Object.assign(clip, patch, { id: clip.id });
  if (clip.end <= clip.start) clip.end = clip.start + 0.5;
  track.clips.sort((a, b) => a.start - b.start);
  return next;
}

export function deleteTextClip(spec: EditSpec, clipId: string): EditSpec {
  const next = clone(spec);
  const track = textTrack(next);
  track.clips = track.clips.filter((c) => c.id !== clipId);
  return next;
}

export function replaceMusic(spec: EditSpec, musicAssetId: string | null): EditSpec {
  const next = clone(spec);
  const track = audioTrack(next);
  if (musicAssetId === null) {
    track.clips = [];
    delete next.meta.musicTrackId;
    return next;
  }
  track.clips = [
    {
      id: "m1",
      assetId: musicAssetId,
      timelineStart: 0,
      srcIn: 0,
      gainDb: track.clips[0]?.gainDb ?? 0,
      duckUnderSpeechDb: track.clips[0]?.duckUnderSpeechDb ?? -10,
    },
  ];
  next.meta.musicTrackId = musicAssetId;
  return next;
}

export function setCaptions(spec: EditSpec, patch: Partial<EditSpec["captions"]>): EditSpec {
  const next = clone(spec);
  Object.assign(next.captions, patch);
  return next;
}

export function updateCaptionWord(
  spec: EditSpec,
  index: number,
  patch: Partial<{ w: string; s: number; e: number }>,
): EditSpec {
  const next = clone(spec);
  const word = next.captions.words[index];
  if (!word) return spec;
  Object.assign(word, patch);
  if (word.e <= word.s) word.e = word.s + 0.1;
  return next;
}

/** Shift a caption word by delta seconds (timing nudge, SPEC §7). */
export function nudgeCaptionWord(spec: EditSpec, index: number, delta: number): EditSpec {
  const word = spec.captions.words[index];
  if (!word) return spec;
  const s = Math.max(0, Math.round((word.s + delta) * 100) / 100);
  const e = Math.max(s + 0.05, Math.round((word.e + delta) * 100) / 100);
  return updateCaptionWord(spec, index, { s, e });
}

/** Snap a time to the nearest beat within `tolerance` seconds. */
export function snapToBeat(time: number, beatTimes: number[], tolerance = 0.15): number {
  if (!beatTimes.length) return time;
  let best = time;
  let bestDist = tolerance;
  for (const beat of beatTimes) {
    const dist = Math.abs(beat - time);
    if (dist < bestDist) {
      best = beat;
      bestDist = dist;
    }
  }
  return best;
}
