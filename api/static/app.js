/* Nexus Router · Dispatch Console v2
 * Vanilla JS, no build step. Leaflet 1.9.4 + leaflet-polylinedecorator 1.6.0 are loaded from unpkg.
 * Sections: config · utils · state · api · map · render · ui · controllers · boot
 */
'use strict';

// ===== config
const REGIONS = {
  colombo:    { label: 'Colombo, Sri Lanka', short: 'Colombo',    center: [6.9271, 79.8612] },
  beijing:    { label: 'Beijing, China',     short: 'Beijing',    center: [39.9042, 116.4074] },
  porto:      { label: 'Porto, Portugal',    short: 'Porto',      center: [41.1579, -8.6291] },
  california: { label: 'California, USA',    short: 'California', center: [37.7749, -122.4194] },
};
const FALLBACK_AVAILABLE = { colombo: true, beijing: false, porto: false, california: false };
// The map uses the original OpenStreetMap standard tile layer in every theme (no other tile provider,
// no tile-layer switcher, no tile filtering in dark mode; only the app chrome changes theme).
const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_TILE_OPTS = { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 };
const RIDER_ID = 99;
const GITHUB_URL = 'https://github.com/NaminduNadeeshan/route-optimizer-colombo';
const KEYS = { theme: 'nexus.theme', legend: 'nexus.legend', arrows: 'nexus.arrows', keys: 'nexus.keys', history: 'nexus.history.v1' };
const HISTORY_MAX = 20;
const UNDO_MAX = 30;
const HEALTH_POLL_MS = 60000;
const HEALTH_STALE_MS = 30000;
const SERVICES = [
  ['db', 'Database (PostGIS)'],
  ['osrm_colombo', 'OSRM · Colombo'],
  ['vroom_colombo', 'VROOM · Colombo'],
  ['osrm_beijing', 'OSRM · Beijing'],
  ['vroom_beijing', 'VROOM · Beijing'],
  ['ml_bridge', 'Traffic model service (ML bridge)'],
];
const IS_MAC = /Mac|iPhone|iPad/i.test((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '');
const MOD = IS_MAC ? '⌘' : 'Ctrl';
const OPT_KBD = `${MOD} ↵`;
const MINUS = '−';

// ===== utils
const byId = (id) => document.getElementById(id);
const pad2 = (n) => String(n).padStart(2, '0');
const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
/** Pin count in the Plan panel's words: the first pin is the depot, the rest are stops. */
const pinsText = (n) => (n <= 0 ? 'no pins' : n === 1 ? '1 depot' : `1 depot · ${plural(n - 1, 'stop')}`);
const round6 = (x) => Math.round(x * 1e6) / 1e6;

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** DOM builder: string children become text nodes; attrs set properties or attributes, never innerHTML. */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'innerHTML' || k === 'outerHTML' || /^on/i.test(k)) throw new Error(`h(): refusing "${k}"`);
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (!k.includes('-') && k in el && typeof el[k] !== 'function' && typeof el[k] !== 'object') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  appendKids(el, children);
  return el;
}
function appendKids(el, kids) {
  for (const c of kids) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendKids(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
/** replaceChildren() that skips null/false and flattens arrays (native replaceChildren would print "null"). */
function fill(el, ...kids) { el.replaceChildren(); appendKids(el, kids); return el; }
function icon(name, cls) { return h('span', { class: 'icon' + (cls ? ' ' + cls : ''), 'aria-hidden': 'true' }, name); }
function setText(id, text) { const el = byId(id); if (el && el.textContent !== text) el.textContent = text; }

const store = {
  get(k, fallback = null) { try { const v = localStorage.getItem(k); return v === null ? fallback : v; } catch (e) { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } },
  remove(k) { try { localStorage.removeItem(k); return true; } catch (e) { return false; } },
};

function cssColor(name) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name.startsWith('--') ? name : `--${name}`).trim();
  const parts = v.split(/[\s,/]+/).filter(Boolean).slice(0, 3);
  return parts.length === 3 ? `rgb(${parts.join(',')})` : 'rgb(37,99,235)';
}
function fmtKm(m) { m = Math.abs(m || 0); return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`; }
function fmtKmSpoken(m) { m = Math.abs(m || 0); return m < 1000 ? `${Math.round(m)} metres` : `${(m / 1000).toFixed(1)} kilometres`; }
function fmtDur(s) {
  const mins = Math.round(Math.abs(s || 0) / 60);
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${pad2(mins % 60)}m`;
}
function fmtDurSpoken(s) {
  const mins = Math.round(Math.abs(s || 0) / 60); const hh = Math.floor(mins / 60), mm = mins % 60;
  if (!hh) return plural(mm, 'minute');
  return mm ? `${plural(hh, 'hour')} ${plural(mm, 'minute')}` : plural(hh, 'hour');
}
function toMin(t) { const m = /^(\d{1,2}):(\d{2})/.exec(t || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : NaN; }
function windowSeconds(start, end) { return (((toMin(end) - toMin(start) + 1440) % 1440) || 1440) * 60; }
function clockFromMin(total) {
  const day = Math.floor(total / 1440); const m = ((total % 1440) + 1440) % 1440;
  const clock = `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
  return { clock, dayOffset: day, text: day > 0 ? `${clock} +${day}d` : clock };
}
/** ETA for a VROOM arrival (seconds after the shift start), rounded to the nearest minute like the leg drive minutes. */
function etaFor(ctx, arrivalS) { return clockFromMin(toMin(ctx.start) + Math.round((arrivalS || 0) / 60)); }
function etaDateTime(ctx, arrivalS) {
  const e = etaFor(ctx, arrivalS); const [y, mo, d] = ctx.date.split('-').map(Number);
  const dt = new Date(y, mo - 1, d + e.dayOffset);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())} ${e.clock}`;
}
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function nowHHMM() { const d = new Date(); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function hhmm(d) { return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function hhmmss(d) { return `${hhmm(d)}:${pad2(d.getSeconds())}`; }
function fmtDayShort(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return String(dateStr);
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function fmtWhen(date) { return `${date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} · ${hhmm(date)}`; }
function whenShort(date) {
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay ? hhmm(date) : `${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${hhmm(date)}`;
}
function prefersReducedMotion() { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
/** Quote every CSV field; prefix text that starts with = + - @ (tab/CR too) to block formula injection. */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  return null;
}
function haversineKm(a, b) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
}
function clone(x) { try { return structuredClone(x); } catch (e) { return JSON.parse(JSON.stringify(x)); } }
function parseLatLon(str) {
  const num = '([+-]?(?:\\d+\\.?\\d*|\\.\\d+))';
  const m = new RegExp(`^\\s*${num}\\s*(?:,|\\s)\\s*${num}\\s*$`).exec(str || '');
  if (!m) return null;
  const lat = Number(m[1]), lon = Number(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

// Standard Google Polyline Decoder algorithm
function decodePolyline(str, precision = 5) {
    let index = 0, lat = 0, lng = 0, coordinates = [];
    let shift = 0, result = 0, byte = null, latitude_change, longitude_change, factor = Math.pow(10, precision);

    while (index < str.length) {
        byte = null; shift = 0; result = 0;
        do {
            byte = str.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);
        latitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));
        shift = result = 0;
        do {
            byte = str.charCodeAt(index++) - 63;
            result |= (byte & 0x1f) << shift;
            shift += 5;
        } while (byte >= 0x20);
        longitude_change = ((result & 1) ? ~(result >> 1) : (result >> 1));

        lat += latitude_change;
        lng += longitude_change;
        coordinates.push([lat / factor, lng / factor]);
    }
    return coordinates;
}

/** Original forward-search splitter, kept verbatim; returns exactly one latlng array per leg. */
function splitLegs(geometry, steps) {
    const sequence = steps;
    const latlngs = sequence.map(step => [step.location[1], step.location[0]]);
    let segments = [];

    if (geometry) {
        const decodedPath = decodePolyline(geometry);

        // Find the index of the closest point in the path for each step
        let stepIndices = [];
        sequence.forEach(step => {
            if (!step.location) return;
            const targetLat = step.location[1];
            const targetLon = step.location[0];

            let minDist = Infinity;
            let closestIdx = 0;
            // Only search forward from the last found index to keep it sequential
            const startSearchIdx = stepIndices.length > 0 ? stepIndices[stepIndices.length - 1] : 0;

            for (let i = startSearchIdx; i < decodedPath.length; i++) {
                const p = decodedPath[i];
                const dist = Math.pow(p[0] - targetLat, 2) + Math.pow(p[1] - targetLon, 2);
                if (dist < minDist) {
                    minDist = dist;
                    closestIdx = i;
                }
            }
            stepIndices.push(closestIdx);
        });

        // Slice the path into segments based on those indices
        for (let i = 1; i < stepIndices.length; i++) {
            const startIdx = stepIndices[i-1];
            // Include the end point in this segment so lines connect seamlessly
            const endIdx = stepIndices[i] + 1;
            segments.push(decodedPath.slice(startIdx, endIdx));
        }
    } else {
        // Fallback straight line segments
        for (let i = 1; i < latlngs.length; i++) {
            segments.push([latlngs[i-1], latlngs[i]]);
        }
    }
    // Keep leg indices aligned with steps: a degenerate slice (two stops on one vertex) becomes a straight line.
    return segments.map((seg, i) => (seg.length >= 2 ? seg : [latlngs[i], latlngs[i + 1]]));
}

// ===== state
const state = {
  region: 'colombo', stops: [], nextId: 0, addMode: true, selection: null,
  result: null, busy: null, error: null,
  health: null, healthState: 'pending', healthCheckedAt: null, healthChecking: false,
  undo: [], arrows: true, singleKeys: true,
  panels: { plan: true, results: true }, drawers: { plan: false, results: false }, sheet: null,
  renaming: null, renameDraft: null, kpiExpanded: false, legendOpen: true, progress: null,
};
let undoSeq = 0;
let historyCache = { ok: true, items: [] };
const MQ = {
  desktop: window.matchMedia('(min-width: 1280px)'),
  mobile: window.matchMedia('(max-width: 767.98px)'),
  wide: window.matchMedia('(min-width: 1024px)'),
  coarse: window.matchMedia('(pointer: coarse)'),
  dark: window.matchMedia('(prefers-color-scheme: dark)'),
};
function layoutMode() { return MQ.desktop.matches ? 'desktop' : MQ.mobile.matches ? 'mobile' : 'tablet'; }
function isDark() { return document.documentElement.classList.contains('dark'); }

function getSchedule() { return { date: byId('planning-date').value, start: byId('start-time').value, end: byId('end-time').value }; }
function signatureOf(ctx, stops) {
  return JSON.stringify({ r: ctx.region, d: ctx.date, s: ctx.start, e: ctx.end, p: stops.map((s) => [s.id, s.lat.toFixed(6), s.lon.toFixed(6)]) });
}
function signature() { return signatureOf({ region: state.region, ...getSchedule() }, state.stops); }
function isStale() { return !!state.result && signature() !== state.result.sig; }
function canOptimizeRegion(r) {
  if (r === 'colombo') return true;
  const live = state.health && state.health.regions && state.health.regions[r];
  return live && typeof live.available === 'boolean' ? live.available : !!FALLBACK_AVAILABLE[r];
}
function regionShort(r) { return (REGIONS[r] || {}).short || r; }
function optimizeBlockReason() {
  if (state.busy) return 'Optimizing…';
  // Region first: adding stops can't fix a map-only region.
  if (!canOptimizeRegion(state.region)) return `No routing data for ${regionShort(state.region)} in this deployment`;
  if (state.stops.length < 2) return 'Add a depot and at least one stop';
  return null;
}
function comparability(resp, drops) {
  const un = resp.unassigned_jobs || 0;
  if (un > 0) return { ok: false, note: `Savings hidden — ${plural(un, 'stop')} not scheduled` };
  if (drops < 2) return { ok: false, note: 'Single stop — no reordering possible' };
  if (!(resp.unoptimized_distance_meters > 0)) return { ok: false, note: 'Baseline unavailable' };
  return { ok: true, note: '' };
}
function displayName(stop, idx) { return stop.name != null && stop.name !== '' ? stop.name : (idx === 0 ? 'Depot' : `Stop ${stop.id}`); }
function stopIndex(id) { return state.stops.findIndex((s) => s.id === id); }
function nameOfId(id) { const i = stopIndex(id); return i < 0 ? null : displayName(state.stops[i], i); }

const modelCache = new WeakMap();
/** Derived, memoised view of a result: steps, exact job→stop mapping, legs. */
function routeModel(result) {
  if (modelCache.has(result)) return modelCache.get(result);
  const resp = result.response || {};
  const steps = (resp.route_sequence || []).filter((s) => Array.isArray(s.location));
  const depotId = result.stopsAtRun[0] ? result.stopsAtRun[0].id : null;
  const byStop = new Map(); const stepStop = []; let n = 0;
  steps.forEach((s, i) => {
    if (s.type === 'job') {
      n += 1;
      const sid = result.jobToStop[s.job];
      if (sid != null) byStop.set(sid, { seq: n, stepIndex: i });
      stepStop.push({ stopId: sid != null ? sid : null, seq: n });
    } else stepStop.push({ stopId: depotId, seq: null });
  });
  const unassigned = (resp.unassigned_details || []).map((u) => ({
    orderId: u.id, stopId: result.jobToStop[u.id] != null ? result.jobToStop[u.id] : null,
    location: Array.isArray(u.location) ? u.location : null,
  }));
  const model = {
    steps, stepStop, byStop, unassigned, depotId, jobsTotal: n,
    unassignedSet: new Set(unassigned.map((u) => u.stopId).filter((x) => x != null)),
    orderByStop: new Map(Object.entries(result.jobToStop).map(([oid, sid]) => [sid, Number(oid)])),
    stopsAtRunById: new Map(result.stopsAtRun.map((s, i) => [s.id, { stop: s, idx: i }])),
    dropsAtRun: Math.max(0, result.stopsAtRun.length - 1),
    legs: steps.length > 1 ? splitLegs(resp.geometry, steps) : [],
  };
  modelCache.set(result, model);
  return model;
}
function viewModel() {
  const stale = isStale();
  return {
    stale, fresh: !!state.result && !stale, model: state.result ? routeModel(state.result) : null,
    mode: layoutMode(), drops: Math.max(0, state.stops.length - 1),
  };
}
function stopChip(stop, idx, v) {
  if (idx === 0) return { text: 'Depot', tone: 'neutral' };
  if (!state.result) return null;
  const m = v.model;
  if (v.fresh) {
    const r = m.byStop.get(stop.id);
    if (r) return { text: `Seq ${r.seq} · ${etaFor(state.result.ctx, m.steps[r.stepIndex].arrival).text}`, tone: 'accent' };
    if (m.unassignedSet.has(stop.id)) return { text: 'Not scheduled', tone: 'danger' };
    return null;
  }
  const prev = m.stopsAtRunById.get(stop.id);
  if (!prev) return { text: 'New', tone: 'warning' };
  if (prev.stop.lat.toFixed(6) !== stop.lat.toFixed(6) || prev.stop.lon.toFixed(6) !== stop.lon.toFixed(6)) return { text: 'Moved', tone: 'warning' };
  return null;
}
function staleParts() {
  const r = state.result; const parts = [];
  const before = new Map(r.stopsAtRun.map((s) => [s.id, s]));
  const nowIds = new Set(state.stops.map((s) => s.id));
  let added = 0, moved = 0;
  for (const s of state.stops) {
    const p = before.get(s.id);
    if (!p) added += 1;
    else if (p.lat.toFixed(6) !== s.lat.toFixed(6) || p.lon.toFixed(6) !== s.lon.toFixed(6)) moved += 1;
  }
  const removed = r.stopsAtRun.filter((s) => !nowIds.has(s.id)).length;
  if (added) parts.push(`${added} added`);
  if (moved) parts.push(`${moved} moved`);
  if (removed) parts.push(`${removed} removed`);
  if (state.stops[0] && r.stopsAtRun[0] && state.stops[0].id !== r.stopsAtRun[0].id && before.has(state.stops[0].id)) parts.push('depot changed');
  const sc = getSchedule();
  if (sc.date !== r.ctx.date || sc.start !== r.ctx.start || sc.end !== r.ctx.end) parts.push('schedule changed');
  return parts;
}

/** Every mutation goes through update(): optional undo snapshot → fn(state) → render(). */
function update(fn, opts = {}) {
  const token = opts.undoLabel ? pushUndo(opts.undoLabel) : null;
  fn(state);
  render();
  return token;
}
function pushUndo(label, opts = {}) {
  const token = ++undoSeq;
  // Actions that overwrite the schedule inputs (Restore run) also snapshot them so Undo puts them back.
  state.undo.push({ token, label, stops: clone(state.stops), nextId: state.nextId, region: state.region, result: state.result,
    schedule: opts.schedule ? getSchedule() : null });
  if (state.undo.length > UNDO_MAX) state.undo.shift();
  return token;
}
function undoTo(token) {
  if (state.busy) { toast({ tone: 'info', title: 'Wait for the current run to finish' }); return; }
  const i = state.undo.findIndex((u) => u.token === token);
  if (i < 0) { toast({ tone: 'info', title: 'Nothing to undo' }); return; }
  const snap = state.undo[i];
  state.undo.length = i;
  const regionChanged = snap.region !== state.region;
  state.stops = snap.stops; state.nextId = snap.nextId; state.region = snap.region; state.result = snap.result;
  state.selection = null; state.renaming = null;
  byId('city-selector').value = snap.region;
  if (snap.schedule) {
    const today = todayStr();
    byId('planning-date').value = snap.schedule.date && snap.schedule.date >= today ? snap.schedule.date : today;
    byId('start-time').value = snap.schedule.start; byId('end-time').value = snap.schedule.end;
    startIsAuto = false;
  }
  if (map) map.closePopup();
  render();
  if (regionChanged) { if (state.stops.length) fitAll(); else flyToRegion(snap.region); }
  announce(`Undone: ${snap.label}`);
}
function undoLatest() {
  const last = state.undo[state.undo.length - 1];
  if (!last) { toast({ tone: 'info', title: 'Nothing to undo' }); return; }
  undoTo(last.token);
}

// ===== api
class ApiError extends Error {
  constructor(status, message, detail) { super(message); this.name = 'ApiError'; this.status = status; this.detail = detail || ''; }
}
function detailOf(data, text) {
  const d = data && data.detail;
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d.map((x) => (x && x.msg ? x.msg : JSON.stringify(x))).join('; ');
  return (text || '').slice(0, 300) || 'No details returned';
}
async function postJSON(url, body, signal) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (e) {
    if (e && e.name === 'AbortError') throw e;
    throw new ApiError('network', "Can't reach the routing API. Check that the route_api container is running.", String((e && e.message) || e));
  }
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (!res.ok) { const d = detailOf(data, text); throw new ApiError(res.status, d, d); }
  if (data === null) throw new ApiError(res.status, 'The server returned an unexpected response.', text.slice(0, 300));
  return data;
}
const createOrders = (locations, signal) => postJSON('/api/v1/create-orders', { locations }, signal);
const optimizeRoute = (payload, signal) => postJSON('/api/v1/optimize-route', payload, signal);

let healthInflight = null;
function getHealth() {
  if (healthInflight) return healthInflight;
  state.healthChecking = true;
  renderStatus();
  const prevLabel = statusSummary().label;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  healthInflight = fetch('/api/v1/health', { cache: 'no-store', signal: ctrl.signal })
    .then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || typeof data.services !== 'object') throw new Error('Malformed health response');
      state.health = data; state.healthState = 'ok';
    })
    .catch(() => { state.health = null; state.healthState = 'unavailable'; })
    .finally(() => {
      clearTimeout(timer);
      state.healthCheckedAt = new Date(); state.healthChecking = false; healthInflight = null;
      const label = statusSummary().label;
      if (prevLabel !== 'Checking…' && label !== prevLabel) announce(`Service status: ${label}`);
      render();
    });
  return healthInflight;
}

