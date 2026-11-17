import type { BrowserContext, Page, Response } from 'patchright';
import { BrowserManager } from './browser';
import { logInfo, logWarn, parseProxy } from './config';
import { proxyPool, maskProxy } from './proxyPool';
import { solverQueue, solverStats } from './solver';
import { interactWithTurnstileCheckbox } from './stealth';
import type {
  LeetCodeLoginRequest,
  LeetCodeLoginResult,
  LeetCodeLoginStorageState,
  ProxyConfig,
} from './types';

const LEETCODE_LOGIN_URL = 'https://leetcode.com/accounts/login/';
const LEETCODE_GRAPHQL_URL = 'https://leetcode.com/graphql';
const DEFAULT_LOGIN_TIMEOUT_MS = 110_000;
const MIN_LOGIN_TIMEOUT_MS = 15_000;
const MAX_LOGIN_TIMEOUT_MS = 180_000;

const USERNAME_SELECTOR =
  'input#id_login, input[name="username"], input[name="login"], input[autocomplete="username"], input[placeholder*="Username" i], input[placeholder*="E-mail" i]';
const PASSWORD_SELECTOR =
  'input#id_password, input[name="password"], input[type="password"]';
const SUBMIT_SELECTOR =
  'button#signin_btn, button[data-cy="sign-in-btn"], form:has(input[type="password"]) button[type="submit"], button:has-text("Sign In")';
const ERROR_BANNER_SELECTOR =
  '.error-message, .errorlist, [role="alert"], p.text-red-500, div.text-red-500';

const ALLOWED_LOGIN_HOSTS = [
  'leetcode.com',
  'challenges.cloudflare.com',
  'cloudflare.com',
  'static.cloudflareinsights.com',
];

function isAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ALLOWED_LOGIN_HOSTS.some((base) => host === base || host.endsWith(`.${base}`));
}

function shouldAbortLoginRequest(url: string, resourceType: string): boolean {
  const lower = url.toLowerCase();
  if (lower.startsWith('blob:') || lower.startsWith('data:') || lower.startsWith('about:')) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (resourceType === 'media') {
    return true;
  }
  if (parsed.pathname.toLowerCase().startsWith('/cdn-cgi/')) {
    return false;
  }
  return !isAllowedHost(parsed.hostname);
}

interface LoginPageSnapshot {
  hasForm: boolean;
  isInterstitial: boolean;
  hasTurnstileWidget: boolean;
  turnstileToken: string;
  errorText: string;
  bodyTextSample: string;
}

async function inspectLoginPage(page: Page): Promise<LoginPageSnapshot> {
  try {
    return await page.evaluate(
      ({ userSel, passSel, errSel }) => {
        const isVis = (el: Element | null): boolean => {
          if (!el) return false;
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
          }
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        };

        const title = (document.title || '').toLowerCase();
        const bodyText = (document.body?.innerText || '').trim();
        const bodyLower = bodyText.toLowerCase();

        const userEl = document.querySelector(userSel);
        const passEl = document.querySelector(passSel);
        const hasForm = isVis(userEl) && isVis(passEl);

        const isInterstitial =
          !hasForm &&
          (/just a moment|attention required|cloudflare/.test(title) ||
            Boolean(document.querySelector('#challenge-running, #challenge-form, form[action*="__cf_chl_"]')) ||
            /checking your browser|verify you are human|performing security verification/.test(bodyLower));

        const hasTurnstileWidget = Boolean(
          document.querySelector(
            'iframe[src*="challenges.cloudflare.com"], iframe[src*="challenge-platform"], .cf-turnstile, #cf-turnstile, [data-sitekey]',
          ),
        );

        let turnstileToken = '';
        const tokenInput = document.querySelector(
          'input[name="cf-turnstile-response"], input[id^="cf-chl-widget-"][id$="_response"]',
        ) as HTMLInputElement | null;
        if (tokenInput?.value && tokenInput.value.trim().length > 10) {
          turnstileToken = tokenInput.value.trim();
        } else {
          const ts = (window as unknown as { turnstile?: { getResponse?: () => unknown } }).turnstile;
          if (ts && typeof ts.getResponse === 'function') {
            try {
              const resp = ts.getResponse();
              if (typeof resp === 'string' && resp.trim().length > 10) {
                turnstileToken = resp.trim();
              }
            } catch {}
          }
        }

        let errorText = '';
        for (const el of Array.from(document.querySelectorAll(errSel))) {
          if (!isVis(el)) continue;
          const txt = (el.textContent || '').trim();
          if (txt.length > 0 && txt.length < 300) {
            errorText = txt;
            break;
          }
        }

        return {
          hasForm,
          isInterstitial,
          hasTurnstileWidget,
          turnstileToken,
          errorText,
          bodyTextSample: bodyLower.slice(0, 600),
        };
      },
      { userSel: USERNAME_SELECTOR, passSel: PASSWORD_SELECTOR, errSel: ERROR_BANNER_SELECTOR },
    );
  } catch {
    return {
      hasForm: false,
      isInterstitial: false,
      hasTurnstileWidget: false,
      turnstileToken: '',
      errorText: '',
      bodyTextSample: '',
    };
  }
}

