# syntax=docker/dockerfile:1
#
# AUDIT OS — web image.
#
# Builds the Vite bundle, then serves it from nginx. nginx also proxies /api
# and /socket.io to the api container, which is what keeps the browser on ONE
# origin: the session cookie then works with no CORS and no SameSite
# gymnastics, exactly as the Vite dev proxy arranges in development.

FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.node.json vite.config.ts postcss.config.js tailwind.config.ts index.html ./
COPY public ./public
COPY src ./src
# `npm run build` is `tsc -b && vite build` — a type error fails the image.
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