// ===== map
let map = null, tileLayer = null, routeLayer = null;
let routeKey = null, legLayers = [], routeColors = null, appliedRouteSel = null, lastScrollKey = '';
let openPopupRef = null, popupAtPreclick = false, popupToken = 0, lastTileError = 0, popoverDismissedAt = 0;
const markers = new Map(); // stopId -> { marker, iconKey, selected }
const POPUP_OPTS = { minWidth: 208, maxWidth: 208, autoPanPaddingTopLeft: [24, 72], autoPanPaddingBottomRight: [24, 24], className: 'nr-popup' };

function initMap() {
  map = L.map('map', { zoomControl: false, maxZoom: 19 }).setView([6.9271, 79.8612], 13);
  tileLayer = L.tileLayer(OSM_TILE_URL, OSM_TILE_OPTS).addTo(map);
  tileLayer.on('tileerror', () => {
    const now = Date.now();
    if (now - lastTileError < 60000) return;
    lastTileError = now;
    toast({ tone: 'warning', title: "Map tiles aren't loading — check your connection." });
  });
  // Leaflet focuses the map on mousedown, which Chrome treats as :focus-visible.
  // Only draw the map focus ring once the keyboard is in use.
  const mapWrap = byId('map-wrap');
  mapWrap.addEventListener('pointerdown', () => { mapWrap.dataset.pointer = '1'; });
  document.addEventListener('keydown', () => { delete mapWrap.dataset.pointer; }, true);
  L.control.zoom({ position: 'topleft' }).addTo(map);
  new (makeToolsControl())().addTo(map);
  L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
  routeLayer = L.layerGroup().addTo(map);
  map.on('preclick', () => { popupAtPreclick = !!openPopupRef; });
  map.on('click', onMapClick);
  map.on('popupopen', (e) => { openPopupRef = e.popup; renderOverlays(viewModel()); });
  map.on('popupclose', (e) => { if (openPopupRef === e.popup) { openPopupRef = null; renderOverlays(viewModel()); } });
  if ('ResizeObserver' in window) new ResizeObserver(() => map.invalidateSize({ debounceMoveend: true })).observe(byId('map'));
  byId('ctl-add-mode').addEventListener('click', () => setAddMode(!state.addMode));
  byId('ctl-fit').addEventListener('click', (e) => { if (isDisabled(e.currentTarget)) return; fitAll(); });
  byId('ctl-layers').addEventListener('click', (e) => {
    const pop = byId('layers-popover');
    if (openPop && openPop.panel === pop) closePopover();
    else openPopover(e.currentTarget, pop, { position: positionLayers, focus: () => byId('opt-arrows') });
  });
}

function makeToolsControl() { return L.Control.extend({
  options: { position: 'topleft' },
  onAdd() {
    const c = L.DomUtil.create('div', 'leaflet-bar nr-tools');
    const mk = (id, iconName, label, kbd) => {
      const b = h('button', { type: 'button', id, class: 'nr-ctl', 'aria-label': label, 'data-tip': '', 'data-kbd': kbd }, icon(iconName));
      c.append(b); return b;
    };
    mk('ctl-add-mode', 'add_location_alt', 'Add stops', 'A').setAttribute('aria-pressed', 'true');
    mk('ctl-fit', 'fit_screen', 'Fit to route', 'F');
    const layers = mk('ctl-layers', 'layers', 'Map layers');
    layers.setAttribute('aria-haspopup', 'dialog'); layers.setAttribute('aria-expanded', 'false'); layers.setAttribute('aria-controls', 'layers-popover');
    L.DomEvent.disableClickPropagation(c);
    L.DomEvent.disableScrollPropagation(c);
    return c;
  },
}); }

function markerSpec(stop, idx, v) {
  if (idx === 0) return { kind: 'depot', label: '' };
  if (v.fresh) {
    const r = v.model.byStop.get(stop.id);
    if (r) return { kind: 'routed', label: String(r.seq) };
    if (v.model.unassignedSet.has(stop.id)) return { kind: 'unassigned', label: '!' };
  }
  return { kind: 'draft', label: String(stop.id) };
}
function makeIcon(spec) {
  const inner = spec.kind === 'depot'
    ? '<span class="icon" aria-hidden="true">warehouse</span>'
    : esc(spec.label);
  return L.divIcon({ className: 'nr-marker', iconSize: [28, 28], iconAnchor: [14, 14], popupAnchor: [0, -14],
    html: `<div class="nr-pin nr-pin--${esc(spec.kind)}">${inner}</div>` });
}
function markerAria(stop, idx, spec, v) {
  const name = displayName(stop, idx);
  if (spec.kind === 'depot') return `${name}, depot`;
  if (spec.kind === 'routed') return `${name}, stop ${spec.label} of ${v.model.jobsTotal}`;
  if (spec.kind === 'unassigned') return `${name}, not scheduled`;
  return name;
}
function syncMarkers(v) {
  const seen = new Set();
  state.stops.forEach((s, idx) => {
    seen.add(s.id);
    const spec = markerSpec(s, idx, v);
    const key = `${spec.kind}:${spec.label}`;
    let e = markers.get(s.id);
    if (!e) {
      const id = s.id;
      const mk = L.marker([s.lat, s.lon], { icon: makeIcon(spec), keyboard: true, draggable: !state.busy, riseOnHover: true });
      mk.bindPopup(() => buildPopup(id), POPUP_OPTS);
      mk.on('click', () => selectStop(id, 'marker'));
      mk.on('dragend', () => onMarkerDragEnd(id, mk));
      mk.addTo(map);
      e = { marker: mk, iconKey: key, selected: false };
      markers.set(id, e);
    } else {
      const ll = e.marker.getLatLng();
      if (ll.lat !== s.lat || ll.lng !== s.lon) e.marker.setLatLng([s.lat, s.lon]);
      if (e.iconKey !== key) { e.marker.setIcon(makeIcon(spec)); e.iconKey = key; e.selected = null; }
    }
    if (e.marker.dragging) { if (state.busy) e.marker.dragging.disable(); else e.marker.dragging.enable(); }
    const el = e.marker.getElement();
    if (el) el.setAttribute('aria-label', markerAria(s, idx, spec, v));
  });
  for (const [id, e] of markers) if (!seen.has(id)) { e.marker.remove(); markers.delete(id); }
}

function drawRoute(v) {
  const r = state.result;
  const key = r ? `${+r.optimizedAt}|${v.stale}|${isDark()}|${state.arrows}` : 'none';
  if (key === routeKey) return;
  routeKey = key; appliedRouteSel = null;
  routeLayer.clearLayers(); legLayers = [];
  if (!r) return;
  routeColors = { route: cssColor('--route'), casing: cssColor('--route-casing'), dim: cssColor('--route-dim'), sel: cssColor('--route-selected') };
  const legs = v.model.legs;
  if (v.stale) {
    // Dark dashes on a thin light casing so the out-of-date route stays distinct from OSM's own grey dashed lines.
    legs.forEach((ll) => L.polyline(ll, { color: routeColors.casing, weight: 7, opacity: 0.85, interactive: false, lineJoin: 'round', lineCap: 'round' }).addTo(routeLayer));
    legs.forEach((ll) => L.polyline(ll, { color: routeColors.dim, weight: 4, opacity: 1, dashArray: '6 8', interactive: false }).addTo(routeLayer));
    legLayers = legs.map(() => null);
    return;
  }
  const casings = legs.map((ll) => L.polyline(ll, { color: routeColors.casing, weight: 9, opacity: 0.9, interactive: false, lineJoin: 'round', lineCap: 'round' }).addTo(routeLayer));
  legs.forEach((ll, i) => {
    const line = L.polyline(ll, { color: routeColors.route, weight: 5, opacity: 1, lineJoin: 'round', lineCap: 'round', bubblingMouseEvents: false }).addTo(routeLayer);
    line.on('click', () => selectLeg(i));
    let deco = null;
    if (state.arrows && typeof L.polylineDecorator === 'function' && L.Symbol) {
      deco = L.polylineDecorator(line, { patterns: [{ offset: 30, repeat: 120, symbol: L.Symbol.arrowHead({ pixelSize: 9, polygon: true,
        pathOptions: { stroke: false, fillOpacity: 1, color: routeColors.casing, interactive: false } }) }] });
    }
    legLayers.push({ casing: casings[i], line, deco });
  });
}
function styleLegs(selLeg) {
  const c = routeColors; const busy = !!state.busy;
  legLayers.forEach((lg, i) => {
    if (!lg) return;
    const isSel = selLeg === i, dim = selLeg != null && !isSel;
    lg.line.setStyle({ color: isSel ? c.sel : c.route, weight: isSel ? 7 : 5, opacity: busy ? 0.4 : dim ? 0.35 : 1 });
    lg.casing.setStyle({ weight: isSel ? 11 : 9, opacity: busy ? 0.4 : dim ? 0.35 : 0.9 });
    if (lg.deco) {
      const show = !busy && !dim; const has = routeLayer.hasLayer(lg.deco);
      if (show && !has) routeLayer.addLayer(lg.deco);
      if (!show && has) routeLayer.removeLayer(lg.deco);
    }
  });
  const lg = selLeg != null ? legLayers[selLeg] : null;
  if (lg) {
    lg.casing.bringToFront(); lg.line.bringToFront();
    if (lg.deco && routeLayer.hasLayer(lg.deco)) { routeLayer.removeLayer(lg.deco); routeLayer.addLayer(lg.deco); }
  }
}
function applySelection(v) {
  const sel = state.selection;
  for (const [id, e] of markers) {
    const on = !!sel && sel.stopId === id;
    if (e.selected === on) continue;
    e.selected = on;
    const pin = e.marker.getElement() && e.marker.getElement().querySelector('.nr-pin');
    if (pin) pin.classList.toggle('is-selected', on);
    e.marker.setZIndexOffset(on ? 1000 : 0);
  }
  const selLeg = v.fresh && sel && sel.stepIndex > 0 ? sel.stepIndex - 1 : null;
  const key = `${routeKey}|${selLeg}|${!!state.busy}`;
  if (key !== appliedRouteSel) { appliedRouteSel = key; styleLegs(selLeg); }
  const sk = sel ? `${sel.stopId}|${sel.stepIndex}` : '';
  if (sk !== lastScrollKey) {
    lastScrollKey = sk;
    if (sel) document.querySelectorAll('#stops-list .stop-row.is-selected, #route-steps [aria-current="true"], #unassigned-list [aria-current="true"]')
      .forEach((el) => el.scrollIntoView({ block: 'nearest' }));
  }
}

