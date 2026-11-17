# ==============================================================================
# Dockerfile for CPSolver: Cloudflare Turnstile Solver Microservice
# Optimized for Render Free Web Services (512MB RAM cgroup limit)
# Ships Xvfb for Chromium instances configured to run with a display
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
    HEADLESS=true \
    CPSOLVER_CONTAINER_CHROMIUM=true \
    CPSOLVER_MANAGE_XVFB=true \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PATCHRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_OPTIONS="--max-old-space-size=112 --max-semi-space-size=4 --expose-gc"

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY mobile ./mobile

# Port exposure (support both Render default 10000 and custom PORT=3000)
EXPOSE 10000 3000

CMD ["node", "dist/src/index.js"]
