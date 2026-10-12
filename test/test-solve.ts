import { solveTurnstile } from '../src/solver';
import { BrowserManager } from '../src/browser';

async function main() {
  const args = process.argv.slice(2);
  const targetSitekey = args[0] || '3x00000000000000000000FF'; // default to interactive test
  const targetUrl = args[1] || 'https://example.com';
  const targetProxy = args[2] || undefined;

  console.log(`Testing Turnstile solver against:`);
  console.log(`  Site URL: ${targetUrl}`);
  console.log(`  Sitekey:  ${targetSitekey}`);
  if (targetProxy) console.log(`  Proxy:    ${targetProxy}`);

  try {
    const res = await solveTurnstile({
      siteurl: targetUrl,
      sitekey: targetSitekey,
      proxy: targetProxy,
      timeout: 35000,
    });

    console.log('Result:', res);
    if (res.ok && res.token) {
      console.log('SUCCESS! Obtained valid token:', res.token.substring(0, 40) + '...');
      process.exitCode = 0;
    } else {
      console.log('Solve did not yield token:', res.error);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('Error during solve execution:', err);
    process.exitCode = 1;
  } finally {
    await BrowserManager.getInstance().close();
    process.exit(process.exitCode ?? 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