function fitPadding(base) {
  const mode = layoutMode(); let tl = [base, base], br = [base, base];
  if (mode === 'tablet') {
    const w = Math.min(360, window.innerWidth * 0.9) + 20;
    if (state.drawers.plan) tl = [w, base];
    if (state.drawers.results) br = [380, 48];
  } else if (mode === 'mobile' && state.sheet) {
    const panel = byId(state.sheet === 'plan' ? 'plan-panel' : 'results-panel');
    br = [base, panel.offsetHeight + 16];
  }
  return { paddingTopLeft: tl, paddingBottomRight: br };
}
function fitAll(opts = {}) {
  const pts = state.stops.map((s) => [s.lat, s.lon]);
  if (!pts.length && !state.result) return;
  const b = L.latLngBounds(pts);
  if (state.result) routeModel(state.result).legs.forEach((ll) => { if (ll.length) b.extend(L.latLngBounds(ll)); });
  if (!b.isValid()) return;
  map.fitBounds(b, { ...fitPadding(opts.padding || 48), maxZoom: 16, animate: !prefersReducedMotion() });
}
function focusBounds(bounds) {
  const opts = { ...fitPadding(60), maxZoom: 17 };
  if (prefersReducedMotion()) map.fitBounds(bounds, { ...opts, animate: false });
  else map.flyToBounds(bounds, { ...opts, duration: 0.4 });
}
/** Centre a point in the part of the map not covered by an open drawer or bottom sheet. */
function focusPoint(ll, zoom) {
  const b = L.latLngBounds([ll, ll]); const opts = { ...fitPadding(48), maxZoom: zoom };
  if (prefersReducedMotion()) map.fitBounds(b, { ...opts, animate: false });
  else map.flyToBounds(b, { ...opts, duration: 0.8 });
}
function panTo(ll, zoom) { if (prefersReducedMotion()) map.setView(ll, zoom, { animate: false }); else map.setView(ll, zoom); }
function flyToRegion(r) {
  const c = REGIONS[r].center;
  if (prefersReducedMotion()) map.setView(c, 13, { animate: false }); else map.flyTo(c, 13, { duration: 0.8 });
}
function openPopupAfterMove(stopId) {
  const t = ++popupToken; let done = false;
  const go = () => {
    if (done || t !== popupToken) return; done = true;
    const e = markers.get(stopId); if (e) e.marker.openPopup();
  };
  map.once('moveend', go);
  setTimeout(go, 900);
}

function buildPopup(id) {
  const idx = stopIndex(id); const s = state.stops[idx];
  if (!s) return h('div', null, 'Removed stop');
  const v = viewModel(); const name = displayName(s, idx);
  let line = idx === 0 ? 'Depot · Not optimized yet' : 'Not optimized yet'; let danger = false;
  if (v.fresh) {
    const m = v.model, ctx = state.result.ctx;
    if (idx === 0) {
      const first = m.steps[0], last = m.steps[m.steps.length - 1];
      line = `Depot · Depart ${etaFor(ctx, first ? first.arrival : 0).text} · Return ${last ? etaFor(ctx, last.arrival).text : '—'}`;
    } else if (m.byStop.has(id)) {
      const r = m.byStop.get(id); const st = m.steps[r.stepIndex];
      line = `Stop ${r.seq} of ${m.jobsTotal} · ETA ${etaFor(ctx, st.arrival).text} · ${Math.round((st.service || 0) / 60)} min service`;
    } else if (m.unassignedSet.has(id)) {
      line = "Not scheduled — didn't fit the shift window or vehicle capacity"; danger = true;
    }
  }
  const order = state.result ? routeModel(state.result).orderByStop.get(id) : null;
  const node = h('div', { class: 'nr-pop' },
    h('div', { class: 'pop-name' }, name),
    h('div', { class: 'pop-line' + (danger ? ' is-danger' : '') }, line),
    h('div', { class: 'mono' }, `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`),
    order != null ? h('div', { class: 'pop-line' }, `Order #${order}`) : null);
  if (!state.busy) {
    const mkBtn = (label, cls, fn) => { const b = h('button', { type: 'button', class: `btn ${cls}` }, label); b.addEventListener('click', fn); return b; };
    node.append(h('div', { class: 'pop-actions' },
      mkBtn('Rename', 'btn-ghost', () => { map.closePopup(); startRename(id, true); }),
      idx > 0 ? mkBtn('Set as depot', 'btn-ghost', () => setDepot(id)) : null,
      mkBtn('Delete', 'btn-danger-ghost', () => deleteStop(id))));
  }
  return node;
}

// ===== render
function render() {
  if (!map) return;
  const v = viewModel();
  renderTopbar(v);
  renderStatus();
  renderSchedule(v);
  renderStops(v);
  renderKpis(v);
  renderResults(v);
  renderOverlays(v);
  syncMarkers(v);
  drawRoute(v);
  applySelection(v);
  renderTitle(v);
}

let regionKey = '';
function renderRegionSelect() {
  const avail = Object.keys(REGIONS).map((r) => [r, canOptimizeRegion(r)]);
  const key = JSON.stringify(avail);
  const sel = byId('city-selector');
  if (key !== regionKey) {
    regionKey = key;
    const groups = [['Routing available', avail.filter(([, ok]) => ok)], ['Map only — no routing data in this deployment', avail.filter(([, ok]) => !ok)]];
    sel.replaceChildren(...groups.filter(([, list]) => list.length).map(([label, list]) =>
      h('optgroup', { label }, list.map(([r]) => h('option', { value: r }, REGIONS[r].label)))));
  }
  if (sel.value !== state.region) sel.value = state.region;
  sel.setAttribute('aria-disabled', state.busy ? 'true' : 'false');
}
function regionStatus() {
  const r = state.region;
  const colombo = state.health && state.health.regions && state.health.regions.colombo;
  if (r === 'colombo' && colombo && colombo.available === false) return { tone: 'warning', label: 'Services down — see status' };
  if (state.healthState === 'unavailable' && r !== 'colombo') return { tone: 'neutral', label: 'Status unknown' };
  return canOptimizeRegion(r) ? { tone: 'success', label: 'Routing available' } : { tone: 'warning', label: 'Map only' };
}
function renderTopbar(v) {
  const b = document.body; const mode = v.mode;
  b.classList.toggle('plan-collapsed', mode === 'desktop' && !state.panels.plan);
  b.classList.toggle('results-collapsed', mode === 'desktop' && !state.panels.results);
  b.classList.toggle('plan-open', mode === 'tablet' && state.drawers.plan);
  b.classList.toggle('results-open', mode === 'tablet' && state.drawers.results);
  b.classList.toggle('sheet-plan', mode === 'mobile' && state.sheet === 'plan');
  b.classList.toggle('sheet-results', mode === 'mobile' && state.sheet === 'results');
  renderRegionSelect();

  const rs = regionStatus(); const chip = byId('region-status');
  const ck = `${rs.tone}|${rs.label}`;
  if (chip.dataset.key !== ck) {
    chip.dataset.key = ck;
    chip.className = `chip chip--${rs.tone}`;
    chip.replaceChildren(h('span', { class: `dot dot--${rs.tone}`, 'aria-hidden': 'true' }), h('span', { class: 'chip-label' }, rs.label));
    chip.dataset.tip = rs.label;
  }

  const attention = v.stale || (v.fresh && v.model.unassigned.length > 0);
  for (const [which, toggleId, sheetId] of [['plan', 'btn-plan-toggle', 'btn-sheet-plan'], ['results', 'btn-results-toggle', 'btn-sheet-results']]) {
    const open = panelOpen(which);
    byId(toggleId).setAttribute('aria-expanded', String(mode === 'tablet' && open));
    byId(sheetId).setAttribute('aria-expanded', String(mode === 'mobile' && open));
    byId(toggleId).dataset.tip = `${open ? 'Hide' : 'Show'} ${which === 'plan' ? 'plan' : 'itinerary'}`;
    const closeBtn = byId(which === 'plan' ? 'btn-plan-close' : 'btn-results-close');
    const label = mode === 'desktop' ? `Collapse ${which === 'plan' ? 'plan' : 'itinerary'} panel` : `Close ${which === 'plan' ? 'plan' : 'itinerary'} panel`;
    if (closeBtn.getAttribute('aria-label') !== label) {
      closeBtn.setAttribute('aria-label', label);
      closeBtn.replaceChildren(icon(mode === 'desktop' ? (which === 'plan' ? 'left_panel_close' : 'right_panel_close') : 'close'));
    }
    byId(which === 'plan' ? 'btn-plan-expand' : 'btn-results-expand').hidden = !(mode === 'desktop' && !state.panels[which]);
  }
  setText('plan-toggle-count', String(v.drops));
  setText('sheet-plan-count', String(v.drops));
  document.querySelectorAll('#btn-results-toggle .toggle-dot, #btn-sheet-results .toggle-dot').forEach((d) => { d.hidden = !attention; });

  renderOptimizeButtons(v);

  const dark = isDark();
  const themeLabel = dark ? 'Switch to light theme' : 'Switch to dark theme';
  const tb = byId('btn-theme');
  if (tb.getAttribute('aria-label') !== themeLabel) {
    tb.setAttribute('aria-label', themeLabel);
    tb.replaceChildren(icon(dark ? 'light_mode' : 'dark_mode'));
    setText('menu-theme-label', themeLabel);
    const mi = document.querySelector('#more-menu [data-menu="theme"] .icon'); if (mi) mi.textContent = dark ? 'light_mode' : 'dark_mode';
  }
  const hc = historyCache.items.length;
  const badge = byId('history-count'); badge.hidden = hc === 0; badge.textContent = String(hc);
  byId('btn-history').setAttribute('aria-label', hc ? `Run history (${plural(hc, 'run')})` : 'Run history');

  const add = byId('ctl-add-mode');
  add.setAttribute('aria-pressed', String(state.addMode));
  add.dataset.tip = state.addMode ? 'Adding stops is on' : 'Add stops';
  byId('map').classList.toggle('is-adding', state.addMode && !state.busy);
  const fit = byId('ctl-fit');
  fit.setAttribute('aria-disabled', state.stops.length ? 'false' : 'true');
  fit.setAttribute('aria-label', state.result ? 'Fit to route' : 'Fit to stops');
}
function renderOptimizeButtons(v) {
  const reason = optimizeBlockReason(); const busy = !!state.busy;
  let label, iconName = 'route';
  if (busy) label = 'Optimizing…';
  else if (v.stale || state.error) { label = 'Re-optimize'; iconName = 'refresh'; }
  else if (v.fresh) { label = 'Optimized'; iconName = 'check'; }
  else label = v.mode === 'tablet' ? 'Optimize' : 'Optimize route';
  const key = `${label}|${iconName}|${busy}|${reason}`;
  for (const btn of [byId('btn-optimize'), byId('btn-optimize-mobile')]) {
    if (btn.dataset.key === key) continue;
    btn.dataset.key = key;
    btn.setAttribute('aria-disabled', reason ? 'true' : 'false');
    if (busy) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy');
    btn.querySelector('.opt-icon').replaceChildren(busy ? h('span', { class: 'spinner' }) : icon(iconName));
    (btn.querySelector('#optimize-label') || btn.querySelector('.opt-label')).textContent = label;
    if (reason && !busy) btn.dataset.tip = reason; else delete btn.dataset.tip;
  }
  setText('optimize-reason', reason || '');
  setText('optimize-kbd', OPT_KBD);
}

function statusSummary() {
  if (state.healthState === 'pending') return { tone: 'neutral', label: 'Checking…' };
  if (state.healthState !== 'ok' || !state.health) return { tone: 'neutral', label: 'Status unavailable' };
  const s = state.health.services || {};
  const core = ['db', 'osrm_colombo', 'vroom_colombo'].every((k) => s[k] && s[k].ok);
  if (!core) return { tone: 'danger', label: 'Routing unavailable' };
  if (!(s.ml_bridge && s.ml_bridge.ok)) return { tone: 'warning', label: 'Operational · static speeds' };
  return { tone: 'success', label: 'Operational' };
}
let statusKey = '';
function renderStatus() {
  const sum = statusSummary();
  const pill = byId('status-pill');
  pill.querySelector('.dot').className = `dot dot--${sum.tone}`;
  const pillLabel = pill.querySelector('.pill-label'); if (pillLabel.textContent !== sum.label) pillLabel.textContent = sum.label;
  pill.setAttribute('aria-label', `Service status: ${sum.label}`);
  pill.dataset.tip = `Service status: ${sum.label}`;
  const key = `${state.healthState}|${state.healthCheckedAt ? +state.healthCheckedAt : 0}|${state.healthChecking}`;
  if (key === statusKey) return;
  statusKey = key;
  const svcs = (state.health && state.health.services) || null;
  byId('status-rows').replaceChildren(...SERVICES.map(([k, label]) => {
    const s = svcs && svcs[k];
    const optional = k === 'ml_bridge' || k.endsWith('_beijing');
    let tone = 'neutral', word = 'Unknown', detail = 'Health endpoint unavailable';
    if (s) {
      tone = s.ok ? 'success' : k === 'ml_bridge' ? 'warning' : optional ? 'neutral' : 'danger';
      word = s.ok ? 'Up' : optional ? 'Not running' : 'Down';
      detail = s.ok ? (s.detail || 'OK') : k === 'ml_bridge' ? 'Routes use static OSRM road speeds'
        : optional ? 'Beijing routing is not deployed here' : (s.detail || 'Unreachable');
    } else if (state.healthState === 'pending') detail = 'Checking…';
    const latency = s && typeof s.latency_ms === 'number' ? `${s.latency_ms.toLocaleString('en-US')} ms` : '—';
    return h('li', { class: 'status-row' },
      h('span', { class: `dot dot--${tone}`, 'aria-hidden': 'true' }),
      h('span', { class: 'status-name' }, label),
      h('span', { class: 'status-meta' }, `${word} · ${latency}`),
      h('span', { class: 'status-detail' }, detail));
  }));
  setText('status-checked', state.healthCheckedAt ? `Checked ${hhmmss(state.healthCheckedAt)}` : 'Not checked yet');
  const rb = byId('btn-status-recheck');
  rb.setAttribute('aria-busy', String(state.healthChecking));
  rb.replaceChildren(state.healthChecking ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : icon('refresh', 'icon-16'),
    h('span', null, state.healthChecking ? 'Checking…' : 'Recheck'));
  const ml = svcs && svcs.ml_bridge;
  setText('engine-live', !ml ? 'Right now: status unknown.'
    : ml.ok ? 'Right now: the traffic model service is reachable.'
      : 'Right now: the traffic model service is offline — static OSRM road speeds are in use.');
}

function renderSchedule() {
  const { start, end } = getSchedule();
  const ws = windowSeconds(start, end);
  const overnight = toMin(end) <= toMin(start);
  setText('window-readout', Number.isFinite(ws) ? `Shift window ${fmtDur(ws)} · ${start} → ${end}${overnight ? ' next day' : ''}` : '');
  for (const id of ['planning-date', 'start-time', 'end-time']) {
    const el = byId(id); el.readOnly = !!state.busy;
    el.setAttribute('aria-disabled', state.busy ? 'true' : 'false');
  }
}

