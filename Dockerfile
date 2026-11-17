# ==============================================================================
# Dockerfile for CPSolver: Cloudflare Turnstile Solver Microservice
# Optimized for Render Free Web Services (512MB RAM cgroup limit)
# Uses Xvfb to provide the display required by headed Chromium
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
RUN apt-get update && apt-get install -y --no-install-recommends xvfb xauth \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=10000 \
    HOST=0.0.0.0 \
    HEADLESS=false \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PATCHRIGHT_BROWSERS_PATH=/ms-playwright \
    # Restrict Node V8 heap to ~192MB with --expose-gc so Chromium has ~300MB headroom within Render's 512MB limit
    NODE_OPTIONS="--max-old-space-size=192 --expose-gc"

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# Port exposure (support both Render default 10000 and custom PORT=3000)
EXPOSE 10000 3000

# Wait for the display to be ready before starting the solver.
CMD ["xvfb-run", "-a", "-s", "-screen 0 1280x800x24 -nolisten tcp", "node", "dist/src/index.js"]
