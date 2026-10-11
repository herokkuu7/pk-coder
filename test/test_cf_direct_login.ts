import { chromium } from 'patchright';

async function main() {
  console.log('=== Step 1: Launching Patchright Chromium ===');
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  console.log('=== Step 2: Navigating to https://codeforces.com/enter ===');
  await page.goto('https://codeforces.com/enter', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  console.log('Initial Title:', await page.title());

  // Wait out interstitial challenge
  for (let i = 0; i < 15; i++) {
    const title = await page.title();
    console.log(`[CF Check ${i}s] Title: "${title}", URL: ${page.url()}`);
    if (!title.toLowerCase().includes('just a moment') && title.trim().length > 0) {
      console.log('Codeforces challenge cleared! Title is:', title);
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
    await page.waitForTimeout(2000);
  }

  // Settle navigation after clearance
  await page.waitForTimeout(3000);

  // If redirected to home, go to /enter
  if (!page.url().includes('/enter')) {
    console.log('Navigating directly to /enter now that session is cleared...');
    await page.goto('https://codeforces.com/enter', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(2000);
  }

  // Check form
  console.log('=== Step 3: Checking Login Form ===');
  console.log('Current URL:', page.url());
  console.log('Current Title:', await page.title());

  const handleInput = page.locator('#handleOrEmail');
  await handleInput.waitFor({ state: 'visible', timeout: 15000 }).catch(() => null);

  if (await handleInput.isVisible()) {
    const handle = process.env.CF_HANDLE || 'gogo_124';
    const password = process.env.CF_PASSWORD || 'q1w2e3r4t5@67890';
    console.log(`SUCCESS: Login form is visible! Filling credentials for ${handle}...`);
    await handleInput.fill(handle);
    await page.locator('#password').fill(password);

    const remember = page.locator('#remember');
    if ((await remember.count()) > 0) {
      await remember.check().catch(() => {});
    }

    console.log('Submitting login form...');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => null),
      page.locator('input[type="submit"].submit').click(),
    ]);

    await page.waitForTimeout(3000);
    console.log('URL after login:', page.url());
    console.log('Title after login:', await page.title());

    const isLogged = (await page.content()).includes('gogo_124');
    console.log('=== Login Status ===');
    console.log('Is gogo_124 logged in?:', isLogged);

    console.log('=== Step 4: Navigating to https://codeforces.com/problemset/submit ===');
    await page.goto('https://codeforces.com/problemset/submit', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    console.log('Submit URL:', page.url());
    console.log('Submit Title:', await page.title());
    const hasSource = (await page.locator('textarea[name="source"]').count()) > 0;
    console.log('Submit form source textarea present?:', hasSource);

    const submitAnalysis = await page.evaluate(() => {
      const form = document.querySelector('form:has(textarea[name="source"])');
      const el = document.querySelector('.cf-turnstile, [data-sitekey]');
      const iframes = Array.from(document.querySelectorAll('iframe')).map((f) => f.src);
      const submitBtn = document.querySelector('input[type="submit"], button[type="submit"]');
      return {
        formExists: !!form,
        hasTurnstile: !!el,
        sitekey: el?.getAttribute('data-sitekey') || (el as HTMLElement)?.dataset?.sitekey || null,
        iframes,
        submitDisabled: (submitBtn as HTMLInputElement)?.disabled,
      };
    });

    console.log('Submit Page Audit:', JSON.stringify(submitAnalysis, null, 2));
  } else {
    console.log('Login form not visible! Page Title:', await page.title());
  }

  await browser.close();
}

main().catch(console.error);
