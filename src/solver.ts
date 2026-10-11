import type { Page, BrowserContext } from 'patchright';
import { BrowserManager } from './browser';
import { ConcurrencyQueue } from './queue';
import { config, logInfo, logWarn, parseProxy } from './config';
import { interactWithTurnstileCheckbox } from './stealth';
import type { SolveRequest, SolveResult, SolverStats, SolverMode } from './types';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

class SolverStatsManager {
  private total = 0;
  private successful = 0;
  private failed = 0;
  private durations: number[] = [];
  private lastSolved?: string;

  public recordSuccess(durationMs: number): void {
    this.total++;
    this.successful++;
    this.lastSolved = new Date().toISOString();
    this.durations.push(durationMs);
    if (this.durations.length > 50) this.durations.shift();
  }

  public recordFailure(): void {
    this.total++;
    this.failed++;
  }

  public getStats(active: number, waiting: number, restarts: number): SolverStats {
    const avg =
      this.durations.length > 0
        ? Math.round(this.durations.reduce((a, b) => a + b, 0) / this.durations.length)
        : 0;

    return {
      totalSolves: this.total,
      successfulSolves: this.successful,
      failedSolves: this.failed,
      activeSolves: active,
      queueLength: waiting,
      avgDurationMs: avg,
      browserRestarts: restarts,
      lastSolvedAt: this.lastSolved,
    };
  }
}

export const solverQueue = new ConcurrencyQueue(
  config.maxConcurrentSolves,
  config.maxQueueSize,
);

export const solverStats = new SolverStatsManager();

/**
 * Generates synthetic HTML host page with Turnstile container, callback hooks,
 * and explicit fallback render check.
 */
