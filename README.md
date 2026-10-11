# CPSolver - Cloudflare Turnstile Solver Microservice

CPSolver is an ultra-lightweight, self-hosted Cloudflare Turnstile and Cloudflare clearance solver microservice built with Node.js, TypeScript, Express, and **Patchright** (undetected Chromium driver stripping Chrome DevTools Protocol CDP automation signatures).

It is specifically engineered to run reliably on a **free Render Web Service with a strict 512MB RAM cgroup limit**, eliminating the need for paid commercial solver APIs (such as Capzy or CapSolver) by running Turnstile verification through your static residential proxy.

---

## Features

- **Patchright CDP Anti-Detection Engine**:
  - Eliminates Chrome DevTools Protocol (CDP) WebSocket signatures and `Runtime.enable` leaks at the C++ driver layer.
  - Successfully solves live Cloudflare Turnstile challenges on strict production services (Codeforces submit/login, LeetCode login) without triggering `Verification failed`.
  - Runs with Xvfb virtual display on Linux/Docker (`HEADLESS=false`), giving full GPU canvas/WebGL fidelity to Turnstile's behavioral analytics.
- **512MB RAM Optimization for Render**:
  - **Single Warm Browser**: Reuses a single Chromium instance across requests with ephemeral `BrowserContext` sessions that are closed immediately upon completion.
  - **Memory Guardrails & Auto-Recycling**: Tracks process RSS memory and solve counts, proactively recycling the browser instance (`global.gc()`) before memory leaks can cause OOM crashes.
  - **Concurrency Mutex / Queue**: By default serializes solves (`MAX_CONCURRENT_SOLVES=1`, configurable), queuing incoming requests with backpressure rejection (`429`) when queue is full.
- **Stealth & Anti-Fingerprinting**:
  - Removes `navigator.webdriver` indicators with native property descriptors.
  - Emulates desktop Chrome runtime, plugins, mime types, languages, and WebGL renderer.
  - Simulates human mouse movements with Bézier curves, easing, and micro-jitter for interactive checkboxes.
- **Dual Solving Strategies**:
  - **Synthetic Harness Mode (`mode: 'harness'`)**: Intercepts the target URL's document request and serves a minimal Turnstile HTML host page under the exact target origin. Super-fast, minimal bandwidth.
  - **Direct Navigation Mode (`mode: 'navigate'`)**: Visits the real page directly when full website session context is required, returning both Turnstile tokens and clearance cookies (`cf_clearance`).
- **Smart Proxy Pool & Sequential Failover**:
  - Automatically loads single or comma-separated proxy lists from `PROXY_URL` or `PROXIES`.
  - Sequential rotation: begins solving with the current active IP; if an IP fails (e.g., sticky peer offline), sequentially fails over to the next candidate until all proxies have been attempted.
  - Automatically preserves the working IP on success for subsequent requests.
  - Exposes `/proxies`, `/proxies/rotate`, and `/proxies/reset` endpoints for real-time observability and pool management.
- **Drop-in Compatibility**:
  - Standard REST contract matching `src/codeforces/browserForm.ts` (`data.token`, `data.cookies`).
  - Health check endpoint (`GET /health` and `GET /`) for Render uptime monitoring.

---

## API Reference

### 1. `POST /solve`

Solves a Cloudflare Turnstile challenge and returns a valid clearance token.

#### Request Headers
`Content-Type: application/json`

#### Request Body
```json
{
  "siteurl": "https://codeforces.com/problemset/submit",
  "sitekey": "0x4AAAAAA...",
  "action": "submit",
  "cdata": "optional-custom-data",
  "proxy": "http://user:pass@residential-proxy.example.com:8080",
  "timeout": 45000,
  "mode": "harness"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `siteurl` | string | **Yes** | Target webpage URL where the Turnstile challenge originated. |
| `sitekey` | string | **Yes** | Cloudflare Turnstile sitekey (e.g. `0x4AAAAAA...`). |
| `action` | string | No | Optional Turnstile action parameter. |
| `cdata` | string | No | Optional Turnstile customer data string. |
| `proxy` | string \| object | No | Per-request proxy override (`http://user:pass@host:port` or `{ server, username, password }`). |
| `timeout` | number | No | Solve timeout in milliseconds (default: 45000). |
| `mode` | string | No | Solving strategy: `"harness"` (default) or `"navigate"`. |

#### Response (Success: `200 OK`)
```json
{
  "ok": true,
  "token": "0.X_...",
  "durationMs": 3410,
  "modeUsed": "harness"
}
```

