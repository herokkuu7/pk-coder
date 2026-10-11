import { chromium } from 'patchright';

async function main() {
  console.log('=== Step 1: Launching Patchright Chromium ===');
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  console.log('=== Step 2: Navigating to https://codeforces.com/enter ===');
  await page.goto('https://codeforces.com/enter', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  // Wait out interstitial challenge
  for (let i = 0; i < 15; i++) {
    const title = await page.title();
    console.log(`[Wait ${i}s] Title: "${title}", URL: ${page.url().substring(0, 50)}`);
    if (!title.toLowerCase().includes('just a moment')) {
      console.log('Cloudflare interstitial cleared!');
      break;
    }
    const frames = page.frames();
    for (const f of frames) {
      if (f.url().includes('cloudflare') || f.url().includes('challenge')) {
        const el = await f.frameElement().catch(() => null);
        const box = await el?.boundingBox().catch(() => null);
        if (box) {
          console.log(`Clicking Turnstile frame at (${box.x + 28}, ${box.y + box.height / 2})`);
          await page.mouse.click(box.x + 28, box.y + box.height / 2);
        }
      }
    }
    await page.waitForTimeout(1500);
  }

  // Wait for login form
  console.log('=== Step 3: Checking Login Form ===');
  const handleInput = page.locator('#handleOrEmail');
  await handleInput.waitFor({ state: 'visible', timeout: 10000 }).catch(() => null);

  if (await handleInput.isVisible()) {
    console.log('Filling credentials for gogo_124...');
    await handleInput.fill('gogo_124');
    await page.locator('#password').fill('q1w2e3r4t5@67890');

    const remember = page.locator('#remember');
    if ((await remember.count()) > 0) {
      await remember.check().catch(() => {});
    }

    console.log('Submitting login form...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
      page.locator('input[type="submit"].submit').click(),
    ]);

    await page.waitForTimeout(3000);
    console.log('After login URL:', page.url());
    console.log('After login Title:', await page.title());
    const content = await page.content();
    const isLogged = content.includes('gogo_124');
    console.log('Is gogo_124 logged in?:', isLogged);

    console.log('=== Step 4: Navigating to Problemset Submit ===');
    await page.goto('https://codeforces.com/problemset/submit', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);
    console.log('Submit URL:', page.url());
    console.log('Submit Title:', await page.title());
    const hasSource = (await page.locator('textarea[name="source"]').count()) > 0;
    console.log('Submit form source textarea present?:', hasSource);
    const submitDisabled = await page.locator('input[type="submit"].submit').isDisabled().catch(() => false);
    console.log('Submit button disabled?:', submitDisabled);
  } else {
    console.log('Login form not visible! Page Title:', await page.title());
  }

  await browser.close();
}

main().catch(console.error);