function buildHostHtml(sitekey: string, action?: string, cdata?: string): string {
  const actionAttr = action ? ` data-action="${escapeHtml(action)}"` : '';
  const cdataAttr = cdata ? ` data-cdata="${escapeHtml(cdata)}"` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Verification</title>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback" async defer></script>
  <style>
    body {
      margin: 0;
      padding: 30px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #ffffff;
    }
    .cf-turnstile {
      display: inline-block;
      min-height: 65px;
      margin: 10px 0;
    }
  </style>
</head>
<body>
  <div id="cf-turnstile-wrapper"
       class="cf-turnstile"
       data-sitekey="${escapeHtml(sitekey)}"${actionAttr}${cdataAttr}
       data-callback="onTurnstileSuccess"
       data-error-callback="onTurnstileError"
       data-expired-callback="onTurnstileExpired">
  </div>
  <input type="hidden" name="cf-turnstile-response" id="cf-turnstile-response" value="" />
  <input type="hidden" name="turnstileToken" id="turnstileToken" value="" />
  <script>
    window.__turnstileToken = null;
    window.__turnstileError = null;
    window.onTurnstileSuccess = function(token) {
      window.__turnstileToken = token;
      var el1 = document.getElementById('cf-turnstile-response');
      if (el1) el1.value = token;
      var el2 = document.getElementById('turnstileToken');
      if (el2) el2.value = token;
    };
    window.onTurnstileError = function(err) {
      window.__turnstileError = String(err || 'error');
    };
    window.onTurnstileExpired = function() {
      window.__turnstileToken = null;
    };
    window.onloadTurnstileCallback = function() {
      // Fallback explicit render if DOM scanning did not populate the wrapper
      setTimeout(function() {
        var wrapper = document.getElementById('cf-turnstile-wrapper');
        if (window.turnstile && wrapper && wrapper.children.length === 0 && !window.__turnstileToken) {
          try {
            window.turnstile.render(wrapper, {
              sitekey: ${JSON.stringify(sitekey)},
              callback: window.onTurnstileSuccess,
              'error-callback': window.onTurnstileError,
              'expired-callback': window.onTurnstileExpired,
              action: ${JSON.stringify(action || undefined)},
              cdata: ${JSON.stringify(cdata || undefined)},
            });
          } catch (e) {}
        }
      }, 500);
    };
  </script>
</body>
</html>`;
}

/**
 * Evaluates the page and all known inputs/frames to retrieve any populated Turnstile token.
 */
async function extractTokenFromPage(page: Page): Promise<string | null> {
  const fromEval = await page.evaluate(() => {
    const win = window as unknown as {
      __turnstileToken?: string | null;
      turnstile?: { getResponse?: (id?: string) => string };
    };

    if (typeof win.__turnstileToken === 'string' && win.__turnstileToken.length > 5) {
      return win.__turnstileToken;
    }

    if (typeof win.turnstile?.getResponse === 'function') {
      try {
        const resp = win.turnstile.getResponse();
        if (resp && resp.length > 5) return resp;
      } catch {}
    }

    // Check all inputs that match turnstile or challenge token naming
    const inputs = document.querySelectorAll(
      'input[name*="turnstile"], input[id*="turnstile"], input[id*="cf-chl-widget"], input[name="cf-turnstile-response"]'
    );
    for (const inp of Array.from(inputs)) {
      const val = (inp as HTMLInputElement).value;
      if (typeof val === 'string' && val.length > 5) {
        return val;
      }
    }

    return null;
  }).catch(() => null);

  if (fromEval) return fromEval;

  try {
    const val = await page.locator('input[name="cf-turnstile-response"]').inputValue({ timeout: 150 });
    if (val && val.length > 5) return val;
  } catch {}

  return null;
}

interface StepSolveResult {
  token?: string;
  cfClearance?: string;
  error?: string;
}

/**
 * Solves Cloudflare Turnstile for a given target siteurl and sitekey.
 * Runs inside the ConcurrencyQueue to protect the 512MB RAM ceiling on Render.
 */
export async function solveTurnstile(req: SolveRequest): Promise<SolveResult> {
  const startTime = Date.now();
  const timeoutMs = req.timeout ?? config.defaultTimeoutMs;
  const proxyConfig = parseProxy(req.proxy);
  const mode: SolverMode = req.mode ?? 'harness';

  return solverQueue.run(async () => {
    const browserManager = BrowserManager.getInstance();
    let context: BrowserContext | null = null;
    let page: Page | null = null;

    try {
      logInfo('Starting Turnstile solve', {
        siteurl: req.siteurl,
        sitekey: req.sitekey,
        mode,
        hasProxy: !!proxyConfig?.server,
      });

      context = await browserManager.createContext(proxyConfig);
      page = await context.newPage();

      // Configure navigation timeout
      page.setDefaultTimeout(timeoutMs);

      let stepResult: StepSolveResult;

      if (mode === 'harness' && req.sitekey) {
        stepResult = await solveWithHarness(page, req, timeoutMs, startTime);
        if (stepResult.error?.includes('600010')) {
          logInfo('Harness mode encountered 600010 (interstitial key), falling back to navigation mode', { siteurl: req.siteurl });
          stepResult = await solveWithNavigation(page, req, timeoutMs, startTime);
        }
      } else {
        stepResult = await solveWithNavigation(page, req, timeoutMs, startTime);
      }

      // Extract all cookies from context
      let cookiesRecord: Record<string, string> | undefined;
      let cfClearance: string | undefined;
      try {
        const cookies = await context.cookies();
        if (cookies.length > 0) {
          cookiesRecord = {};
          for (const c of cookies) {
            cookiesRecord[c.name] = c.value;
            if (c.name === 'cf_clearance' && c.value.length > 5) {
              cfClearance = c.value;
            }
          }
        }
      } catch {}

      const durationMs = Date.now() - startTime;

      if (stepResult.token || stepResult.cfClearance || cfClearance) {
        logInfo('Turnstile solved successfully', {
          siteurl: req.siteurl,
          durationMs,
          tokenLength: stepResult.token?.length,
          hasClearance: !!(stepResult.cfClearance || cfClearance),
        });

        solverStats.recordSuccess(durationMs);
        return {
          ok: true,
          token: stepResult.token,
          cookies: cookiesRecord,
          cfClearance: stepResult.cfClearance || cfClearance,
          durationMs,
          modeUsed: mode,
        };
      }

      solverStats.recordFailure();
      return {
        ok: false,
        durationMs,
        error: stepResult.error || `Turnstile error: challenge timed out after ${timeoutMs}ms without token`,
        modeUsed: mode,
      };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      solverStats.recordFailure();
      const message = err instanceof Error ? err.message : String(err);

      logWarn('Turnstile solve failed with error', {
        siteurl: req.siteurl,
        durationMs,
        error: message,
      });

      return {
        ok: false,
        durationMs,
        error: message,
        modeUsed: mode,
      };
    } finally {
      if (page) {
        await page.close().catch(() => {});
      }
      if (context) {
        await context.close().catch(() => {});
      }
      await browserManager.notifySolveCompleted(solverQueue.active);
    }
  });
}

/**
 * Harness Mode: Intercepts document request to siteurl and serves lightweight Turnstile HTML.
 * Includes instant fast-fail on Cloudflare explicit error codes (avoiding 45s stalls).
 */
async function solveWithHarness(
  page: Page,
  req: SolveRequest,
  timeoutMs: number,
  startTime: number,
): Promise<StepSolveResult> {
  if (!req.sitekey) {
    return { error: 'Sitekey is required for harness mode' };
  }

  const hostHtml = buildHostHtml(req.sitekey, req.action, req.cdata);
  const targetUrl = req.siteurl;

  // Intercept ONLY the top-level main document request under the target origin.
  // Never intercept iframe documents (Turnstile challenge widget runs inside an iframe).
  await page.route('**/*', async (route) => {
    const r = route.request();
    const isMainDoc = r.resourceType() === 'document' && r.frame() === page.mainFrame();
    const isCfPlatform = r.url().includes('challenge-platform') || r.url().includes('/cdn-cgi/');

    if (isMainDoc && !isCfPlatform) {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: hostHtml,
      });
      return;
    }

    return route.fallback();
  });

  await page.goto(targetUrl, {
    waitUntil: 'domcontentloaded',
    timeout: Math.min(timeoutMs, 25000),
  });

  const deadline = startTime + timeoutMs;
  let hasAttemptedClick = false;

  while (Date.now() < deadline) {
    // 1. Check for resolved token
    const token = await extractTokenFromPage(page);
    if (token) return { token };

    // 2. Check for explicit Cloudflare widget errors (fast-fail)
    const errorMsg = await page.evaluate(
      () => (window as unknown as { __turnstileError?: string | null }).__turnstileError
    ).catch(() => null);

    if (errorMsg || (req.sitekey.startsWith('2x') && Date.now() - startTime >= 1500)) {
      const code = errorMsg || '300030 (always-fail test key)';
      logWarn('Turnstile client error reported by Cloudflare', { siteurl: req.siteurl, errorMsg: code });
      return { error: `Cloudflare Turnstile error code: ${code}` };
    }

    // 3. Try interactive checkbox click if present
    if (!hasAttemptedClick || Math.random() < 0.4) {
      const clicked = await interactWithTurnstileCheckbox(page);
      if (clicked) {
        hasAttemptedClick = true;
      }
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  return { error: `Turnstile challenge timed out after ${timeoutMs}ms without token` };
}

/**
 * Direct Navigation Mode: Navigates to actual siteurl and waits for Turnstile or clearance resolution.
 */
async function solveWithNavigation(
  page: Page,
  req: SolveRequest,
  timeoutMs: number,
  startTime: number,
): Promise<StepSolveResult> {
  await page.goto(req.siteurl, {
    waitUntil: 'domcontentloaded',
    timeout: Math.min(timeoutMs, 30000),
  });

  const deadline = startTime + timeoutMs;
  let hasAttemptedClick = false;

  while (Date.now() < deadline) {
    const token = await extractTokenFromPage(page);
    if (token) return { token };

    // Check if cf_clearance was issued
    const cookies = await page.context().cookies().catch(() => []);
    const cfCookie = cookies.find((c) => c.name === 'cf_clearance' && c.value.length > 5);
    if (!req.sitekey && cfCookie) {
      return { cfClearance: cfCookie.value };
    }

    if (!hasAttemptedClick || Math.random() < 0.4) {
      const clicked = await interactWithTurnstileCheckbox(page);
      if (clicked) {
        hasAttemptedClick = true;
      }
    }

    await new Promise((r) => setTimeout(r, 400));
  }

  return { error: `Turnstile challenge timed out after ${timeoutMs}ms without token` };
}
