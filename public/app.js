// The Control Panel: draws the console from /api/panel and keeps it in step.
// Everything shown comes from environment variables the server read at boot.
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const SVG = 'http://www.w3.org/2000/svg';

const ACCENTS = { cherry: '#ff4469', orange: '#ff8f72', gold: '#ffcd40', teal: '#3ae6cf', violet: '#aaa7ff' };
const ACCENT_ANGLE = { cherry: -90, orange: -45, gold: 0, teal: 45, violet: 90 };
const UPLOAD_STEPS = [10, 25, 100, 500];
const POLL_SELF_MS = 4000;
const POLL_FLEET_MS = 5000;

let panel = JSON.parse($('#boot').textContent);
let clockOffset = Date.parse(panel.now) - Date.now(); // server clock minus browser clock
let fleet = new Map(); // origin -> { data, offset, down }

const flag = (p, name) => p.flags.find((f) => f.name === name);
const two = (n) => String(n).padStart(2, '0');
const hms = (d) => `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;

// ---------- Springs: the needle and the knob move like the real thing ----------
const springs = new Map();
function springTo(key, target, apply, { stiffness = 120, damping = 11, from } = {}) {
  let s = springs.get(key);
  if (!s) { s = { x: from ?? target, v: 0, running: false }; springs.set(key, s); }
  s.target = target;
  if (reduceMotion) { s.x = target; apply(target); return; }
  if (s.running) return;
  s.running = true;
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(0.032, (now - last) / 1000); last = now;
    s.v += (stiffness * (s.target - s.x) - damping * s.v) * dt;
    s.x += s.v * dt;
    if (Math.abs(s.v) < 0.02 && Math.abs(s.target - s.x) < 0.02) { s.x = s.target; s.running = false; }
    apply(s.x);
    if (s.running) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- Build the static parts of the instruments once ----------
function el(name, attrs, parent) {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
}
const polar = (cx, cy, r, deg) => [cx + r * Math.sin((deg * Math.PI) / 180), cy - r * Math.cos((deg * Math.PI) / 180)];

function buildSelector() {
  const g = $('#selectorDial');
  const [cx, cy] = [140, 110];
  el('circle', { cx, cy, r: 62, class: 'dial__ring' }, g);
  for (const [name, deg] of Object.entries(ACCENT_ANGLE)) {
    const [x1, y1] = polar(cx, cy, 52, deg); const [x2, y2] = polar(cx, cy, 60, deg);
    el('line', { x1, y1, x2, y2, class: 'dial__tick' }, g);
    const [jx, jy] = polar(cx, cy, 71, deg);
    el('circle', { cx: jx, cy: jy, r: 6, fill: ACCENTS[name], color: ACCENTS[name], class: 'dial__jewel', 'data-accent': name }, g);
    const [lx, ly] = polar(cx, cy, 86, deg);
    const anchor = deg < -10 ? 'end' : deg > 10 ? 'start' : 'middle';
    const t = el('text', { x: lx, y: ly + 3.5, 'text-anchor': anchor, class: 'engr' }, g);
    t.textContent = name.toUpperCase();
  }
  const [ox1, oy1] = polar(cx, cy, 52, 180); const [ox2, oy2] = polar(cx, cy, 60, 180);
  el('line', { x1: ox1, y1: oy1, x2: ox2, y2: oy2, class: 'dial__tick' }, g);
  const off = el('text', { x: cx, y: cy + 80, 'text-anchor': 'middle', class: 'engr' }, g);
  off.textContent = 'OFF';
}

// MAX_UPLOAD_MB sits on a log scale from 1 to 1000 MB
const vuAngle = (mb) => (mb == null ? -56 : -48 + (96 * Math.log10(Math.min(1000, Math.max(1, mb)))) / 3);
function buildVu() {
  const g = $('#vuScale');
  const [cx, cy] = [120, 168];
  const arc = (r, a0, a1) => {
    const [x0, y0] = polar(cx, cy, r, a0); const [x1, y1] = polar(cx, cy, r, a1);
    return `M${x0} ${y0} A${r} ${r} 0 0 1 ${x1} ${y1}`;
  };
  el('path', { d: arc(118, vuAngle(250), 48), class: 'vu__red' }, g);
  el('path', { d: arc(115, -48, vuAngle(250)), fill: 'none', stroke: '#221d17', 'stroke-width': 1 }, g);
  const labelled = [1, 5, 10, 25, 50, 100, 250, 1000];
  for (const mb of [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000]) {
    const a = vuAngle(mb);
    const major = labelled.includes(mb);
    const [x1, y1] = polar(cx, cy, major ? 106 : 110, a); const [x2, y2] = polar(cx, cy, 120, a);
    el('line', { x1, y1, x2, y2, class: 'vu__tick', 'stroke-width': major ? 1.8 : 1.1 }, g);
    if (major) {
      const [lx, ly] = polar(cx, cy, 131, a);
      const t = el('text', { x: lx, y: ly + 4, 'text-anchor': 'middle', class: 'vu__label' }, g);
      t.textContent = mb === 1000 ? '1k' : String(mb);
    }
  }
}

function buildNixie() {
  const box = $('#nixie');
  for (let i = 0; i < 6; i++) {
    if (i === 2 || i === 4) box.insertAdjacentHTML('beforeend', '<span class="nixie__sep"><i></i><i></i></span>');
    const tube = document.createElement('span');
    tube.className = 'tube';
    // Real Nixie tubes stack all ten cathodes: the unlit ones stay faintly visible.
    tube.innerHTML = [1, 6, 9, 8, 4, 3, 2, 5, 7, 0].map((d) => `<span data-d="${d}">${d}</span>`).join('');
    box.appendChild(tube);
  }
}

// ---------- Render the console ----------
const SOURCE_TEXT = {
  provider: 'from the provider',
  app: 'set on this app',
  override: 'this app overrides the provider',
  untraced: 'source not traced',
  missing: 'not set',
};

function formatFlag(f) {
  if (!f.ok) return f.problem === 'missing' ? 'Not wired' : 'Invalid value';
  switch (f.name) {
    case 'FEATURE_NIGHT_MODE': return f.value ? 'On' : 'Off';
    case 'THEME_ACCENT': return f.value[0].toUpperCase() + f.value.slice(1);
    case 'MAX_UPLOAD_MB': return `${f.value} MB`;
    case 'MAINTENANCE_BANNER': return f.value ? 'Posted' : 'No notice';
  }
}

function renderConsole(p, { first = false } = {}) {
  const night = flag(p, 'FEATURE_NIGHT_MODE');
  const accent = flag(p, 'THEME_ACCENT');
  const upload = flag(p, 'MAX_UPLOAD_MB');
  const notice = flag(p, 'MAINTENANCE_BANNER');

  document.body.dataset.night = night.value ? 'on' : 'off';
  document.body.dataset.accent = accent.value || 'none';

  for (const f of p.flags) {
    const bay = $(`.bay[data-flag="${f.name}"]`);
    bay.classList.toggle('is-bad', !f.ok);
    $('[data-value]', bay).textContent = formatFlag(f);
    const src = $('[data-source]', bay);
    src.dataset.source = f.source;
    src.textContent = SOURCE_TEXT[f.source];
    if (!f.ok && f.problem !== 'missing') src.title = f.problem;
  }

  $('.bay[data-flag="FEATURE_NIGHT_MODE"]').dataset.state = night.value ? 'on' : 'off';

  document.querySelectorAll('.dial__jewel').forEach((j) => j.classList.toggle('is-on', j.dataset.accent === accent.value));
  const knob = $('#knob');
  springTo('knob', accent.value ? ACCENT_ANGLE[accent.value] : 180, (a) => knob.setAttribute('transform', `rotate(${a} 140 110)`),
    { stiffness: 220, damping: 22, from: first ? 180 : undefined });

  const needle = $('#vuNeedle');
  springTo('needle', vuAngle(upload.value), (a) => needle.setAttribute('transform', `rotate(${a} 120 168)`),
    { stiffness: 70, damping: 6.5, from: first ? -56 : undefined });

  const lit = Boolean(notice.value);
  $('#annunciator').classList.toggle('is-lit', lit);
  $('#tape').textContent = lit ? notice.value : (notice.ok ? 'All clear' : 'Not wired');
  $('#tape').classList.toggle('is-clear', !lit && notice.ok);
  $('#notice').hidden = !lit;
  $('#noticeText').textContent = notice.value || '';

  $('#stationName').textContent = p.station.name;
  $('#introStation').textContent = p.station.name;
  $('#appName').textContent = p.station.app;
  document.title = `The Control Panel · ${p.station.name} · Clever Cloud demo`;
  $('#bootedAt').textContent = `since ${hms(new Date(Date.parse(p.bootedAt) - clockOffset))}`;
  $('#addonName').textContent = p.wiring.addon || 'not traced yet';
  $('#busAddon').textContent = p.wiring.addon || 'one source of truth';

  const stations = p.fleet.stations;
  const index = stations.indexOf(location.origin);
  $('#fleetCount').textContent = index >= 0 ? `console ${index + 1} of ${stations.length}` : stations.length ? 'not listed in FLEET_STATIONS' : '';

  renderRack(p);
  renderCommands(p);
  renderPlatform(p);
}

// ---------- Nixie: time on the current configuration ----------
function tick() {
  const elapsed = Math.max(0, Math.floor((Date.now() + clockOffset - Date.parse(panel.bootedAt)) / 1000));
  const h = Math.min(99, Math.floor(elapsed / 3600));
  const digits = `${two(h)}${two(Math.floor(elapsed / 60) % 60)}${two(elapsed % 60)}`;
  document.querySelectorAll('#nixie .tube').forEach((tube, i) => {
    tube.querySelectorAll('span').forEach((s) => s.classList.toggle('on', s.dataset.d === digits[i]));
  });
  $('#nixie').setAttribute('aria-label', `On the current configuration for ${h} h ${Math.floor(elapsed / 60) % 60} min`);
  for (const [origin, st] of fleet) {
    const age = document.querySelector(`.station[data-origin="${CSS.escape(origin)}"] .station__age`);
    if (!age || !st.data) continue;
    const s = Math.max(0, Math.floor((Date.now() + st.offset - Date.parse(st.data.bootedAt)) / 1000));
    age.textContent = `${two(Math.min(99, Math.floor(s / 3600)))}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`;
  }
}

// ---------- Patch bay: which source feeds each variable ----------
function rackRows(p) {
  const rows = p.flags.map((f) => ({ name: f.name, value: f.raw ?? null, source: f.source }));
  rows.push({ name: p.fleet.name, value: p.fleet.stations.map((o) => o.replace(/^https?:\/\//, '')).join(', ') || null, source: p.fleet.source });
  for (const o of p.own) rows.push({ name: o.name, value: o.value, source: o.source });
  return rows;
}

function renderRack(p) {
  const list = $('#rackRows');
  list.innerHTML = rackRows(p).map((r) => `
    <li class="rack__row" data-source="${r.source}">
      <span class="socket" data-col="provider"></span>
      <span class="socket" data-col="app"></span>
      <span></span>
      <span class="socket" data-col="jack"></span>
      <div class="rack__var">
        <span class="dymo dymo--sm">${esc(r.name)}</span>
        <span class="rack__val${r.value ? '' : ' is-empty'}">${r.value ? esc(r.value) : '(empty)'}</span>
        <span class="rack__src">${SOURCE_TEXT[r.source]}</span>
      </div>
    </li>`).join('');
  const more = p.wiring.traced ? p.wiring.otherAppVars : 0;
  $('#rackMore').textContent = more ? `Plus ${more} other variable${more > 1 ? 's' : ''} set on this app, not shown.` : '';
  $('#traceNote').innerHTML = p.wiring.traced
    ? `Traced from <code>clever env --format json</code> (provider variables arrive in <code>fromAddons</code>) on ${esc(new Date(p.wiring.tracedAt).toUTCString().replace(' GMT', ' UTC'))}. Names only; values are read live from the environment.`
    : 'Sources are not traced yet: run <code>node scripts/trace-wiring.mjs</code>, then restart.';
  drawCables();
}

function drawCables() {
  document.querySelectorAll('.rack__row').forEach((row) => {
    row.querySelectorAll('.cable').forEach((c) => c.remove());
    const box = row.getBoundingClientRect();
    const center = (col) => {
      const r = $(`.socket[data-col="${col}"]`, row).getBoundingClientRect();
      return [r.left - box.left + r.width / 2, r.top - box.top + r.height / 2];
    };
    const [jx, y] = center('jack');
    // A jack takes one plug: an overridden provider cord hangs loose next to it.
    const cord = (col, color, shadowed) => {
      const [x] = center(col);
      const [ex, ey] = shadowed ? [jx - 22, y + 20] : [jx, y];
      const sag = 14 + (ex - x) * 0.07;
      const svg = el('svg', { class: `cable${shadowed ? ' is-shadowed' : ''}`, width: jx + 14, height: box.height, 'aria-hidden': 'true' });
      const d = `M${x} ${y} C${x + (ex - x) * 0.3} ${y + sag}, ${ex - (ex - x) * 0.3} ${ey + sag * 0.6}, ${ex} ${ey}`;
      el('path', { d, class: 'cord', stroke: color }, svg);
      el('path', { d, class: 'sheen', transform: 'translate(0 -1.2)' }, svg);
      el('circle', { cx: x, cy: y, r: 7, fill: color, class: 'plug' }, svg);
      el('circle', { cx: ex, cy: ey, r: shadowed ? 4.5 : 7, fill: color, class: 'plug' }, svg);
      row.prepend(svg);
    };
    const s = row.dataset.source;
    const css = getComputedStyle(document.documentElement);
    const pColor = css.getPropertyValue('--cable-p').trim();
    const aColor = css.getPropertyValue('--cable-a').trim();
    if (s === 'provider') cord('provider', pColor);
    if (s === 'app') cord('app', aColor);
    if (s === 'override') { cord('app', aColor); cord('provider', pColor, true); } // prepend: the last drawn sits underneath
  });
}

// ---------- Commands to try ----------
function nextValue(p, name) {
  const f = flag(p, name);
  switch (name) {
    case 'FEATURE_NIGHT_MODE': return f.value ? 'false' : 'true';
    case 'THEME_ACCENT': {
      const keys = Object.keys(ACCENTS);
      return keys[(keys.indexOf(f.value) + 1) % keys.length];
    }
    case 'MAX_UPLOAD_MB': return String(UPLOAD_STEPS.find((n) => n > (f.value ?? 0)) ?? UPLOAD_STEPS[0]);
    case 'MAINTENANCE_BANNER': return f.value ? 'off' : '"Deploy freeze tonight from 22:00"';
  }
}

function renderCommands(p) {
  const addon = p.wiring.addon || '<provider>';
  $('#cmds').innerHTML = p.flags.map((f) => {
    const cmd = `clever config-provider set ${addon} ${f.name} ${nextValue(p, f.name)}`;
    return `<li class="cmd"><code>clever config-provider set ${esc(addon)} <b>${esc(f.name)}</b> ${esc(nextValue(p, f.name))}</code>
      <button class="cc-btn cc-btn--sm" type="button" data-copy="${esc(cmd)}">Copy</button></li>`;
  }).join('');
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  try {
    await navigator.clipboard.writeText(btn.dataset.copy);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = 'Copy'; }, 1600);
});

// ---------- Platform panel ----------
const PLATFORM_LABELS = {
  CC_APP_NAME: 'Application', APP_ID: 'App ID', INSTANCE_NUMBER: 'Instance', INSTANCE_TYPE: 'Instance type',
  CC_PRETTY_INSTANCE_NAME: 'Instance name', CC_COMMIT_ID: 'Commit', CC_DEPLOYMENT_ID: 'Deployment',
};
function renderPlatform(p) {
  $('#platformVars').innerHTML = Object.entries(PLATFORM_LABELS).map(([k, label]) => {
    const v = p.platform[k];
    return `<div><dt>${label}</dt><dd${v ? '' : ' class="is-empty"'}>${v ? esc(v) : 'set by Clever Cloud'}</dd></div>`;
  }).join('');
}

async function checkDeep() {
  const pill = $('#deepPill');
  try {
    const r = await fetch('/health/deep', { cache: 'no-store' });
    const body = await r.json();
    pill.classList.toggle('is-bad', !r.ok);
    pill.classList.toggle('cc-pill--ok', r.ok);
    $('#deepText').textContent = r.ok
      ? `Provider wired · ${body.provider.fromProvider.length || 4} flags`
      : `Provider check failed · ${body.provider.broken.map((b) => b.name).join(', ')}`;
  } catch {
    pill.classList.add('is-bad');
    $('#deepText').textContent = 'Console unreachable';
  }
}

// ---------- Teletype: what changed, as seen by this page ----------
function print(html, isNew = true) {
  const li = document.createElement('li');
  if (isNew) li.className = 'is-new';
  li.innerHTML = `<time>${hms(new Date())}</time>${html}`;
  const tape = $('#teletype');
  tape.appendChild(li);
  tape.scrollTop = tape.scrollHeight;
}

function valueText(f) { return f.ok ? (f.value === '' ? '(none)' : String(f.value)) : f.problem; }

function compare(prev, next) {
  const restarted = (prev.platform.CC_DEPLOYMENT_ID || prev.bootedAt) !== (next.platform.CC_DEPLOYMENT_ID || next.bootedAt);
  const changes = next.flags.flatMap((f) => {
    const before = flag(prev, f.name);
    return valueText(before) === valueText(f) ? [] : [{ name: f.name, from: valueText(before), to: valueText(f) }];
  });
  if (prev.station.name !== next.station.name) changes.push({ name: 'STATION_NAME', from: prev.station.name, to: next.station.name });
  return { restarted, changes };
}

async function pollSelf() {
  try {
    const r = await fetch('/api/panel', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(r.status);
    const next = await r.json();
    clockOffset = Date.parse(next.now) - Date.now();
    const { restarted, changes } = compare(panel, next);
    if (restarted) print(`Restarted. Configuration read again at ${esc(hms(new Date(Date.parse(next.bootedAt) - clockOffset)))}.`);
    for (const c of changes) print(`<b>${esc(c.name)}</b> ${esc(c.from)} → ${esc(c.to)}`);
    if (restarted && !changes.length) print('Same values as before.', true);
    panel = next;
    if (restarted || changes.length) renderConsole(panel);
  } catch {
    // A restart briefly answers 503: the next poll catches up.
  } finally {
    setTimeout(pollSelf, POLL_SELF_MS);
  }
}

// ---------- The fleet: every console listed in FLEET_STATIONS ----------
function stationCard(origin, st) {
  const self = origin === location.origin;
  if (!st.data) {
    return `<li class="station is-down" data-origin="${esc(origin)}">
      <div class="station__top"><strong class="station__name">${esc(origin.replace(/^https?:\/\//, ''))}</strong></div>
      <div class="station__foot"><span class="sync"><i class="lamp"></i>${st.down ? 'No signal' : 'Listening…'}</span></div></li>`;
  }
  const d = st.data;
  const f = (n) => flag(d, n);
  const mine = (n) => valueText(flag(panel, n));
  const differs = d.flags.filter((x) => valueText(x) !== mine(x.name)).map((x) => x.name);
  const syncText = self ? 'This console' : differs.length ? `Differs on ${differs.join(', ')}` : 'Same readings as this console';
  const accent = f('THEME_ACCENT').value;
  return `<li class="station${self ? ' is-self' : ''}" data-origin="${esc(origin)}">
    <div class="station__top"><strong class="station__name">${esc(d.station.name)}</strong>${self ? '<span class="dymo dymo--sm dymo--red">You are here</span>' : ''}</div>
    <code class="station__app">${esc(d.station.app)}</code>
    <div class="station__meters">
      <span class="mini"><i class="lamp${f('FEATURE_NIGHT_MODE').value ? ' is-on' : ''}" data-lamp="#ffb340"></i><small>Night</small></span>
      <span class="mini"><i class="lamp${accent ? ' is-on' : ''}" data-lamp="${accent ? ACCENTS[accent] : ''}"></i><small>${esc(accent || 'none')}</small></span>
      <span class="mini"><b>${esc(f('MAX_UPLOAD_MB').value ?? '–')}</b><small>MB max</small></span>
      <span class="mini"><i class="lamp${f('MAINTENANCE_BANNER').value ? ' is-on' : ''}" data-lamp="#ffb340"></i><small>Notice</small></span>
    </div>
    <div class="station__foot">
      <span class="sync"><i class="lamp is-on" data-lamp="${differs.length && !self ? '#ff4469' : '#3ae6cf'}"></i>${esc(syncText)}</span>
      <span class="station__age" title="Time on its current configuration"></span>
    </div></li>`;
}

function renderFleet() {
  const list = $('#stations');
  const origins = [...fleet.keys()];
  list.style.setProperty('--n', String(Math.max(1, origins.length)));
  list.innerHTML = origins.map((o) => stationCard(o, fleet.get(o))).join('');
  list.querySelectorAll('[data-lamp]').forEach((l) => { if (l.dataset.lamp) l.style.setProperty('--lamp', l.dataset.lamp); });
  tick();
}

async function pollFleet() {
  const origins = panel.fleet.stations.length ? panel.fleet.stations : [location.origin];
  for (const o of [...fleet.keys()]) if (!origins.includes(o)) fleet.delete(o);
  await Promise.all(origins.map(async (origin) => {
    const st = fleet.get(origin) || { data: null, offset: 0, down: false };
    fleet.set(origin, st);
    try {
      const r = await fetch(`${origin}/api/panel`, { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error(r.status);
      st.data = await r.json();
      st.offset = Date.parse(st.data.now) - Date.now();
      st.down = false;
    } catch {
      st.down = true;
    }
  }));
  renderFleet();
  setTimeout(pollFleet, POLL_FLEET_MS);
}

// ---------- Power on ----------
buildSelector();
buildVu();
buildNixie();
const consoleEl = $('#console');
if (!reduceMotion) {
  consoleEl.classList.add('is-warming');
  setTimeout(() => consoleEl.classList.remove('is-warming'), 1600);
}
renderConsole(panel, { first: true });
tick();
setInterval(tick, 1000);
print(`Watching ${esc(panel.station.name)}. Configuration read at boot, ${esc(hms(new Date(Date.parse(panel.bootedAt) - clockOffset)))}.`, false);
print('Change a value in the provider: the restart and the new values print here.', false);
checkDeep();
setInterval(checkDeep, 20000);
setTimeout(pollSelf, POLL_SELF_MS);
pollFleet();
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(drawCables, 120); });
document.fonts?.ready.then(drawCables);
