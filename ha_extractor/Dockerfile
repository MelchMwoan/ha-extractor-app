# https://developers.home-assistant.io/docs/apps/configuration#app-dockerfile
ARG BUILD_FROM=ghcr.io/home-assistant/base:latest
FROM ${BUILD_FROM}

ARG TARGETARCH

LABEL \
  org.opencontainers.image.title="Home Assistant App: HA Extractor" \
  org.opencontainers.image.description="Pre-renders Home Assistant dashboards as animated WebP or MP4 files." \
  org.opencontainers.image.source="https://github.com/MelchMwoan/ha-extractor-app" \
  org.opencontainers.image.licenses="MIT"

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser

RUN \
  apk add --no-cache \
    ca-certificates \
    chromium \
    ffmpeg \
    nodejs \
    npm

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev \
  && npx playwright install ffmpeg

COPY . /app/
COPY rootfs /
RUN chmod +x /etc/services.d/ha-extractor/run \
  && mkdir -p /config/www/ha-extractor
