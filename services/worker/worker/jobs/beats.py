"""beats handler — librosa beat grid for audio assets & music tracks (SPEC §5.2, §6.4.2)."""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

from sqlalchemy import text

from worker.jobs import register
from worker.lib import assets, ffmpeg, s3
from worker.lib.db import get_engine


def compute_beats(local: Path, tmp: Path) -> tuple[list[float], float, list[float]]:
    """Returns (beat times, tempo bpm, per-beat energy 0..1).

    Synthesizes a tempo grid when sparse (SPEC §6.4.2); energy is peak-normalized
    RMS around each beat and drives the slot planner's pacing (§6.4.3).
    """
    import librosa
    import numpy as np

    wav = ffmpeg.extract_wav(local, tmp / "beat.wav")
    if wav is None:
        return [], 0.0, []
    y, sr = librosa.load(str(wav), sr=22050, mono=True)
    if not len(y):
        return [], 0.0, []
    duration = len(y) / sr
    tempo, beats = librosa.beat.beat_track(y=y, sr=sr, units="time")
    tempo_f = float(np.atleast_1d(tempo)[0]) if tempo is not None else 0.0
    beat_list = [round(float(b), 3) for b in beats]
    # sparse -> synthesize grid from tempo
    if tempo_f > 0 and (len(beat_list) < 4 or len(beat_list) < duration * tempo_f / 60 * 0.5):
        interval = 60.0 / tempo_f
        start = beat_list[0] if beat_list else 0.0
        n_beats = int((duration - start) / interval) + 1
        beat_list = [round(start + i * interval, 3) for i in range(n_beats)]

    energy: list[float] = []
    if beat_list:
        hop = 512
        rms = librosa.feature.rms(y=y, hop_length=hop)[0]
        times = librosa.frames_to_time(np.arange(len(rms)), sr=sr, hop_length=hop)
        for b in beat_list:
            idx = int(np.searchsorted(times, b))
            lo, hi = max(0, idx - 2), min(len(rms), idx + 3)
            energy.append(float(np.mean(rms[lo:hi])) if hi > lo else 0.0)
        peak = max(energy)
        energy = [round(e / peak, 3) for e in energy] if peak > 0 else [0.5] * len(energy)
    return beat_list, tempo_f, energy


@register("beats")
def handle(job: dict) -> dict:
    asset_id = job["payload"]["assetId"]

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = Path(tmpdir)
        asset = assets.get_asset(asset_id)
        if asset is not None:
            local = s3.download_to_tmp(asset["storage_key"])
            try:
                beat_times, tempo, _energy = compute_beats(local, tmp)
            finally:
                local.unlink(missing_ok=True)
            assets.upsert_analysis(asset_id, beat_times=beat_times)
            return {"assetId": asset_id, "beats": len(beat_times), "tempo": tempo}

        # not a media asset — maybe a seeded/uploaded music track
        with get_engine().begin() as conn:
            row = (
                conn.execute(
                    text("SELECT id, storage_key FROM music_tracks WHERE id=:id"),
                    {"id": asset_id},
                )
                .mappings()
                .first()
            )
        if row is None:
            raise RuntimeError(f"no media asset or music track {asset_id}")
        local = s3.download_to_tmp(row["storage_key"])
        try:
            beat_times, tempo, energy = compute_beats(local, tmp)
        finally:
            local.unlink(missing_ok=True)
        with get_engine().begin() as conn:
            conn.execute(
                text(
                    "UPDATE music_tracks SET beat_times=CAST(:b AS jsonb), "
                    "energy=CAST(:e AS jsonb) WHERE id=:id"
                ),
                {"b": json.dumps(beat_times), "e": json.dumps(energy), "id": row["id"]},
            )
        return {"musicTrackId": row["id"], "beats": len(beat_times), "tempo": tempo}
