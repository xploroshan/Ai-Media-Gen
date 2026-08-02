#!/usr/bin/env bash
# Synthetic test media for e2e (SPEC §2: generated, never committed).
# Needs: ffmpeg, python3 + Pillow.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=e2e/fixtures
mkdir -p "$OUT"

echo "==> images (Pillow, with EXIF + GPS)"
if ! python3 -c "import PIL" 2>/dev/null; then
  python3 -m pip install --quiet --user Pillow
fi
python3 scripts/gen_fixture_images.py "$OUT"

# 120 bpm "beat" audio: 60 ms clicks every 0.5 s (librosa tracks this cleanly).
# Commas inside expressions are escaped for ffmpeg's filtergraph parser.
BEAT_EXPR='sin(2*PI*880*t)*lt(mod(t\,0.5)\,0.06)+0.3*sin(2*PI*220*t)*lt(mod(t\,0.5)\,0.12)'

echo "==> vid1.mp4 (8s, moving pattern + 120bpm click)"
ffmpeg -y -v error \
  -f lavfi -i "testsrc2=size=1280x720:rate=30:duration=8" \
  -f lavfi -i "aevalsrc=${BEAT_EXPR}:s=44100:d=8" \
  -metadata creation_time="2026-07-15T11:00:00Z" \
  -c:v libx264 -preset veryfast -crf 23 -c:a aac -shortest "$OUT/vid1.mp4"

echo "==> vid2.mp4 (6s, different pattern + beat)"
ffmpeg -y -v error \
  -f lavfi -i "mandelbrot=size=1280x720:rate=30" -t 6 \
  -f lavfi -i "aevalsrc=${BEAT_EXPR}:s=44100:d=6" \
  -metadata creation_time="2026-07-15T11:30:00Z" \
  -c:v libx264 -preset veryfast -crf 23 -c:a aac -shortest "$OUT/vid2.mp4"

echo "==> music.mp3 (30s, 120bpm click track for auto-edit)"
ffmpeg -y -v error \
  -f lavfi -i "aevalsrc=${BEAT_EXPR}:s=44100:d=30" \
  -c:a libmp3lame -q:a 4 "$OUT/music.mp3"

echo "==> speech fixtures (espeak-ng if available; tone placeholder otherwise)"
SPEECH_TEXT="Hello everyone. Welcome to our travel video. Today we visit the beach."
if command -v espeak-ng >/dev/null 2>&1; then
  espeak-ng -v en-us -s 115 -a 190 -g 8 -w "$OUT/speech-raw.wav" "$SPEECH_TEXT"
elif command -v espeak >/dev/null 2>&1; then
  espeak -v en-us -s 115 -a 190 -g 8 -w "$OUT/speech-raw.wav" "$SPEECH_TEXT"
else
  ffmpeg -y -v error -f lavfi \
    -i 'aevalsrc=0.4*sin(2*PI*180*t)*(0.5+0.5*sin(2*PI*3*t)):s=16000:d=5' \
    "$OUT/speech-raw.wav"
fi
ffmpeg -y -v error -i "$OUT/speech-raw.wav" -ar 16000 -ac 1 "$OUT/speech.wav"
# speech VIDEO: moving pattern + the spoken audio, for transcribe→caption e2e
ffmpeg -y -v error \
  -f lavfi -i "testsrc2=size=1280x720:rate=30" \
  -i "$OUT/speech.wav" \
  -metadata creation_time="2026-07-15T12:00:00Z" \
  -c:v libx264 -preset veryfast -crf 23 -c:a aac -shortest "$OUT/speech.mp4"
rm -f "$OUT/speech-raw.wav"

echo "fixtures ready in $OUT:"
ls -la "$OUT"
