import type { ProxyConfig } from './types';
import { logInfo, logWarn, normalizeProxyUrl } from './config';

export { normalizeProxyUrl };

/**
 * Parses comma, newline, or semicolon-separated proxy lists from environment strings.
 */
export function parseProxyList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const lines = raw.split(/[\r\n,;]+/);
  const results: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/).filter(Boolean);
    for (const part of parts) {
      const normalized = normalizeProxyUrl(part);
      if (normalized && !results.includes(normalized)) {
        results.push(normalized);
      }
    }
  }

  return results;
}

/**
 * Safely masks proxy credentials for logging and telemetry.
 */
export function maskProxy(proxyUrl: string): string {
  const normalized = normalizeProxyUrl(proxyUrl) ?? proxyUrl;
  try {
    const u = new URL(normalized);
    const pass = u.password ? ':****' : '';
    const user = u.username ? `${u.username}${pass}@` : '';
    return `${u.protocol}//${user}${u.host}`;
  } catch {
    if (/^([^:\s]+):(\d+):([^:@\s]+):([^@\s]+)$/.test(proxyUrl.trim())) {
      return proxyUrl.trim().replace(/^([^:\s]+):(\d+):([^:@\s]+):([^@\s]+)$/, 'http://$3:****@$1:$2');
    }
    return proxyUrl.replace(/:[^:@]+@/, ':****@');
  }
}

/**
 * Converts a raw proxy URL string into Playwright/Patchright ProxyConfig.
 */
export function proxyUrlToConfig(proxyUrl: string): ProxyConfig | undefined {
  if (!proxyUrl) return undefined;
  const normalized = normalizeProxyUrl(proxyUrl) ?? proxyUrl;
  try {
    const u = new URL(normalized);
    const server = `${u.protocol}//${u.host}`;
    const username = u.username ? decodeURIComponent(u.username) : undefined;
    const password = u.password ? decodeURIComponent(u.password) : undefined;
    return { server, username, password };
  } catch {
    return undefined;
  }
}

export interface ProxyItemStatus {
  index: number;
  masked: string;
  isCurrent: boolean;
  successCount: number;
  failureCount: number;
}

export interface ProxyPoolStatus {
  total: number;
  activeIndex: number;
  activeMasked: string | null;
  proxies: ProxyItemStatus[];
}

/**
 * Stateful Proxy Pool Manager.
 * Maintains proxy order, tracks active index, handles sequential failover rotation,
 * and maintains telemetry on success/failure rates.
 */
export class ProxyPoolManager {
  private static instance: ProxyPoolManager | null = null;
  private pool: string[] = [];
  private activeIndex = 0;
  private successCounts = new Map<number, number>();
  private failureCounts = new Map<number, number>();

  private constructor() {
    this.reloadFromEnv();
  }

  public static getInstance(): ProxyPoolManager {
    if (!ProxyPoolManager.instance) {
      ProxyPoolManager.instance = new ProxyPoolManager();
    }
    return ProxyPoolManager.instance;
  }

  public reloadFromEnv(): void {
    const raw =
      process.env.PROXIES?.trim() ||
      process.env.PROXY_LIST?.trim() ||
      process.env.PROXY_URL?.trim() ||
      '';

    const parsed = parseProxyList(raw);
    this.pool = parsed;
    if (this.activeIndex >= this.pool.length) {
      this.activeIndex = 0;
    }

    if (this.pool.length > 0 && this.pool[0]) {
      logInfo('ProxyPool loaded proxies from environment', {
        total: this.pool.length,
        firstProxy: maskProxy(this.pool[0]),
      });
    }
  }

  public get size(): number {
    return this.pool.length;
  }

  public get currentIndex(): number {
    return this.activeIndex;
  }

  public getProxyAt(index: number): ProxyConfig | undefined {
    const raw = this.pool[index];
    return raw ? proxyUrlToConfig(raw) : undefined;
  }

  public getRawAt(index: number): string | undefined {
    return this.pool[index];
  }

  public getActiveProxy(): ProxyConfig | undefined {
    if (this.pool.length === 0) return undefined;
    return this.getProxyAt(this.activeIndex);
  }

  public getActiveRaw(): string | undefined {
    if (this.pool.length === 0) return undefined;
    return this.getRawAt(this.activeIndex);
  }

  /**
   * Advances active pointer to the next proxy in the list.
   * Wraps around when reaching the end of the pool.
   */
  public rotateToNext(): { index: number; proxy?: ProxyConfig; masked?: string } {
    if (this.pool.length === 0) {
      return { index: 0 };
    }

    const previousIndex = this.activeIndex;
    this.activeIndex = (this.activeIndex + 1) % this.pool.length;
    const currentRaw = this.pool[this.activeIndex];
    const masked = currentRaw ? maskProxy(currentRaw) : undefined;

    logInfo('ProxyPool rotated to next proxy', {
      fromIndex: previousIndex,
      toIndex: this.activeIndex,
      total: this.pool.length,
      activeProxy: masked,
    });

    return {
      index: this.activeIndex,
      proxy: currentRaw ? proxyUrlToConfig(currentRaw) : undefined,
      masked,
    };
  }

  /**
   * Records a successful solve for the given proxy index.
   */
  public markSuccess(index = this.activeIndex): void {
    const current = this.successCounts.get(index) ?? 0;
    this.successCounts.set(index, current + 1);
  }

  /**
   * Records a failure for the given proxy index and rotates to the next available proxy.
   */
  public markFailure(index = this.activeIndex, reason?: string): void {
    const current = this.failureCounts.get(index) ?? 0;
    this.failureCounts.set(index, current + 1);

    const raw = this.pool[index];
    logWarn('Proxy failure recorded', {
      index,
      proxy: raw ? maskProxy(raw) : 'unknown',
      failCount: current + 1,
      reason: reason ?? 'solve-failed',
    });

    // Advance to next proxy in pool
    if (this.pool.length > 1) {
      this.rotateToNext();
    }
  }

  /**
   * Resets active index back to the first proxy (index 0).
   */
  public resetToFirst(): void {
    this.activeIndex = 0;
    logInfo('ProxyPool reset to first proxy (index 0)');
  }

  public getStatus(): ProxyPoolStatus {
    const currentRaw = this.pool[this.activeIndex];
    return {
      total: this.pool.length,
      activeIndex: this.activeIndex,
      activeMasked: currentRaw ? maskProxy(currentRaw) : null,
      proxies: this.pool.map((p, idx) => ({
        index: idx,
        masked: maskProxy(p),
        isCurrent: idx === this.activeIndex,
        successCount: this.successCounts.get(idx) ?? 0,
        failureCount: this.failureCounts.get(idx) ?? 0,
      })),
    };
  }
}

export const proxyPool = ProxyPoolManager.getInstance();
