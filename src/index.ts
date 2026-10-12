import express, { type Request, type Response } from 'express';
import cors from 'cors';
import { config, logInfo, logWarn, logError, getLogs } from './config';
import { solveTurnstile, solverQueue, solverStats, lastDebugScreenshot } from './solver';
import { proxyPool } from './proxyPool';
import { BrowserManager } from './browser';
import { QueueFullError } from './queue';
import type { SolveRequest, HealthResponse, SolverMode } from './types';

export const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

/**
 * Public IP check endpoint.
 */
app.get('/ip', async (_req: Request, res: Response) => {
  try {
    const ip = await fetch('https://api.ipify.org').then((r) => r.text());
    res.status(200).json({ ip });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Real-time PNG screenshot of latest browser page state.
 */
app.get('/screenshot', (_req: Request, res: Response) => {
  if (!lastDebugScreenshot) {
    res.status(404).send('No debug screenshot captured yet');
    return;
  }
  res.setHeader('Content-Type', 'image/png');
  res.status(200).send(lastDebugScreenshot);
});

/**
 * Health check endpoint for Render liveness monitors and uptime probes.
 */
app.get(['/health', '/'], (_req: Request, res: Response) => {
  const browserManager = BrowserManager.getInstance();
  const mem = process.memoryUsage();

  const health: HealthResponse = {
    status: 'ok',
    service: 'CPSolver',
    uptimeSeconds: Math.round(process.uptime()),
    memory: {
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    },
    queue: {
      active: solverQueue.active,
      waiting: solverQueue.waiting,
      maxConcurrent: solverQueue.capacity.maxConcurrent,
      maxQueueSize: solverQueue.capacity.maxQueueSize,
    },
    browser: {
      isAlive: browserManager.isAlive,
      solvesSinceRestart: browserManager.solvesSinceRestart,
    },
    proxyPool: {
      total: proxyPool.size,
      activeIndex: proxyPool.currentIndex,
      activeProxy: proxyPool.getStatus().activeMasked,
    },
  };

  res.status(200).json(health);
});

/**
 * Proxy pool telemetry endpoint.
 */
app.get('/proxies', (_req: Request, res: Response) => {
  res.status(200).json(proxyPool.getStatus());
});

/**
 * Manually rotate to next proxy in pool.
 */
app.post('/proxies/rotate', (_req: Request, res: Response) => {
  const rotated = proxyPool.rotateToNext();
  res.status(200).json({ ok: true, activeIndex: rotated.index, activeProxy: rotated.masked });
});

/**
 * Reset proxy pool index to first proxy (index 0).
 */
app.post('/proxies/reset', (_req: Request, res: Response) => {
  proxyPool.resetToFirst();
  res.status(200).json({ ok: true, activeIndex: 0, activeProxy: proxyPool.getStatus().activeMasked });
});

/**
 * Statistics endpoint for telemetry and monitoring.
 */
app.get('/stats', (_req: Request, res: Response) => {
  const browserManager = BrowserManager.getInstance();
  const stats = solverStats.getStats(
    solverQueue.active,
    solverQueue.waiting,
    browserManager.restarts,
  );
  res.status(200).json(stats);
});

/**
 * In-memory log buffer endpoint for Render debugging and real-time telemetry.
 */
app.get('/logs', (req: Request, res: Response) => {
  const limit = Math.min(200, Math.max(1, parseInt((req.query.limit as string) || '100', 10)));
  const logs = getLogs(limit);
  if (req.query.format === 'text') {
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.status(200).send(logs.map((l) => `[${l.time}] [${l.level}] ${l.msg} ${JSON.stringify(l)}`).join('\n'));
    return;
  }
  res.status(200).json({ ok: true, count: logs.length, logs });
});

/**
 * Primary Turnstile solving endpoint.
 *
 * Expected body:
 * {
 *   "siteurl": "https://example.com/page",
 *   "sitekey": "0x4AAAAAA...",
 *   "action": "login",       // optional
 *   "cdata": "abc123",       // optional
 *   "proxy": "http://...",   // optional
 *   "timeout": 45000,        // optional (ms)
 *   "mode": "harness"        // optional ('harness' | 'navigate')
 * }
 *
 * Successful response:
 * {
 *   "ok": true,
 *   "token": "0....",
 *   "durationMs": 3410
 * }
 */
app.post('/solve', async (req: Request, res: Response): Promise<void> => {
  const body = req.body as Partial<SolveRequest>;

  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'Missing JSON request body' });
    return;
  }

  const { siteurl, sitekey, action, cdata, proxy, timeout, mode, userAgent, cookies } = body;

  if (!siteurl || typeof siteurl !== 'string') {
    res.status(400).json({ ok: false, error: 'Missing or invalid "siteurl" parameter' });
    return;
  }

  try {
    const parsedUrl = new URL(siteurl);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      res.status(400).json({ ok: false, error: '"siteurl" must use http or https protocol' });
      return;
    }
  } catch {
    res.status(400).json({ ok: false, error: 'Invalid URL string for "siteurl"' });
    return;
  }

  if (sitekey !== undefined && (typeof sitekey !== 'string' || !sitekey.trim())) {
    res.status(400).json({ ok: false, error: 'Missing or invalid "sitekey" parameter' });
    return;
  }

  const isInterstitialKey = sitekey === '0x4AAAAAAADnPIDROrmt1Wwj';
  const effectiveMode: SolverMode =
    mode ? mode : (isInterstitialKey ? 'navigate' : (sitekey ? 'harness' : 'navigate'));

  const abortController = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      abortController.abort();
    }
  });

  try {
    const solveReq: SolveRequest = {
      siteurl: siteurl.trim(),
      sitekey: typeof sitekey === 'string' && sitekey.trim() ? sitekey.trim() : undefined,
      action: typeof action === 'string' ? action.trim() : undefined,
      cdata: typeof cdata === 'string' ? cdata.trim() : undefined,
      proxy: proxy,
      timeout: typeof timeout === 'number' && timeout > 0 ? timeout : undefined,
      mode: effectiveMode,
      userAgent: typeof userAgent === 'string' && userAgent.trim() ? userAgent.trim() : undefined,
      cookies: cookies,
    };

    const result = await solveTurnstile(solveReq, abortController.signal);

    const hasToken = typeof result.token === 'string' && result.token.trim().length > 10;
    const hasClearance = typeof result.cfClearance === 'string' && result.cfClearance.trim().length > 0;
    const hasCookies = !!(result.cookies && Object.keys(result.cookies).length > 0);

    // Interstitial challenge key (0x4AAAAAAADnPIDROrmt1Wwj) or navigation-only solves succeed via clearance cookies.
    // Form widget keys (e.g. 0x4AAAAAACDz1ltMYNJCAQZS on Codeforces problem submit) strictly require an interactive token.
    const requiresToken = Boolean(solveReq.sitekey && solveReq.sitekey !== '0x4AAAAAAADnPIDROrmt1Wwj');

    const isSuccess = result.ok && (
      requiresToken
        ? hasToken
        : (hasToken || hasClearance || hasCookies)
    );

    if (isSuccess) {
      res.status(200).json({
        ok: true,
        token: result.token,
        cookies: result.cookies,
        cfClearance: result.cfClearance,
        durationMs: result.durationMs,
        modeUsed: result.modeUsed,
        proxyUsed: result.proxyUsed,
      });
      return;
    }

    const statusCode = result.error?.includes('timed out') ? 408 : 422;
    res.status(statusCode).json({
      ok: false,
      error: result.error || (sitekey ? 'No Turnstile token issued for sitekey' : 'Failed to solve challenge'),
      durationMs: result.durationMs,
      modeUsed: result.modeUsed,
      proxyUsed: result.proxyUsed,
    });
  } catch (err) {
    if (err instanceof QueueFullError) {
      res.status(429).json({
        ok: false,
        error: err.message,
      });
      return;
    }

    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      ok: false,
      error: message,
    });
  }
});