let stopsKey = '';
function renderStops(v) {
  const n = state.stops.length; const busy = !!state.busy;
  setText('stops-count', n === 0 ? 'None yet' : `1 depot · ${plural(n - 1, 'stop')}`);
  for (const id of ['btn-export', 'btn-clear']) {
    const b = byId(id); const off = n === 0 || busy;
    b.setAttribute('aria-disabled', String(off));
    if (off) b.dataset.tip = busy ? 'Optimizing…' : 'Add stops first'; else delete b.dataset.tip;
  }
  const imp = byId('btn-import'); imp.setAttribute('aria-disabled', String(busy));
  if (busy) imp.dataset.tip = 'Optimizing…'; else delete imp.dataset.tip;
  byId('add-coords').readOnly = busy;
  byId('btn-add-coords').setAttribute('aria-disabled', String(busy));
  byId('stops-empty').hidden = n > 0;

  const chips = state.stops.map((s, i) => stopChip(s, i, v));
  const sel = state.selection ? state.selection.stopId : null;
  const key = JSON.stringify([state.stops, chips, sel, state.renaming, busy, v.fresh]);
  if (key === stopsKey) return;
  const list = byId('stops-list');
  const live = list.querySelector('.stop-rename');
  if (live && state.renaming != null) state.renameDraft = live.value;
  stopsKey = key;
  const frag = document.createDocumentFragment();
  state.stops.forEach((s, idx) => {
    const name = displayName(s, idx); const spec = markerSpec(s, idx, v); const chip = chips[idx];
    const swatch = h('span', { class: `swatch swatch--${spec.kind}`, 'aria-hidden': 'true' }, spec.kind === 'depot' ? icon('warehouse') : spec.label);
    const nameEl = state.renaming === s.id
      ? h('input', { type: 'text', class: 'input stop-rename', maxlength: 40, value: state.renameDraft != null ? state.renameDraft : (s.name || ''),
        placeholder: idx === 0 ? 'Depot' : `Stop ${s.id}`, 'aria-label': `Rename ${name}`, 'data-focus-key': `stop-${s.id}-select`, 'data-stop-rename': s.id })
      : h('button', { type: 'button', class: 'stop-name', 'data-action': 'select', 'data-focus-key': `stop-${s.id}-select`,
        'aria-current': sel === s.id ? 'true' : null }, name);
    const actBtn = (action, iconName, label) => h('button', { type: 'button', class: 'icon-btn icon-btn-sm', 'data-action': action,
      'data-focus-key': `stop-${s.id}-${action}`, 'aria-label': label, 'data-tip': '', 'aria-disabled': busy ? 'true' : null }, icon(iconName, 'icon-16'));
    frag.append(h('li', { class: 'stop-row' + (sel === s.id ? ' is-selected' : ''), 'data-stop-id': s.id },
      swatch,
      h('div', { class: 'stop-main' },
        h('div', { class: 'stop-line1' }, nameEl, chip ? h('span', { class: `chip chip--${chip.tone}` }, chip.text) : null),
        h('div', { class: 'mono' }, `#${s.id} · ${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}`)),
      state.renaming === s.id ? null : h('div', { class: 'stop-actions' },
        actBtn('rename', 'edit', `Rename ${name}`),
        idx > 0 ? actBtn('depot', 'warehouse', `Set ${name} as depot`) : null,
        actBtn('delete', 'close', `Delete ${name}`))));
  });
  swapList(list, frag);
  const inp = list.querySelector('.stop-rename');
  if (inp && document.activeElement !== inp) { inp.focus(); inp.select(); }
}

/** Replace a list's children, keeping keyboard focus on the equivalent element (data-focus-key). */
function swapList(container, frag) {
  const ae = document.activeElement;
  const keyed = ae && container.contains(ae) ? ae.closest('[data-focus-key]') : null;
  const key = keyed ? keyed.dataset.focusKey : null;
  const rows = keyed ? [...container.children] : [];
  const rowIdx = keyed ? rows.findIndex((r) => r.contains(keyed)) : -1;
  container.replaceChildren(frag);
  if (!key) return;
  const same = container.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
  if (same) { same.focus({ preventScroll: true }); return; }
  const kids = container.children;
  const row = kids[Math.min(rowIdx, kids.length - 1)];
  const target = (row && row.querySelector('button, input')) || container.closest('.panel')?.querySelector('.panel-title');
  if (target) target.focus({ preventScroll: true });
}

function setSub(el, text, tone) {
  el.textContent = text;
  el.classList.toggle('is-success', tone === 'success');
  el.classList.toggle('is-danger', tone === 'danger');
}
function renderKpis(v) {
  const strip = byId('kpi-strip');
  strip.classList.toggle('is-stale', v.stale);
  strip.classList.toggle('is-expanded', state.kpiExpanded);
  const ex = byId('btn-kpi-expand');
  ex.setAttribute('aria-expanded', String(state.kpiExpanded));
  ex.setAttribute('aria-label', state.kpiExpanded ? 'Hide route summary details' : 'Show route summary details');
  byId('chip-stale').hidden = !v.stale;
  const r = state.result;
  const traffic = byId('chip-traffic'), baseline = byId('chip-baseline');
  const distOld = byId('val-dist-old'), distBadge = byId('badge-dist-save'), timeOld = byId('val-time-old'), timeBadge = byId('badge-time-save');
  const drops = byId('val-drops'), slackEl = byId('val-slack');
  const sc = getSchedule();
  // Tooltips belong to the current figures only; never let a previous run's numbers linger in data-tip.
  for (const el of [distBadge, timeBadge, slackEl]) delete el.dataset.tip;
  if (!r) {
    delete slackEl.dataset.key;
    traffic.hidden = true; baseline.hidden = true;
    drops.textContent = String(v.drops); drops.classList.remove('is-danger');
    setSub(byId('kpi-stops-sub'), 'Not optimized yet', null);
    setText('val-dist', '—'); distOld.hidden = true; distBadge.hidden = true; setText('kpi-distance-note', 'Optimize to see distance');
    setText('val-time', '—'); timeOld.hidden = true; timeBadge.hidden = true;
    byId('shift-bar-drive').style.width = '0%'; byId('shift-bar-service').style.width = '0%';
    for (const id of ['val-time-driving', 'val-time-service', 'val-unassigned']) setText(id, '—');
    byId('val-unassigned').classList.remove('is-danger');
    setText('val-return', '—');
    setText('val-slack', Number.isFinite(toMin(sc.end)) ? `Deadline ${sc.end}${toMin(sc.end) <= toMin(sc.start) ? ' +1d' : ''}` : '—');
    const um = byId('util-meter'); um.className = 'util-meter'; um.firstElementChild.style.width = '0%';
    setText('kpi-compact', `${plural(v.drops, 'stop')} · not optimized`);
    return;
  }
  const resp = r.response, m = v.model, ctx = r.ctx;
  const win = windowSeconds(ctx.start, ctx.end);
  const total = resp.total_duration_seconds || 0, drive = resp.driving_duration_seconds || 0, service = resp.service_duration_seconds || 0;
  const dist = resp.total_distance_meters || 0;
  const un = resp.unassigned_jobs != null ? resp.unassigned_jobs : m.unassigned.length;
  const cmp = comparability(resp, m.dropsAtRun);

  traffic.hidden = false;
  traffic.textContent = r.mlBridgeOk === false ? 'Traffic: static OSRM speeds' : r.mlBridgeOk === true ? 'Traffic model service reachable at run time' : 'Traffic source unknown';
  baseline.hidden = false;

  drops.textContent = `${m.jobsTotal} / ${m.dropsAtRun}`;
  drops.classList.toggle('is-danger', un > 0);
  setSub(byId('kpi-stops-sub'), un > 0 ? `${un} not scheduled` : 'All scheduled', un > 0 ? 'danger' : 'success');

  setText('val-dist', fmtKm(dist));
  const base = resp.unoptimized_distance_meters || 0;
  distOld.hidden = true; distBadge.hidden = true; setText('kpi-distance-note', '');
  if (cmp.ok) {
    const d = Math.round(base - dist); // whole metres saved (negative = longer than the entered order)
    distBadge.hidden = false;
    if (d > 0) {
      const pct = Math.round((d / base) * 100);
      distOld.hidden = false; distOld.textContent = fmtKm(base);
      distBadge.className = 'chip chip--success';
      distBadge.textContent = `${MINUS}${fmtKm(d)}${pct >= 1 ? ` (${MINUS}${pct}%)` : ''}`;
      distBadge.dataset.tip = `Baseline (entered order): ${fmtKm(base)}`;
    } else if (d < 0) {
      distBadge.className = 'chip chip--neutral';
      distBadge.textContent = `+${fmtKm(-d)}`;
      distBadge.dataset.tip = 'The solver minimises time; distance can rise slightly.';
    } else {
      distBadge.className = 'chip chip--neutral';
      distBadge.textContent = 'No change';
      distBadge.dataset.tip = 'Same distance as driving the stops in the order you added them.';
    }
  } else setText('kpi-distance-note', cmp.note);

  setText('val-time', fmtDur(total));
  byId('shift-bar-drive').style.width = `${Math.min(100, (drive / win) * 100)}%`;
  byId('shift-bar-service').style.width = `${Math.max(0, Math.min(100 - (drive / win) * 100, (service / win) * 100))}%`;
  setText('val-time-driving', fmtDur(drive));
  setText('val-time-service', fmtDur(service));
  setText('val-unassigned', String(un));
  byId('val-unassigned').classList.toggle('is-danger', un > 0);
  const baseT = resp.unoptimized_duration_seconds || 0;
  timeOld.hidden = true; timeBadge.hidden = true;
  if (cmp.ok && baseT > 0) {
    const dt = baseT - total; const dtMin = Math.round(dt / 60);
    timeBadge.hidden = false;
    if (dtMin > 0) {
      timeOld.hidden = false; timeOld.textContent = fmtDur(baseT);
      timeBadge.className = 'chip chip--success tile-badge'; timeBadge.textContent = `${MINUS}${fmtDur(dt)}`;
      timeBadge.dataset.tip = `Baseline (entered order): ${fmtDur(baseT)}`;
    } else if (dtMin < 0) {
      timeBadge.className = 'chip chip--neutral tile-badge'; timeBadge.textContent = `+${fmtDur(-dt)}`;
      timeBadge.dataset.tip = "The optimized route isn't shorter in time than the entered order.";
    } else {
      timeBadge.className = 'chip chip--neutral tile-badge'; timeBadge.textContent = 'No change';
      timeBadge.dataset.tip = 'Within a minute of driving the stops in the order you added them.';
    }
  }

  const last = m.steps[m.steps.length - 1];
  const retArr = last && last.type === 'end' ? last.arrival : total;
  const ret = etaFor(ctx, retArr);
  setText('val-return', ret.text);
  const deadline = `${ctx.end}${toMin(ctx.end) <= toMin(ctx.start) ? ' +1d' : ''}`;
  const slack = win - retArr; const pct = Math.round((retArr / win) * 100);
  const slackText = slack >= 0 ? `${fmtDur(slack)} before ${deadline} deadline · ${pct}% of window` : `${fmtDur(-slack)} past ${deadline} deadline`;
  if (slackEl.dataset.key !== slackText) {
    slackEl.dataset.key = slackText;
    fill(slackEl, h('span', { class: 'kv' }, slack >= 0 ? `${fmtDur(slack)} before ${deadline}` : `${fmtDur(-slack)} past ${deadline}`),
      slack >= 0 ? h('span', { class: 'kv kv--row' }, `${pct}% of window`) : null);
  }
  slackEl.dataset.tip = slackText;
  const um = byId('util-meter');
  um.className = 'util-meter' + (un > 0 ? ' is-danger' : pct >= 85 ? ' is-warning' : '');
  um.firstElementChild.style.width = `${Math.min(100, pct)}%`;
  setText('kpi-compact', `${m.jobsTotal}/${m.dropsAtRun} stops · ${fmtKm(dist)} · ${fmtDur(total)} · back ${ret.text}`);
}

let stepsKey = '', unassignedKey = '';
function renderResults(v) {
  const r = state.result;
  setText('results-meta', r ? `Optimized ${whenShort(r.optimizedAt)} · ${(r.elapsedMs / 1000).toFixed(1)} s · Rider #${RIDER_ID}` : '');
  const csv = byId('btn-export-csv');
  csv.setAttribute('aria-disabled', String(!r));
  csv.dataset.tip = r ? 'Download itinerary as CSV' : 'Optimize a route first';

  const alert = byId('results-alert');
  if (!state.error) { alert.hidden = true; alert.replaceChildren(); alert._err = null; }
  else if (alert._err !== state.error) {
    const er = state.error; alert._err = er;
    fill(alert,
      h('div', { class: 'alert-head' }, icon('error'),
        h('div', { class: 'callout-text' }, h('p', { class: 'alert-title' }, er.title), er.body ? h('p', { class: 'alert-body' }, er.body) : null)),
      er.detail ? h('details', null, h('summary', null, 'Technical details'), h('pre', null, er.detail)) : null,
      h('div', { class: 'alert-actions' },
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'retry' }, icon('refresh', 'icon-16'), 'Retry'),
        h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'dismiss' }, 'Dismiss')));
    alert.hidden = false;
  }

  const partial = byId('results-partial');
  const un = r && v.fresh ? v.model.unassigned.length : 0;
  partial.hidden = !un;
  if (un) {
    const deadline = `${r.ctx.end}${toMin(r.ctx.end) <= toMin(r.ctx.start) ? ' next day' : ''}`;
    const text = `${plural(un, 'stop')} couldn't be scheduled before ${deadline}. Extend the deadline or remove stops, then re-optimize.`;
    if (partial.dataset.text !== text) {
      partial.dataset.text = text;
      partial.replaceChildren(icon('error'), h('div', { class: 'callout-text' }, h('p', null, text),
        h('div', { class: 'callout-actions' }, h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'show-unassigned' }, 'Show'))));
    }
  }
  const staleBox = byId('results-stale');
  staleBox.hidden = !v.stale;
  if (v.stale && !staleBox.firstChild) {
    staleBox.replaceChildren(icon('history_toggle_off'), h('div', { class: 'callout-text' },
      h('p', null, 'Stops or schedule changed since this route was computed. Figures are out of date.'),
      h('div', { class: 'callout-actions' }, h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'reoptimize' }, icon('refresh', 'icon-16'), 'Re-optimize'))));
  }

  const stepsEl = byId('route-steps'), unSec = byId('unassigned-section'), empty = byId('results-empty');
  stepsEl.classList.toggle('is-stale', v.stale); unSec.classList.toggle('is-stale', v.stale);
  const names = state.stops.map((s, i) => [s.id, displayName(s, i)]);
  const sel = state.selection;
  const sk = r ? JSON.stringify([+r.optimizedAt, names, sel, v.stale]) : 'none';
  if (sk !== stepsKey) { stepsKey = sk; swapList(stepsEl, r ? buildSteps(v) : document.createDocumentFragment()); }
  const uk = r ? JSON.stringify([+r.optimizedAt, names, sel]) : 'none';
  if (uk !== unassignedKey) {
    unassignedKey = uk;
    const list = r ? v.model.unassigned : [];
    unSec.hidden = list.length === 0;
    setText('unassigned-title', `Not scheduled (${list.length})`);
    swapList(byId('unassigned-list'), buildUnassigned(v, list));
  }
  empty.hidden = !!r;
  if (!r) {
    const ready = state.stops.length >= 2;
    const ek = `${ready}|${v.drops}`;
    if (empty.dataset.key !== ek) {
      empty.dataset.key = ek;
      fill(empty, icon('format_list_numbered', 'empty-icon'),
        ready ? [h('p', { class: 'empty-title' }, 'Optimize to see the itinerary'), h('p', { class: 'empty-body' }, `${plural(v.drops, 'stop')} ready · press ${OPT_KBD}`)]
          : h('p', { class: 'empty-body' }, 'Add a depot and stops to plan a route.'));
    }
  }
}
function buildSteps(v) {
  const r = state.result, m = v.model, ctx = r.ctx; const frag = document.createDocumentFragment();
  const selStep = state.selection ? state.selection.stepIndex : null;
  const totalDist = r.response.total_distance_meters || 0;
  m.steps.forEach((s, i) => {
    const prev = i > 0 ? m.steps[i - 1] : null; const ss = m.stepStop[i];
    const eta = etaFor(ctx, s.arrival);
    const legM = prev ? (s.distance || 0) - (prev.distance || 0) : 0;
    const driveMin = prev ? Math.round((s.arrival - (prev.arrival + (prev.service || 0))) / 60) : 0;
    const svcMin = Math.round((s.service || 0) / 60);
    const cur = ss.stopId != null ? nameOfId(ss.stopId) : null;
    let badge, name, line2, aria, removed = false;
    if (s.type === 'start') {
      badge = h('span', { class: 'badge badge--depot' }, icon('home'));
      name = 'Depart depot';
      line2 = `${cur || 'Depot'} · ${plural(m.jobsTotal, 'stop')} · ${fmtKm(totalDist)}`;
      aria = `Depart depot, ${cur || 'Depot'}, ETA ${eta.text}`;
    } else if (s.type === 'end') {
      badge = h('span', { class: 'badge badge--depot' }, icon('flag'));
      name = 'Return to depot';
      line2 = `${fmtKm(legM)} · ${driveMin} min drive · ${fmtKm(s.distance)} total`;
      aria = `Return to depot, ETA ${eta.text}, ${fmtKmSpoken(legM)}, ${plural(driveMin, 'minute')} drive`;
    } else {
      badge = h('span', { class: 'badge' }, String(ss.seq));
      removed = cur == null; name = cur != null ? cur : 'Removed stop';
      line2 = `#${ss.stopId != null ? ss.stopId : '?'} · ${fmtKm(legM)} · ${driveMin} min drive · ${svcMin} min service · ${fmtKm(s.distance)} total`;
      aria = `Stop ${ss.seq} of ${m.jobsTotal}, ${name}, ETA ${eta.text}, ${fmtKmSpoken(legM)}, ${plural(driveMin, 'minute')} drive, ${plural(svcMin, 'minute')} service`;
    }
    frag.append(h('li', { class: 'step' },
      h('button', { type: 'button', class: 'step-btn', 'data-step': i, 'data-focus-key': `step-${i}`, 'aria-label': aria, 'aria-current': selStep === i ? 'true' : null },
        badge,
        h('span', { class: 'step-text' },
          h('span', { class: 'step-line1' }, h('span', { class: 'step-name' + (removed ? ' is-removed' : '') }, name),
            h('span', { class: 'step-eta' }, eta.clock, eta.dayOffset > 0 ? h('small', null, ` +${eta.dayOffset}d`) : null)),
          h('span', { class: 'step-line2' }, line2)))));
  });
  return frag;
}
function buildUnassigned(v, list) {
  const frag = document.createDocumentFragment(); const sel = state.selection;
  list.forEach((u, k) => {
    const idx = u.stopId != null ? stopIndex(u.stopId) : -1; const s = idx >= 0 ? state.stops[idx] : null;
    const name = s ? displayName(s, idx) : 'Removed stop';
    const coords = s ? `${s.lat.toFixed(5)}, ${s.lon.toFixed(5)}` : u.location ? `${u.location[1].toFixed(5)}, ${u.location[0].toFixed(5)}` : '';
    const current = !!sel && sel.stepIndex == null && s && sel.stopId === s.id;
    frag.append(h('li', null, h('button', { type: 'button', class: 'unassigned-btn', 'data-unassigned': k, 'data-focus-key': `un-${k}`,
      'aria-current': current ? 'true' : null, 'aria-label': `Not scheduled: ${name}, ${coords}` },
      h('span', { class: 'badge badge--danger' }, '!'),
      h('span', { class: 'step-text' }, h('span', { class: 'step-name' + (s ? '' : ' is-removed') }, name), h('span', { class: 'mono' }, coords)))));
  });
  return frag;
}

