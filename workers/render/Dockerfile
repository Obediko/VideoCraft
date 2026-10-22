FROM node:22-bookworm-slim

ENV NODE_ENV=production
ENV RENDER_ROOT=/tmp/videocraft-render
ENV RENDER_WORK_ROOT=/tmp/videocraft-render

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .
RUN npm install --ignore-scripts && npm run build

USER node
CMD ["node", "workers/render/dist/main.js"]
