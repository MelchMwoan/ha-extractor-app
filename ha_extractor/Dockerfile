# https://developers.home-assistant.io/docs/apps/configuration#app-dockerfile
ARG BUILD_FROM=ghcr.io/home-assistant/base:latest
FROM ${BUILD_FROM} AS builder

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apk add --no-cache nodejs npm

WORKDIR /build
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund --no-progress \
  && npx playwright install ffmpeg

FROM ${BUILD_FROM}

LABEL \
  org.opencontainers.image.title="Home Assistant App: HA Extractor" \
  org.opencontainers.image.description="Pre-renders Home Assistant dashboards as animated WebP or MP4 files." \
  org.opencontainers.image.source="https://github.com/MelchMwoan/ha-extractor-app" \
  org.opencontainers.image.licenses="MIT"

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-headless-shell

RUN \
  apk add --no-cache \
    ca-certificates \
    chromium-headless-shell \
    ffmpeg \
    nodejs \
  && rm -f /usr/lib/libLLVM.so.* /usr/lib/libgallium-*.so* \
  && rm -rf /usr/lib/dri

WORKDIR /app
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json
COPY --from=builder /ms-playwright /ms-playwright

COPY index.js player.html ./
COPY rootfs /
RUN chmod +x /etc/services.d/ha-extractor/run \
  && mkdir -p /config/www/ha-extractor
