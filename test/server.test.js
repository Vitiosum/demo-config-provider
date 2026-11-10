import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.js';

const ENV = {
  FEATURE_NIGHT_MODE: 'false', THEME_ACCENT: 'cherry', MAX_UPLOAD_MB: '25', MAINTENANCE_BANNER: 'off',
  FLEET_STATIONS: 'https://a.example.com,https://b.example.com',
  STATION_NAME: '<b>Console</b> A', SECRET_TOKEN: 'must-never-leak',
};
let server, base, broken, brokenBase;

const listen = (app) => new Promise((resolve) => app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${app.address().port}`)));
before(async () => {
  server = createApp(ENV); base = await listen(server);
  broken = createApp({ ...ENV, MAX_UPLOAD_MB: undefined }); brokenBase = await listen(broken);
});
after(() => { server.close(); broken.close(); });

test('GET /health answers without touching the provider', async () => {
  const r = await fetch(`${base}/health`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { status: 'ok' });
});

test('GET /health/deep checks the provider variables', async () => {
  assert.equal((await fetch(`${base}/health/deep`)).status, 200);
  const r = await fetch(`${brokenBase}/health/deep`);
  assert.equal(r.status, 503);
  assert.equal((await r.json()).provider.broken[0].name, 'MAX_UPLOAD_MB');
});

test('GET /api/panel is readable by the other consoles and leaks nothing else', async () => {
  const r = await fetch(`${base}/api/panel`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  const text = await r.text();
  assert.ok(!text.includes('must-never-leak'));
  assert.equal(JSON.parse(text).flags.length, 4);
});

test('GET / renders the console with escaped values and a strict CSP', async () => {
  const r = await fetch(`${base}/`);
  const html = await r.text();
  assert.equal(r.status, 200);
  assert.ok(html.includes('&lt;b&gt;Console&lt;/b&gt; A'));
  assert.ok(!html.includes('<b>Console</b>'));
  assert.ok(!html.includes('must-never-leak'));
  assert.ok(!html.includes('{{'));
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /connect-src 'self' https:\/\/a\.example\.com https:\/\/b\.example\.com/);
});

test('the header pill says live only when APP_ID is set', async () => {
  const local = await (await fetch(`${base}/`)).text();
  assert.ok(local.includes('Local · not on Clever Cloud'));
  assert.ok(!local.includes('Live on Clever Cloud'));
  const app = createApp({ ...ENV, APP_ID: 'app_test' });
  try {
    const live = await (await fetch(`${await listen(app)}/`)).text();
    assert.ok(live.includes('Live on Clever Cloud'));
    assert.ok(!live.includes('Local · not on Clever Cloud'));
  } finally { app.close(); }
});

test('static files, 404 and 405', async () => {
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/cc-brand.css`)).status, 200);
  assert.equal((await fetch(`${base}/../server.js`)).status, 404);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
  assert.equal((await fetch(`${base}/health`, { method: 'POST' })).status, 405);
});
