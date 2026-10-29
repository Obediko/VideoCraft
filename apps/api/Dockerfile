FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV PORT=8080

# FFmpeg/ffprobe: upload inspection and silence detection. Python: faster-whisper transcription and scene detection.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 python3-venv \
  && rm -rf /var/lib/apt/lists/*
COPY workers/transcription/requirements.txt /tmp/transcription-requirements.txt
COPY workers/scenes/requirements.txt /tmp/scenes-requirements.txt
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir -r /tmp/transcription-requirements.txt -r /tmp/scenes-requirements.txt
ENV WHISPER_PYTHON=/opt/venv/bin/python \
    WHISPER_WORKER_PATH=/app/workers/transcription/worker.py \
    SCENE_PYTHON=/opt/venv/bin/python \
    SCENE_WORKER_PATH=/app/workers/scenes/worker.py \
    HF_HOME=/opt/hf-cache

WORKDIR /app
COPY . .
RUN npm install --include=dev --ignore-scripts   && npm run build --workspace=@videocraft/domain   && npm run build --workspace=@videocraft/storage   && npm run build --workspace=@videocraft/application   && npm run build --workspace=@videocraft/security   && npm run build --workspace=@videocraft/observability   && npm run build --workspace=@videocraft/analysis   && npm run build --workspace=@videocraft/captions   && npm run build --workspace=@videocraft/music   && npm run build --workspace=@videocraft/strategies   && npm run build --workspace=@videocraft/transcription   && npm run build --workspace=@videocraft/intent-analysis   && npm run build --workspace=@videocraft/timeline-interchange   && npm run build --workspace=@videocraft/scene-detection   && npm run build --workspace=@videocraft/jobs   && npm run build --workspace=@videocraft/persistence   && npm run build --workspace=@videocraft/api

# Speech-model cache: a persistent volume in deployments (not /tmp, which is RAM-backed tmpfs there).
RUN mkdir -p /opt/hf-cache && chown node:node /opt/hf-cache
USER node
EXPOSE 8080
CMD ["node", "apps/api/dist/main.js"]
