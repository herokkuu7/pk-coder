import assert from 'node:assert/strict';
import { parseProxyList, normalizeProxyUrl, maskProxy, proxyUrlToConfig, ProxyPoolManager } from '../src/proxyPool';
import { app } from '../src/index';
import type { Server } from 'node:http';

async function runProxyPoolTests() {
  console.log('--- Running Proxy Pool and Rotation Verification ---');

  // Test 1: URL Normalization
  console.log('[Test 1] Testing proxy URL normalization...');
  const n1 = normalizeProxyUrl('http://user:pass@gate.example.com:8080');
  assert.equal(n1, 'http://user:pass@gate.example.com:8080');

  const n2 = normalizeProxyUrl('gate.example.com:8080:alice:secret123');
  assert.equal(n2, 'http://alice:secret123@gate.example.com:8080');

  const n3 = normalizeProxyUrl('socks5://proxy.io:1080');
  assert.equal(n3, 'socks5://proxy.io:1080');
  console.log('✓ URL Normalization passed');

  // Test 2: Comma-separated parsing
  console.log('[Test 2] Testing comma-separated proxy list parsing...');
  const rawEnv = `
    http://bi_1-session-s1:pass1@gate.busyip.com:18080,
    http://bi_2-session-s2:pass2@gate.busyip.com:18080,
    gate.busyip.com:18080:bi_3-session-s3:pass3
  `;
  const list = parseProxyList(rawEnv);
  assert.equal(list.length, 3);
  assert.ok(list[0]?.includes('bi_1-session-s1'));
  assert.ok(list[1]?.includes('bi_2-session-s2'));
  assert.ok(list[2]?.includes('bi_3-session-s3'));
  console.log('✓ Comma-separated parsing passed (3 proxies found)');

  // Test 3: Password Masking
  console.log('[Test 3] Testing password masking for logs and telemetry...');
  const masked = maskProxy(list[0]!);
  assert.ok(!masked.includes('pass1'), 'Password should be masked');
  assert.ok(masked.includes(':****@'), 'Mask indicator should be present');
  console.log(`✓ Masked proxy string: ${masked}`);

  // Test 4: Proxy Config Conversion
  console.log('[Test 4] Testing conversion to Patchright ProxyConfig...');
  const cfg = proxyUrlToConfig(list[0]!);
  assert.ok(cfg);
  assert.equal(cfg.server, 'http://gate.busyip.com:18080');
  assert.equal(cfg.username, 'bi_1-session-s1');
  assert.equal(cfg.password, 'pass1');
  console.log('✓ ProxyConfig conversion passed');

  // Test 5: Pool Rotation and Failover
  console.log('[Test 5] Testing stateful pool rotation and failover...');
  const pool = ProxyPoolManager.getInstance();
  // Inject the 3 test proxies
  process.env.PROXY_URL = rawEnv;
  pool.reloadFromEnv();

  assert.equal(pool.size, 3);
  assert.equal(pool.currentIndex, 0);

  // Active proxy should be #0
  const active0 = pool.getActiveProxy();
  assert.ok(active0?.username?.includes('bi_1'));

  // Simulate Proxy #0 failure -> should rotate to Proxy #1
  pool.markFailure(0, 'sticky_device_offline');
  assert.equal(pool.currentIndex, 1);
  const active1 = pool.getActiveProxy();
  assert.ok(active1?.username?.includes('bi_2'));

  // Simulate Proxy #1 success -> stays on Proxy #1
  pool.markSuccess(1);
  assert.equal(pool.currentIndex, 1);

  // Rotate manually -> moves to #2
  pool.rotateToNext();
  assert.equal(pool.currentIndex, 2);

  // Rotate past end -> wraps to #0
  pool.rotateToNext();
  assert.equal(pool.currentIndex, 0);

  // Reset to first
  pool.rotateToNext();
  pool.resetToFirst();
  assert.equal(pool.currentIndex, 0);
  console.log('✓ Stateful pool rotation and failover passed');

  // Test 6: HTTP Telemetry Endpoints
  console.log('[Test 6] Testing HTTP telemetry endpoints (/proxies, /proxies/rotate, /health)...');
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 6.1 GET /health
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json() as Record<string, any>;
    assert.ok(healthJson.proxyPool);
    assert.equal(healthJson.proxyPool.total, 3);
    assert.equal(healthJson.proxyPool.activeIndex, 0);
    console.log('✓ GET /health reports proxyPool stats');

    // 6.2 GET /proxies
    const proxiesRes = await fetch(`${baseUrl}/proxies`);
    assert.equal(proxiesRes.status, 200);
    const proxiesJson = await proxiesRes.json() as Record<string, any>;
    assert.equal(proxiesJson.total, 3);
    assert.equal(proxiesJson.proxies.length, 3);
    assert.ok(proxiesJson.proxies[0].masked.includes(':****@'));
    console.log('✓ GET /proxies returns full pool status');

    // 6.3 POST /proxies/rotate
    const rotateRes = await fetch(`${baseUrl}/proxies/rotate`, { method: 'POST' });
    assert.equal(rotateRes.status, 200);
    const rotateJson = await rotateRes.json() as Record<string, any>;
    assert.equal(rotateJson.ok, true);
    assert.equal(rotateJson.activeIndex, 1);
    console.log('✓ POST /proxies/rotate successfully rotates proxy');

    // 6.4 POST /proxies/reset
    const resetRes = await fetch(`${baseUrl}/proxies/reset`, { method: 'POST' });
    assert.equal(resetRes.status, 200);
    const resetJson = await resetRes.json() as Record<string, any>;
    assert.equal(resetJson.ok, true);
    assert.equal(resetJson.activeIndex, 0);
    console.log('✓ POST /proxies/reset resets to index 0');
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  console.log('\n=== ALL PROXY POOL TESTS PASSED! ===');
}

runProxyPoolTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