function renderOverlays(v) {
  // Stale banner
  const banner = byId('stale-banner');
  banner.hidden = !v.stale;
  if (v.stale) {
    const parts = staleParts();
    const text = `Route out of date${parts.length ? ` — ${parts.join(' · ')}` : ''} since ${hhmm(state.result.optimizedAt)}`;
    if (banner.dataset.text !== text) {
      banner.dataset.text = text;
      banner.replaceChildren(icon('history_toggle_off'), h('span', { class: 'banner-text', title: text }, text),
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'reoptimize' }, 'Re-optimize', h('kbd', { class: 'kbd' }, OPT_KBD)));
    }
  }
  renderProgress();
  // Map hint (first matching state wins)
  const hint = byId('map-hint'); let spec = null;
  const addBtn = (label) => h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'add-mode' }, label, state.singleKeys ? h('kbd', { class: 'kbd' }, 'A') : null);
  if (!canOptimizeRegion(state.region)) {
    spec = ['map', `Map preview only — no routing data for ${regionShort(state.region)} in this deployment.`, null,
      h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'switch-colombo' }, 'Switch to Colombo')];
  } else if (state.busy) spec = ['lock', 'Optimizing… editing is locked.', null, null];
  else if (openPopupRef) spec = null; // never cover an open popup
  else if (state.stops.length === 0) spec = ['ads_click', 'Click the map to place the depot', 'or add coordinates in the Plan panel', state.addMode ? null : addBtn('Add stops')];
  else if (state.stops.length === 1) spec = ['add_location_alt', 'Now click to add delivery stops.', null, state.addMode ? null : addBtn('Add stops')];
  else if (v.fresh && !state.addMode && !state.selection) spec = ['travel_explore', 'Viewing route · click a stop or leg to inspect', null, addBtn('Add stops')];
  const hk = spec ? `${spec[1]}|${spec[2]}|${!!spec[3]}|${state.singleKeys}` : '';
  hint.hidden = !spec;
  if (spec && hint.dataset.key !== hk) {
    hint.dataset.key = hk;
    fill(hint, icon(spec[0]), h('span', { class: 'map-hint-text' }, spec[1], spec[2] ? h('span', { class: 'map-hint-sub' }, spec[2]) : null), spec[3]);
  }
  // Map layers popover state (route arrows only; the tile layer is always OpenStreetMap)
  byId('opt-arrows').checked = state.arrows;
  renderLegend();
}
let progressTimer = null, progressFade = null;
function renderProgress() {
  const card = byId('progress-card'); const p = state.progress;
  if (!p) { card.hidden = true; card.dataset.key = ''; return; }
  const key = `${p.stage}|${p.failed}|${p.done}|${!!state.busy}`;
  card.hidden = false;
  if (card.dataset.key === key) return;
  card.dataset.key = key;
  card.classList.remove('is-leaving');
  const rows = [`Creating ${plural(p.n, 'order')}`, 'Solving route (VROOM + OSRM)', 'Drawing route'];
  const head = p.failed ? 'Optimization failed' : p.done ? 'Route ready' : 'Optimizing route';
  card.replaceChildren(
    h('div', { class: 'progress-head' }, h('span', null, head), h('span', { class: 'text-xs text-ink-muted tabular-nums', id: 'progress-elapsed', 'aria-hidden': 'true' }, elapsedText(p)),
      state.busy ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', 'data-action': 'cancel' }, 'Cancel') : null),
    h('ol', { class: 'progress-rows' }, rows.map((label, i) => {
      const k = i + 1;
      const st = p.failed === k ? 'failed' : (p.done || p.stage > k || (p.failed && p.failed > k)) ? 'done' : p.stage === k && !p.failed ? 'active' : 'pending';
      const mark = st === 'active' ? h('span', { class: 'spinner', 'aria-hidden': 'true' }) : st === 'done' ? icon('check_circle', 'icon-16')
        : st === 'failed' ? icon('cancel', 'icon-16') : h('span', { class: 'p-ring', 'aria-hidden': 'true' });
      const sr = { active: 'in progress', done: 'done', failed: 'failed', pending: 'pending' }[st];
      return h('li', { class: `progress-row is-${st}` }, h('span', { class: 'p-state' }, mark), h('span', null, label), h('span', { class: 'sr-only' }, `, ${sr}`));
    })));
}
function elapsedText(p) { return `${(((p.end || performance.now()) - p.t0) / 1000).toFixed(1)} s`; }

let legendBuilt = false;
function renderLegend() {
  const el = byId('map-legend');
  if (!legendBuilt) {
    legendBuilt = true;
    const sw = (kind, label) => h('span', { class: 'lg-swatch' }, h('span', { class: `swatch swatch--${kind}` }, kind === 'depot' ? icon('warehouse') : label));
    const items = [[sw('depot'), 'Depot'], [sw('draft', '3'), 'Stop (not optimized)'], [sw('routed', '1'), 'Routed stop (visit order)'],
      [sw('unassigned', '!'), 'Not scheduled'], [h('span', { class: 'lg-swatch' }, h('span', { class: 'lg-line' })), 'Route'],
      [h('span', { class: 'lg-swatch' }, h('span', { class: 'lg-line lg-line--sel' })), 'Selected leg'],
      [h('span', { class: 'lg-swatch' }, h('span', { class: 'lg-line lg-line--stale' })), 'Out-of-date route (dashed)']];
    el.replaceChildren(
      h('button', { type: 'button', class: 'legend-toggle', id: 'btn-legend', 'aria-expanded': 'true', 'aria-controls': 'legend-list' }, icon('legend_toggle', 'icon-16'), h('span', null, 'Legend'), icon('expand_less', 'icon-16 legend-chevron')),
      h('ul', { class: 'legend-list', id: 'legend-list' }, items.map(([s, t]) => h('li', { class: 'legend-item' }, s, h('span', null, t)))));
    byId('btn-legend').addEventListener('click', () => {
      state.legendOpen = !state.legendOpen; store.set(KEYS.legend, state.legendOpen ? 'open' : 'closed'); renderLegend();
    });
  }
  byId('btn-legend').setAttribute('aria-expanded', String(state.legendOpen));
  byId('legend-list').hidden = !state.legendOpen;
  el.querySelector('.legend-chevron').textContent = state.legendOpen ? 'expand_more' : 'expand_less';
}

function renderTitle(v) {
  const parts = ['Nexus Router'];
  const n = state.stops.length;
  parts.push(n === 0 ? 'Route planner' : n === 1 ? 'Depot only' : plural(n - 1, 'stop'));
  if (state.busy) parts.push('Optimizing…'); else if (v.stale) parts.push('Out of date'); else if (v.fresh) parts.push('Optimized');
  const t = parts.join(' · ');
  if (document.title !== t) document.title = t;
}

// ===== ui
let srTimer = null;
function announce(msg) {
  const el = byId('sr-live'); el.textContent = '';
  clearTimeout(srTimer);
  srTimer = setTimeout(() => { el.textContent = msg; }, 60);
}

function toast({ tone = 'info', title, body, action, timeout }) {
  const region = byId('toast-region');
  const iconName = { info: 'info', success: 'check_circle', warning: 'warning', danger: 'error' }[tone] || 'info';
  const closeBtn = h('button', { type: 'button', class: 'icon-btn icon-btn-sm', 'aria-label': 'Dismiss notification' }, icon('close', 'icon-16'));
  const actBtn = action ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm toast-action' }, action.label) : null;
  const el = h('div', { class: `toast toast--${tone}` },
    h('span', { class: 'toast-icon' }, icon(iconName)),
    h('div', { class: 'toast-text' }, h('p', { class: 'toast-title' }, title), body ? h('p', { class: 'toast-body' }, body) : null),
    actBtn, closeBtn);
  let remaining = timeout || (action ? 8000 : 5000), started = 0, timer = null, holds = 0;
  const dismiss = () => {
    clearTimeout(timer);
    if (!el.isConnected || el.classList.contains('is-leaving')) return;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), prefersReducedMotion() ? 0 : 180);
  };
  const run = () => { started = Date.now(); timer = setTimeout(dismiss, Math.max(1000, remaining)); };
  const hold = () => { if (holds++ === 0) { clearTimeout(timer); remaining -= Date.now() - started; } };
  const release = () => { if (holds > 0 && --holds === 0) run(); };
  el.addEventListener('mouseenter', hold); el.addEventListener('mouseleave', release);
  el.addEventListener('focusin', (e) => { if (!e.relatedTarget || !el.contains(e.relatedTarget)) hold(); });
  el.addEventListener('focusout', (e) => { if (!e.relatedTarget || !el.contains(e.relatedTarget)) release(); });
  closeBtn.addEventListener('click', dismiss);
  if (actBtn) actBtn.addEventListener('click', () => { dismiss(); action.onClick(); });
  region.append(el);
  while (region.children.length > 3) region.firstElementChild.remove();
  run();
  return { dismiss };
}

function openDialog(dlg, opener) {
  dlg._opener = opener || document.activeElement;
  if (!dlg.open) dlg.showModal();
  const first = dlg.querySelector('[data-autofocus]') || dlg.querySelector('.dlg-close');
  if (first) first.focus();
}
function setupDialogs() {
  document.querySelectorAll('dialog.dlg').forEach((dlg) => {
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close('cancel'); });
    dlg.addEventListener('close', () => {
      const o = dlg._opener; dlg._opener = null;
      if (o && o.isConnected && typeof o.focus === 'function' && !o.closest('[hidden]')) o.focus();
    });
    dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close('cancel')));
  });
}
function confirmDialog({ title, body, actions }) {
  const dlg = byId('confirm-dialog'); const wrap = byId('confirm-actions');
  setText('confirm-title', title); setText('confirm-body', body || '');
  const variant = { primary: 'btn-primary', secondary: 'btn-secondary', ghost: 'btn-ghost', danger: 'btn-danger' };
  wrap.replaceChildren(...actions.map((a) => h('button', { type: 'button', class: `btn ${variant[a.variant] || 'btn-secondary'}`, 'data-id': a.id, 'data-autofocus': a.autofocus ? true : null }, a.label)));
  return new Promise((resolve) => {
    const onClick = (e) => { const b = e.target.closest('button[data-id]'); if (b) dlg.close(b.dataset.id); };
    wrap.addEventListener('click', onClick);
    dlg.addEventListener('close', () => {
      wrap.removeEventListener('click', onClick);
      resolve(dlg.returnValue && dlg.returnValue !== 'cancel' ? dlg.returnValue : 'cancel');
    }, { once: true });
    dlg.returnValue = '';
    const opener = document.activeElement;
    dlg._opener = opener;
    dlg.showModal();
    (wrap.querySelector('[data-autofocus]') || wrap.querySelector('button')).focus();
  });
}

let openPop = null;
function openPopover(trigger, panel, opts = {}) {
  closePopover({ returnFocus: false });
  hideTip();
  panel.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  (opts.position || positionFixed)(trigger, panel);
  openPop = { trigger, panel };
  const f = opts.focus ? opts.focus() : null;
  if (f) f.focus();
}
function closePopover({ returnFocus = true } = {}) {
  if (!openPop) return;
  const { trigger, panel } = openPop; openPop = null;
  panel.hidden = true; trigger.setAttribute('aria-expanded', 'false');
  if (returnFocus && trigger.isConnected) trigger.focus();
}
function positionFixed(trigger, panel) {
  const r = trigger.getBoundingClientRect(); const w = panel.offsetWidth; const vw = document.documentElement.clientWidth;
  panel.style.top = `${Math.round(r.bottom + 8)}px`;
  panel.style.left = `${Math.round(Math.max(16, Math.min(r.right - w, vw - w - 16)))}px`;
}
function positionLayers(trigger, panel) {
  const wrap = byId('map-wrap').getBoundingClientRect(); const r = trigger.getBoundingClientRect();
  panel.style.top = `${Math.round(r.top - wrap.top)}px`;
  panel.style.left = `${Math.round(Math.min(r.right - wrap.left + 8, wrap.width - panel.offsetWidth - 8))}px`;
}

