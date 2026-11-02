import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFlag, parseRoster, parseWiring, sourceOf, readPanel, checkProvider } from '../src/panel.js';

const WIRING = JSON.stringify({
  provider: ['FEATURE_NIGHT_MODE', 'THEME_ACCENT', 'MAX_UPLOAD_MB', 'MAINTENANCE_BANNER', 'FLEET_STATIONS'],
  app: ['STATION_NAME', 'THEME_ACCENT'],
  addon: 'demo-config-provider-fleet',
  tracedAt: '2026-11-01T20:00:00Z',
  otherAppVars: 2,
});

const ENV = {
  FEATURE_NIGHT_MODE: 'true',
  THEME_ACCENT: 'Gold',
  MAX_UPLOAD_MB: '25',
  MAINTENANCE_BANNER: 'off',
  FLEET_STATIONS: 'https://a.example.com, https://b.example.com/path, not a url, ftp://x',
  STATION_NAME: 'Console A',
  PANEL_WIRING: WIRING,
  CC_APP_NAME: 'demo-config-provider-a',
  CC_COMMIT_ID: '0123456789abcdef',
  POSTGRESQL_ADDON_PASSWORD: 'must-never-leak',
};

test('flags are parsed and validated', () => {
  assert.deepEqual(parseFlag('FEATURE_NIGHT_MODE', 'on'), { value: true, ok: true });
  assert.equal(parseFlag('FEATURE_NIGHT_MODE', 'maybe').ok, false);
  assert.deepEqual(parseFlag('THEME_ACCENT', ' TEAL '), { value: 'teal', ok: true });
  assert.equal(parseFlag('THEME_ACCENT', 'pink').ok, false);
  assert.deepEqual(parseFlag('MAX_UPLOAD_MB', '100'), { value: 100, ok: true });
  assert.equal(parseFlag('MAX_UPLOAD_MB', '0').ok, false);
  assert.equal(parseFlag('MAX_UPLOAD_MB', '2.5').ok, false);
  assert.deepEqual(parseFlag('MAINTENANCE_BANNER', 'none'), { value: '', ok: true });
  assert.equal(parseFlag('MAINTENANCE_BANNER', 'x'.repeat(300)).value.length, 140);
  assert.deepEqual(parseFlag('THEME_ACCENT', undefined), { value: null, ok: false, problem: 'missing' });
});

test('the fleet roster keeps http(s) origins only', () => {
  assert.deepEqual(parseRoster(ENV.FLEET_STATIONS), ['https://a.example.com', 'https://b.example.com']);
  assert.deepEqual(parseRoster(undefined), []);
});

test('sources come from the traced wiring, and the app wins over the provider', () => {
  const w = parseWiring(WIRING);
  assert.equal(sourceOf('MAX_UPLOAD_MB', true, w), 'provider');
  assert.equal(sourceOf('STATION_NAME', true, w), 'app');
  assert.equal(sourceOf('THEME_ACCENT', true, w), 'override');
  assert.equal(sourceOf('MAX_UPLOAD_MB', false, w), 'missing');
  assert.equal(sourceOf('MAX_UPLOAD_MB', true, null), 'untraced');
  assert.equal(parseWiring('{not json'), null);
});

test('the panel shows demo flags and allowed platform variables only', () => {
  const panel = readPanel(ENV, new Date('2026-11-01T21:00:00Z'));
  const json = JSON.stringify(panel);
  assert.ok(!json.includes('must-never-leak'));
  assert.ok(!json.includes('POSTGRESQL'));
  assert.equal(panel.station.name, 'Console A');
  assert.equal(panel.platform.CC_COMMIT_ID, '0123456');
  assert.equal(panel.wiring.addon, 'demo-config-provider-fleet');
  assert.equal(panel.flags.find((f) => f.name === 'THEME_ACCENT').source, 'override');
  assert.equal(panel.fleet.stations.length, 2);
});

test('the deep check fails when a flag is missing or invalid', () => {
  assert.equal(checkProvider(readPanel(ENV)).ok, true);
  const broken = checkProvider(readPanel({ ...ENV, MAX_UPLOAD_MB: 'lots', THEME_ACCENT: undefined }));
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.broken.map((b) => b.name).sort(), ['MAX_UPLOAD_MB', 'THEME_ACCENT']);
});
