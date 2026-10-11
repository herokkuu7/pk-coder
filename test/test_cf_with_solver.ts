import { chromium } from 'patchright';
import { solveTurnstile } from '../src/solver';
import { applyStealthScripts } from '../src/stealth';

const PROXY =
  'http://customer-jp-lmc6hb64r-cc-in-iptype-residential-sessid-ylvk7rom-sesstime-1-backup-1:kdKWYXp9PFrh@gate.joyproxy.com:9001';

async function main() {
  console.log('=== Step 1: Solving Codeforces Interstitial with Solver ===');
  const solveRes = await solveTurnstile({
    siteurl: 'https://codeforces.com/enter',
    mode: 'navigate',
    proxy: PROXY,
    timeout: 35000,
  });

  console.log('Solver Result:', {
    ok: solveRes.ok,
    durationMs: solveRes.durationMs,
    hasClearance: !!solveRes.cfClearance,
    clearanceLen: solveRes.cfClearance?.length,
  });

  if (!solveRes.ok || !solveRes.cfClearance) {
    console.error('Failed to obtain Cloudflare clearance:', solveRes.error);
    process.exit(1);
  }

  console.log('=== Step 2: Launching Browser with Clearance Cookies & Matching UA ===');
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const matchingUA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browser.version()} Safari/537.36`;
  console.log('Using matching User-Agent:', matchingUA);

  const parsedProxy = new URL(PROXY);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: matchingUA,
    proxy: {
      server: `${parsedProxy.protocol}//${parsedProxy.host}`,
      username: decodeURIComponent(parsedProxy.username),
      password: decodeURIComponent(parsedProxy.password),
    },
  });

  await applyStealthScripts(context);

  // Inject cookies from solver
  const cookiesToAdd = [];
  if (solveRes.cookies) {
    for (const [name, value] of Object.entries(solveRes.cookies)) {
      cookiesToAdd.push({
        name,
        value,
        domain: '.codeforces.com',
        path: '/',
      });
    }
  }
  if (!cookiesToAdd.some((c) => c.name === 'cf_clearance')) {
    cookiesToAdd.push({
      name: 'cf_clearance',
      value: solveRes.cfClearance,
      domain: '.codeforces.com',
      path: '/',
    });
  }

  await context.addCookies(cookiesToAdd);
  console.log(`Injected ${cookiesToAdd.length} clearance cookies into browser context`);

  const page = await context.newPage();
  console.log('Navigating directly to https://codeforces.com/enter ...');
  await page.goto('https://codeforces.com/enter', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  console.log('Page Title:', await page.title());
  console.log('Page URL:', page.url());

  const handleInput = page.locator('#handleOrEmail');
  const visible = await handleInput.isVisible({ timeout: 10000 }).catch(() => false);
  console.log('Is #handleOrEmail visible directly?:', visible);

  if (visible) {
    console.log('=== Step 3: Submitting Credentials for gogo_124 ===');
    await handleInput.fill('gogo_124');
    await page.locator('#password').fill('q1w2e3r4t5@67890');

    const remember = page.locator('#remember');
    if ((await remember.count()) > 0) {
      await remember.check().catch(() => {});
    }

    console.log('Clicking Submit button...');
    await page.locator('input[type="submit"].submit').click();
    await page.waitForTimeout(5000);

    console.log('URL after login:', page.url());
    console.log('Title after login:', await page.title());
    const content = await page.content();
    const isLogged = content.includes('gogo_124');
    console.log('Is gogo_124 logged in?:', isLogged);

    console.log('=== Step 4: Navigating to Submit Page ===');
    await page.goto('https://codeforces.com/problemset/submit', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);
    console.log('Submit URL:', page.url());
    console.log('Submit Title:', await page.title());
    const hasSource = (await page.locator('textarea[name="source"]').count()) > 0;
    console.log('Submit form source textarea present?:', hasSource);
    const submitBtn = page.locator('input[type="submit"].submit');
    const submitDisabled = await submitBtn.isDisabled().catch(() => false);
    console.log('Submit button disabled?:', submitDisabled);
  } else {
    console.log('Login form not visible! Page Title:', await page.title());
  }

  await browser.close();
}

main().catch(console.error);