// Shared tooltip: data-tip (falls back to aria-label), optional data-kbd hint.
let tipTimer = null, tipFor = null;
function showTip(el) {
  const tip = byId('tooltip');
  const text = el.getAttribute('data-tip') || el.getAttribute('aria-label') || '';
  if (!text || !el.isConnected || el.getAttribute('aria-expanded') === 'true') return;
  let kbd = el.getAttribute('data-kbd');
  if (kbd && kbd.length === 1 && !state.singleKeys) kbd = null; // don't advertise a switched-off shortcut
  fill(tip, h('span', null, text), kbd ? h('kbd', { class: 'kbd' }, kbd) : null);
  tip.hidden = false;
  const r = el.getBoundingClientRect(); const tw = tip.offsetWidth, th = tip.offsetHeight;
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  let top = r.bottom + 6; if (top + th > vh - 8) top = r.top - th - 6;
  const left = Math.max(8, Math.min(r.left + r.width / 2 - tw / 2, vw - tw - 8));
  tip.style.top = `${Math.round(top)}px`; tip.style.left = `${Math.round(left)}px`;
  tipFor = el;
}
function scheduleTip(el) { clearTimeout(tipTimer); tipTimer = setTimeout(() => showTip(el), 400); }
function hideTip() { clearTimeout(tipTimer); tipFor = null; const t = byId('tooltip'); if (!t.hidden) t.hidden = true; }
function setupTooltip() {
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el === tipFor) return;
    hideTip(); if (el) scheduleTip(el);
  });
  document.addEventListener('pointerout', (e) => {
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el && !el.contains(e.relatedTarget)) hideTip();
  });
  document.addEventListener('focusin', (e) => {
    hideTip();
    const el = e.target.closest && e.target.closest('[data-tip]');
    if (el && !MQ.coarse.matches && el.matches(':focus-visible')) scheduleTip(el);
  });
  document.addEventListener('focusout', hideTip);
  window.addEventListener('scroll', hideTip, true);
}

function panelOpen(which) {
  const mode = layoutMode();
  return mode === 'desktop' ? state.panels[which] : mode === 'tablet' ? state.drawers[which] : state.sheet === which;
}
function setPanel(which, open, { focus = true } = {}) {
  const mode = layoutMode(); const other = which === 'plan' ? 'results' : 'plan';
  if (mode === 'desktop') state.panels[which] = open;
  else if (mode === 'tablet') { state.drawers[which] = open; if (open && !MQ.wide.matches) state.drawers[other] = false; }
  else state.sheet = open ? which : (state.sheet === which ? null : state.sheet);
  const hadFocusInside = byId(`${which}-panel`).contains(document.activeElement);
  render();
  if (open && focus) byId(`${which}-title`).focus({ preventScroll: true });
  if (!open && (focus || hadFocusInside)) {
    const target = mode === 'desktop' ? byId(`btn-${which}-expand`) : mode === 'tablet' ? byId(`btn-${which}-toggle`) : byId(`btn-sheet-${which}`);
    if (target) target.focus({ preventScroll: true });
  }
}
function togglePanel(which) { setPanel(which, !panelOpen(which)); }

function isDisabled(el) { return el.getAttribute('aria-disabled') === 'true'; }
function blockedWhileBusy() { if (state.busy) { toast({ tone: 'info', title: 'Optimizing… editing is locked' }); return true; } return false; }
function applyTheme(dark, persist) {
  document.documentElement.classList.toggle('dark', dark);
  if (persist) store.set(KEYS.theme, dark ? 'dark' : 'light');
  document.dispatchEvent(new CustomEvent('themechange', { detail: { dark } }));
}

// ===== controllers
function setAddMode(on) {
  update((s) => { s.addMode = on; });
  announce(on ? 'Adding stops is on. Click the map to add stops.' : 'Adding stops is off.');
}
function onMapClick(e) {
  const hadPopup = popupAtPreclick; popupAtPreclick = false;
  if (Date.now() - popoverDismissedAt < 400) return;
  if (state.selection || hadPopup) { map.closePopup(); if (state.selection) update((s) => { s.selection = null; }); return; }
  if (state.addMode && !state.busy) addStop(e.latlng.lat, e.latlng.lng);
}
function addStop(lat, lon, name = null) {
  if (state.busy) return null;
  let id = null;
  update((s) => { id = s.nextId++; s.stops.push({ id, lat: round6(lat), lon: round6(lon), name }); }, { undoLabel: 'Add stop' });
  const idx = state.stops.length - 1;
  announce(idx === 0 ? 'Depot placed' : `${displayName(state.stops[idx], idx)} added`);
  return id;
}
function clearSelection() { if (map) map.closePopup(); update((s) => { s.selection = null; }); }
function selectStop(id, source) {
  const idx = stopIndex(id); if (idx < 0) return;
  const v = viewModel(); let stepIndex = null;
  if (v.fresh) { if (idx === 0) stepIndex = 0; else { const b = v.model.byStop.get(id); if (b) stepIndex = b.stepIndex; } }
  state.selection = { stopId: id, stepIndex };
  if (source === 'stop-row' && v.mode === 'mobile') state.sheet = null;
  render();
  if (source === 'marker') return; // Leaflet opens the marker's popup itself
  const s = state.stops[idx];
  if (v.fresh && stepIndex > 0 && legLayers[stepIndex - 1]) focusBounds(legLayers[stepIndex - 1].line.getBounds());
  else panTo([s.lat, s.lon], 16);
  openPopupAfterMove(id);
}
function selectStep(i) {
  if (!state.result) return;
  const v = viewModel(); const step = v.model.steps[i]; if (!step) return;
  const sid = v.model.stepStop[i].stopId; const exists = sid != null && stopIndex(sid) >= 0;
  state.selection = { stopId: exists ? sid : null, stepIndex: i };
  if (v.mode === 'mobile') state.sheet = null;
  render();
  if (v.fresh && i > 0 && legLayers[i - 1]) focusBounds(legLayers[i - 1].line.getBounds());
  else panTo([step.location[1], step.location[0]], 16);
  if (exists) openPopupAfterMove(sid);
}
function selectLeg(legIdx) {
  if (!state.result) return;
  const v = viewModel(); const ss = v.model.stepStop[legIdx + 1]; if (!ss) return;
  const exists = ss.stopId != null && stopIndex(ss.stopId) >= 0;
  state.selection = { stopId: exists ? ss.stopId : null, stepIndex: legIdx + 1 };
  render();
  announce(`Leg ${legIdx + 1} selected`);
  if (exists) { const e = markers.get(ss.stopId); if (e) e.marker.openPopup(); }
}
function selectUnassigned(k) {
  if (!state.result) return;
  const u = routeModel(state.result).unassigned[k]; if (!u) return;
  const idx = u.stopId != null ? stopIndex(u.stopId) : -1;
  state.selection = idx >= 0 ? { stopId: u.stopId, stepIndex: null } : null;
  if (layoutMode() === 'mobile') state.sheet = null;
  render();
  const ll = idx >= 0 ? [state.stops[idx].lat, state.stops[idx].lon] : u.location ? [u.location[1], u.location[0]] : null;
  if (ll) panTo(ll, 16);
  if (idx >= 0) openPopupAfterMove(u.stopId);
}

function deleteStop(id) {
  if (blockedWhileBusy()) return;
  const idx = stopIndex(id); if (idx < 0) return;
  const name = displayName(state.stops[idx], idx);
  const token = update((s) => {
    s.stops.splice(idx, 1);
    if (s.selection && s.selection.stopId === id) s.selection = null;
    if (s.renaming === id) s.renaming = null;
  }, { undoLabel: 'Delete stop' });
  let title = `Deleted ${name}`;
  if (idx === 0 && state.stops.length) { const nd = state.stops[0]; title = `Depot deleted — ${nd.name || `Stop ${nd.id}`} is now the depot`; }
  toast({ tone: 'info', title, action: { label: 'Undo', onClick: () => undoTo(token) } });
}
function setDepot(id) {
  if (blockedWhileBusy()) return;
  const idx = stopIndex(id); if (idx <= 0) return;
  const newName = displayName(state.stops[idx], idx);
  map.closePopup();
  const token = update((s) => {
    const old = s.stops[0];
    if (old.name == null || old.name === '') old.name = 'Former depot';
    s.stops[0] = s.stops[idx]; s.stops[idx] = old;
  }, { undoLabel: 'Set depot' });
  toast({ tone: 'info', title: `${newName} is now the depot`, action: { label: 'Undo', onClick: () => undoTo(token) } });
}
function clearAll() {
  if (blockedWhileBusy()) return;
  const n = state.stops.length;
  if (!n) { toast({ tone: 'info', title: 'Add stops first' }); return; }
  map.closePopup();
  const token = update((s) => {
    s.stops = []; s.result = null; s.selection = null; s.renaming = null; s.error = null; s.nextId = 0; s.addMode = true;
  }, { undoLabel: 'Clear all' });
  toast({ tone: 'info', title: `Cleared ${pinsText(n)}`, action: { label: 'Undo', onClick: () => undoTo(token) } });
}
function onMarkerDragEnd(id, mk) {
  const idx = stopIndex(id); if (idx < 0) return;
  const s = state.stops[idx];
  if (state.busy) { mk.setLatLng([s.lat, s.lon]); return; }
  const ll = mk.getLatLng(); const name = displayName(s, idx);
  const token = update((st) => { st.stops[idx].lat = round6(ll.lat); st.stops[idx].lon = round6(ll.lng); }, { undoLabel: 'Move stop' });
  toast({ tone: 'info', title: `Moved ${name}`, action: { label: 'Undo', onClick: () => undoTo(token) } });
}
function startRename(id, openPlan) {
  if (blockedWhileBusy()) return;
  if (stopIndex(id) < 0) return;
  if (openPlan && !panelOpen('plan')) setPanel('plan', true, { focus: false });
  update((s) => { s.renaming = id; s.renameDraft = null; });
  const row = document.querySelector(`#stops-list [data-stop-id="${id}"]`); if (row) row.scrollIntoView({ block: 'nearest' });
}
function commitRename(id, value) {
  if (state.renaming !== id) return;
  const idx = stopIndex(id);
  update((s) => {
    s.renaming = null; s.renameDraft = null;
    if (idx >= 0) s.stops[idx].name = String(value || '').trim().slice(0, 40) || null;
  });
  if (idx >= 0) announce(`Renamed to ${displayName(state.stops[idx], idx)}`);
}
function cancelRename() { update((s) => { s.renaming = null; s.renameDraft = null; }); }

function switchRegion(next) {
  const sel = byId('city-selector');
  if (state.busy) { sel.value = state.region; toast({ tone: 'info', title: 'Optimizing… editing is locked' }); return; }
  if (!REGIONS[next] || next === state.region) return;
  const n = state.stops.length; const had = n > 0 || !!state.result;
  map.closePopup();
  const token = update((s) => {
    s.region = next;
    if (had) { s.stops = []; s.result = null; s.nextId = 0; s.addMode = true; }
    s.selection = null; s.renaming = null; s.error = null;
  }, { undoLabel: had ? 'Switch region' : null });
  flyToRegion(next);
  if (n) toast({ tone: 'info', title: `Switched to ${regionShort(next)} · cleared ${pinsText(n)}`, action: { label: 'Undo', onClick: () => undoTo(token) } });
  else announce(`Switched to ${REGIONS[next].label}`);
}

let startIsAuto = true; // true until the user edits the start time or a saved schedule is restored
function enforceTimeConstraints() {
  const msgs = [];
  const d = byId('planning-date'), s = byId('start-time'), e = byId('end-time');
  if (d.value !== todayStr()) return msgs;
  const now = nowHHMM();
  if (s.value < now) { s.value = now; msgs.push(`Start moved to ${now} — earlier times have passed.`); }
  if (e.value <= s.value) {
    const [sh, sm] = s.value.split(':');
    e.value = `${pad2(Math.min(23, parseInt(sh, 10) + 4))}:${sm}`;
    msgs.push(`Deadline moved to ${e.value} — it must be after the start.`);
  }
  return msgs;
}
let hintTimer = null;
function showScheduleHint(text) {
  const el = byId('schedule-hint'); el.textContent = text;
  clearTimeout(hintTimer); hintTimer = setTimeout(() => { el.textContent = ''; }, 6000);
}
function onScheduleChange(e) {
  if (state.busy) return;
  const msgs = []; const d = byId('planning-date'); const today = todayStr();
  d.min = today;
  if (!d.value || d.value < today) { d.value = today; msgs.push("Date moved to today — past dates can't be planned."); }
  if (!Number.isFinite(toMin(byId('start-time').value))) byId('start-time').value = '09:00';
  if (!Number.isFinite(toMin(byId('end-time').value))) byId('end-time').value = '17:00';
  if (e.target.id === 'start-time') startIsAuto = false;
  if (e.target.id === 'planning-date' || e.target.id === 'start-time') msgs.push(...enforceTimeConstraints());
  if (msgs.length) showScheduleHint(msgs.join(' '));
  render();
}

