// The Control Panel: one Node.js server, no dependencies.
// The same code runs as two Clever Cloud apps; both read the same Configuration provider.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { readPanel, checkProvider } from './src/panel.js';

const PUBLIC = join(import.meta.dirname, 'public');
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const STATIC = new Set(['/cc-brand.css', '/panel.css', '/app.js']);

// Header pill: "Live" only when Clever Cloud injected APP_ID.
const LIVE_PILL = '<span class="cc-pill cc-pill--live"><span class="cc-dot"></span>Live on Clever Cloud</span>';
const LOCAL_PILL = '<span class="cc-pill cc-pill--muted"><span class="cc-dot cc-dot--muted"></span>Local · not on Clever Cloud</span>';

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Environment variables are read once, at boot: that is when Clever Cloud hands them over.
export function createApp(env = process.env, bootedAt = new Date()) {
  const panel = readPanel(env, bootedAt);
  const template = readFile(join(PUBLIC, 'index.html'), 'utf8');

  // The browser polls every console of the fleet, so the CSP lets it reach their origins.
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data:",
    `connect-src 'self' ${panel.fleet.stations.join(' ')}`.trim(),
    "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
  ].join('; ');

  function send(res, status, body, headers = {}) {
    res.writeHead(status, {
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    });
    res.end(body);
  }
  const json = (res, status, data, headers = {}) =>
    send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });

  async function page() {
    const accent = panel.flags.find((f) => f.name === 'THEME_ACCENT').value || 'none';
    const night = panel.flags.find((f) => f.name === 'FEATURE_NIGHT_MODE').value ? 'on' : 'off';
    return (await template)
      .replaceAll('{{STATION}}', escapeHtml(panel.station.name))
      .replaceAll('{{APP}}', escapeHtml(panel.station.app))
      .replaceAll('{{ACCENT}}', accent)
      .replaceAll('{{NIGHT}}', night)
      .replace('{{LIVE_PILL}}', panel.station.appId ? LIVE_PILL : LOCAL_PILL)
      .replace('{{BOOT}}', JSON.stringify({ ...panel, now: new Date().toISOString() }).replaceAll('<', '\\u003c'));
  }

  return createServer(async (req, res) => {
    const { pathname } = new URL(req.url, 'http://local');
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'GET only' }, { Allow: 'GET, HEAD' });
    try {
      if (pathname === '/health') return json(res, 200, { status: 'ok' });
      if (pathname === '/health/deep') {
        const check = checkProvider(panel);
        return json(res, check.ok ? 200 : 503, { status: check.ok ? 'ok' : 'degraded', provider: check });
      }
      // Readable from every console of the fleet: demo flags and allowed platform variables only.
      // Polled every few seconds: a fresh connection per poll reaches the newest instance right after a restart.
      if (pathname === '/api/panel') {
        return json(res, 200, { ...panel, now: new Date().toISOString() }, { 'Access-Control-Allow-Origin': '*', Connection: 'close' });
      }
      if (pathname === '/') return send(res, 200, await page(), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      if (STATIC.has(pathname)) {
        const body = await readFile(join(PUBLIC, pathname));
        return send(res, 200, body, { 'Content-Type': TYPES[extname(pathname)], 'Cache-Control': 'public, max-age=300' });
      }
      return json(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error(err);
      return json(res, 500, { error: 'Internal error' });
    }
  });
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) {
  const port = Number(process.env.PORT) || 8080;
  const server = createApp().listen(port, '0.0.0.0', () => {
    const p = readPanel();
    const wired = p.flags.map((f) => `${f.name}=${f.ok ? 'ok' : f.problem} (${f.source})`).join(', ');
    console.log(`Console "${p.station.name}" listening on 0.0.0.0:${port}`);
    console.log(`Flags read at boot: ${wired}`);
  });
  // On restart, Clever Cloud starts the new instance, then stops this one: let go of open connections quickly.
  process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
