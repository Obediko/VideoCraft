FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV RENDER_ROOT=/tmp/videocraft-render
ENV RENDER_WORK_ROOT=/tmp/videocraft-render

RUN apt-get update   && apt-get install -y --no-install-recommends ffmpeg ca-certificates fontconfig fonts-dejavu-core   && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN npm install --include=dev --ignore-scripts   && npm run build --workspace=@videocraft/domain   && npm run build --workspace=@videocraft/storage   && npm run build --workspace=@videocraft/application   && npm run build --workspace=@videocraft/transcription   && npm run build --workspace=@videocraft/analysis   && npm run build --workspace=@videocraft/captions   && npm run build --workspace=@videocraft/rendering   && npm run build --workspace=@videocraft/persistence   && npm run build --workspace=@videocraft/jobs   && npm run build --workspace=@videocraft/render-worker

USER node
CMD ["node", "workers/render/dist/main.js"]