function hasChallengeFrame(page: Page): boolean {
  return page.frames().some((frame) => {
    const u = frame.url().toLowerCase();
    return u.includes('challenges.cloudflare.com') || u.includes('challenge-platform');
  });
}

async function verifySignedInUser(
  page: Page,
  context: BrowserContext,
): Promise<{ signedIn: boolean; username?: string }> {
  const cookies = await context.cookies('https://leetcode.com').catch(() => []);
  const sessionCookie = cookies.find((c) => c.name === 'LEETCODE_SESSION' && c.value.trim().length > 10);
  const csrfToken = cookies.find((c) => c.name === 'csrftoken' && c.value.trim().length > 0)?.value ?? '';
  const currentUrl = page.url();
  const leftLoginPage = Boolean(
    currentUrl &&
    currentUrl.includes('leetcode.com') &&
    !currentUrl.includes('/accounts/login'),
  );

  if (!sessionCookie && !leftLoginPage) {
    return { signedIn: false };
  }

  // First try in-page fetch so all browser headers, cookies, and TLS match identically
  try {
    const inPage = await page.evaluate(
      async ({ gqlUrl, csrf }) => {
        const res = await fetch(gqlUrl, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'content-type': 'application/json',
            ...(csrf ? { 'x-csrftoken': csrf } : {}),
          },
          body: JSON.stringify({ query: 'query { userStatus { isSignedIn username } }' }),
        });
        if (!res.ok) return null;
        return (await res.json()) as { data?: { userStatus?: { isSignedIn?: boolean; username?: string } } };
      },
      { gqlUrl: LEETCODE_GRAPHQL_URL, csrf: csrfToken },
    );
    const status = inPage?.data?.userStatus;
    if (status?.isSignedIn === true && typeof status.username === 'string' && status.username.trim()) {
      return { signedIn: true, username: status.username.trim() };
    }
  } catch {
    // Frame may be navigating; fall back to context.request
  }

  try {
    const resp = await context.request.post(LEETCODE_GRAPHQL_URL, {
      headers: {
        'content-type': 'application/json',
        origin: 'https://leetcode.com',
        referer: 'https://leetcode.com/',
        ...(csrfToken ? { 'x-csrftoken': csrfToken } : {}),
      },
      data: { query: 'query { userStatus { isSignedIn username } }' },
      timeout: 10_000,
    });
    if (resp.ok()) {
      const json = (await resp.json()) as { data?: { userStatus?: { isSignedIn?: boolean; username?: string } } };
      const status = json?.data?.userStatus;
      if (status?.isSignedIn === true && typeof status.username === 'string' && status.username.trim()) {
        return { signedIn: true, username: status.username.trim() };
      }
    }
  } catch {
    // Non-fatal while redirect is still settling
  }

  return { signedIn: false };
}

function classifyVisibleLoginError(errorText: string, bodySample: string): { code: string; message: string } | null {
  const combined = `${errorText} ${bodySample}`.toLowerCase();
  if (
    /not correct|incorrect username|incorrect password|wrong password|invalid username|credentials|does not exist|too many failed/.test(
      combined,
    )
  ) {
    return {
      code: 'LOGIN_REJECTED',
      message: errorText || 'LeetCode rejected the username or password.',
    };
  }
  if (/verification code|two-factor|2fa|authenticator|enter the code sent/.test(combined)) {
    return {
      code: 'VERIFICATION_REQUIRED',
      message: 'LeetCode requires email/2FA verification code on this login. Complete once or use /renew.',
    };
  }
  return null;
}

interface SingleAttemptOutcome {
  result: LeetCodeLoginResult;
  nonRetryable?: boolean;
}

