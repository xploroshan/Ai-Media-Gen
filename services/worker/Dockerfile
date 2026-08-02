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

# Pre-bake model weights (CLIP ViT-B/32 + BlazeFace) so first analyze job doesn't stall
ENV MODEL_CACHE_DIR=/models
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
PY

COPY pyproject.toml ./
COPY worker ./worker

ENV PYTHONUNBUFFERED=1
EXPOSE 8001
CMD ["python", "-m", "worker"]
