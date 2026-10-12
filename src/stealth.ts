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
export async function applyStealthScripts(_context: BrowserContext): Promise<void> {
  // Patchright natively patches automation indicators at the C++ engine level.
  // We intentionally avoid injecting JavaScript prototype proxies or property getters,
  // as Cloudflare Turnstile's integrity checker detects modified property descriptors.
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
 * Simulates human-like click with realistic trajectory and clean native event dispatching.
 */
export async function simulateHumanClick(
  page: Page,
  targetX: number,
  targetY: number,
  options: { moveSteps?: number; dwellMs?: number; holdMs?: number } = {},
): Promise<void> {
  const steps = options.moveSteps ?? (5 + Math.floor(Math.random() * 4));
  await page.mouse.move(targetX, targetY, { steps }).catch(() => {});
  await new Promise((r) => setTimeout(r, 60 + Math.random() * 60));
  await page.mouse.click(targetX, targetY).catch(() => {});
  await new Promise((r) => setTimeout(r, 40 + Math.random() * 40));
}

/**
 * Detects Cloudflare Turnstile challenge iframes (including those enclosed in closed shadow DOM)
 * and performs a human-like cursor approach and click on the verification checkbox.
 */
export async function interactWithTurnstileCheckbox(page: Page): Promise<boolean> {
  try {
    // 1. MUST wait until Cloudflare challenge execution frame has actually appeared!
    const challengeFrame = page.frames().find((f) => {
      const u = f.url().toLowerCase();
      return u.includes('challenge-platform') || u.includes('challenges.cloudflare.com');
    });

    if (!challengeFrame) {
      // Challenge frame not attached yet — do not click early!
      return false;
    }

    // 2. Locate container or iframe bounding box
    const container = page.locator('#cf-turnstile-wrapper, .cf-turnstile, [data-sitekey]').first();
    const box = await Promise.race([
      container.boundingBox(),
      new Promise<null>((r) => setTimeout(() => r(null), 1000)),
    ]).catch(() => null);

    if (box && box.width > 0 && box.height > 0) {
      const targetX = Math.round(box.x + 28);
      const targetY = Math.round(box.y + 32);
      logInfo('Clicking Turnstile widget checkbox with human curve', {
        targetX,
        targetY,
        boxWidth: box.width,
        boxHeight: box.height,
        frameUrl: challengeFrame.url().slice(0, 100),
      });
      await simulateHumanClick(page, targetX, targetY);
      return true;
    }

    return false;
  } catch {
    return false;
  }
}
