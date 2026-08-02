"""Image studio operations — SPEC §6.7. Pure functions over arrays/paths."""

from __future__ import annotations

from pathlib import Path

import numpy as np

UPSCALE_MAX_INPUT_PX = 2048  # cap input (SPEC §6.7: warn slow)


def enhance(bgr: np.ndarray, clahe_clip: float = 2.0, saturation: float = 1.12) -> np.ndarray:
    """CLAHE on LAB L-channel + mild saturation + gray-world white balance."""
    import cv2

    # gray-world white balance
    result = bgr.astype(np.float32)
    means = result.reshape(-1, 3).mean(axis=0)
    gray = means.mean()
    scale = gray / np.maximum(means, 1e-6)
    result = np.clip(result * scale[None, None, :], 0, 255).astype(np.uint8)

    # CLAHE on L
    lab = cv2.cvtColor(result, cv2.COLOR_BGR2LAB)
    l_chan, a_chan, b_chan = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=clahe_clip, tileGridSize=(8, 8))
    lab = cv2.merge((clahe.apply(l_chan), a_chan, b_chan))
    result = cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)

    # mild saturation
    hsv = cv2.cvtColor(result, cv2.COLOR_BGR2HSV).astype(np.float32)
    hsv[..., 1] = np.clip(hsv[..., 1] * saturation, 0, 255)
    return cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)


def prepare_mask(mask_rgba_or_gray: np.ndarray, target_hw: tuple[int, int]) -> np.ndarray:
    """Normalize an uploaded mask to a binary uint8 (255 = erase) at image size.

    Accepts RGBA (alpha as mask), RGB, or grayscale; resizes with nearest to
    keep edges crisp; binarizes at 127.
    """
    import cv2

    mask = mask_rgba_or_gray
    if mask.ndim == 3:
        if mask.shape[2] == 4:
            alpha = mask[..., 3]
            # painted-on-transparent canvas: alpha carries the strokes
            mask = alpha if alpha.max() > 0 else cv2.cvtColor(mask[..., :3], cv2.COLOR_BGR2GRAY)
        else:
            mask = cv2.cvtColor(mask, cv2.COLOR_BGR2GRAY)
    if (mask.shape[0], mask.shape[1]) != target_hw:
        mask = cv2.resize(mask, (target_hw[1], target_hw[0]), interpolation=cv2.INTER_NEAREST)
    return np.where(mask > 127, 255, 0).astype(np.uint8)


def bg_remove(image_path: Path, out_png: Path) -> Path:
    """rembg isnet-general -> RGBA PNG (SPEC §6.7)."""
    from rembg import new_session, remove

    session = new_session("isnet-general-use")
    data = image_path.read_bytes()
    result = remove(data, session=session)
    out_png.write_bytes(result)
    return out_png


def erase(image_path: Path, mask_path: Path, out_path: Path) -> Path:
    """LaMa inpainting over the masked region (SPEC §6.7)."""
    import cv2
    from PIL import Image
    from simple_lama_inpainting import SimpleLama

    img = Image.open(image_path).convert("RGB")
    raw_mask = cv2.imread(str(mask_path), cv2.IMREAD_UNCHANGED)
    if raw_mask is None:
        raise RuntimeError("unreadable mask")
    mask = prepare_mask(raw_mask, (img.height, img.width))
    result = SimpleLama()(img, Image.fromarray(mask))
    result.save(out_path)
    return out_path


def upscale(image_path: Path, out_path: Path, model_path: Path) -> Path:
    """Real-ESRGAN ×2, input capped at UPSCALE_MAX_INPUT_PX (SPEC §6.7)."""
    import cv2
    from basicsr.archs.rrdbnet_arch import RRDBNet
    from realesrgan import RealESRGANer

    img = cv2.imread(str(image_path), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise RuntimeError("unreadable image")
    h, w = img.shape[:2]
    if max(h, w) > UPSCALE_MAX_INPUT_PX:
        scale = UPSCALE_MAX_INPUT_PX / max(h, w)
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)

    model = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=23,
                    num_grow_ch=32, scale=2)
    upsampler = RealESRGANer(
        scale=2, model_path=str(model_path), model=model, tile=512, tile_pad=10,
        pre_pad=0, half=False, device="cpu",
    )
    output, _ = upsampler.enhance(img, outscale=2)
    cv2.imwrite(str(out_path), output)
    return out_path