async function runOptimize() {
  if (state.busy || document.querySelector('dialog[open]')) return;
  let reason = optimizeBlockReason();
  if (reason) { toast({ tone: 'info', title: reason }); return; }
  // A start time the user never touched follows the clock, so it can't go stale while pins are placed.
  if (startIsAuto) enforceTimeConstraints();
  const sched = getSchedule();
  if (sched.date === todayStr()) {
    const now = nowHHMM();
    if (sched.start < now) {
      const choice = await confirmDialog({
        title: `Start time ${sched.start} has already passed`, body: `It's ${now} now.`,
        actions: [{ id: 'cancel', label: 'Cancel', variant: 'ghost' }, { id: 'keep', label: `Keep ${sched.start} and optimize`, variant: 'secondary' },
          { id: 'use', label: `Use ${now} and optimize`, variant: 'primary', autofocus: true }],
      });
      if (choice === 'cancel') return;
      if (choice === 'use') {
        byId('start-time').value = now;
        if (byId('end-time').value <= now) byId('end-time').value = `${pad2(Math.min(23, new Date().getHours() + 4))}:${now.split(':')[1]}`;
      }
      reason = optimizeBlockReason();
      if (reason) { if (!state.busy) toast({ tone: 'info', title: reason }); render(); return; }
    }
  }
  const ctx = { region: state.region, ...getSchedule() };
  const sig = signature();
  const mlBridgeOk = state.health && state.health.services && state.health.services.ml_bridge ? !!state.health.services.ml_bridge.ok : null;
  const stopsAtRun = clone(state.stops);
  const depot = stopsAtRun[0], drops = stopsAtRun.slice(1);
  const busy = { stage: 1, t0: performance.now(), ctrl: new AbortController() };
  clearTimeout(progressFade);
  state.busy = busy; state.error = null;
  state.progress = { n: drops.length, stage: 1, failed: null, done: false, t0: busy.t0, end: null };
  map.closePopup();
  render();
  clearInterval(progressTimer);
  progressTimer = setInterval(() => { const el = byId('progress-elapsed'); if (el && state.progress) el.textContent = elapsedText(state.progress); }, 100);
  announce(`Optimizing ${plural(drops.length, 'stop')}…`);
  const prev = state.result; const prevSel = state.selection ? state.selection.stopId : null;
  let ok = false;
  try {
    const orderData = await createOrders(drops.map((s) => [s.lon, s.lat]), busy.ctrl.signal);
    const orderIds = orderData && orderData.order_ids;
    if (!Array.isArray(orderIds) || orderIds.length !== drops.length) {
      throw new ApiError('mapping', `The API returned ${Array.isArray(orderIds) ? orderIds.length : 0} order ids for ${drops.length} stops.`, JSON.stringify(orderData).slice(0, 300));
    }
    const jobToStop = Object.fromEntries(orderIds.map((oid, i) => [oid, drops[i].id]));
    busy.stage = 2; state.progress.stage = 2; renderProgress();
    const response = await optimizeRoute({
      rider_id: RIDER_ID,
      depot_location: [depot.lon, depot.lat],
      order_ids: orderIds,
      max_duration_seconds: windowSeconds(ctx.start, ctx.end),
      start_hour: parseInt(ctx.start.split(':')[0], 10),
      planning_date: ctx.date,
      city: ctx.region,
    }, busy.ctrl.signal);
    busy.stage = 3; state.progress.stage = 3; renderProgress();
    const elapsedMs = performance.now() - busy.t0;
    state.result = { response, ctx, sig, jobToStop, stopsAtRun, optimizedAt: new Date(), elapsedMs, mlBridgeOk };
    state.addMode = false; state.error = null; state.selection = null;
    const m = routeModel(state.result);
    if (prevSel != null && stopIndex(prevSel) >= 0) {
      const b = m.byStop.get(prevSel);
      state.selection = { stopId: prevSel, stepIndex: stopIndex(prevSel) === 0 ? 0 : b ? b.stepIndex : null };
    }
    state.progress.done = true; state.progress.end = performance.now();
    saveRun(state.result);
    ok = true;
    const dist = response.total_distance_meters || 0;
    let delta = '';
    if (prev && prev.ctx.region === ctx.region) {
      const d = dist - (prev.response.total_distance_meters || 0);
      if (Math.abs(d) >= 50) delta = ` (${d < 0 ? MINUS : '+'}${fmtKm(d)} vs previous run)`;
    }
    const mode = layoutMode();
    if (mode === 'tablet') { state.drawers.results = true; if (!MQ.wide.matches) state.drawers.plan = false; }
    // The toast region is a polite live region, so the toast itself is the announcement.
    toast({ tone: 'success', title: `Route optimized · ${m.jobsTotal} of ${m.dropsAtRun} stops · ${fmtKm(dist)}${delta}`,
      action: mode === 'mobile' ? { label: 'Itinerary', onClick: () => setPanel('results', true) } : undefined });
  } catch (err) {
    const p = state.progress;
    if (err && err.name === 'AbortError') {
      state.progress = null;
      toast({ tone: 'info', title: 'Optimization cancelled' }); // announced by the toast region
    } else {
      if (p) { p.failed = busy.stage; p.end = performance.now(); }
      let title = 'Optimization failed', body = '', detail = '';
      if (err instanceof ApiError) {
        if (err.status === 'network') { title = "Can't reach the routing API"; body = 'Check that the route_api container is running.'; detail = err.detail; }
        else if (err.status === 404) { body = 'None of these stops were found in the database. Retry to recreate them.'; detail = `HTTP 404: ${err.detail}`; }
        else if (err.status === 'mapping') { body = err.message; detail = err.detail; }
        else { body = err.message.length > 220 ? `${err.message.slice(0, 220)}…` : err.message; detail = `HTTP ${err.status}: ${err.detail}`; }
      } else { body = String((err && err.message) || err); detail = String((err && err.stack) || ''); }
      state.error = { title, body, detail };
      // One channel only: #results-alert (role=alert) when the itinerary is visible, otherwise a toast.
      if (!panelOpen('results')) toast({ tone: 'danger', title, body, action: { label: 'Details', onClick: () => setPanel('results', true) } });
      console.error('[optimize]', err);
    }
  } finally {
    state.busy = null;
    clearInterval(progressTimer);
    render();
    if (ok) {
      fitAll();
      progressFade = setTimeout(() => {
        byId('progress-card').classList.add('is-leaving');
        progressFade = setTimeout(() => { state.progress = null; renderProgress(); }, prefersReducedMotion() ? 0 : 180);
      }, 1200);
    } else if (state.progress) {
      progressFade = setTimeout(() => { state.progress = null; renderProgress(); }, 4000);
    }
  }
}

function importFile(file) {
  const reader = new FileReader();
  const fail = () => toast({ tone: 'danger', title: `Couldn't read ${file.name}`, body: 'Expected a JSON array like [{"lat": 6.93, "lon": 79.85}].' });
  reader.onerror = fail;
  reader.onload = () => {
    let data;
    try { data = JSON.parse(String(reader.result)); } catch (e) { fail(); return; }
    if (!Array.isArray(data)) { fail(); return; }
    const rows = []; let skipped = 0;
    for (const p of data) {
      const lat = p && typeof p === 'object' ? toNum(p.lat) : null, lon = p && typeof p === 'object' ? toNum(p.lon) : null;
      if (lat == null || lon == null || lat < -90 || lat > 90 || lon < -180 || lon > 180) { skipped += 1; continue; }
      const name = typeof p.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 40) : null;
      rows.push({ lat: round6(lat), lon: round6(lon), name });
    }
    if (!data.length) { toast({ tone: 'danger', title: `${file.name} has no pins`, body: 'Expected a JSON array like [{"lat": 6.93, "lon": 79.85}].' }); return; }
    if (!rows.length) { toast({ tone: 'danger', title: `No valid pins in ${file.name}`, body: `Skipped ${plural(skipped, 'invalid row')}. Expected [{"lat": 6.93, "lon": 79.85}].` }); return; }
    if (state.busy) { blockedWhileBusy(); return; }
    map.closePopup();
    const token = update((s) => {
      s.stops = rows.map((r, i) => ({ id: i, lat: r.lat, lon: r.lon, name: r.name }));
      s.nextId = rows.length; s.result = null; s.selection = null; s.renaming = null; s.error = null; s.addMode = true;
    }, { undoLabel: 'Import pins' });
    fitAll({ padding: 50 });
    const title = `Imported ${pinsText(rows.length)}${skipped ? ` · skipped ${plural(skipped, 'invalid row')}` : ''}`;
    toast({ tone: skipped ? 'warning' : 'success', title, action: { label: 'Undo', onClick: () => undoTo(token) } });
  };
  reader.readAsText(file);
}
function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, hidden: true });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function exportPins() {
  if (!state.stops.length) { toast({ tone: 'info', title: 'Add stops first' }); return; }
  const data = state.stops.map((s) => (s.name ? { lat: s.lat, lon: s.lon, name: s.name } : { lat: s.lat, lon: s.lon }));
  download(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `nexus-pins_${state.region}_${getSchedule().date || todayStr()}.json`);
  toast({ tone: 'success', title: `Exported ${plural(data.length, 'pin')}` });
}
function exportCsv() {
  const r = state.result;
  if (!r) { toast({ tone: 'info', title: 'Optimize a route first' }); return; }
  const v = viewModel(), m = v.model, ctx = r.ctx;
  const runName = (sid) => { const x = m.stopsAtRunById.get(sid); return x ? displayName(x.stop, x.idx) : ''; };
  const rows = [['seq', 'stop_id', 'name', 'type', 'order_id', 'lat', 'lon', 'eta', 'leg_km', 'leg_drive_min', 'service_min', 'cumulative_km', 'status']];
  m.steps.forEach((s, i) => {
    const prev = i > 0 ? m.steps[i - 1] : null; const ss = m.stepStop[i];
    const name = ss.stopId != null ? (nameOfId(ss.stopId) || runName(ss.stopId)) : '';
    rows.push([s.type === 'start' ? 0 : s.type === 'end' ? m.jobsTotal + 1 : ss.seq, ss.stopId != null ? ss.stopId : '', name, s.type,
      s.type === 'job' ? s.job : '', s.location[1], s.location[0], etaDateTime(ctx, s.arrival),
      prev ? Number((((s.distance || 0) - (prev.distance || 0)) / 1000).toFixed(3)) : 0,
      prev ? Math.round((s.arrival - (prev.arrival + (prev.service || 0))) / 60) : 0,
      Math.round((s.service || 0) / 60), Number(((s.distance || 0) / 1000).toFixed(3)), v.stale ? 'outdated' : 'scheduled']);
  });
  m.unassigned.forEach((u) => {
    const name = u.stopId != null ? (nameOfId(u.stopId) || runName(u.stopId)) : '';
    rows.push(['', u.stopId != null ? u.stopId : '', name, 'unassigned', u.orderId != null ? u.orderId : '',
      u.location ? u.location[1] : '', u.location ? u.location[0] : '', '', '', '', '', '', v.stale ? 'outdated' : 'unassigned']);
  });
  const csv = '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `nexus-itinerary_${ctx.region}_${ctx.date}_${ctx.start.replace(':', '')}.csv`);
  toast({ tone: 'success', title: `Exported itinerary · ${plural(rows.length - 1, 'row')}` });
}

// Run history (browser-local)
function loadHistory() {
  let raw;
  try { raw = localStorage.getItem(KEYS.history); } catch (e) { return { ok: false, items: [] }; }
  if (!raw) return { ok: true, items: [] };
  try {
    const arr = JSON.parse(raw);
    return { ok: true, items: Array.isArray(arr) ? arr.filter(validRunEntry) : [] };
  } catch (e) { return { ok: true, items: [] }; }
}
/** Stored runs are untrusted (hand-edited or from an older build): accept only entries render() can draw safely. */
function validRunEntry(e) {
  const fin = (x) => typeof x === 'number' && Number.isFinite(x);
  const isLonLat = (l) => Array.isArray(l) && l.length >= 2 && fin(l[0]) && fin(l[1]);
  try {
    if (!e || e.v !== 1 || !fin(e.id) || typeof e.savedAt !== 'string' || Number.isNaN(Date.parse(e.savedAt))) return false;
    const c = e.ctx;
    if (!c || !REGIONS[c.region] || !/^\d{4}-\d{2}-\d{2}$/.test(c.date) || !/^\d{2}:\d{2}$/.test(c.start) || !/^\d{2}:\d{2}$/.test(c.end)) return false;
    if (!Array.isArray(e.stops) || e.stops.length < 2) return false;
    const ids = new Set();
    for (const s of e.stops) {
      if (!s || !Number.isInteger(s.id) || s.id < 0 || ids.has(s.id) || !fin(s.lat) || !fin(s.lon) || Math.abs(s.lat) > 90 || Math.abs(s.lon) > 180) return false;
      if (s.name != null && typeof s.name !== 'string') return false;
      ids.add(s.id);
    }
    if (!e.jobToStop || typeof e.jobToStop !== 'object' || !Object.values(e.jobToStop).every((sid) => ids.has(sid))) return false;
    const r = e.response;
    if (!r || typeof r !== 'object' || !Array.isArray(r.route_sequence)) return false;
    if (r.geometry != null && typeof r.geometry !== 'string') return false;
    for (const st of r.route_sequence) {
      if (!st || typeof st !== 'object') return false;
      if (st.location != null && !isLonLat(st.location)) return false;
      if (Array.isArray(st.location) && (!fin(st.arrival || 0) || !fin(st.distance || 0) || !fin(st.service || 0))) return false;
    }
    if (r.unassigned_details != null && (!Array.isArray(r.unassigned_details) || !r.unassigned_details.every((u) => u && (u.location == null || isLonLat(u.location))))) return false;
    return true;
  } catch (err) { return false; }
}
function writeHistory(items) {
  try { localStorage.setItem(KEYS.history, JSON.stringify(items)); return items; } catch (e) {
    const quota = e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014);
    if (quota && items.length > 1) {
      const fewer = items.slice(0, -1);
      try { localStorage.setItem(KEYS.history, JSON.stringify(fewer)); return fewer; } catch (e2) { /* fall through */ }
    }
    return null;
  }
}
function saveRun(result) {
  // Re-read storage right before writing so runs saved by another tab since our last read are kept.
  const cur = loadHistory();
  historyCache = cur;
  if (!cur.ok) return;
  const prevId = cur.items.reduce((mx, x) => Math.max(mx, x.id), 0);
  const entry = { v: 1, id: Math.max(Date.now(), prevId + 1), savedAt: result.optimizedAt.toISOString(), ctx: result.ctx,
    stops: result.stopsAtRun, nextId: state.nextId, jobToStop: result.jobToStop, response: result.response,
    elapsedMs: Math.round(result.elapsedMs), mlBridgeOk: result.mlBridgeOk };
  const saved = writeHistory([entry, ...cur.items].slice(0, HISTORY_MAX));
  if (saved) historyCache.items = saved;
  else toast({ tone: 'warning', title: "Couldn't save this run to history", body: 'Browser storage is full or blocked.' });
  if (byId('history-drawer').open) renderHistory();
}
function renderHistory() {
  const { ok, items } = historyCache;
  byId('history-unavailable').hidden = ok;
  byId('history-empty').hidden = !ok || items.length > 0;
  byId('btn-history-clear').setAttribute('aria-disabled', String(!ok || !items.length));
  const frag = document.createDocumentFragment();
  items.forEach((e) => {
    const when = new Date(e.savedAt); const resp = e.response || {}; const c = e.ctx;
    const drops = e.stops.length - 1; const un = resp.unassigned_jobs || 0;
    frag.append(h('li', { class: 'history-card', 'data-run-id': e.id },
      h('div', { class: 'history-text', id: `run-${e.id}-text` },
        h('strong', null, fmtWhen(when)),
        h('span', null, `${regionShort(c.region)} · plan for ${fmtDayShort(c.date)}, ${c.start}–${c.end}`),
        h('div', { class: 'h-stats' }, `${drops - un}/${drops} stops · ${fmtKm(resp.total_distance_meters)} · ${fmtDur(resp.total_duration_seconds)}`)),
      h('div', { class: 'history-actions' },
        h('button', { type: 'button', class: 'btn btn-secondary btn-sm', 'data-action': 'restore', 'data-focus-key': `run-${e.id}-restore`,
          'aria-label': `Restore run from ${hhmm(when)}`, 'aria-describedby': `run-${e.id}-text` }, 'Restore'),
        h('button', { type: 'button', class: 'icon-btn icon-btn-sm', 'data-action': 'delete', 'data-focus-key': `run-${e.id}-delete`,
          'aria-label': `Delete run from ${hhmm(when)}`, 'data-tip': '' }, icon('delete', 'icon-16')))));
  });
  swapList(byId('history-list'), frag);
}
function restoreRun(id) {
  if (blockedWhileBusy()) return;
  const e = historyCache.items.find((x) => x.id === id); if (!e) return;
  const token = pushUndo('Restore run', { schedule: true });
  const prevAddMode = state.addMode;
  let moved = false;
  try {
    const stops = clone(e.stops);
    state.region = REGIONS[e.ctx.region] ? e.ctx.region : 'colombo';
    state.stops = stops;
    state.nextId = Math.max(e.nextId || 0, ...stops.map((s) => s.id + 1));
    const today = todayStr();
    byId('planning-date').value = e.ctx.date < today ? (moved = true, today) : e.ctx.date;
    byId('start-time').value = e.ctx.start; byId('end-time').value = e.ctx.end;
    startIsAuto = false;
    state.result = { response: e.response, ctx: e.ctx, sig: signatureOf(e.ctx, e.stops), jobToStop: e.jobToStop, stopsAtRun: clone(e.stops),
      optimizedAt: new Date(e.savedAt), elapsedMs: e.elapsedMs || 0, mlBridgeOk: e.mlBridgeOk != null ? e.mlBridgeOk : null };
    state.selection = null; state.renaming = null; state.error = null; state.addMode = false;
    byId('history-drawer').close();
    map.closePopup(); render(); fitAll();
  } catch (err) {
    // A damaged entry must never leave the app half-restored: roll back to the snapshot taken above.
    console.error('[history] restore failed', err);
    state.addMode = prevAddMode;
    undoTo(token);
    toast({ tone: 'danger', title: "Couldn't restore this run", body: 'The saved entry is damaged. Your current plan was kept.' });
    return;
  }
  const t = hhmm(new Date(e.savedAt));
  if (moved) toast({ tone: 'warning', title: `This plan was for ${fmtDayShort(e.ctx.date)}; date set to today — re-optimize for current ETAs` });
  toast({ tone: 'success', title: `Restored run from ${t}` }); // the toast region announces it
}
function deleteRun(id) {
  // Re-read first so runs another tab saved meanwhile aren't overwritten.
  const cur = loadHistory();
  if (!cur.ok) { historyCache = cur; renderHistory(); render(); return; }
  const items = cur.items.filter((x) => x.id !== id);
  const saved = items.length ? writeHistory(items) : (store.remove(KEYS.history) ? items : null);
  historyCache = { ok: true, items: saved || cur.items };
  renderHistory(); render();
  announce('Run deleted');
}
async function clearHistory() {
  if (!historyCache.items.length) return;
  const n = historyCache.items.length;
  const choice = await confirmDialog({ title: 'Clear run history?', body: `This removes ${plural(n, 'saved run')} from this browser. It can't be undone.`,
    actions: [{ id: 'cancel', label: 'Cancel', variant: 'ghost', autofocus: true }, { id: 'clear', label: 'Clear history', variant: 'danger' }] });
  if (choice !== 'clear') return;
  store.remove(KEYS.history); historyCache.items = [];
  renderHistory(); render();
  toast({ tone: 'info', title: 'History cleared' });
}

