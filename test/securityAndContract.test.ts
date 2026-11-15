import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { app } from '../src/index';
import {
  validateTargetUrl,
  isPrivateOrReservedIp,
  sanitizeLogMeta,
} from '../src/security';
import { parseProxy, config, logInfo, getLogs } from '../src/config';
import { sanitizeTargetSiteUrl, isProxyOrTunnelError } from '../src/solver';
import { ConcurrencyQueue, QueueFullError } from '../src/queue';
import { BrowserManager } from '../src/browser';

async function runTests() {
  console.log('--- Running CPSolver Security & API Contract Tests ---');

  // 1. Private / Reserved IP detection
  assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('10.0.0.5'), true);
  assert.equal(isPrivateOrReservedIp('172.16.0.1'), true);
  assert.equal(isPrivateOrReservedIp('172.31.255.255'), true);
  assert.equal(isPrivateOrReservedIp('192.168.1.10'), true);
  assert.equal(isPrivateOrReservedIp('169.254.169.254'), true);
  assert.equal(isPrivateOrReservedIp('100.64.0.1'), true);
  assert.equal(isPrivateOrReservedIp('::1'), true);
  assert.equal(isPrivateOrReservedIp('fe80::1'), true);
  assert.equal(isPrivateOrReservedIp('fc00::1'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:169.254.169.254'), true);
  assert.equal(isPrivateOrReservedIp('93.184.216.34'), false);
  console.log('✓ IP range checks passed');

  // 2. SSRF URL & DNS validation
  delete process.env.CPSOLVER_ALLOW_LOOPBACK_TEST;
  delete process.env.CPSOLVER_ALLOWED_HOSTS;

  const badProto = await validateTargetUrl('file:///etc/passwd');
  assert.equal(badProto.ok, false);
  assert.equal(badProto.statusCode, 400);

  const badCreds = await validateTargetUrl('https://user:pass@example.com/');
  assert.equal(badCreds.ok, false);

  const metaHost = await validateTargetUrl('http://169.254.169.254/latest/meta-data/');
  assert.equal(metaHost.ok, false);
  assert.equal(metaHost.statusCode, 403);

  const googleMeta = await validateTargetUrl('http://metadata.google.internal/computeMetadata/v1/');
  assert.equal(googleMeta.ok, false);
  assert.equal(googleMeta.statusCode, 403);

  const dnsPrivate = await validateTargetUrl('https://rebind.attacker.example/', {
    lookup: async () => [{ address: '10.0.0.1', family: 4 }],
  });
  assert.equal(dnsPrivate.ok, false);
  assert.equal(dnsPrivate.statusCode, 403);

  const allowlistBlocked = await validateTargetUrl('https://evil.example.com/login', {
    allowlist: ['leetcode.com', 'codeforces.com'],
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  assert.equal(allowlistBlocked.ok, false);
  assert.equal(allowlistBlocked.statusCode, 403);

  const validPublic = await validateTargetUrl('https://leetcode.com/accounts/login/', {
    allowlist: ['leetcode.com', 'codeforces.com'],
    lookup: async () => [{ address: '104.18.0.1', family: 4 }],
  });
  assert.equal(validPublic.ok, true);
  console.log('✓ SSRF URL, DNS resolution, and allowlist validation passed');

  // 3. Log redaction
  const redacted = sanitizeLogMeta({
    proxyServer: 'http://alice:supersecret@gate.example.com:9001',
    password: 'my-password',
    cfClearance: 'secret-cookie-value',
    nested: { authorization: 'Bearer secret123', safeField: 'ok' },
  });
  assert.equal(redacted?.proxyServer, 'http://alice:****@gate.example.com:9001');
  assert.equal(redacted?.password, '[REDACTED]');
  assert.equal(redacted?.cfClearance, '[REDACTED]');
  assert.equal((redacted?.nested as any)?.authorization, '[REDACTED]');
  assert.equal((redacted?.nested as any)?.safeField, 'ok');

  logInfo('Security log check', { proxyServer: 'http://user:pw@proxy.local:8080', token: 'top-secret' });
  const recent = getLogs(1);
  assert.equal(recent[0]?.token, '[REDACTED]');
  assert.equal(recent[0]?.proxyServer, 'http://user:****@proxy.local:8080');
  console.log('✓ Log sanitization passed');

  // 4. Config, proxy parser, queue checks
  assert.equal(typeof config.port, 'number');
  const parsed = parseProxy('http://alice:secret123@192.168.1.100:8080');
  assert.equal(parsed?.server, 'http://192.168.1.100:8080');

  // 4b. URL sanitization & proxy/tunnel error classification
  assert.equal(
    sanitizeTargetSiteUrl('https://leetcode.com/accounts/login/?__cf_chl_rt_tk=abc.123#hash'),
    'https://leetcode.com/accounts/login/',
  );
  assert.equal(
    sanitizeTargetSiteUrl('https://leetcode.com/problems/two-sum/?envType=daily&__cf_chl_tk=xyz&__cf_chl_f_tk=qrs&lang=cpp#editor'),
    'https://leetcode.com/problems/two-sum/?envType=daily&lang=cpp',
  );
  assert.equal(isProxyOrTunnelError('page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at https://leetcode.com/'), true);
  assert.equal(isProxyOrTunnelError('net::ERR_TUNNEL_CONNECTION_FAILED'), true);
  assert.equal(isProxyOrTunnelError('net::ERR_PROXY_CONNECTION_FAILED'), true);
  assert.equal(isProxyOrTunnelError('Turnstile challenge timed out after 45000ms without token'), false);
  console.log('✓ URL sanitization and proxy error classification passed');

  const queue = new ConcurrencyQueue(1, 1);
  const t1 = queue.run(async () => {
    await new Promise((r) => setTimeout(r, 30));
    return 1;
  });
  const t2 = queue.run(async () => 2);
  await assert.rejects(() => queue.run(async () => 3), QueueFullError);
  await Promise.all([t1, t2]);
  console.log('✓ Config, proxy parser, and queue capacity passed');

  // 5. HTTP Server Auth, CORS, Health, and Input Validation
  const prevToken = process.env.CPSOLVER_API_TOKEN;
  process.env.CPSOLVER_API_TOKEN = 'unit_test_secret_token_987654';

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });

  try {
    const addr = server.address();
    assert.ok(addr && typeof addr === 'object');
    const baseUrl = `http://127.0.0.1:${addr.port}`;

    // Health stays accessible for Render liveness probes
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthBody = (await healthRes.json()) as Record<string, unknown>;
    assert.equal(healthBody.status, 'ok');

    // Sensitive routes must reject unauthenticated requests
    const protectedRoutes: Array<[string, string]> = [
      ['POST', '/solve'],
      ['GET', '/logs'],
      ['GET', '/screenshot'],
      ['GET', '/proxies'],
      ['POST', '/proxies/rotate'],
      ['POST', '/proxies/reset'],
      ['GET', '/stats'],
      ['GET', '/ip'],
    ];

    for (const [method, route] of protectedRoutes) {
      const unauth = await fetch(`${baseUrl}${route}`, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        body: method === 'POST' ? JSON.stringify({ siteurl: 'https://example.com' }) : undefined,
      });
      assert.equal(unauth.status, 401, `Expected 401 for unauthenticated ${method} ${route}`);
    }

    // Wrong token must also fail with 401
    const badAuth = await fetch(`${baseUrl}/stats`, {
      headers: { Authorization: 'Bearer wrong_token' },
    });
    assert.equal(badAuth.status, 401);

    // Valid Bearer / x-api-key succeeds on protected routes
    const authHeaders = {
      Authorization: 'Bearer unit_test_secret_token_987654',
      'Content-Type': 'application/json',
    };
    const statsRes = await fetch(`${baseUrl}/stats`, { headers: authHeaders });
    assert.equal(statsRes.status, 200);
    const logsRes = await fetch(`${baseUrl}/logs?limit=5`, {
      headers: { 'x-api-key': 'unit_test_secret_token_987654' },
    });
    assert.equal(logsRes.status, 200);
    const proxiesRes = await fetch(`${baseUrl}/proxies`, { headers: authHeaders });
    assert.equal(proxiesRes.status, 200);

    // CORS blocks arbitrary Origin headers on responses
    const corsCheck = await fetch(`${baseUrl}/health`, {
      headers: { Origin: 'https://evil-site.example' },
    });
    assert.equal(corsCheck.headers.get('access-control-allow-origin'), null);

    // Schema & SSRF enforcement on authenticated POST /solve
    const badUrlRes = await fetch(`${baseUrl}/solve`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ siteurl: 'http://169.254.169.254/latest/meta-data/' }),
    });
    assert.equal(badUrlRes.status, 403);

    const badModeRes = await fetch(`${baseUrl}/solve`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ siteurl: 'https://example.com', mode: 'invalid-mode' }),
    });
    assert.equal(badModeRes.status, 400);

    const badTimeoutRes = await fetch(`${baseUrl}/solve`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ siteurl: 'https://example.com', timeout: 50 }),
    });
    assert.equal(badTimeoutRes.status, 400);

    console.log('✓ HTTP API authentication, CORS, schema validation, and SSRF protection passed');
  } finally {
    if (prevToken === undefined) {
      delete process.env.CPSOLVER_API_TOKEN;
    } else {
      process.env.CPSOLVER_API_TOKEN = prevToken;
    }
    await new Promise((resolve) => server.close(resolve));
    await BrowserManager.getInstance().close();
  }

  console.log('=== All CPSolver Security & Contract Tests Passed! ===');
}

runTests().catch((err) => {
  console.error('Security & contract tests failed:', err);
  process.exit(1);
});
