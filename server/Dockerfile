# syntax=docker/dockerfile:1
#
# AUDIT OS — API image.
#
# Two targets are built from these stages:
#   `runtime`   — the API itself: production dependencies plus compiled JS.
#   `toolchain` — full dependencies plus sources, used by the one-shot
#                 `migrate` service to run `prisma db push` and the seed.
#                 Those need the Prisma CLI and tsx, which are devDependencies
#                 and therefore absent from `runtime` on purpose.
#
# Debian slim rather than Alpine: Prisma's query engine, `sharp` and
# `tesseract.js` all ship prebuilt glibc binaries, and matching them beats
# rebuilding three native toolchains against musl.

FROM node:20-bookworm-slim AS base
# Prisma's query engine links against OpenSSL; the slim image does not carry it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# ── Dependencies ──────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ── Build: generate the Prisma client, then compile TypeScript ────────────
FROM deps AS build
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
# `npm run build`, not a bare `tsc`: the script also copies prisma/sql beside
# the compiled output, and the Books invariants loader reads it from there.
RUN npm run build

# ── Toolchain: schema push + seed ─────────────────────────────────────────
# Runs to completion and exits; the API waits on it via depends_on.
FROM build AS toolchain
ENV NODE_ENV=development
CMD ["sh", "-c", "npx prisma db push --skip-generate && npx tsx prisma/seed.ts"]

# ── Runtime ───────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# The generated client comes ACROSS from the build stage rather than being
# regenerated here: `prisma generate` needs the Prisma CLI, which is a
# devDependency this stage deliberately does not install. Same base image, so
# the engine binaries match.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
# dist already carries prisma/sql — the build script copies it beside the
# compiled loader, which is where invariants.ts resolves it from.
COPY --from=build /app/dist ./dist
COPY prisma/schema.prisma ./prisma/schema.prisma

# Uploaded files land under ./uploads (resolved from the working directory by
# the storage adapters), so that path is a volume in compose.
RUN mkdir -p uploads && chown -R node:node /app
USER node

EXPOSE 4000
# The API answers /api/health without a session, which is what this checks.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/index.js"]
