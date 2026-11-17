import { timingSafeEqual } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import type { Request, Response, NextFunction } from 'express';
import type { CorsOptions } from 'cors';

export interface LookupAddress {
  address: string;
  family: number;
}

export type DnsLookupFn = (hostname: string, opts: { all: true }) => Promise<LookupAddress[]>;

export interface UrlValidationResult {
  ok: boolean;
  url?: URL;
  statusCode?: number;
  error?: string;
}

export function getConfiguredApiToken(): string {
  return (
    process.env.CPSOLVER_API_TOKEN?.trim() ||
    process.env.SOLVER_API_TOKEN?.trim() ||
    process.env.API_TOKEN?.trim() ||
    ''
  );
}

function isLoopbackRemote(remoteAddress?: string): boolean {
  if (!remoteAddress) return false;
  const clean = remoteAddress.toLowerCase();
  return clean === '127.0.0.1' || clean === '::1' || clean === '::ffff:127.0.0.1';
}

function constantTimeMatch(expected: string, supplied: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(supplied, 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export function extractBearerOrHeaderToken(req: Request): string {
  const auth = req.header('authorization')?.trim();
  if (auth && /^bearer\s+/i.test(auth)) {
    return auth.replace(/^bearer\s+/i, '').trim();
  }
  return (
    req.header('x-api-key')?.trim() ||
    req.header('x-solver-token')?.trim() ||
    ''
  );
}

/**
 * Authenticates sensitive CPSolver endpoints via environment-configured API token.
 * Fails closed unless CPSOLVER_ALLOW_INSECURE_LOCAL=true on loopback when no token is configured.
 */
export function requireApiAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = getConfiguredApiToken();
  if (!expected) {
    if (
      process.env.CPSOLVER_ALLOW_INSECURE_LOCAL === 'true' &&
      process.env.NODE_ENV !== 'production' &&
      isLoopbackRemote(req.socket?.remoteAddress)
    ) {
      next();
      return;
    }
    res.status(401).json({
      ok: false,
      error: 'Unauthorized: CPSOLVER_API_TOKEN must be configured for protected endpoints',
    });
    return;
  }

  const supplied = extractBearerOrHeaderToken(req);
  if (!constantTimeMatch(expected, supplied)) {
    res.status(401).json({
      ok: false,
      error: 'Unauthorized: missing or invalid API token',
    });
    return;
  }

  next();
}

/**
 * Builds strict CORS options from CORS_ALLOWED_ORIGINS / ALLOWED_ORIGINS.
 * Server-to-server requests without an Origin header are permitted; cross-origin
 * browser requests are denied unless explicitly listed.
 */
export function buildCorsOptions(): CorsOptions {
  const raw = process.env.CORS_ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS || '';
  const allowed = raw
    .split(',')
    .map((o) => o.trim())
    .filter((o) => o.length > 0 && o !== '*');

  return {
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowed.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key', 'x-solver-token', 'x-request-id'],
  };
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true; // multicast & reserved
  return false;
}

export function isPrivateOrReservedIp(rawIp: string): boolean {
  const stripped = rawIp.trim().replace(/^\[|\]$/g, '').split('%')[0]?.toLowerCase() || '';
  const family = net.isIP(stripped);
  if (family === 4) {
    return isPrivateIPv4(stripped);
  }
  if (family === 6) {
    if (stripped === '::' || stripped === '::1') return true;
    if (stripped.startsWith('::ffff:')) {
      const tail = stripped.slice('::ffff:'.length);
      if (net.isIP(tail) === 4) {
        return isPrivateIPv4(tail);
      }
      const hexMatch = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
      if (hexMatch && hexMatch[1] && hexMatch[2]) {
        const hi = parseInt(hexMatch[1], 16);
        const lo = parseInt(hexMatch[2], 16);
        const mapped = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateIPv4(mapped);
      }
      return true;
    }
    const firstSegment = stripped.split(':')[0] || '';
    const firstWord = parseInt(firstSegment.padStart(1, '0'), 16);
    if ((firstWord & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((firstWord & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((firstWord & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    return false;
  }
  return true;
}

function hostnameMatchesAllowlist(hostname: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const host = hostname.toLowerCase();
  return allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/**
 * Validates target URL syntax, optional host allowlist, private/metadata hosts,
 * and resolved DNS addresses to mitigate SSRF.
 */
export async function validateTargetUrl(
  rawUrl: string,
  options?: {
    lookup?: DnsLookupFn;
    allowlist?: string[];
    allowLoopbackForTest?: boolean;
  },
): Promise<UrlValidationResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return { ok: false, statusCode: 400, error: 'Invalid URL string for "siteurl"' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, statusCode: 400, error: '"siteurl" must use http or https protocol' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, statusCode: 400, error: '"siteurl" must not contain embedded credentials' };
  }

  const cleanHost = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!cleanHost) {
    return { ok: false, statusCode: 400, error: 'Invalid hostname in "siteurl"' };
  }

  const allowLoopback =
    options?.allowLoopbackForTest ?? process.env.CPSOLVER_ALLOW_LOOPBACK_TEST === 'true';

  if (allowLoopback && (cleanHost === '127.0.0.1' || cleanHost === 'localhost' || cleanHost === '::1')) {
    return { ok: true, url: parsed };
  }

  const configuredAllowlist =
    options?.allowlist ??
    (process.env.CPSOLVER_ALLOWED_HOSTS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);

  if (!hostnameMatchesAllowlist(cleanHost, configuredAllowlist)) {
    return { ok: false, statusCode: 403, error: `Blocked destination host not in allowlist: ${cleanHost}` };
  }

  if (
    cleanHost === 'localhost' ||
    cleanHost.endsWith('.localhost') ||
    cleanHost.endsWith('.local') ||
    cleanHost.endsWith('.internal') ||
    cleanHost === 'metadata' ||
    cleanHost === 'metadata.google.internal'
  ) {
    return { ok: false, statusCode: 403, error: `Blocked private or metadata destination host: ${cleanHost}` };
  }

  if (net.isIP(cleanHost) !== 0) {
    if (isPrivateOrReservedIp(cleanHost)) {
      return { ok: false, statusCode: 403, error: `Blocked private or reserved destination IP: ${cleanHost}` };
    }
    return { ok: true, url: parsed };
  }

  const lookupFn: DnsLookupFn = options?.lookup ?? ((host, opts) => dns.lookup(host, opts));
  let records: LookupAddress[];
  try {
    records = await lookupFn(cleanHost, { all: true });
  } catch {
    return { ok: false, statusCode: 400, error: `Could not resolve hostname: ${cleanHost}` };
  }

  if (!records || records.length === 0) {
    return { ok: false, statusCode: 400, error: `Hostname resolved to zero addresses: ${cleanHost}` };
  }

  for (const rec of records) {
    if (isPrivateOrReservedIp(rec.address)) {
      return {
        ok: false,
        statusCode: 403,
        error: `Blocked destination host resolving to private or reserved IP (${cleanHost})`,
      };
    }
  }

  return { ok: true, url: parsed };
}

const SENSITIVE_KEY_RE = /pass(word)?|secret|token|cookie|storageState|authorization|api[-_]?key|cfclearance/i;

export function maskUrlCredentials(value: string): string {
  return value.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:/@\s]+):[^@\s]+@/g, '$1:****@');
}

export function sanitizeLogMeta(meta?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(meta)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = '[REDACTED]';
    } else if (typeof val === 'string') {
      out[key] = maskUrlCredentials(val);
    } else if (val && typeof val === 'object' && !Array.isArray(val)) {
      out[key] = sanitizeLogMeta(val as Record<string, unknown>);
    } else {
      out[key] = val;
    }
  }
  return out;
}