#### Response (Failure: `400` / `408` / `429` / `500`)
```json
{
  "ok": false,
  "error": "Turnstile challenge timed out after 45000ms without token",
  "durationMs": 45002,
  "modeUsed": "harness"
}
```

---

### 2. `GET /health` or `GET /`

Liveness and health monitoring for Render.

#### Response (`200 OK`)
```json
{
  "status": "ok",
  "service": "CPSolver",
  "uptimeSeconds": 3600,
  "memory": {
    "rssMb": 85,
    "heapTotalMb": 32,
    "heapUsedMb": 24
  },
  "queue": {
    "active": 0,
    "waiting": 0,
    "maxConcurrent": 1,
    "maxQueueSize": 10
  },
  "browser": {
    "isAlive": true,
    "solvesSinceRestart": 12
  }
}
```

---

### 3. `GET /stats`

Returns aggregated execution statistics.

#### Response (`200 OK`)
```json
{
  "totalSolves": 45,
  "successfulSolves": 44,
  "failedSolves": 1,
  "activeSolves": 0,
  "queueLength": 0,
  "avgDurationMs": 3250,
  "browserRestarts": 1,
  "lastSolvedAt": "2026-10-11T05:00:00.000Z"
}
```

---

## Configuration (Environment Variables)

Create a `.env` file based on `.env.example`:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `10000` | HTTP port to bind (Render automatically sets `$PORT`). |
| `HOST` | `0.0.0.0` | Bind host address. |
| `DEFAULT_TIMEOUT_MS` | `45000` | Default timeout for solving challenges in milliseconds. |
| `MAX_CONCURRENT_SOLVES` | `1` | Max concurrent browser solves. Keep at `1` for Render 512MB RAM. |
| `MAX_QUEUE_SIZE` | `10` | Max number of pending requests waiting in the queue before rejecting with 429. |
| `MAX_SOLVES_BEFORE_RECYCLE` | `50` | Recycles the browser process after this many solves to prevent memory bloat. |
| `MAX_RSS_MB` | `380` | Process RSS threshold to trigger automatic browser recycling. |
| `HEADLESS` | `true` | Runs Chromium in headless mode. Set to `false` for local visual debugging. |
| `PROXY_URL` | *unset* | Default proxy URL, e.g. `http://user:pass@proxy.example.com:8080`. Supports comma-separated list of multiple proxies. |
| `PROXIES` | *unset* | Comma-separated or newline-separated list of proxies for automatic rotation and sequential failover. |
| `PROXY_SERVER` | *unset* | Alternate proxy server host without credentials. |
| `PROXY_USERNAME` | *unset* | Username for `PROXY_SERVER`. |
| `PROXY_PASSWORD` | *unset* | Password for `PROXY_SERVER`. |

---

## Local Development & Testing

### 1. Installation
```bash
cd CPSolver
npm install
```

### 2. Run Sanity Verification Suite
```bash
# Run with tsx
npm test

# Or run against compiled JavaScript bundle in dist/
npm run test:dist

# Run standalone CLI solver test against interactive challenge
npm run test:solve
```

### 3. Build TypeScript
```bash
npm run build
```

### 4. Start the Service Locally
```bash
npm start
```
Or for hot reloading:
```bash
npm run dev
```

---

## Deployment to Render (Free Web Service)

1. **Create a New Repository**:
   Initialize a git repo inside the `CPSolver/` folder and push to GitHub:
   ```bash
   cd CPSolver
   git init
   git add .
   git commit -m "Initial commit for CPSolver microservice"
   git remote add origin https://github.com/<your-username>/cpsolver.git
   git push -u origin main
   ```

2. **Deploy on Render**:
   - Go to [Render Dashboard](https://dashboard.render.com).
   - Click **New +** -> **Web Service**.
   - Connect your `cpsolver` GitHub repository.
   - Configure:
     - **Environment**: `Docker`
     - **Region**: Choose closest to your target services (e.g. Frankfurt, Oregon).
     - **Instance Type**: `Free (512MB RAM, 0.1 CPU)`
     - **Health Check Path**: `/health`
   - Add Environment Variables:
     - `PORT`: `10000` (or leave default, Render sets this automatically)
     - `PROXY_URL`: `http://your-residential-proxy-url` (recommended for Cloudflare bypass)
     - `MAX_CONCURRENT_SOLVES`: `1`

3. **Integrate with Main Backend**:
   In your main application (e.g., `c:\Users\Lenovo\Videos\BE\NEW-REPO\.env`):
   ```env
   TURNSTILE_SOLVER_URL=https://your-cpsolver.onrender.com
   ```
   `src/codeforces/browserForm.ts` will automatically send Turnstile challenge requests to your deployed solver!
