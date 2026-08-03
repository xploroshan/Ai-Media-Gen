FROM python:3.12-slim

# FFmpeg 6+ and fonts for caption burn-in (Noto Sans + Devanagari, SPEC §3)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg fonts-noto-core libgl1 libgles2 libegl1 libglib2.0-0 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Optional extra CA bundle (corporate/sandbox TLS proxies). certs/ ships empty;
# drop a .crt in it to trust it at build+run time. No-op otherwise.
COPY certs/ /tmp/build-certs/
RUN if ls /tmp/build-certs/*.crt >/dev/null 2>&1; then \
      cp /tmp/build-certs/*.crt /usr/local/share/ca-certificates/ && update-ca-certificates; \
    fi && rm -rf /tmp/build-certs
ENV PIP_CERT=/etc/ssl/certs/ca-certificates.crt \
    REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt

COPY requirements.txt requirements-media.txt* ./
RUN pip install --no-cache-dir -r requirements.txt \
    && if [ -f requirements-media.txt ]; then pip install --no-cache-dir -r requirements-media.txt; fi

# Image-studio deps. basicsr/realesrgan/simple-lama ship stale dependency pins
# (old Pillow with no cp312 wheels, tb-nightly, unused facexlib/gfpgan), so they
# are installed --no-deps with their true runtime deps in requirements-media2.txt.
# basicsr's sdist imports torch at build time -> --no-build-isolation.
COPY requirements-media2.txt ./
RUN pip install --no-cache-dir -r requirements-media2.txt
RUN pip install --no-cache-dir --no-build-isolation --no-deps \
    "basicsr==1.4.2" "realesrgan==0.3.0" "simple-lama-inpainting==0.1.2"
# basicsr imports the removed torchvision.transforms.functional_tensor -> shim it
RUN python -c "import pathlib, torchvision; \
p = pathlib.Path(torchvision.__file__).parent / 'transforms' / 'functional_tensor.py'; \
p.exists() or p.write_text('from torchvision.transforms.functional import rgb_to_grayscale\n')"
RUN python -c "import basicsr, realesrgan, simple_lama_inpainting, rembg; print('image deps ok')"

# Pre-bake model weights so first jobs don't stall on downloads
ENV MODEL_CACHE_DIR=/models \
    U2NET_HOME=/models/u2net \
    TORCH_HOME=/models/torch
RUN python - <<'PY' || echo "model prefetch skipped (offline build)"
import os, urllib.request
cache = os.environ["MODEL_CACHE_DIR"]
os.makedirs(cache, exist_ok=True)
try:
    import open_clip
    open_clip.create_model_and_transforms("ViT-B-32", pretrained="openai", cache_dir=cache)
    print("CLIP weights cached")
except Exception as e:
    print("CLIP prefetch failed:", e)
try:
    url = ("https://storage.googleapis.com/mediapipe-models/face_detector/"
           "blaze_face_short_range/float16/1/blaze_face_short_range.tflite")
    urllib.request.urlretrieve(url, os.path.join(cache, "blaze_face_short_range.tflite"))
    print("BlazeFace model cached")
except Exception as e:
    print("BlazeFace prefetch failed:", e)
try:
    from faster_whisper import WhisperModel
    WhisperModel("small", device="cpu", compute_type="int8", download_root=cache)
    print("faster-whisper small int8 cached")
except Exception as e:
    print("whisper prefetch failed:", e)
try:
    from rembg import new_session
    new_session("isnet-general-use")
    print("rembg isnet-general-use cached")
except Exception as e:
    print("rembg prefetch failed:", e)
try:
    from simple_lama_inpainting import SimpleLama
    SimpleLama()
    print("LaMa big-lama cached")
except Exception as e:
    print("LaMa prefetch failed:", e)
try:
    url = ("https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.1/"
           "RealESRGAN_x2plus.pth")
    dest = os.path.join(cache, "RealESRGAN_x2plus.pth")
    if not os.path.exists(dest):
        urllib.request.urlretrieve(url, dest)
    print("RealESRGAN x2plus cached")
except Exception as e:
    print("RealESRGAN prefetch failed:", e)
PY

COPY pyproject.toml ./
COPY worker ./worker

ENV PYTHONUNBUFFERED=1
EXPOSE 8001
CMD ["python", "-m", "worker"]