async function runSingleLoginAttempt(params: {
  username: string;
  password: string;
  proxyConfig?: ProxyConfig;
  proxyLabel: string;
  timeoutMs: number;
}): Promise<SingleAttemptOutcome> {
  const { username, password, proxyConfig, proxyLabel, timeoutMs } = params;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const remaining = () => Math.max(0, deadline - Date.now());

  const browserManager = BrowserManager.getInstance();
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let challengeObserved = 'none';

  try {
    context = await browserManager.createContext(proxyConfig);
    page = await context.newPage();

    await page.route('**/*', (route) => {
      const req = route.request();
      if (shouldAbortLoginRequest(req.url(), req.resourceType())) {
        return route.abort().catch(() => {});
      }
      return route.continue().catch(() => {});
    });

    let loginPostStatus: number | null = null;
    const responseHandler = (response: Response) => {
      const u = response.url();
      const method = response.request().method();
      if (method === 'POST' && (u.includes('/accounts/login') || u.includes('/graphql'))) {
        const s = response.status();
        if (s >= 400) {
          loginPostStatus = s;
        }
      }
    };
    page.on('response', responseHandler);

    logInfo('Navigating to LeetCode login in remote Patchright browser', {
      proxy: proxyLabel,
      timeoutMs,
    });

    await page.goto(LEETCODE_LOGIN_URL, {
      waitUntil: 'domcontentloaded',
      timeout: Math.min(28_000, Math.max(5_000, remaining())),
    });

    // Phase 1: Wait for login form or solve Cloudflare interstitial on the SAME context & IP
    const interstitialDeadline = Math.min(deadline - 12_000, Date.now() + 40_000);
    let lastCheckboxClick = 0;
    let snapshot = await inspectLoginPage(page);

    while (!snapshot.hasForm && Date.now() < interstitialDeadline && remaining() > 8_000) {
      const alreadySignedIn = await verifySignedInUser(page, context);
      if (alreadySignedIn.signedIn && alreadySignedIn.username) {
        const rawState = (await context.storageState()) as unknown as LeetCodeLoginStorageState;
        return {
          nonRetryable: true,
          result: {
            ok: true,
            username: alreadySignedIn.username,
            storageState: rawState,
            durationMs: Date.now() - startedAt,
            proxyUsed: proxyLabel,
            challengeObserved,
          },
        };
      }

      if (snapshot.isInterstitial || hasChallengeFrame(page)) {
        challengeObserved = 'cloudflare_interstitial';
        if (Date.now() - lastCheckboxClick >= 3_500) {
          const clicked = await interactWithTurnstileCheckbox(page);
          if (clicked) {
            lastCheckboxClick = Date.now();
          }
        }
      }

      await page.waitForTimeout(550);
      snapshot = await inspectLoginPage(page);
    }

    if (!snapshot.hasForm) {
      return {
        result: {
          ok: false,
          code: 'VERIFICATION_REQUIRED',
          error:
            challengeObserved === 'cloudflare_interstitial'
              ? 'Cloudflare interstitial did not clear into the LeetCode login form within timeout.'
              : 'LeetCode login form did not render in remote browser.',
          durationMs: Date.now() - startedAt,
          proxyUsed: proxyLabel,
          challengeObserved,
        },
      };
    }

    // Phase 2: Give inline Turnstile up to 12s to auto-resolve or be clicked on the same IP
    if (snapshot.hasTurnstileWidget || hasChallengeFrame(page)) {
      if (challengeObserved === 'none') challengeObserved = 'turnstile';
      const inlineWaitUntil = Math.min(deadline - 10_000, Date.now() + 12_000);
      while (!snapshot.turnstileToken && Date.now() < inlineWaitUntil) {
        if (Date.now() - lastCheckboxClick >= 3_500) {
          const clicked = await interactWithTurnstileCheckbox(page);
          if (clicked) {
            lastCheckboxClick = Date.now();
          }
        }
        await page.waitForTimeout(450);
        snapshot = await inspectLoginPage(page);
      }
    }

    // Phase 3: Fill credentials carefully and wait for Sign In button
    const userInput = page.locator(USERNAME_SELECTOR).first();
    const passInput = page.locator(PASSWORD_SELECTOR).first();
    const submitBtn = page.locator(SUBMIT_SELECTOR).first();

    await userInput.click({ timeout: Math.min(8_000, remaining()) });
    await page.waitForTimeout(80);
    await userInput.fill(username.trim(), { timeout: Math.min(8_000, remaining()) });
    await page.waitForTimeout(100);
    await passInput.click({ timeout: Math.min(8_000, remaining()) });
    await page.waitForTimeout(80);
    await passInput.fill(password, { timeout: Math.min(8_000, remaining()) });
    await page.waitForTimeout(150);

    // Wait briefly if submit button is disabled awaiting inline Turnstile completion
    const enableWaitUntil = Math.min(deadline - 8_000, Date.now() + 10_000);
    while (!(await submitBtn.isEnabled().catch(() => false)) && Date.now() < enableWaitUntil) {
      if (hasChallengeFrame(page) && Date.now() - lastCheckboxClick >= 3_500) {
        if (challengeObserved === 'none') challengeObserved = 'turnstile';
        if (await interactWithTurnstileCheckbox(page)) {
          lastCheckboxClick = Date.now();
        }
      }
      await page.waitForTimeout(350);
    }

    if (!(await submitBtn.isEnabled().catch(() => false))) {
      return {
        result: {
          ok: false,
          code: 'VERIFICATION_REQUIRED',
          error: 'Sign-in button stayed disabled awaiting Turnstile completion.',
          durationMs: Date.now() - startedAt,
          proxyUsed: proxyLabel,
          challengeObserved,
        },
      };
    }

    loginPostStatus = null;
    await submitBtn.click({ timeout: Math.min(10_000, remaining()) });

    // Phase 4: Verify authenticated session or handle deferred Turnstile/error
    let retriedPostSubmit = false;
    while (remaining() > 0) {
      const auth = await verifySignedInUser(page, context);
      if (auth.signedIn && auth.username) {
        const rawState = (await context.storageState()) as unknown as LeetCodeLoginStorageState;
        return {
          nonRetryable: true,
          result: {
            ok: true,
            username: auth.username,
            storageState: rawState,
            durationMs: Date.now() - startedAt,
            proxyUsed: proxyLabel,
            challengeObserved,
          },
        };
      }

      const postSnap = await inspectLoginPage(page);
      const visibleErr = classifyVisibleLoginError(postSnap.errorText, postSnap.bodyTextSample);
      if (visibleErr) {
        return {
          nonRetryable: true,
          result: {
            ok: false,
            code: visibleErr.code,
            error: visibleErr.message,
            durationMs: Date.now() - startedAt,
            proxyUsed: proxyLabel,
            challengeObserved,
          },
        };
      }

      if (loginPostStatus === 400 || loginPostStatus === 401) {
        return {
          nonRetryable: true,
          result: {
            ok: false,
            code: 'LOGIN_REJECTED',
            error: 'LeetCode rejected username or password.',
            durationMs: Date.now() - startedAt,
            proxyUsed: proxyLabel,
            challengeObserved,
          },
        };
      }

      if (loginPostStatus === 429) {
        return {
          nonRetryable: true,
          result: {
            ok: false,
            code: 'LOGIN_RATE_LIMITED',
            error: 'LeetCode rate limited login attempts (HTTP 429).',
            durationMs: Date.now() - startedAt,
            proxyUsed: proxyLabel,
            challengeObserved,
          },
        };
      }

      if ((loginPostStatus === 403 || postSnap.isInterstitial || (postSnap.hasTurnstileWidget && !postSnap.turnstileToken)) && !retriedPostSubmit && remaining() > 10_000) {
        retriedPostSubmit = true;
        if (challengeObserved === 'none') {
          challengeObserved = postSnap.isInterstitial ? 'cloudflare_interstitial' : 'turnstile';
        }
        const retryWaitUntil = Math.min(deadline - 4_000, Date.now() + 12_000);
        while (Date.now() < retryWaitUntil) {
          const authNow = await verifySignedInUser(page, context);
          if (authNow.signedIn && authNow.username) {
            const rawState = (await context.storageState()) as unknown as LeetCodeLoginStorageState;
            return {
              nonRetryable: true,
              result: {
                ok: true,
                username: authNow.username,
                storageState: rawState,
                durationMs: Date.now() - startedAt,
                proxyUsed: proxyLabel,
                challengeObserved,
              },
            };
          }
          if (Date.now() - lastCheckboxClick >= 3_000) {
            if (await interactWithTurnstileCheckbox(page)) {
              lastCheckboxClick = Date.now();
            }
          }
          const s = await inspectLoginPage(page);
          if (s.turnstileToken) {
            loginPostStatus = null;
            if (await submitBtn.isEnabled().catch(() => false)) {
              await submitBtn.click({ timeout: 5_000 }).catch(() => {});
            }
            break;
          }
          await page.waitForTimeout(450);
        }
      }

      await page.waitForTimeout(Math.min(400, Math.max(50, remaining())));
    }

    return {
      result: {
        ok: false,
        code: 'VERIFICATION_REQUIRED',
        error: 'LeetCode remote login timed out before session verification succeeded.',
        durationMs: Date.now() - startedAt,
        proxyUsed: proxyLabel,
        challengeObserved,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      result: {
        ok: false,
        code: 'LOGIN_BROWSER_ERROR',
        error: message,
        durationMs: Date.now() - startedAt,
        proxyUsed: proxyLabel,
        challengeObserved,
      },
    };
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
    await browserManager.notifySolveCompleted(solverQueue.active).catch(() => {});
  }
}

/**
 * Executes end-to-end LeetCode login inside a single isolated Patchright context
 * on CPSolver (Xvfb headless=false), guaranteeing every Cloudflare challenge and form
 * submission shares the exact same IP and TLS fingerprint.
 */
export async function solveLeetCodeLogin(req: LeetCodeLoginRequest): Promise<LeetCodeLoginResult> {
  const startTime = Date.now();
  const totalTimeout = Math.min(
    MAX_LOGIN_TIMEOUT_MS,
    Math.max(MIN_LOGIN_TIMEOUT_MS, req.timeout ?? DEFAULT_LOGIN_TIMEOUT_MS),
  );

  return solverQueue.run(async () => {
    const deadline = startTime + totalTimeout;
    const rawProxy = typeof req.proxy === 'string' ? req.proxy.trim() : '';

    const attempts: Array<{ proxyConfig?: ProxyConfig; proxyLabel: string; poolIndex?: number }> = [];

    if (req.proxy && typeof req.proxy === 'object') {
      attempts.push({ proxyConfig: req.proxy, proxyLabel: maskProxy(req.proxy.server) });
      attempts.push({ proxyConfig: undefined, proxyLabel: 'direct' });
    } else if (rawProxy.toLowerCase() === 'direct') {
      attempts.push({ proxyConfig: undefined, proxyLabel: 'direct' });
    } else if (rawProxy) {
      const parsed = parseProxy(rawProxy);
      if (parsed) {
        attempts.push({ proxyConfig: parsed, proxyLabel: maskProxy(rawProxy) });
      }
      attempts.push({ proxyConfig: undefined, proxyLabel: 'direct' });
    } else {
      // Zero-proxy default: run direct first on Patchright + Xvfb so stale env proxies never stall login;
      // fall back to configured pool proxies only if direct fails and pool entries exist.
      attempts.push({ proxyConfig: undefined, proxyLabel: 'direct' });
      if (proxyPool.size > 0) {
        const poolCount = Math.min(2, proxyPool.size);
        for (let i = 0; i < poolCount; i++) {
          const idx = (proxyPool.currentIndex + i) % proxyPool.size;
          const pCfg = proxyPool.getProxyAt(idx);
          const pRaw = proxyPool.getRawAt(idx);
          if (pCfg) {
            attempts.push({
              proxyConfig: pCfg,
              proxyLabel: pRaw ? maskProxy(pRaw) : `pool:${idx}`,
              poolIndex: idx,
            });
          }
        }
      }
    }

    let lastResult: LeetCodeLoginResult = {
      ok: false,
      code: 'LOGIN_FAILED',
      error: 'No login attempts executed.',
      durationMs: 0,
    };

    for (let i = 0; i < attempts.length; i++) {
      const step = attempts[i]!;
      const remaining = deadline - Date.now();
      if (remaining < 12_000) {
        break;
      }

      const attemptBudget =
        i < attempts.length - 1 ? Math.min(Math.max(45_000, Math.floor(remaining * 0.65)), remaining) : remaining;

      const outcome = await runSingleLoginAttempt({
        username: req.username,
        password: req.password,
        proxyConfig: step.proxyConfig,
        proxyLabel: step.proxyLabel,
        timeoutMs: attemptBudget,
      });

      lastResult = outcome.result;
      if (outcome.result.ok) {
        if (step.poolIndex !== undefined) {
          proxyPool.markSuccess(step.poolIndex);
        }
        solverStats.recordSuccess(Date.now() - startTime);
        return {
          ...outcome.result,
          durationMs: Date.now() - startTime,
        };
      }

      if (step.poolIndex !== undefined) {
        proxyPool.markFailure(step.poolIndex, outcome.result.error || 'leetcode_login_failed');
      }

      logWarn('Remote LeetCode login attempt failed', {
        attempt: i + 1,
        totalAttempts: attempts.length,
        proxy: step.proxyLabel,
        code: outcome.result.code,
        challengeObserved: outcome.result.challengeObserved,
        error: outcome.result.error?.slice(0, 150),
      });

      if (outcome.nonRetryable) {
        break;
      }
    }

    solverStats.recordFailure();
    return {
      ...lastResult,
      durationMs: Date.now() - startTime,
    };
  });
}
