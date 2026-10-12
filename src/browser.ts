import { chromium, type Browser, type BrowserContext } from 'patchright';
import { config, logInfo, logWarn, logError } from './config';
import { STEALTH_CHROMIUM_ARGS, getRandomDesktopViewport, applyStealthScripts } from './stealth';
import type { ProxyConfig } from './types';

export class BrowserManager {
  private static instance: BrowserManager | null = null;
  private browser: Browser | null = null;
  private launchingPromise: Promise<Browser> | null = null;
  private recyclingPromise: Promise<void> | null = null;
  private solvesCount = 0;
  private browserRestarts = 0;
  private cachedUserAgent: string | null = null;

  private constructor() {}

  public static getInstance(): BrowserManager {
    if (!BrowserManager.instance) {
      BrowserManager.instance = new BrowserManager();
    }
    return BrowserManager.instance;
  }

  public get isAlive(): boolean {
    return this.browser !== null && this.browser.isConnected();
  }

  public get solvesSinceRestart(): number {
    return this.solvesCount;
  }

  public get restarts(): number {
    return this.browserRestarts;
  }

  /**
   * Returns an active Chromium browser instance, launching one if necessary.
   * Ensures that if browser recycling is currently underway, callers await completion.
   */
  public async ensureBrowser(): Promise<Browser> {
    if (this.recyclingPromise) {
      await this.recyclingPromise;
    }

    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }

    if (this.launchingPromise) {
      return this.launchingPromise;
    }

    this.launchingPromise = (async () => {
      try {
        logInfo('Launching Chromium instance with memory-conservative flags...', {
          headless: config.headless,
          maxOldSpace: 160,
        });

        const instance = await chromium.launch({
          headless: config.headless,
          args: STEALTH_CHROMIUM_ARGS,
          timeout: 30000,
        });

        instance.on('disconnected', () => {
          logWarn('Chromium disconnected or terminated.');
          this.browser = null;
        });

        this.browser = instance;
        this.solvesCount = 0;
        this.browserRestarts++;

        // Cache a realistic User-Agent based on the actual Chromium version
        const version = instance.version();
        this.cachedUserAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;

        return instance;
      } catch (err) {
        logError('Failed to launch Chromium browser', { error: String(err) });
        this.browser = null;
        throw err;
      } finally {
        this.launchingPromise = null;
      }
    })();

    return this.launchingPromise;
  }

  /**
   * Creates an ephemeral, stealth-instrumented BrowserContext with optional proxy routing.
   * Configures lightweight resource blocking to conserve memory on 512MB RAM instances.
   */
  public async createContext(proxyConfig?: ProxyConfig, overrideUserAgent?: string): Promise<BrowserContext> {
    if (this.recyclingPromise) {
      await this.recyclingPromise;
    }

    const browser = await this.ensureBrowser();
    const viewport = getRandomDesktopViewport();

    const playwrightProxy = proxyConfig?.server
      ? {
          server: proxyConfig.server,
          username: proxyConfig.username,
          password: proxyConfig.password,
        }
      : undefined;

    const userAgent =
      (overrideUserAgent && overrideUserAgent.trim()) ||
      this.cachedUserAgent ||
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;

    const context = await browser.newContext({
      viewport,
      proxy: playwrightProxy,
      deviceScaleFactor: 1,
      hasTouch: false,
      isMobile: false,
      userAgent,
    });

    // 1. Inject anti-fingerprinting & stealth masks
    await applyStealthScripts(context);

    return context;
  }

  /**
   * Increments the solve counter and recycles the browser process if thresholds are reached
   * and no active solves are currently using the browser.
   */
  public async notifySolveCompleted(activeCount = 0): Promise<void> {
    this.solvesCount++;
    const mem = process.memoryUsage();
    const rssMb = Math.round(mem.rss / 1024 / 1024);

    const needsRecycle =
      this.solvesCount >= config.maxSolvesBeforeRecycle || rssMb >= config.maxRssMb;

    if (needsRecycle && activeCount <= 1 && !this.recyclingPromise) {
      logInfo('Recycling browser to prevent memory accumulation in 512MB cgroup', {
        solvesCount: this.solvesCount,
        rssMb,
        maxRssMb: config.maxRssMb,
      });

      await this.recycle();
    }
  }

  /**
   * Gracefully and safely restarts the Chromium instance under a mutex.
   */
  public async recycle(): Promise<void> {
    if (this.recyclingPromise) {
      return this.recyclingPromise;
    }

    this.recyclingPromise = (async () => {
      try {
        if (this.browser) {
          const oldBrowser = this.browser;
          this.browser = null;
          await oldBrowser.close().catch(() => {});
        }

        if (typeof global.gc === 'function') {
          try {
            global.gc();
          } catch {}
        }

        await this.ensureBrowser();
      } catch (err) {
        logError('Error recycling browser instance', { error: String(err) });
      } finally {
        this.recyclingPromise = null;
      }
    })();

    return this.recyclingPromise;
  }

  /**
   * Process shutdown handler.
   */
  public async close(): Promise<void> {
    if (this.recyclingPromise) {
      await this.recyclingPromise.catch(() => {});
    }
    if (this.browser) {
      const b = this.browser;
      this.browser = null;
      await b.close().catch(() => {});
    }
  }
}
