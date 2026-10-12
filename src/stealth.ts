import type { BrowserContext, Page } from 'patchright';
import { logInfo } from './config';

/**
 * Ultra-low-memory and stealth flags for Chromium on Render (512MB RAM).
 * Minimizes memory footprint by disabling unused features (GPU, audio, sync, translate)
 * while stripping automation indicators (--disable-blink-features=AutomationControlled).
 */
export const STEALTH_CHROMIUM_ARGS: string[] = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage', // Critical in Docker/Render cgroups (uses /tmp instead of 64MB /dev/shm)
  '--enable-webgl',
  '--ignore-gpu-blocklist',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--enable-unsafe-webgpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-breakpad',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-extensions',
  '--mute-audio',
  '--no-pings',
];

export const STANDARD_DESKTOP_VIEWPORTS = [
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];

export function getRandomDesktopViewport(): { width: number; height: number } {
  const index = Math.floor(Math.random() * STANDARD_DESKTOP_VIEWPORTS.length);
  return STANDARD_DESKTOP_VIEWPORTS[index] ?? { width: 1366, height: 768 };
}

/**
 * Injects scripts before any page scripts execute to mask automation indicators
 * and present a standard desktop Chromium fingerprint.
 */
export async function applyStealthScripts(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    // 1. Mock standard chrome runtime object
    try {
      const win = window as unknown as Record<string, unknown>;
      if (!win.chrome) {
        win.chrome = {
          app: {
            isInstalled: false,
            InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
            RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
          },
          runtime: {
            OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
            OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
            PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
            PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
            PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
            RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
          },
          loadTimes: () => {
            const now = Date.now() / 1000;
            return {
              requestTime: now - 0.45,
              startLoadTime: now - 0.4,
              commitLoadTime: now - 0.25,
              finishDocumentLoadTime: now - 0.1,
              firstPaintTime: now - 0.15,
              finishLoadTime: now - 0.05,
              wasFetchedViaSpdy: true,
              wasNpnNegotiated: true,
              npnNegotiatedProtocol: 'h2',
              connectionInfo: 'h2',
            };
          },
          csi: () => ({
            startE: Date.now() - 500,
            onloadT: Date.now(),
            pageT: 500,
            tran: 15,
          }),
        };
      }
    } catch {}

    // 2. Ensure navigator.languages is defined
    try {
      if (!navigator.languages || navigator.languages.length === 0) {
        Object.defineProperty(navigator, 'languages', {
          get: () => ['en-US', 'en'],
          configurable: true,
        });
      }
    } catch {}

    // 2b. Align navigator.platform and userAgentData with User-Agent (crucial on Linux Docker)
    try {
      const isWin = navigator.userAgent.includes('Windows');
      const isMac = navigator.userAgent.includes('Macintosh');
      const targetPlatform = isWin ? 'Win32' : (isMac ? 'MacIntel' : 'Linux x86_64');
      Object.defineProperty(navigator, 'platform', {
        get: () => targetPlatform,
        configurable: true,
      });
      const navAny = navigator as any;
      if (navAny.userAgentData) {
        Object.defineProperty(navAny.userAgentData, 'platform', {
          get: () => (isWin ? 'Windows' : (isMac ? 'macOS' : 'Linux')),
          configurable: true,
        });
      }
    } catch {}

    // 3. Strip automation artifacts & leakage flags
    try {
      const win = window as unknown as Record<string, unknown>;
      [
        'cdc_adoQpoasnfa76pfcZLmcfl_Array',
        'cdc_adoQpoasnfa76pfcZLmcfl_Promise',
        'cdc_adoQpoasnfa76pfcZLmcfl_Symbol',
        '__nightmare',
        'callPhantom',
        '_phantom',
      ].forEach((prop) => {
        try {
          delete win[prop];
        } catch {}
      });
    } catch {}

    // 4. Mock WebGL vendor & renderer to match host OS cleanly
    try {
      const isLinux = navigator.userAgent.includes('Linux') || navigator.platform.includes('Linux');
      const spoofVendor = isLinux ? 'Google Inc. (Intel)' : 'Google Inc. (NVIDIA)';
      const spoofRenderer = isLinux
        ? 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)'
        : 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
      if (typeof WebGLRenderingContext !== 'undefined') {
        const origGetParam = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(param: number) {
          if (param === 37445) return spoofVendor;
          if (param === 37446) return spoofRenderer;
          return origGetParam.apply(this, [param]);
        };
      }
      if (typeof WebGL2RenderingContext !== 'undefined') {
        const origGetParam2 = WebGL2RenderingContext.prototype.getParameter;
        WebGL2RenderingContext.prototype.getParameter = function(param: number) {
          if (param === 37445) return spoofVendor;
          if (param === 37446) return spoofRenderer;
          return origGetParam2.apply(this, [param]);
        };
      }
    } catch {}

    // 5. Intercept postMessage to avoid cross-origin target origin mismatch errors
    try {
      const origPostMessage = Window.prototype.postMessage;
      (Window.prototype as any).postMessage = function(msg: any, targetOrigin: any, transfer?: any) {
        const safeOrigin =
          typeof targetOrigin === 'string' && (targetOrigin.startsWith('http') || targetOrigin.includes('cloudflare'))
            ? '*'
            : targetOrigin;
        if (transfer !== undefined) {
          return (origPostMessage as any).call(this, msg, safeOrigin, transfer);
        }
        return (origPostMessage as any).call(this, msg, safeOrigin);
      };
    } catch {}
  }).catch(() => undefined);
}

