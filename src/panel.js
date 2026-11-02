// What the console shows, read once from the environment at boot.
//
// Clever Cloud merges two sources into an app's environment:
//   - the Configuration provider add-on (shared by every linked app),
//   - the app's own variables (they win when a name exists in both).
// A running process cannot tell them apart, so the source of each name comes
// from PANEL_WIRING, written by scripts/trace-wiring.mjs from `clever env --format json`.

// The four fleet flags the provider holds. Each one drives an instrument.
export const FLAGS = {
  FEATURE_NIGHT_MODE: { kind: 'bool', label: 'Night mode' },
  THEME_ACCENT: { kind: 'choice', label: 'Accent', choices: ['cherry', 'orange', 'gold', 'teal', 'violet'] },
  MAX_UPLOAD_MB: { kind: 'int', label: 'Upload limit', min: 1, max: 1000 },
  MAINTENANCE_BANNER: { kind: 'text', label: 'Maintenance notice', max: 140 },
};

// The roster of consoles, also held by the provider: a comma-separated list of app URLs.
export const ROSTER = 'FLEET_STATIONS';

// Set on each app itself, so the two consoles differ on purpose.
export const OWN = ['STATION_NAME'];

// The only platform variables ever displayed (Clever Brand Kit rule).
export const PLATFORM = ['CC_APP_NAME', 'APP_ID', 'INSTANCE_NUMBER', 'INSTANCE_TYPE',
  'CC_PRETTY_INSTANCE_NAME', 'CC_COMMIT_ID', 'CC_DEPLOYMENT_ID'];

// Every name the console is allowed to show with its value. Nothing else leaves the process.
export const SHOWN = [...Object.keys(FLAGS), ROSTER, ...OWN];

const OFF_WORDS = new Set(['', 'off', 'none', 'false', '0', 'no']);

export function parseFlag(name, raw) {
  const spec = FLAGS[name];
  if (raw === undefined) return { value: null, ok: false, problem: 'missing' };
  const text = String(raw).trim();
  switch (spec.kind) {
    case 'bool': {
      const v = text.toLowerCase();
      if (['true', 'on', '1', 'yes'].includes(v)) return { value: true, ok: true };
      if (['false', 'off', '0', 'no'].includes(v)) return { value: false, ok: true };
      return { value: null, ok: false, problem: 'expected true or false' };
    }
    case 'choice': {
      const v = text.toLowerCase();
      return spec.choices.includes(v)
        ? { value: v, ok: true }
        : { value: null, ok: false, problem: `expected one of ${spec.choices.join(', ')}` };
    }
    case 'int': {
      const n = Number(text);
      return Number.isInteger(n) && n >= spec.min && n <= spec.max
        ? { value: n, ok: true }
        : { value: null, ok: false, problem: `expected a whole number from ${spec.min} to ${spec.max}` };
    }
    case 'text': {
      // An empty notice, or a word like "off", means no notice.
      if (OFF_WORDS.has(text.toLowerCase())) return { value: '', ok: true };
      return { value: text.slice(0, spec.max), ok: true };
    }
  }
}

export function parseRoster(raw) {
  if (!raw) return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean).flatMap((s) => {
    try {
      const url = new URL(s);
      return url.protocol === 'https:' || url.protocol === 'http:' ? [url.origin] : [];
    } catch {
      return [];
    }
  }).slice(0, 8);
}

// PANEL_WIRING = {"provider":[names],"app":[names],"addon":"…","tracedAt":"…","otherAppVars":n}
export function parseWiring(raw) {
  if (!raw) return null;
  try {
    const w = JSON.parse(raw);
    const names = (list) => (Array.isArray(list) ? list.filter((n) => typeof n === 'string') : []);
    return {
      provider: names(w.provider),
      app: names(w.app),
      addon: typeof w.addon === 'string' ? w.addon : null,
      tracedAt: typeof w.tracedAt === 'string' ? w.tracedAt : null,
      otherAppVars: Number.isInteger(w.otherAppVars) ? w.otherAppVars : 0,
    };
  } catch {
    return null;
  }
}

// provider | app | override (set in both, the app wins) | untraced | missing
export function sourceOf(name, present, wiring) {
  if (!present) return 'missing';
  if (!wiring) return 'untraced';
  const inProvider = wiring.provider.includes(name);
  const inApp = wiring.app.includes(name);
  if (inProvider && inApp) return 'override';
  if (inApp) return 'app';
  if (inProvider) return 'provider';
  return 'untraced';
}

export function readPanel(env = process.env, bootedAt = new Date()) {
  const wiring = parseWiring(env.PANEL_WIRING);
  const flags = Object.entries(FLAGS).map(([name, spec]) => {
    const raw = env[name];
    return { name, label: spec.label, kind: spec.kind, raw: raw === undefined ? null : String(raw).slice(0, 160), ...parseFlag(name, raw), source: sourceOf(name, raw !== undefined, wiring) };
  });
  const roster = env[ROSTER];
  const shortCommit = env.CC_COMMIT_ID ? env.CC_COMMIT_ID.slice(0, 7) : undefined;
  const platform = Object.fromEntries(PLATFORM.map((k) => [k, k === 'CC_COMMIT_ID' ? shortCommit : env[k]])
    .filter(([, v]) => v !== undefined && v !== ''));
  return {
    station: {
      name: (env.STATION_NAME || env.CC_APP_NAME || 'Local console').slice(0, 40),
      app: env.CC_APP_NAME || 'local',
      appId: env.APP_ID || null,
    },
    bootedAt: bootedAt.toISOString(),
    flags,
    own: OWN.map((name) => ({ name, value: env[name] ?? null, source: sourceOf(name, env[name] !== undefined, wiring) })),
    fleet: {
      name: ROSTER,
      stations: parseRoster(roster),
      source: sourceOf(ROSTER, roster !== undefined, wiring),
    },
    wiring: wiring
      ? { traced: true, addon: wiring.addon, tracedAt: wiring.tracedAt, otherAppVars: wiring.otherAppVars }
      : { traced: false },
    platform,
  };
}

// /health/deep: the add-on is healthy when every flag it should provide is present and valid.
export function checkProvider(panel) {
  const broken = panel.flags.filter((f) => !f.ok).map((f) => ({ name: f.name, problem: f.problem }));
  const fromProvider = panel.flags.filter((f) => f.source === 'provider').map((f) => f.name);
  return { ok: broken.length === 0, fromProvider, broken, traced: panel.wiring.traced };
}
