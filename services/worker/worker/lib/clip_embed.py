"""CLIP ViT-B/32 embeddings + zero-shot tags (SPEC §6.1.5). CPU, lazy singleton."""

from __future__ import annotations

import threading
from pathlib import Path

import numpy as np

from worker.lib.labels import LABELS
from worker.lib.settings import get_settings

_lock = threading.Lock()
_state: dict = {}


def _load():
    with _lock:
        if "model" not in _state:
            import open_clip
            import torch

            cache = get_settings().model_cache_dir
            model, _, preprocess = open_clip.create_model_and_transforms(
                "ViT-B-32", pretrained="openai", cache_dir=cache
            )
            model.eval()
            tokenizer = open_clip.get_tokenizer("ViT-B-32")
            with torch.no_grad():
                text_feat = model.encode_text(tokenizer([f"a photo of {t}" for t in LABELS]))
                text_feat = text_feat / text_feat.norm(dim=-1, keepdim=True)
            _state.update(
                model=model, preprocess=preprocess, text_feat=text_feat, torch=torch
            )
    return _state


def embed_image(image_path: Path | str) -> np.ndarray:
    """512-dim L2-normalized embedding."""
    from PIL import Image

    st = _load()
    torch = st["torch"]
    img = Image.open(image_path).convert("RGB")
    tensor = st["preprocess"](img).unsqueeze(0)
    with torch.no_grad():
        feat = st["model"].encode_image(tensor)
        feat = feat / feat.norm(dim=-1, keepdim=True)
    return feat[0].cpu().numpy().astype(np.float32)


def top_tags(embedding: np.ndarray, k: int = 8) -> list[dict]:
    """Top-k cosine matches against the label set."""
    st = _load()
    text = st["text_feat"].cpu().numpy()
    sims = text @ embedding
    order = np.argsort(-sims)[:k]
    return [{"label": LABELS[i], "score": round(float(sims[i]), 4)} for i in order]
