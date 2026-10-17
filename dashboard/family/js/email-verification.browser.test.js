// Optional local UI contract check. Every API call is intercepted: no account,
// provider email, database write, or real confirmation link is used.
import test from 'node:test';
import assert from 'node:assert/strict';

const baseUrl = process.env.FAMILY_UI_TEST_URL;

test('pending confirmation clears passwords, resends, and verifies codes or pasted links without navigation', { skip: !baseUrl }, async () => {
  const origin = new URL(baseUrl);
  assert.ok(['localhost', '127.0.0.1'].includes(origin.hostname));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    const external = [];
    const submissions = [];
    let confirmed = false;
    let releaseSignup;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).origin !== origin.origin) external.push(request.url()); });
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const body = route.request().method() === 'POST' ? route.request().postDataJSON() : null;
      if (body) submissions.push({ path, body });
      let data;
      if (path === '/api/session') {
        if (!confirmed) { await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'unauthenticated', message: 'Sign in.' } }) }); return; }
        data = { authenticated: true, authType: 'user', user: { id: 'fixture-user', name: 'UI TEST USER', email: 'test@example.invalid' }, role: null, household: null, claimRequired: true };
      } else if (path === '/api/auth/get-session') data = null;
      else if (path === '/api/auth/sign-up/email') {
        await new Promise(resolve => { releaseSignup = resolve; });
        data = { session: null, user: null, confirmationRequired: true };
      } else if (path === '/api/auth/resend-verification') data = { success: true };
      else if (path === '/api/auth/verify-email') {
        if (body.token) { await route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: { code: 'otp_expired', message: 'This test code has expired.' } }) }); return; }
        confirmed = true;
        data = { session: { expiresAt: '2099-01-01T00:00:00Z' }, user: { id: 'fixture-user', name: 'UI TEST USER', email: 'test@example.invalid' } };
      } else { await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'test_route_missing', message: 'Missing UI fixture.' } }) }); return; }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(path.startsWith('/api/auth/') ? data : { data }) });
    });
    await page.goto(new URL('/family.html', origin).href);
    await page.getByRole('button', { name: 'Create an account', exact: true }).click();
    await page.getByLabel('Your name', { exact: true }).fill('UI TEST USER');
    await page.getByLabel('Email', { exact: true }).fill('test@example.invalid');
    await page.getByLabel('Password', { exact: true }).fill('test-fixture-password');
    await page.getByRole('button', { name: 'Create account', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[name="password"]').value === '');
    assert.ok(releaseSignup, 'Signup must be waiting for its response while the password field is already clear.');
    releaseSignup();
    await page.getByRole('heading', { name: 'Confirm your email.', exact: true }).waitFor({ timeout: 5000 });
    await page.getByRole('button', { name: 'Resend confirmation email', exact: true }).click();
    await page.getByText('Confirmation requested.', { exact: false }).waitFor();
    await page.getByLabel('Email confirmation code', { exact: true }).fill('123456');
    await page.getByRole('button', { name: 'Confirm email', exact: true }).click();
    await page.getByText('This test code has expired.', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Email confirmation code', { exact: true }).inputValue(), '');
    await page.getByRole('button', { name: 'Paste link', exact: true }).click();
    const fixtureLink = 'https://fixture.supabase.invalid/auth/v1/verify?token=fixture-secret&type=signup';
    await page.getByLabel('Full confirmation link from the email', { exact: true }).fill(fixtureLink);
    await page.getByRole('button', { name: 'Confirm email', exact: true }).click();
    await page.getByRole('heading', { name: 'Join your family', exact: true }).waitFor({ timeout: 5000 });
    assert.equal(new URL(page.url()).pathname, '/family.html');
    assert.equal(page.url().includes('fixture-secret'), false);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })), { local: [], session: [] });
    assert.deepEqual(submissions.find(item => item.path.endsWith('resend-verification')).body, { email: 'test@example.invalid' });
    assert.deepEqual(submissions.filter(item => item.path.endsWith('verify-email')).map(item => item.body), [{ email: 'test@example.invalid', token: '123456' }, { confirmationLink: fixtureLink }]);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  } finally { await browser.close(); }
});