/**
 * Simulates human-like mouse movement using a Cubic Bézier curve
 * with biomechanical easing and sub-pixel micro-jitter.
 */
export async function simulateHumanMouseMove(
  page: Page,
  targetX: number,
  targetY: number,
  steps?: number,
): Promise<void> {
  try {
    const lastPos = (page as unknown as { _lastMousePos?: { x: number; y: number } })._lastMousePos ?? {
      x: Math.round(150 + Math.random() * 200),
      y: Math.round(150 + Math.random() * 200),
    };
    const startX = lastPos.x;
    const startY = lastPos.y;

    const dx = targetX - startX;
    const dy = targetY - startY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (distance < 2) {
      await page.mouse.move(targetX, targetY).catch(() => {});
      (page as unknown as { _lastMousePos: { x: number; y: number } })._lastMousePos = { x: targetX, y: targetY };
      return;
    }

    const numSteps = steps ?? Math.max(12, Math.min(36, Math.round(distance / 16)));
    const angle = Math.atan2(dy, dx);
    const perpAngle = angle + (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2);
    const curveDeviation = Math.min(40, distance * 0.2) * (0.6 + Math.random() * 0.8);

    const cp1x = startX + dx * 0.25 + Math.cos(perpAngle) * curveDeviation * (0.5 + Math.random() * 0.5);
    const cp1y = startY + dy * 0.25 + Math.sin(perpAngle) * curveDeviation * (0.5 + Math.random() * 0.5);
    const cp2x = startX + dx * 0.75 + Math.cos(perpAngle) * curveDeviation * (0.3 + Math.random() * 0.7);
    const cp2y = startY + dy * 0.75 + Math.sin(perpAngle) * curveDeviation * (0.3 + Math.random() * 0.7);

    for (let i = 1; i <= numSteps; i++) {
      const u = i / numSteps;
      const t = u * u * (3 - 2 * u); // Smoothstep easing

      const oneMinusT = 1 - t;
      const b0 = oneMinusT * oneMinusT * oneMinusT;
      const b1 = 3 * oneMinusT * oneMinusT * t;
      const b2 = 3 * oneMinusT * t * t;
      const b3 = t * t * t;

      const tremor = (1 - u) * 1.5;
      const jitterX = (Math.random() - 0.5) * tremor;
      const jitterY = (Math.random() - 0.5) * tremor;

      const currentX = Math.round(b0 * startX + b1 * cp1x + b2 * cp2x + b3 * targetX + jitterX);
      const currentY = Math.round(b0 * startY + b1 * cp1y + b2 * cp2y + b3 * targetY + jitterY);

      await page.mouse.move(currentX, currentY).catch(() => {});

      if (numSteps > 1) {
        const delay = 5 + Math.floor(Math.random() * 8);
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    await page.mouse.move(targetX, targetY).catch(() => {});
    (page as unknown as { _lastMousePos: { x: number; y: number } })._lastMousePos = { x: targetX, y: targetY };
  } catch {
    // Non-fatal if target frame changes
  }
}

/**
 * Simulates human-like click with realistic trajectory, dwell time, and hold duration.
 */
export async function simulateHumanClick(
  page: Page,
  targetX: number,
  targetY: number,
  options: { moveSteps?: number; dwellMs?: number; holdMs?: number } = {},
): Promise<void> {
  const dwellMs = options.dwellMs ?? (60 + Math.random() * 80);
  const holdMs = options.holdMs ?? (60 + Math.random() * 50);

  // 1. Move mouse to target
  await simulateHumanMouseMove(page, targetX, targetY, options.moveSteps);

  // 2. Pre-click hover dwell
  if (dwellMs > 0) {
    await new Promise((r) => setTimeout(r, dwellMs));
  }

  // 3. Mouse down
  await page.mouse.down().catch(() => {});

  // 4. Contact hold duration
  if (holdMs > 0) {
    await new Promise((r) => setTimeout(r, holdMs));
  }

  // 5. Mouse up
  await page.mouse.up().catch(() => {});

  // 6. Post-click settle
  await new Promise((r) => setTimeout(r, 40 + Math.random() * 40));
}

/**
 * Detects Cloudflare Turnstile challenge iframes (including those enclosed in closed shadow DOM)
 * and performs a human-like cursor approach and click on the verification checkbox.
 */
export async function interactWithTurnstileCheckbox(page: Page): Promise<boolean> {
  try {
    // Strategy 1: Search page.frames() for Cloudflare Turnstile frames
    // (Crucial: Cloudflare attaches the iframe inside a closed shadow root, so page.locator('iframe') misses it,
    // but page.frames() tracks every frame in the browser process).
    for (const f of page.frames()) {
      const url = f.url().toLowerCase();
      if (url.includes('challenge-platform') || url.includes('challenges.cloudflare.com')) {
        logInfo('Detected Cloudflare challenge frame', { frameUrl: url.slice(0, 100) });
        const elHandle = await f.frameElement().catch(() => null);
        if (elHandle) {
          const box = await elHandle.boundingBox().catch(() => null);
          if (box && box.width > 0 && box.height > 0) {
            // Checkbox target calculation: center of 300x65 widget checkbox is (box.x + 28, box.y + 32)
            const targetX = Math.round(box.x + (box.width < 150 ? box.width / 2 : 28));
            const targetY = Math.round(box.y + (box.height > 65 ? 32 : box.height / 2));

            logInfo('Clicking Turnstile widget checkbox with human curve', { targetX, targetY, boxWidth: box.width, boxHeight: box.height });
            await simulateHumanClick(page, targetX, targetY);
            return true;
          }
        }

        // Try direct click inside frame if elements are accessible
        try {
          const clickable = f.locator(
            'input[type="checkbox"], .ctp-checkbox-container, .mark, #challenge-stage, #cf-stage, label, body'
          ).first();
          if ((await clickable.count().catch(() => 0)) > 0) {
            const cbBox = await clickable.boundingBox().catch(() => null);
            if (cbBox && cbBox.width > 0 && cbBox.height > 0) {
              const targetX = Math.round(cbBox.x + cbBox.width / 2);
              const targetY = Math.round(cbBox.y + cbBox.height / 2);
              await simulateHumanClick(page, targetX, targetY);
              return true;
            }
          }
        } catch {}
      }
    }

    // Strategy 2: Check Turnstile container elements in the main document
    const containerLocators = [
      '.cf-turnstile > div > div',
      '.cf-turnstile > div',
      '#cf-turnstile-wrapper',
      '.cf-turnstile',
      'div[data-sitekey]',
      '#turnstile-wrapper',
      '[id^="cf-chl-widget"]',
    ];

    for (const selector of containerLocators) {
      const loc = page.locator(selector).first();
      if ((await loc.count().catch(() => 0)) > 0) {
        const isVis = await loc.isVisible().catch(() => false);
        if (isVis) {
          const box = await loc.boundingBox().catch(() => null);
          if (box && box.width > 0 && box.height > 0) {
            const targetX = Math.round(
              box.x + (box.width < 150 ? box.width / 2 : 28) + (Math.random() - 0.5) * 4
            );
            const targetY = Math.round(
              box.y + (box.height > 65 ? 32 : box.height / 2) + (Math.random() - 0.5) * 4
            );

            await simulateHumanClick(page, targetX, targetY);
            return true;
          }
        }
      }
    }

    // Strategy 3: Standard iframe locator fallback
    const iframeLoc = page.locator(
      'iframe[src*="challenges.cloudflare.com"], iframe[src*="challenge-platform"], iframe[title*="Turnstile"], iframe[title*="Cloudflare"]'
    ).first();

    if ((await iframeLoc.count().catch(() => 0)) > 0 && (await iframeLoc.isVisible().catch(() => false))) {
      const box = await iframeLoc.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) {
        const targetX = Math.round(box.x + 28);
        const targetY = Math.round(box.y + box.height / 2);
        await simulateHumanClick(page, targetX, targetY);
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}
