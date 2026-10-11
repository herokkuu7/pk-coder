# ==============================================================================
# Dockerfile for CPSolver: Cloudflare Turnstile Solver Microservice
# Optimized for Render Free Web Services (512MB RAM cgroup limit)
# Uses Xvfb virtual display to enable headed Chromium for 100% Turnstile bypass
# ==============================================================================

# Stage 1: Build stage
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS builder

WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build \
 && npm prune --omit=dev

# Stage 2: Runtime stage
FROM mcr.microsoft.com/playwright:v1.63.0-noble AS runner

WORKDIR /app

# Install lightweight Xvfb virtual display server
RUN apt-get update && apt-get install -y --no-install-recommends xvfb \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=10000 \
    HOST=0.0.0.0 \
    HEADLESS=false \
    DISPLAY=:99 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PATCHRIGHT_BROWSERS_PATH=/ms-playwright \
    # Restrict Node V8 heap to ~192MB with --expose-gc so Chromium has ~300MB headroom within Render's 512MB limit
    NODE_OPTIONS="--max-old-space-size=192 --expose-gc"

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Port exposure
EXPOSE 10000

# Start Xvfb virtual display in background, then launch solver microservice
CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x800x24 -ac & node dist/src/index.js"]
