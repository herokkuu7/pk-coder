import type { Page, BrowserContext, Frame } from 'patchright';
import { AsyncResource } from 'node:async_hooks';
import { BrowserManager } from './browser';
import { ConcurrencyQueue } from './queue';
import { config, getContainerMemory, logInfo, logWarn, parseProxy } from './config';
import { proxyPool, maskProxy } from './proxyPool';
import { validateTargetUrl } from './security';
import { openLeetCodeEgress, probeLeetCodeConnectivity } from './leetcodeEgress';
import { interactWithTurnstileCheckbox, isTurnstileCheckboxVisible } from './stealth';
import type { SolveRequest, SolveResult, SolveState, SolverStats, SolverMode, ProxyConfig } from './types';

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

export let lastDebugScreenshot: Buffer | null = null;

const PROXY_OR_TUNNEL_ERROR_RE =
  /ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_FAILED|Challenge iframe network failure|Proxy authentication required \(HTTP 407\)/i;
const LEETCODE_LOGIN_URL = 'https://leetcode.com/accounts/login/';

function isLeetCodeLoginUrl(siteurl: string): boolean {
  try {
    const url = new URL(siteurl);
    return url.hostname === 'leetcode.com' && /^\/accounts\/login\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function requiresTurnstileToken(req: Pick<SolveRequest, 'siteurl' | 'sitekey'>): boolean {
  return isLeetCodeLoginUrl(req.siteurl) || Boolean(req.sitekey && req.sitekey !== '0x4AAAAAAADnPIDROrmt1Wwj');
}

/**
 * Strips single-use Cloudflare challenge token query params (`__cf_chl_*`) and
 * URL fragments so a fresh browser context never replays a stale token.
 */
export function sanitizeTargetSiteUrl(rawUrl: string): string {
  if (typeof rawUrl !== 'string') return '';
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (key.toLowerCase().startsWith('__cf_chl_')) {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return trimmed.split('#')[0] ?? trimmed;
  }
}

/**
 * Identifies proxy or CONNECT tunnel failures where direct fallback can recover.
 */
export function isProxyOrTunnelError(errMsg?: string): boolean {
  return typeof errMsg === 'string' && PROXY_OR_TUNNEL_ERROR_RE.test(errMsg);
}

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
  <style>
    body {
      margin: 20px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #ffffff;
    }
    .cf-turnstile {
      display: inline-block;
      min-height: 65px;
      margin: 10px 0;
    }
  </style>
  <script>
    window.__turnstileToken = null;
    window.__turnstileError = null;
    window.onTurnstileSuccess = function(token) {
      window.__turnstileToken = token;
      try { document.title = 'TURNSTILE_TOKEN:' + token; } catch(e) {}
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
      try { document.title = 'Verification'; } catch(e) {}
      var el1 = document.getElementById('cf-turnstile-response');
      if (el1) el1.value = '';
      var el2 = document.getElementById('turnstileToken');
      if (el2) el2.value = '';
    };
  </script>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
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
</body>
</html>`;
}

/**
 * Evaluates the page and all known inputs/frames to retrieve any populated Turnstile token.
 */
async function extractTokenFromPage(page: Page): Promise<string | null> {
  const title = await page.title().catch(() => '');
  if (typeof title === 'string' && title.startsWith('TURNSTILE_TOKEN:')) {
    const tok = title.slice('TURNSTILE_TOKEN:'.length);
    if (tok.length > 5) return tok;
  }
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

  // Search non-Cloudflare child frames for token (do not inject scripts into Cloudflare's security frame)
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    const frameUrl = f.url().toLowerCase();
    if (frameUrl.includes('challenges.cloudflare.com') || frameUrl.includes('challenge-platform')) continue;
    try {
      const frameVal = await f.evaluate(() => {
        const win = window as any;
        if (typeof win.__turnstileToken === 'string' && win.__turnstileToken.length > 5) {
          return win.__turnstileToken;
        }
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
      if (frameVal) return frameVal;
    } catch {}
  }

  try {
    const val = await page.locator('input[name="cf-turnstile-response"]').inputValue({ timeout: 150 });
    if (val && val.length > 5) return val;
  } catch {}

  try {
    const val2 = await page.locator('input[name="turnstileToken"]').inputValue({ timeout: 150 });
    if (val2 && val2.length > 5) return val2;
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
/**
 * Executes a single Turnstile solve attempt under a specific browser context and proxy configuration.
 */
async function executeSingleSolveAttempt(
  rawReq: SolveRequest,
  proxyConfigInput: ProxyConfig | undefined,
  timeoutMs: number,
  mode: SolverMode,
  attemptStartTime: number,
  signal: AbortSignal,
): Promise<SolveResult> {
  const browserManager = BrowserManager.getInstance();
  const req: SolveRequest = {
    ...rawReq,
    siteurl: sanitizeTargetSiteUrl(rawReq.siteurl),
  };
  const isExplicitDirect =
    typeof req.proxy === 'string' &&
    ['direct', 'none', 'off'].includes(req.proxy.trim().toLowerCase());
  const proxyConfig = isExplicitDirect ? undefined : proxyConfigInput;
  const effectiveProxyLabel = proxyConfig?.server ? maskProxy(proxyConfig.server) : 'direct';

  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let egress: Awaited<ReturnType<typeof openLeetCodeEgress>> | undefined;
  const leetCodeLogin = isLeetCodeLoginUrl(req.siteurl);
  let stage = 'create_context';
  const onAbort = () => { void context?.close().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    signal.throwIfAborted();
    logInfo('Starting Turnstile solve attempt', {
      siteurl: req.siteurl,
      sitekey: req.sitekey,
      mode,
      hasProxy: !!proxyConfig?.server,
      proxyServer: proxyConfig?.server ? maskProxy(proxyConfig.server) : 'direct',
    });

    if (req.siteurl === LEETCODE_LOGIN_URL && !proxyConfig && !req.cookies) {
      egress = await openLeetCodeEgress();
    }
    context = await browserManager.createContext(egress ?? proxyConfig, req.userAgent, Boolean(egress));
    signal.throwIfAborted();

    if (req.cookies) {
      try {
        let fallbackDomain: string | undefined;
        try {
          const host = new URL(req.siteurl).hostname.replace(/^\.+/, '');
          if (host) fallbackDomain = `.${host}`;
        } catch {}

        if (Array.isArray(req.cookies)) {
          const safeCookies = req.cookies
            .filter(
              (c) =>
                c &&
                typeof c.name === 'string' &&
                c.name.length > 0 &&
                !c.name.toLowerCase().startsWith('cf_') &&
                !c.name.toLowerCase().startsWith('__cf')
            )
            .map((c) => {
              const cookieObj = c as {
                name: string;
                value: string;
                url?: string;
                domain?: string;
                path?: string;
                expires?: number;
                httpOnly?: boolean;
                secure?: boolean;
                sameSite?: 'Strict' | 'Lax' | 'None';
              };
              if (!cookieObj.url && !cookieObj.domain && fallbackDomain) {
                return { ...cookieObj, domain: fallbackDomain, path: cookieObj.path || '/' };
              }
              if (cookieObj.domain && !cookieObj.path) {
                return { ...cookieObj, path: '/' };
              }
              return cookieObj;
            });
          if (safeCookies.length > 0) {
            await context.addCookies(safeCookies);
          }
        } else if (typeof req.cookies === 'object') {
          const domain = fallbackDomain || `.${new URL(req.siteurl).hostname}`;
          const formatted = Object.entries(req.cookies)
            .filter(([name]) => !name.toLowerCase().startsWith('cf_') && !name.toLowerCase().startsWith('__cf'))
            .map(([name, value]) => ({
              name,
              value: String(value),
              domain,
              path: '/',
            }));
          if (formatted.length > 0) {
            await context.addCookies(formatted);
          }
        }
      } catch (cookieErr) {
        logWarn('Failed to add client cookies to context', { err: String(cookieErr) });
      }
    }

    stage = 'create_page';
    page = await context.newPage();
    stage = 'solve';
    if (leetCodeLogin) {
      logInfo('LeetCode browser page ready', { elapsedMs: Date.now() - attemptStartTime, containerMemory: getContainerMemory() });
    }

    page.setDefaultTimeout(timeoutMs);

    let stepResult: StepSolveResult;
    let activeMode: SolverMode = mode;

    if (mode === 'harness' && req.sitekey) {
      stepResult = await solveWithHarness(page, req, timeoutMs, attemptStartTime, signal);
      if (stepResult.error?.includes('600010')) {
        logInfo('Harness mode encountered 600010 (interstitial key), falling back to navigation mode', { siteurl: req.siteurl });
        await page.unroute('**/*').catch(() => {});
        activeMode = 'navigate';
        stepResult = await solveWithNavigation(page, req, timeoutMs, attemptStartTime, signal);
      }
    } else {
      stepResult = await solveWithNavigation(page, req, timeoutMs, attemptStartTime, signal, Boolean(egress));
    }
    signal.throwIfAborted();

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

    const durationMs = Date.now() - attemptStartTime;

    const resolvedClearance =
      stepResult.cfClearance && stepResult.cfClearance !== 'cleared'
        ? stepResult.cfClearance
        : cfClearance;
    const hasValidToken = typeof stepResult.token === 'string' && stepResult.token.trim().length > 10;
    const hasClearance = Boolean(resolvedClearance && resolvedClearance.trim().length > 5);
    const hasCookies = !!(cookiesRecord && Object.keys(cookiesRecord).some((k) => k.toLowerCase().startsWith('cf_')));

    // Interstitial challenge key (0x4AAAAAAADnPIDROrmt1Wwj) only needs clearance cookies.
    // Interactive form widget keys (e.g. 0x4AAAAAACDz1ltMYNJCAQZS) strictly require a token.
    const isSuccessful = requiresTurnstileToken(req)
      ? hasValidToken
      : (hasValidToken || hasClearance || hasCookies);

    if (isSuccessful) {
      logInfo('Turnstile / Cloudflare solved successfully', {
        siteurl: req.siteurl,
        durationMs,
        tokenLength: stepResult.token?.length ?? 0,
        hasClearance: hasClearance,
      });

      return {
        ok: true,
        state: 'VERIFICATION_COMPLETED',
        token: stepResult.token,
        cookies: cookiesRecord,
        cfClearance: resolvedClearance,
        durationMs,
        modeUsed: activeMode,
        proxyUsed: effectiveProxyLabel,
      };
    }

    const failError = stepResult.error || (req.sitekey ? 'Turnstile widget did not issue a token before timeout' : `Challenge timed out after ${timeoutMs}ms without clearance`);
    const failState: SolveState = /timed out/i.test(failError) ? 'TIMED_OUT' : 'VERIFICATION_FAILED';
    return {
      ok: false,
      state: failState,
      durationMs,
      error: failError,
      modeUsed: activeMode,
      proxyUsed: effectiveProxyLabel,
    };
  } catch (err) {
    const durationMs = Date.now() - attemptStartTime;
    const message = err instanceof Error ? err.message : String(err);
    const errState: SolveState = signal.aborted
      ? 'CANCELLED'
      : (/timed out/i.test(message) ? 'TIMED_OUT' : 'VERIFICATION_FAILED');

    logWarn('Turnstile solve attempt failed with error', {
      siteurl: req.siteurl,
      durationMs,
      state: errState,
      error: message,
      stage,
      ...(leetCodeLogin ? { containerMemory: getContainerMemory() } : {}),
    });

    return {
      ok: false,
      state: errState,
      durationMs,
      error: message,
      modeUsed: mode,
      proxyUsed: effectiveProxyLabel,
    };
  } finally {
    if (page) {
      try {
        if (!signal.aborted) lastDebugScreenshot = await page.screenshot({ timeout: 2000 }).catch(() => null);
      } catch {}
      await Promise.race([page.close(), new Promise((r) => setTimeout(r, 2000))]).catch(() => {});
    }
    if (context) {
      await Promise.race([context.close(), new Promise((r) => setTimeout(r, 2000))]).catch(() => {});
    }
    egress?.close();
    try {
      if (context) await browserManager.notifySolveCompleted(solverQueue.active);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    signal.throwIfAborted();
  }
}

/**
 * Solves Cloudflare Turnstile for a given target siteurl and sitekey.
 * Runs inside ConcurrencyQueue and performs sequential proxy failover across the pool
 * (from the first working IP till the end) if multiple proxies are configured.
 */
export async function solveTurnstile(rawReq: SolveRequest, signal?: AbortSignal): Promise<SolveResult> {
  const overallStartTime = Date.now();
  const req: SolveRequest = {
    ...rawReq,
    siteurl: sanitizeTargetSiteUrl(rawReq.siteurl),
  };
  const totalTimeoutMs = req.timeout ?? config.defaultTimeoutMs;
  const mode: SolverMode = isLeetCodeLoginUrl(req.siteurl) ? 'navigate' : (req.mode ?? 'harness');
  const directFallbackEnabled = process.env.CPSOLVER_DISABLE_DIRECT_FALLBACK !== 'true';

  const runDirectFallbackIfEligible = async (
    reason: string,
    failedResult: SolveResult,
    workSignal: AbortSignal,
  ): Promise<SolveResult> => {
    if (!directFallbackEnabled || workSignal.aborted) {
      return failedResult;
    }
    const remainingForDirect = totalTimeoutMs - (Date.now() - overallStartTime);
    if (remainingForDirect < 12000) {
      return failedResult;
    }
    logWarn(reason, {
      remainingTimeMs: remainingForDirect,
      priorError: failedResult.error,
    });
    const directRes = await executeSingleSolveAttempt(
      { ...req, proxy: 'direct' },
      undefined,
      remainingForDirect,
      mode,
      Date.now(),
      workSignal,
    );
    directRes.proxyUsed = 'direct';
    directRes.durationMs = Date.now() - overallStartTime;
    return directRes.ok ? directRes : failedResult;
  };

  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason);
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(), totalTimeoutMs);

  return solverQueue.run(async (workSignal) => {
    workSignal.throwIfAborted();
    // 1. Explicit per-request proxy override (or explicit 'direct')
    if (req.proxy && typeof req.proxy === 'string' && req.proxy.trim().toLowerCase() !== 'auto') {
      const explicitDirect = ['direct', 'none', 'off'].includes(req.proxy.trim().toLowerCase());
      const explicitProxy = explicitDirect ? undefined : parseProxy(req.proxy);
      const firstBudget =
        explicitProxy && directFallbackEnabled && totalTimeoutMs >= 45000
          ? totalTimeoutMs - 15000
          : totalTimeoutMs;
      let res = await executeSingleSolveAttempt(req, explicitProxy, firstBudget, mode, overallStartTime, workSignal);
      res.proxyUsed = explicitProxy ? maskProxy(req.proxy) : 'direct';
      if (!res.ok && explicitProxy && isProxyOrTunnelError(res.error)) {
        res = await runDirectFallbackIfEligible(
          'Explicit proxy failed with proxy/tunnel error; falling back to direct egress',
          res,
          workSignal,
        );
      }
      res.durationMs = Date.now() - overallStartTime;
      if (res.ok) {
        solverStats.recordSuccess(res.durationMs);
      } else {
        solverStats.recordFailure();
      }
      return res;
    }

    if (req.proxy && typeof req.proxy === 'object') {
      const explicitProxy = parseProxy(req.proxy);
      const firstBudget =
        explicitProxy && directFallbackEnabled && totalTimeoutMs >= 45000
          ? totalTimeoutMs - 15000
          : totalTimeoutMs;
      let res = await executeSingleSolveAttempt(req, explicitProxy, firstBudget, mode, overallStartTime, workSignal);
      res.proxyUsed = explicitProxy ? maskProxy(req.proxy.server) : 'direct';
      if (!res.ok && explicitProxy && isProxyOrTunnelError(res.error)) {
        res = await runDirectFallbackIfEligible(
          'Explicit object proxy failed with proxy/tunnel error; falling back to direct egress',
          res,
          workSignal,
        );
      }
      res.durationMs = Date.now() - overallStartTime;
      if (res.ok) {
        solverStats.recordSuccess(res.durationMs);
      } else {
        solverStats.recordFailure();
      }
      return res;
    }

    // 2. If no proxies in pool, run with default proxy config or direct
    if (proxyPool.size === 0) {
      const defaultProxy = parseProxy();
      const firstBudget =
        defaultProxy && directFallbackEnabled && totalTimeoutMs >= 45000
          ? totalTimeoutMs - 15000
          : totalTimeoutMs;
      let res = await executeSingleSolveAttempt(req, defaultProxy, firstBudget, mode, overallStartTime, workSignal);
      if (!res.ok && defaultProxy && isProxyOrTunnelError(res.error)) {
        res = await runDirectFallbackIfEligible(
          'Default proxy failed with proxy/tunnel error; falling back to direct egress',
          res,
          workSignal,
        );
      }
      res.durationMs = Date.now() - overallStartTime;
      if (res.ok) {
        solverStats.recordSuccess(res.durationMs);
      } else {
        solverStats.recordFailure();
      }
      return res;
    }

    // 3. Sequential rotation across proxy pool (starts at current working proxy and fails over till end)
    const startIndex = proxyPool.currentIndex;
    let lastResult: SolveResult | null = null;

    for (let attempt = 0; attempt < proxyPool.size; attempt++) {
      workSignal.throwIfAborted();
      const candidateIndex = (startIndex + attempt) % proxyPool.size;
      const candidateConfig = proxyPool.getProxyAt(candidateIndex);
      const candidateRaw = proxyPool.getRawAt(candidateIndex) || '';
      const masked = maskProxy(candidateRaw);

      const elapsed = Date.now() - overallStartTime;
      const remainingTime = totalTimeoutMs - elapsed;

      // Abort failover if insufficient time left for a browser solve
      if (remainingTime < 15000 && attempt > 0) {
        logWarn('Insufficient time remaining for next proxy in pool, aborting failover', {
          remainingTime,
          attempt,
          totalInPool: proxyPool.size,
        });
        break;
      }

      // Split remaining budget across remaining pool proxies (and optional direct fallback)
      // so candidate #0 cannot starve subsequent candidates or direct egress.
      const slotsRemaining = (proxyPool.size - attempt) + (directFallbackEnabled ? 1 : 0);
      const candidateBudget = Math.min(
        remainingTime,
        slotsRemaining > 1
          ? Math.max(15000, Math.floor(remainingTime / slotsRemaining))
          : remainingTime,
      );

      logInfo('Attempting Turnstile solve with pool proxy', {
        proxyIndex: candidateIndex,
        proxy: masked,
        attempt: attempt + 1,
        totalInPool: proxyPool.size,
        timeoutMs: candidateBudget,
      });

      const attemptStartTime = Date.now();
      const result = await executeSingleSolveAttempt(
        req,
        candidateConfig,
        candidateBudget,
        mode,
        attemptStartTime,
        workSignal,
      );

      result.proxyUsed = masked;

      if (result.ok) {
        proxyPool.markSuccess(candidateIndex);
        const totalDuration = Date.now() - overallStartTime;
        result.durationMs = totalDuration;
        solverStats.recordSuccess(totalDuration);
        return result;
      }

      // Record failure and rotate pointer to next proxy
      proxyPool.markFailure(candidateIndex, result.error);
      lastResult = result;

      logWarn(`Proxy candidate #${candidateIndex} (${masked}) failed. Rotating to next candidate in pool...`, {
        error: result.error,
        nextCandidate: (candidateIndex + 1) % proxyPool.size,
      });
    }

    // All pool proxies failed — attempt direct egress fallback when sufficient budget remains
    const poolFailure: SolveResult = lastResult || {
      ok: false,
      durationMs: Date.now() - overallStartTime,
      error: `All ${proxyPool.size} proxies in pool failed to solve challenge`,
      modeUsed: mode,
    };
    const finalResult = await runDirectFallbackIfEligible(
      'All proxy pool candidates failed; attempting direct egress fallback',
      poolFailure,
      workSignal,
    );
    finalResult.durationMs = Date.now() - overallStartTime;
    if (finalResult.ok) {
      solverStats.recordSuccess(finalResult.durationMs);
      return finalResult;
    }

    solverStats.recordFailure();
    return finalResult;
  }, controller.signal, totalTimeoutMs).catch((error) => {
    if (!controller.signal.aborted || signal?.aborted) throw error;
    solverStats.recordFailure();
    return {
      ok: false,
      state: 'TIMED_OUT' as const,
      error: `Solve timed out after ${totalTimeoutMs}ms`,
      durationMs: Date.now() - overallStartTime,
      modeUsed: mode,
    };
  }).finally(() => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
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
  signal: AbortSignal,
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
    const url = r.url();

    const isMainDoc = r.resourceType() === 'document' && r.frame() === page.mainFrame();
    const isCfPlatform = url.includes('challenge-platform') || url.includes('/cdn-cgi/');

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

  let fatalProxyError: string | null = null;
  page.on('requestfailed', (r) => {
    const err = r.failure()?.errorText || '';
    const url = r.url();
    if (url.includes('brunhild.challenges.cloudflare.com')) return;
    logWarn('Harness resource load failed', { url: url.slice(0, 120), error: err });
    if (url.includes('/turnstile/f/av0/rch/') && (err.includes('TIMED_OUT') || err.includes('TUNNEL'))) {
      fatalProxyError = `Challenge iframe network failure (${err})`;
    }
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.type() === 'warning') {
      logWarn('Harness page console', { type: msg.type(), text: msg.text().slice(0, 200) });
    }
  });

  await page.goto(targetUrl, {
    waitUntil: 'commit',
    timeout: Math.min(timeoutMs, 25000),
  });

  const deadline = startTime + timeoutMs;
  let clickCount = 0;
  let lastClickTime = 0;

  // Allow Turnstile API script and container iframe to mount and stabilize
  await page.waitForTimeout(2500).catch(() => {});

  while (Date.now() < deadline) {
    signal.throwIfAborted();

    // 1. Check for resolved token on page
    const token = await extractTokenFromPage(page);
    if (token) return { token };

    // 2. Check for explicit Cloudflare widget errors (fast-fail)
    const errorMsg = await page.evaluate(
      () => (window as unknown as { __turnstileError?: string | null }).__turnstileError
    ).catch(() => null);

    if (fatalProxyError && Date.now() - startTime >= 15000) {
      logWarn('Aborting attempt early due to proxy network failure', { fatalProxyError });
      return { error: fatalProxyError };
    }

    if (errorMsg || (req.sitekey.startsWith('2x') && Date.now() - startTime >= 1500)) {
      const code = errorMsg || '300030 (always-fail test key)';
      logWarn('Turnstile client error reported by Cloudflare', { siteurl: req.siteurl, errorMsg: code });
      return { error: `Cloudflare Turnstile error code: ${code}` };
    }

    // 3. Check if challenge frame has presented the interactive checkbox
    const isInteractiveReady = await isTurnstileCheckboxVisible(page);
    const elapsed = Date.now() - startTime;

    // Click as soon as the checkbox is visible, or after 35s as an edge-case fallback
    const shouldClick =
      (clickCount === 0 && (isInteractiveReady || elapsed >= 35000)) ||
      (clickCount === 1 && Date.now() - lastClickTime >= 15000 && isInteractiveReady);

    if (shouldClick) {
      const clicked = await interactWithTurnstileCheckbox(page);
      if (clicked) {
        clickCount += 1;
        lastClickTime = Date.now();
      }
    }

    await new Promise((r) => setTimeout(r, 400));
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
  signal: AbortSignal,
  egressFiltersRequests = false,
): Promise<StepSolveResult> {
  const leetCodeLogin = isLeetCodeLoginUrl(req.siteurl);
  if (leetCodeLogin) {
    page.on('request', AsyncResource.bind(request => {
      if (request.resourceType() === 'document' && isLeetCodeLoginUrl(request.url())) {
        logInfo('Requesting live LeetCode login document');
      }
    }));
    page.on('response', AsyncResource.bind(response => {
      if (response.request().resourceType() === 'document' && isLeetCodeLoginUrl(response.url())) {
        logInfo('LeetCode login document received', {
          status: response.status(),
          cloudflareChallenge: response.headers()['cf-mitigated'] === 'challenge',
        });
      }
    }));
    page.on('requestfailed', AsyncResource.bind(request => {
      if (request.resourceType() === 'document' && isLeetCodeLoginUrl(request.url())) {
        logWarn('LeetCode login document request failed', { error: request.failure()?.errorText });
      }
    }));
    page.on('console', AsyncResource.bind(message => {
      const code = /\[Cloudflare Turnstile\]\s*(?:Error:\s*)?(\d{6})/i.exec(message.text())?.[1];
      if (code) logWarn('LeetCode Turnstile widget reported an error', { code });
    }));
  }
  // Abort non-essential media assets and validate any top-level navigation redirects against SSRF rules
  if (!egressFiltersRequests) await page.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      const destCheck = await validateTargetUrl(url);
      if (!destCheck.ok) {
        logWarn('Blocked unsafe navigation redirect destination', { url: url.slice(0, 120), reason: destCheck.error });
        await route.abort('blockedbyclient').catch(() => {});
        return;
      }
    }
    if (/\.(png|jpg|jpeg|gif|webp|ico|svg|woff|woff2|ttf|mp4|webm|avi|mp3)(\?.*)?$/i.test(url)) {
      return route.abort();
    }
    if (leetCodeLogin) {
      if (['image', 'font', 'media'].includes(request.resourceType())) return route.abort();
      const { protocol, hostname } = new URL(url);
      if ((protocol === 'https:' || protocol === 'http:') &&
          hostname !== 'leetcode.com' && !hostname.endsWith('.leetcode.com') &&
          hostname !== 'challenges.cloudflare.com') {
        return route.abort();
      }
    }
    return route.fallback();
  }).catch(() => {});

  if (egressFiltersRequests) {
    probeLeetCodeConnectivity();
    const session = await page.context().newCDPSession(page);
    logInfo('Starting Chromium navigation for live LeetCode login');
    const navigation = await session.send('Page.navigate', { url: req.siteurl });
    if (navigation.errorText) return { error: navigation.errorText };
    logInfo('Chromium navigation committed for live LeetCode login');
  } else {
    const response = await page.goto(req.siteurl, {
      waitUntil: leetCodeLogin ? 'commit' : 'domcontentloaded',
      timeout: Math.min(timeoutMs, 25000),
    });
    if (response?.status() === 407) return { error: 'Proxy authentication required (HTTP 407)' };
  }

  const deadline = startTime + timeoutMs;
  const clickedFrames = new WeakMap<Frame, string>();
  const requiresToken = requiresTurnstileToken(req);
  const readToken = async (): Promise<string | null> => {
    if (!leetCodeLogin) return extractTokenFromPage(page);
    // The interstitial and the rendered LeetCode sign-in form have separate
    // verification steps. Only read the response field on the real form.
    return page.evaluate(() => {
      if (location.hostname !== 'leetcode.com' || !/^\/accounts\/login\/?$/.test(location.pathname)) return null;
      if (!document.querySelector('input[type="password"]')) return null;
      const inputs = document.querySelectorAll<HTMLInputElement>('input[name="cf-turnstile-response"]');
      return Array.from(inputs, input => input.value.trim()).find(value => value.length > 10) ?? null;
    }).catch(() => null);
  };

  while (Date.now() < deadline) {
    signal.throwIfAborted();
    // 1. Check for a real Turnstile token on the page
    const token = await readToken();
    if (token) return { token };

    if (!requiresToken) {
      const cookies = await page.context().cookies().catch(() => []);
      const cfCookie = cookies.find((c) => c.name === 'cf_clearance' && c.value.length > 5);
      if (cfCookie) return { cfClearance: cfCookie.value };
    }

    await interactWithTurnstileCheckbox(page, clickedFrames);

    await new Promise((r) => setTimeout(r, 400));
  }

  // Final check before timeout
  const finalToken = await readToken();
  if (finalToken) return { token: finalToken };

  if (!requiresToken) {
    const finalCookies = await page.context().cookies().catch(() => []);
    const finalCf = finalCookies.find((c) => c.name === 'cf_clearance' && c.value.length > 5);
    if (finalCf) {
      return { cfClearance: finalCf.value };
    }
  }

  return { error: `Turnstile challenge timed out after ${timeoutMs}ms without token or clearance` };
}