// Start listening if executed directly
if (require.main === module) {
  // Pre-warm Chromium on startup so the first request does not suffer cold start latency
  BrowserManager.getInstance().ensureBrowser().catch((err) => {
    logWarn('Initial browser warm-up notice', { error: String(err) });
  });

  const portsToListen = new Set<number>([config.port, 10000, 3000]);
  const servers: import('http').Server[] = [];

  for (const p of portsToListen) {
    try {
      const s = app.listen(p, config.host, () => {
        logInfo(`CPSolver microservice listening on http://${config.host}:${p}`, {
          port: p,
          maxConcurrent: config.maxConcurrentSolves,
          maxQueue: config.maxQueueSize,
          headless: config.headless,
        });
      });
      s.on('error', (err: any) => {
        if (err.code !== 'EADDRINUSE') {
          logError(`Error on port ${p}`, { error: String(err) });
        }
      });
      servers.push(s);
    } catch {}
  }

  const shutdown = async (signal: string) => {
    logInfo(`Received ${signal}. Shutting down gracefully...`);
    for (const s of servers) {
      s.close();
    }
    try {
      await BrowserManager.getInstance().close();
      logInfo('CPSolver shutdown complete.');
      process.exit(0);
    } catch (err) {
      logError('Error closing browser on shutdown', { error: String(err) });
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
