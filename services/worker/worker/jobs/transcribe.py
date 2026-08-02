"""transcribe handler — faster-whisper small int8, en+hi (SPEC §3, §5.2)."""

from __future__ import annotations

import tempfile
import threading
from pathlib import Path

from worker.jobs import register
from worker.lib import assets, ffmpeg, s3
from worker.lib.settings import get_settings

_lock = threading.Lock()
_model = None


def get_model():
    global _model
    with _lock:
        if _model is None:
            from faster_whisper import WhisperModel

            _model = WhisperModel(
                "small",
                device="cpu",
                compute_type="int8",
                download_root=get_settings().model_cache_dir,
            )
    return _model


def transcribe_wav(wav_path: Path, lang: str | None = None) -> dict:
    """Returns {lang, words: [{w, s, e}]} (§4 MediaAnalysis.transcript shape)."""
    segments, info = get_model().transcribe(
        str(wav_path),
        language=lang,
        word_timestamps=True,
        vad_filter=True,
    )
    words = []
    for segment in segments:
        for word in segment.words or []:
            text = word.word.strip()
            if text:
                # cast: faster-whisper returns numpy floats, which break json.dumps
                words.append(
                    {"w": text, "s": round(float(word.start), 3), "e": round(float(word.end), 3)}
                )
    return {"lang": lang or info.language or "en", "words": words}


@register("transcribe")
def handle(job: dict) -> dict:
    payload = job["payload"]
    asset_id = payload["assetId"]
    lang = payload.get("lang")
    asset = assets.get_asset(asset_id)
    if asset is None:
        raise RuntimeError(f"asset {asset_id} not found")

    local = s3.download_to_tmp(asset["storage_key"])
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            wav = ffmpeg.extract_wav(local, Path(tmpdir) / "speech.wav", sr=16000)
            if wav is None:
                raise RuntimeError("asset has no audio stream")
            transcript = transcribe_wav(wav, lang)
    finally:
        local.unlink(missing_ok=True)

    assets.upsert_analysis(asset_id, transcript=transcript)
    return {"assetId": asset_id, "lang": transcript["lang"], "words": len(transcript["words"])}
