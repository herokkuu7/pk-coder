import assert from 'node:assert/strict';
import { parseProxy, config } from '../src/config';
import { ConcurrencyQueue, QueueFullError } from '../src/queue';
import { app } from '../src/index';
import type { Server } from 'node:http';

async function runTests() {
  console.log('--- Running CPSolver Comprehensive Sanity Verification ---');

  // Test 1: Config and defaults
  console.log('[Test 1] Verifying configuration defaults...');
  assert.equal(typeof config.port, 'number');
  assert.ok(config.maxConcurrentSolves >= 1);
  assert.ok(config.maxQueueSize >= 1);
  assert.ok(config.defaultTimeoutMs > 0);
  console.log('✓ Config passed');

  // Test 2: Proxy parser
  console.log('[Test 2] Verifying proxy parser...');
  const p1 = parseProxy('http://alice:secret123@192.168.1.100:8080');
  assert.ok(p1);
  assert.equal(p1.server, 'http://192.168.1.100:8080');
  assert.equal(p1.username, 'alice');
  assert.equal(p1.password, 'secret123');

  const p2 = parseProxy('socks5://user:pass@proxy.io:1080');
  assert.ok(p2);
  assert.equal(p2.server, 'socks5://proxy.io:1080');
  assert.equal(p2.username, 'user');
  assert.equal(p2.password, 'pass');

  const p3 = parseProxy('10.0.0.1:3128');
  assert.ok(p3);
  assert.equal(p3.server, 'http://10.0.0.1:3128');

  const p4 = parseProxy({ server: 'http://custom:8888', username: 'u', password: 'p' });
  assert.ok(p4);
  assert.equal(p4.server, 'http://custom:8888');
  assert.equal(p4.username, 'u');
  assert.equal(p4.password, 'p');

  const pDirect = parseProxy('direct');
  assert.equal(pDirect, undefined, 'Explicit direct override should bypass proxy');

  console.log('✓ Proxy parser passed');

  // Test 3: ConcurrencyQueue
  console.log('[Test 3] Verifying ConcurrencyQueue...');
  const queue = new ConcurrencyQueue(2, 2); // max 2 concurrent, max 2 waiting
  let running = 0;
  let maxSeenRunning = 0;

  const makeTask = (delayMs: number) => async () => {
    running++;
    if (running > maxSeenRunning) maxSeenRunning = running;
    await new Promise((r) => setTimeout(r, delayMs));
    running--;
    return 'done';
  };

  // Launch 2 tasks (active = 2)
  const t1 = queue.run(makeTask(50));
  const t2 = queue.run(makeTask(50));
  // Queue 2 tasks (waiting = 2)
  const t3 = queue.run(makeTask(50));
  const t4 = queue.run(makeTask(50));

  // 5th task should exceed queue capacity (capacity = 2)
  await assert.rejects(async () => {
    await queue.run(makeTask(10));
  }, QueueFullError);

  const results = await Promise.all([t1, t2, t3, t4]);
  assert.deepEqual(results, ['done', 'done', 'done', 'done']);
  assert.ok(maxSeenRunning <= 2, `Max running was ${maxSeenRunning}, expected <= 2`);
  assert.equal(queue.active, 0);
  assert.equal(queue.waiting, 0);
  console.log('✓ ConcurrencyQueue passed');

  // Test 4: Express HTTP endpoints
  console.log('[Test 4] Verifying HTTP endpoints...');
  const testPort = 19999;
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(testPort, '127.0.0.1', () => resolve(s));
  });

  try {
    const baseUrl = `http://127.0.0.1:${testPort}`;

    // 4.1 GET /health
    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    const healthJson = await healthRes.json() as Record<string, unknown>;
    assert.equal(healthJson.status, 'ok');
    assert.equal(healthJson.service, 'CPSolver');
    assert.ok(healthJson.memory);
    assert.ok(healthJson.queue);

    // 4.2 GET /
    const rootRes = await fetch(`${baseUrl}/`);
    assert.equal(rootRes.status, 200);
    const rootJson = await rootRes.json() as Record<string, unknown>;
    assert.equal(rootJson.service, 'CPSolver');

    // 4.3 GET /stats
    const statsRes = await fetch(`${baseUrl}/stats`);
    assert.equal(statsRes.status, 200);
    const statsJson = await statsRes.json() as Record<string, unknown>;
    assert.equal(typeof statsJson.totalSolves, 'number');

    // 4.4 POST /solve validation failures
    // Missing body
    const badRes1 = await fetch(`${baseUrl}/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(badRes1.status, 400);

    // Invalid URL
    const badRes2 = await fetch(`${baseUrl}/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteurl: 'not-a-url', sitekey: '0x4AAAAAA' }),
    });
    assert.equal(badRes2.status, 400);

    // Missing sitekey
    const badRes3 = await fetch(`${baseUrl}/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ siteurl: 'https://example.com', sitekey: '' }),
    });
    assert.equal(badRes3.status, 400);

    // Test 5: Live non-interactive solve (Always Pass test sitekey)
    console.log('[Test 5] Live solve with non-interactive sitekey (1x00000000000000000000AA)...');
    const solveRes5 = await fetch(`${baseUrl}/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteurl: 'https://example.com',
        sitekey: '1x00000000000000000000AA',
        timeout: 20000,
      }),
    });
    assert.equal(solveRes5.status, 200);
    const solveJson5 = await solveRes5.json() as Record<string, unknown>;
    assert.equal(solveJson5.ok, true);
    assert.ok(typeof solveJson5.token === 'string' && solveJson5.token.length > 5);
    console.log(`✓ Non-interactive solve passed! Token: ${solveJson5.token}`);

    // Test 6: Fast-fail error handling on blocked sitekey (2x00000000000000000000AB)
    console.log('[Test 6] Live fast-fail error handling on blocked sitekey (2x00000000000000000000AB)...');
    const t0 = Date.now();
    const solveRes6 = await fetch(`${baseUrl}/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteurl: 'https://example.com',
        sitekey: '2x00000000000000000000AB',
        timeout: 20000,
      }),
    });
    const errDurationMs = Date.now() - t0;
    const solveJson6 = await solveRes6.json() as Record<string, unknown>;
    assert.equal(solveJson6.ok, false);
    assert.ok(typeof solveJson6.error === 'string' && solveJson6.error.includes('Turnstile error'));
    assert.ok(errDurationMs < 8000, `Expected fast-fail under 8000ms, took ${errDurationMs}ms`);
    console.log(`✓ Fast-fail error handling passed in ${errDurationMs}ms! Reported error: ${solveJson6.error}`);

    // Test 7: Live interactive challenge solve with checkbox interaction (3x00000000000000000000FF)
    console.log('[Test 7] Live interactive solve with checkbox interaction (3x00000000000000000000FF)...');
    const solveRes7 = await fetch(`${baseUrl}/solve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        siteurl: 'https://example.com',
        sitekey: '3x00000000000000000000FF',
        timeout: 25000,
      }),
    });
    assert.equal(solveRes7.status, 200);
    const solveJson7 = await solveRes7.json() as Record<string, unknown>;
    assert.equal(solveJson7.ok, true);
    assert.ok(typeof solveJson7.token === 'string' && solveJson7.token.length > 5);
    console.log(`✓ Interactive solve passed with checkbox click! Token: ${solveJson7.token}`);

    console.log('✓ All HTTP endpoint and live solving tests passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    const { BrowserManager } = await import('../src/browser');
    await BrowserManager.getInstance().close();
  }

  console.log('=== All CPSolver Sanity Tests Passed Successfully! ===');
}

runTests().catch((err) => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
