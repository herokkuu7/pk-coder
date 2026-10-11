import { solveTurnstile } from '../src/solver';
import { BrowserManager } from '../src/browser';

async function main() {
  const args = process.argv.slice(2);
  const targetSitekey = args[0] || '3x00000000000000000000FF'; // default to interactive test
  const targetUrl = args[1] || 'https://example.com';

  console.log(`Testing Turnstile solver against:`);
  console.log(`  Site URL: ${targetUrl}`);
  console.log(`  Sitekey:  ${targetSitekey}`);

  try {
    const res = await solveTurnstile({
      siteurl: targetUrl,
      sitekey: targetSitekey,
      timeout: 30000,
    });

    console.log('Result:', res);
    if (res.ok && res.token) {
      console.log('SUCCESS! Obtained valid token:', res.token.substring(0, 40) + '...');
    } else {
      console.log('Solve did not yield token:', res.error);
    }
  } catch (err) {
    console.error('Error during solve execution:', err);
  } finally {
    await BrowserManager.getInstance().close();
  }
}

main().catch(console.error);
