# Match the render worker's Debian/FFmpeg runtime for resource regressions.
# Segmentation uses a generated fixture here; OpenCV is not needed in this image.
FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 fontconfig fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
