// Asks Clever Cloud where each variable of an app comes from, and stores the answer
// (names only, never values) in the app's own PANEL_WIRING variable.
// A running process cannot tell a provider variable from an app variable; the API can:
// `clever env --format json` lists the app's own variables in `env`
// and the injected ones, per add-on, in `fromAddons`.
//
// Usage: node scripts/trace-wiring.mjs <alias|app_id>...   then restart the apps.
import { execFileSync } from 'node:child_process';
import { SHOWN } from '../src/panel.js';

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error('Usage: node scripts/trace-wiring.mjs <alias|app_id>...');
  process.exit(1);
}

for (const target of targets) {
  const which = target.startsWith('app_') ? '--app' : '--alias';
  const env = JSON.parse(execFileSync('clever', ['env', '--format', 'json', which, target], { encoding: 'utf8' }));
  const shown = (name) => SHOWN.includes(name);
  const providers = env.fromAddons.filter((addon) => addon.env.some((v) => shown(v.name)));
  const wiring = {
    provider: [...new Set(providers.flatMap((addon) => addon.env.map((v) => v.name)).filter(shown))],
    app: env.env.map((v) => v.name).filter(shown),
    addon: providers.map((addon) => addon.addonName).join(', ') || null,
    tracedAt: new Date().toISOString(),
    otherAppVars: env.env.filter((v) => !shown(v.name) && v.name !== 'PANEL_WIRING').length,
  };
  execFileSync('clever', ['env', 'set', 'PANEL_WIRING', JSON.stringify(wiring), which, target], { stdio: ['ignore', 'ignore', 'inherit'] });
  console.log(`${target}: ${wiring.addon ?? 'no provider'} -> ${wiring.provider.join(', ') || 'nothing'}; this app -> ${wiring.app.join(', ') || 'nothing'}`);
}
console.log('PANEL_WIRING set. Restart (or deploy) the apps to load it.');
