# syntax=docker/dockerfile:1.7

# Build the owner dashboard from the pnpm workspace.
FROM node:22-alpine AS web-build
WORKDIR /src
RUN corepack enable && corepack prepare pnpm@10.30.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web-admin/package.json apps/web-admin/package.json
RUN pnpm install --frozen-lockfile --filter @ctracking/web-admin...

COPY apps/web-admin apps/web-admin
RUN pnpm --filter @ctracking/web-admin build

# Render the static marketing pages for the Railway-generated/custom domain. The
# committed site supplies the shared styles, images, videos and download assets;
# build.mjs refreshes the environment-specific HTML, sitemap and robots file.
FROM node:22-alpine AS marketing-build
WORKDIR /src
ARG SITE_BASE_URL=https://example.invalid
COPY marketing marketing
RUN cp -R marketing/site marketing/site-railway \
    && SITE_BASE_URL="$SITE_BASE_URL" SITE_OUT=site-railway SITE_GA_ID="" \
       node marketing/build.mjs

# Build the API as a static Linux binary. Database migrations are embedded in it
# and run automatically when the service starts.
FROM golang:1.26-alpine AS backend-build
WORKDIR /src
COPY apps/backend/go.mod apps/backend/go.sum ./
RUN go mod download
COPY apps/backend ./
RUN CGO_ENABLED=0 GOOS=linux go build \
    -trimpath \
    -ldflags "-s -w -X ctracking/backend/internal/handlers.Version=railway" \
    -o /out/server ./cmd/server

# One public Railway service serves the landing site, /admin SPA and /v1 API on
# the same origin. The entrypoint fixes ownership of a newly attached Railway
# volume before dropping privileges to the unprivileged app user.
FROM alpine:3.22
RUN apk add --no-cache ca-certificates su-exec \
    && addgroup -S -g 10001 app \
    && adduser -S -D -H -u 10001 -G app app \
    && mkdir -p /app/web/admin /app/storage/screenshots /app/logs \
    && chown -R app:app /app

WORKDIR /app
COPY --from=backend-build /out/server /app/server
COPY --from=web-build /src/apps/web-admin/dist /app/web/admin
COPY --from=marketing-build /src/marketing/site-railway /app/web
COPY scripts/railway-entrypoint.sh /usr/local/bin/railway-entrypoint

ENV PORT=8080 \
    STATIC_DIR=/app/web \
    STORAGE_DIR=/app/storage \
    LOG_DIR=/app/logs \
    APP_ENV=production

EXPOSE 8080
ENTRYPOINT ["railway-entrypoint"]