function handleEscape(e) {
  const hadTip = !byId('tooltip').hidden;
  hideTip();
  if (openPop) { e.preventDefault(); closePopover(); return; }
  if (state.renaming != null) { cancelRename(); return; }
  // A visible tooltip is dismissed by Esc on its own (it never aborts a run or closes a panel),
  // but an open selection/popup is cleared in the same press.
  if (hadTip) { if (state.selection || openPopupRef) clearSelection(); return; }
  if (state.busy) { state.busy.ctrl.abort(); return; }
  const mode = layoutMode();
  if (mode === 'tablet' && (state.drawers.plan || state.drawers.results)) {
    const inside = ['plan', 'results'].find((w) => byId(`${w}-panel`).contains(document.activeElement));
    setPanel(inside || (state.drawers.results ? 'results' : 'plan'), false); return;
  }
  if (mode === 'mobile' && state.sheet) { setPanel(state.sheet, false); return; }
  if (state.selection || openPopupRef) clearSelection();
}
function isTypingTarget(t) { return !!(t && t.closest && t.closest('input, select, textarea, [contenteditable=""], [contenteditable="true"]')); }
function onKeydown(e) {
  const dlgOpen = !!document.querySelector('dialog[open]');
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { if (dlgOpen) return; e.preventDefault(); runOptimize(); return; }
  if (e.key === 'Escape') { if (!dlgOpen) handleEscape(e); return; }
  if (dlgOpen) return;
  const typing = isTypingTarget(e.target);
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { if (typing) return; e.preventDefault(); undoLatest(); return; }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  if (!state.singleKeys && e.key !== 'Delete') return;
  switch (e.key) {
    case 'a': case 'A': e.preventDefault(); setAddMode(!state.addMode); break;
    case 'f': case 'F': e.preventDefault(); fitAll(); break;
    case '[': e.preventDefault(); togglePanel('plan'); break;
    case ']': e.preventDefault(); togglePanel('results'); break;
    case '?': e.preventDefault(); openDialog(byId('shortcuts-dialog'), document.activeElement); break;
    case 'Delete': {
      const li = document.activeElement && document.activeElement.closest && document.activeElement.closest('#stops-list [data-stop-id]');
      if (li) { e.preventDefault(); deleteStop(Number(li.dataset.stopId)); }
      break;
    }
    default: break;
  }
}
function rowNav(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const rows = [...document.querySelectorAll('#route-steps .step-btn, #unassigned-list .unassigned-btn')];
  const i = rows.indexOf(document.activeElement); if (i < 0) return;
  e.preventDefault();
  const next = rows[e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)];
  if (next) next.focus();
}

function bindControllers() {
  byId('city-selector').addEventListener('change', (e) => switchRegion(e.target.value));
  for (const id of ['planning-date', 'start-time', 'end-time']) {
    byId(id).addEventListener('change', onScheduleChange);
    byId(id).addEventListener('input', () => { if (!state.busy) render(); });
  }
  byId('btn-import').addEventListener('click', (e) => { if (isDisabled(e.currentTarget)) { blockedWhileBusy(); return; } byId('file-import').click(); });
  byId('file-import').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; if (f) importFile(f); e.target.value = ''; });
  byId('btn-export').addEventListener('click', (e) => { if (state.busy) { blockedWhileBusy(); return; } exportPins(); });
  byId('btn-clear').addEventListener('click', clearAll);
  byId('add-coords-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (blockedWhileBusy()) return;
    const input = byId('add-coords'), err = byId('add-coords-error');
    const p = parseLatLon(input.value);
    if (!p) {
      err.textContent = 'Enter latitude, longitude — e.g. 6.9271, 79.8612'; err.hidden = false;
      input.setAttribute('aria-invalid', 'true'); input.focus(); return;
    }
    err.textContent = ''; err.hidden = true; input.removeAttribute('aria-invalid'); input.value = '';
    addStop(p.lat, p.lon);
    focusPoint([p.lat, p.lon], Math.max(map.getZoom(), 15));
    const km = haversineKm(REGIONS[state.region].center, [p.lat, p.lon]);
    if (km > 100) toast({ tone: 'warning', title: `This point is ${Math.round(km).toLocaleString('en-US')} km from ${regionShort(state.region)}` });
  });
  byId('add-coords').addEventListener('input', () => {
    const err = byId('add-coords-error');
    if (!err.hidden) { err.hidden = true; err.textContent = ''; byId('add-coords').removeAttribute('aria-invalid'); }
  });

  const stopsList = byId('stops-list');
  stopsList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]'); if (!btn) return;
    const li = btn.closest('[data-stop-id]'); if (!li) return;
    const id = Number(li.dataset.stopId);
    if (btn.dataset.action === 'select') selectStop(id, 'stop-row');
    else if (btn.dataset.action === 'rename') startRename(id);
    else if (btn.dataset.action === 'depot') setDepot(id);
    else if (btn.dataset.action === 'delete') deleteStop(id);
  });
  stopsList.addEventListener('keydown', (e) => {
    const inp = e.target.closest('.stop-rename'); if (!inp) return;
    const id = Number(inp.dataset.stopRename);
    if (e.key === 'Enter') { e.preventDefault(); commitRename(id, inp.value); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelRename(); }
  });
  stopsList.addEventListener('focusout', (e) => {
    const inp = e.target.closest && e.target.closest('.stop-rename');
    if (inp && inp.isConnected) commitRename(Number(inp.dataset.stopRename), inp.value);
  });

  const steps = byId('route-steps');
  steps.addEventListener('click', (e) => { const b = e.target.closest('[data-step]'); if (b) selectStep(Number(b.dataset.step)); });
  steps.addEventListener('keydown', rowNav);
  const un = byId('unassigned-list');
  un.addEventListener('click', (e) => { const b = e.target.closest('[data-unassigned]'); if (b) selectUnassigned(Number(b.dataset.unassigned)); });
  un.addEventListener('keydown', rowNav);
  byId('history-list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]'); const card = b && b.closest('[data-run-id]'); if (!card) return;
    const id = Number(card.dataset.runId);
    if (b.dataset.action === 'restore') restoreRun(id); else if (b.dataset.action === 'delete') deleteRun(id);
  });

  const onAction = (e) => {
    const b = e.target.closest('[data-action]'); if (!b) return;
    switch (b.dataset.action) {
      case 'reoptimize': case 'retry': runOptimize(); break;
      case 'dismiss': update((s) => { s.error = null; }); break;
      case 'cancel': if (state.busy) state.busy.ctrl.abort(); break;
      case 'switch-colombo': switchRegion('colombo'); break;
      case 'add-mode': setAddMode(true); break;
      case 'show-unassigned': { const sec = byId('unassigned-section'); sec.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' }); byId('unassigned-title').focus({ preventScroll: true }); break; }
      default: break;
    }
  };
  byId('map-overlay-top').addEventListener('click', onAction);
  document.querySelector('.results-callouts').addEventListener('click', onAction);

  const optClick = (e) => { const r = optimizeBlockReason(); if (r) { toast({ tone: 'info', title: r }); return; } runOptimize(e.currentTarget); };
  byId('btn-optimize').addEventListener('click', optClick);
  byId('btn-optimize-mobile').addEventListener('click', optClick);
  byId('btn-export-csv').addEventListener('click', exportCsv);

  byId('status-pill').addEventListener('click', (e) => {
    const pop = byId('status-popover');
    if (openPop && openPop.panel === pop) { closePopover(); return; }
    openPopover(e.currentTarget, pop, { focus: () => byId('btn-status-recheck') });
    if (!state.healthCheckedAt || Date.now() - state.healthCheckedAt > HEALTH_STALE_MS) getHealth();
  });
  byId('btn-status-recheck').addEventListener('click', () => getHealth());
  const openHistory = (opener) => { historyCache = loadHistory(); renderHistory(); openDialog(byId('history-drawer'), opener); };
  byId('btn-history').addEventListener('click', (e) => openHistory(e.currentTarget));
  byId('btn-engine-info').addEventListener('click', (e) => openDialog(byId('engine-dialog'), e.currentTarget));
  byId('btn-theme').addEventListener('click', () => applyTheme(!isDark(), true));
  byId('btn-shortcuts').addEventListener('click', (e) => openDialog(byId('shortcuts-dialog'), e.currentTarget));
  byId('btn-history-clear').addEventListener('click', (e) => { if (!isDisabled(e.currentTarget)) clearHistory(); });

  const menu = byId('more-menu'); const more = byId('btn-more');
  const menuItems = () => [...menu.querySelectorAll('[role="menuitem"]')];
  more.addEventListener('click', () => {
    if (openPop && openPop.panel === menu) { closePopover(); return; }
    openPopover(more, menu, { focus: () => menuItems()[0] });
  });
  more.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openPopover(more, menu, { focus: () => (e.key === 'ArrowDown' ? menuItems()[0] : menuItems().slice(-1)[0]) }); }
  });
  menu.addEventListener('keydown', (e) => {
    const items = menuItems(); const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'Tab') closePopover({ returnFocus: false });
  });
  menu.addEventListener('click', (e) => {
    const it = e.target.closest('[data-menu]'); if (!it) return;
    const act = it.dataset.menu;
    closePopover({ returnFocus: act === 'theme' || act === 'github' });
    if (act === 'history') openHistory(more);
    else if (act === 'engine') openDialog(byId('engine-dialog'), more);
    else if (act === 'shortcuts') openDialog(byId('shortcuts-dialog'), more);
    else if (act === 'theme') applyTheme(!isDark(), true);
  });

  byId('btn-plan-toggle').addEventListener('click', () => togglePanel('plan'));
  byId('btn-results-toggle').addEventListener('click', () => togglePanel('results'));
  byId('btn-sheet-plan').addEventListener('click', () => togglePanel('plan'));
  byId('btn-sheet-results').addEventListener('click', () => togglePanel('results'));
  byId('btn-plan-close').addEventListener('click', () => setPanel('plan', false));
  byId('btn-results-close').addEventListener('click', () => setPanel('results', false));
  byId('btn-plan-expand').addEventListener('click', () => setPanel('plan', true));
  byId('btn-results-expand').addEventListener('click', () => setPanel('results', true));
  byId('btn-kpi-expand').addEventListener('click', () => update((s) => { s.kpiExpanded = !s.kpiExpanded; }));
  byId('skip-link').addEventListener('click', (e) => {
    e.preventDefault();
    if (!panelOpen('results')) setPanel('results', true, { focus: false });
    const target = byId('route-steps').querySelector('.step-btn') ? byId('route-steps') : byId('results-title');
    target.focus();
  });

  byId('opt-arrows').addEventListener('change', (e) => { state.arrows = e.target.checked; store.set(KEYS.arrows, state.arrows ? 'on' : 'off'); render(); });
  byId('opt-single-keys').addEventListener('change', (e) => {
    state.singleKeys = e.target.checked; store.set(KEYS.keys, state.singleKeys ? 'on' : 'off'); render();
    announce(state.singleKeys ? 'Single-key shortcuts on' : 'Single-key shortcuts off');
  });
  // Another tab saved or deleted a run: refresh the cached list and the badge.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEYS.history && e.key !== null) return;
    historyCache = loadHistory();
    if (byId('history-drawer').open) renderHistory();
    render();
  });

  document.addEventListener('pointerdown', (e) => {
    if (openPop && !openPop.panel.contains(e.target) && !openPop.trigger.contains(e.target)) {
      closePopover({ returnFocus: false });
      if (byId('map').contains(e.target)) popoverDismissedAt = Date.now();
    }
  }, true);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', () => { if (openPop) closePopover({ returnFocus: false }); hideTip(); });
  const onLayout = () => { state.drawers = { plan: false, results: false }; state.sheet = null; closePopover({ returnFocus: false }); render(); };
  MQ.desktop.addEventListener('change', onLayout);
  MQ.mobile.addEventListener('change', onLayout);
  MQ.wide.addEventListener('change', () => { if (!MQ.wide.matches && state.drawers.plan && state.drawers.results) { state.drawers.plan = false; render(); } });
  MQ.dark.addEventListener('change', (e) => { if (store.get(KEYS.theme) == null) applyTheme(e.matches, false); });
  // Theme changes only re-read the route/marker colour tokens; the OSM tile layer is never swapped or filtered.
  document.addEventListener('themechange', () => { routeKey = null; render(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!state.healthCheckedAt || Date.now() - state.healthCheckedAt > HEALTH_STALE_MS)) getHealth();
  });
  setupDialogs();
  setupTooltip();
}

// ===== boot
function initInputs() {
  const d = byId('planning-date'); const today = todayStr();
  d.min = today; d.value = today;
  const msgs = enforceTimeConstraints();
  if (msgs.length) showScheduleHint(msgs.join(' '));
  // Keep an untouched start time on "now" before the first run; after a run, changing it would mark the route out of date.
  setInterval(() => {
    if (startIsAuto && !state.busy && !state.result && enforceTimeConstraints().length) render();
  }, 30000);
}
function restorePrefs() {
  state.arrows = store.get(KEYS.arrows, 'on') !== 'off';
  state.singleKeys = store.get(KEYS.keys, 'on') !== 'off';
  byId('opt-single-keys').checked = state.singleKeys;
  const lg = store.get(KEYS.legend, null);
  state.legendOpen = lg ? lg === 'open' : !MQ.mobile.matches;
}
document.addEventListener('DOMContentLoaded', () => {
  if (!window.L) {
    document.body.prepend(h('p', { class: 'chip chip--danger', style: 'position:fixed;top:64px;left:16px;z-index:70' }, 'The map library failed to load. Check your connection and reload.'));
    return;
  }
  document.querySelectorAll('.mod-key').forEach((k) => { k.textContent = MOD; });
  initInputs();
  initMap();
  restorePrefs();
  bindControllers();
  historyCache = loadHistory();
  render();
  getHealth();
  setInterval(() => { if (document.visibilityState === 'visible') getHealth(); }, HEALTH_POLL_MS);
});
