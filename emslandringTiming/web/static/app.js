/* ════════════════════════════════════════════════════════════════════════════
   emslandringTiming – Frontend
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  runs:          [],
  selectedRunId: null,
  activeRun:     null,
  karts:         [],
  decoder:       { connected: false, noise: 0, loop: 0 },
  currentDate:   today(),
  ws:            null,
  wsOk:          false,
  expandedKart:  null,
  ctxRunId:      null,
  classes:       [],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

function fmtTime(us) {
  if (!us) return '–';
  const ms  = Math.floor(us / 1000);
  const min = Math.floor(ms / 60000);
  const sec = (ms % 60000) / 1000;
  return `${min}:${sec.toFixed(3).padStart(6, '0')}`;
}

function fmtSec(sec) {
  if (sec == null || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
}

function fmtUs(us) {
  if (!us) return '–';
  const h = Math.floor(us / 3_600_000_000);
  const m = Math.floor((us % 3_600_000_000) / 60_000_000);
  const s = Math.floor((us % 60_000_000) / 1_000_000);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtTs(unixTs) {
  if (!unixTs) return '';
  const d = new Date(unixTs * 1000);
  return d.toTimeString().slice(0, 8);
}

function sigClass(v, noise = 8) {
  if (v >= 150) return 'sig-good';
  if (v >= noise + 60) return 'sig-ok';
  return 'sig-bad';
}

function trendSymbol(t) {
  if (t === 'up')     return '<span class="trend-up">↑</span>';
  if (t === 'down')   return '<span class="trend-down">↓</span>';
  if (t === 'stable') return '<span class="trend-stable">→</span>';
  return '<span class="trend-stable">–</span>';
}

function modeLabel(m) {
  if (m === 'gp_time') return 'GP Zeit';
  if (m === 'gp_laps') return 'GP Runden';
  return 'Training';
}

// Kategorie-Zuordnung für Sidebar-Farbcodierung
const KIDS_CLASSES = new Set(['Minikart', 'Leihkart', 'Doppelkart']);
const ADULT_CLASSES = new Set(['Rennkart', 'Superkart']);

function runCategoryClass(classes) {
  if (!classes || !classes.length) return '';
  const hasKids   = classes.some(c => KIDS_CLASSES.has(c));
  const hasAdults = classes.some(c => ADULT_CLASSES.has(c));
  if (hasKids && !hasAdults)   return 'cat-kinder';
  if (hasAdults && !hasKids)   return 'cat-erwachsene';
  return 'cat-mixed';
}

function classColor(className) {
  const cl = state.classes.find(c => c.name === className);
  return cl ? cl.color : '#8b949e';
}

// ── Toasts ────────────────────────────────────────────────────────────────
function showToast(msg, kind = 'ok') {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = 'toast toast-' + kind;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.classList.add('fade'), 4000);
  setTimeout(() => el.remove(), 5000);
}

// ── WebSocket ────────────────────────────────────────────────────────────────

let _wsRetry = 1000;
let _reconnectScheduled = false;

function scheduleReconnect() {
  if (_reconnectScheduled) return;
  _reconnectScheduled = true;
  const delay = Math.min(_wsRetry, 10000);
  _wsRetry = Math.min(Math.max(_wsRetry * 1.5, 1000), 10000);
  setTimeout(() => {
    _reconnectScheduled = false;
    connectWs();
  }, delay);
}

function connectWs() {
  if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) {
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws;
  try {
    ws = new WebSocket(`${proto}://${location.host}/ws?client=app`);
  } catch (_) {
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  ws.onopen = () => {
    state.wsOk = true;
    _wsRetry = 1000;
    // Sofort "VERBINDE..." entfernen, sobald WS steht
    updateDecoderStatus(state.decoder);
  };

  ws.onmessage = e => {
    try { handleMsg(JSON.parse(e.data)); } catch (_) {}
  };

  ws.onerror = () => {
    // let onclose handle reconnection
  };

  ws.onclose = () => {
    state.wsOk = false;
    updateDecoderStatus({ connected: false });
    scheduleReconnect();
  };
}

function handleMsg(msg) {
  switch (msg.type) {

    case 'snapshot':
      state.decoder = msg.decoder || state.decoder;
      // Decoder-Status zuerst aktualisieren – damit er auch bei späterem Fehler sichtbar ist
      updateDecoderStatus(state.decoder);
      if (msg.ampel) updateAmpelDebug(msg.ampel);
      // Defekt-Konfig vom Server holen damit Transponder-Modal sie nutzen kann
      fetch('/api/settings').then(r => r.json()).then(s => {
        state.settings = state.settings || {};
        state.settings.defect_categories        = s.defect_categories        || {};
        state.settings.signal_defect_categories = s.signal_defect_categories || {};
      }).catch(() => {});
      if (msg.runs_today) {
        state.runs = msg.runs_today;
        renderRunList();
      }
      if (msg.run) {
        state.activeRun = msg.run;
        if (!state.selectedRunId && msg.run.id) state.selectedRunId = msg.run.id;
      }
      if (msg.karts && msg.run && state.selectedRunId === (msg.run && msg.run.id)) {
        state.karts = msg.karts;
        renderKartTable();
      }
      updateRunHeader();
      updateFloatTimer();
      updateDocTitle();
      break;

    case 'run_list':
      state.runs = msg.runs;
      renderRunList();
      break;

    case 'run_state':
      state.activeRun = msg;
      { const ri = state.runs.findIndex(r => r.id === msg.id);
        if (ri >= 0) state.runs[ri].status = msg.status; }
      renderRunList();
      updateRunHeader();
      updateFloatTimer();
      updateDocTitle();
      break;

    case 'run_updated':
      { const ru = state.runs.findIndex(r => r.id === msg.run.id);
        if (ru >= 0) state.runs[ru] = { ...state.runs[ru], ...msg.run }; }
      renderRunList();
      if (state.selectedRunId === msg.run.id) updateRunHeader();
      break;

    case 'run_finished':
      { const rf = state.runs.findIndex(r => r.id === msg.run_id);
        if (rf >= 0) state.runs[rf].status = 'done'; }
      renderRunList();
      updateRunHeader();
      updateFloatTimer();
      updateDocTitle();
      if (state.selectedRunId === msg.run_id) refreshSelectedRun();
      break;

    case 'kart_table':
      if (state.activeRun && state.selectedRunId === state.activeRun.id) {
        state.karts = msg.karts;
        renderKartTable();
      }
      break;

    case 'passing':
      if (state.activeRun && state.selectedRunId === state.activeRun.id)
        flashKartRow(msg.kart_nr);
      break;

    case 'timer_tick':
      if (state.activeRun) {
        state.activeRun.remaining_sec = msg.remaining_sec;
        state.activeRun.elapsed_sec   = msg.elapsed_sec;
        if (msg.finish_remaining_sec != null)
          state.activeRun.finish_remaining_sec = msg.finish_remaining_sec;
        if (msg.finish_phase != null)
          state.activeRun.finish_phase = msg.finish_phase;
        updateTimer();
        updateFinishTimer();
        updateSidebarTimers();
        updateFloatTimer();
        updateDocTitle();
        updateProgressBar(state.runs.find(r => r.id === state.activeRun.id) || state.activeRun);
      }
      break;

    case 'decoder_health':
      state.decoder = msg;
      updateDecoderStatus(msg);
      break;

    case 'ampel_state':
      updateAmpelDebug(msg);
      break;

    case 'client_count':
      updateClientBar(msg);
      break;

    case 'ping':
      break;

    case 'print_ok':
      showToast(`✓ Druck an ${msg.printer || 'Drucker'} gesendet`, 'ok');
      break;

    case 'print_error':
      showToast(`✗ Druck-Fehler: ${msg.error || 'unbekannt'}`, 'err');
      break;

    case 'debug_decoder':
      appendDebugEntry('decoder', msg);
      break;

    case 'debug_emulator':
      appendDebugEntry('emulator', msg);
      break;
  }
}

// ── Decoder Status ────────────────────────────────────────────────────────────

function updateDecoderStatus(d) {
  if (!d) return;
  const el    = document.getElementById('decoder-status');
  const txt   = document.getElementById('decoder-text');
  const noise = document.getElementById('decoder-noise');
  const loop  = document.getElementById('decoder-loop');
  if (d.connected) {
    el.classList.add('connected');
    txt.textContent = 'VERBUNDEN';
    noise.textContent = `N:${d.noise}`;
    loop.textContent  = `L:${d.loop}`;
    noise.style.color = d.noise < 40 ? 'var(--green)' : d.noise < 80 ? 'var(--yellow)' : 'var(--red)';
    loop.style.color  = d.loop > 100 ? 'var(--green)' : d.loop > 50  ? 'var(--yellow)' : 'var(--red)';
  } else {
    el.classList.remove('connected');
    txt.textContent = 'GETRENNT';
    noise.textContent = '';
    loop.textContent  = '';
  }
}

// ── Ampel Debug ───────────────────────────────────────────────────────────────

function updateAmpelDebug(d) {
  if (!d) return;

  // State-Helfer: bei 'both' leuchten beide
  const redOn   = d.state === 'red'   || d.state === 'both';
  const greenOn = d.state === 'green' || d.state === 'both';

  // ── Footer indicators ──
  const barRed   = document.getElementById('ampel-bar-red');
  const barGreen = document.getElementById('ampel-bar-green');
  if (barRed)   barRed.classList.toggle('lit',   redOn);
  if (barGreen) barGreen.classList.toggle('lit', greenOn);

  // ── Debug panel ──
  const redEl   = document.getElementById('debug-ampel-red');
  const greenEl = document.getElementById('debug-ampel-green');
  const label   = document.getElementById('debug-ampel-state-label');
  const okLbl   = document.getElementById('debug-ampel-ok-label');
  const enabledCb  = document.getElementById('debug-ampel-enabled');
  const enabledLbl = document.getElementById('debug-ampel-enabled-label');

  if (redEl) {
    redEl.style.background   = redOn ? '#e53935' : '#3a0000';
    redEl.style.borderColor  = redOn ? '#ff6659' : '#600';
    redEl.style.boxShadow    = redOn ? '0 0 10px #e53935' : 'none';
  }
  if (greenEl) {
    greenEl.style.background  = greenOn ? '#43a047' : '#003a00';
    greenEl.style.borderColor = greenOn ? '#76d275' : '#060';
    greenEl.style.boxShadow   = greenOn ? '0 0 10px #43a047' : 'none';
  }
  if (label) {
    const map = { off: 'AUS', green: 'GRÜN', red: 'ROT', both: '⚠ ROT + GRÜN' };
    label.textContent = map[d.state] || d.state;
    if (d.state === 'both')      label.style.color = 'var(--orange)';
    else if (d.state === 'green') label.style.color = 'var(--green)';
    else if (d.state === 'red')   label.style.color = 'var(--red)';
    else                          label.style.color = 'var(--text-dim)';
  }
  if (okLbl) {
    if (d.ok === true)        okLbl.textContent = d.forced ? '✓ Gesendet (manuell)' : '✓ Gesendet';
    else if (d.ok === false) {
      const errDetail = d.last_err ? ` (${d.last_err})` : '';
      okLbl.textContent = `✗ Relaismodul nicht erreichbar${errDetail}`;
    }
    else if (d.ok === null && !d.enabled) okLbl.textContent = '(Senden deaktiviert)';
    else                      okLbl.textContent = '';
    okLbl.style.color = d.ok === true ? 'var(--green)' : d.ok === false ? 'var(--red)' : 'var(--text-muted)';
  }
  // Letzten gesendeten Befehl anzeigen
  const cmdEl = document.getElementById('debug-ampel-cmd');
  if (cmdEl && d.last_cmd) cmdEl.textContent = d.last_cmd;

  if (enabledCb && enabledCb.checked !== d.enabled) enabledCb.checked = d.enabled;
  if (enabledLbl) {
    enabledLbl.textContent = d.enabled ? 'Senden aktiv' : 'Senden deaktiviert';
    enabledLbl.style.color = d.enabled ? 'var(--green)' : 'var(--text-muted)';
  }
}

// ── Client Bar ────────────────────────────────────────────────────────────────

function updateClientBar(msg) {
  const app   = msg.app || 0;
  const dash  = msg.dashboard || 0;
  const total = msg.total || (app + dash + (msg.other || 0));
  const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setText('client-count-app', app);
  setText('client-count-dashboard', dash);
  setText('client-count-total', total);
}

// ── Floating Timer ────────────────────────────────────────────────────────────

// Tab-Titel mit Restzeit aktualisieren – damit der Operator den Countdown
// auch im Browser-Tab sieht wenn er auf einer anderen Seite arbeitet.
const DEFAULT_DOC_TITLE = 'emslandringTiming';
function updateDocTitle() {
  const r = state.activeRun;
  if (!r || !['running','paused','finishing'].includes(r.status)) {
    document.title = DEFAULT_DOC_TITLE;
    return;
  }
  const runName = (state.runs.find(x => x.id === r.id) || {}).name || r.name || '';
  const mode = r.mode || '';
  const modeLabel =
    (mode === 'gp_time' || mode === 'gp_laps') ? 'Grand Prix' :
    (mode === 'training') ? 'Training' : '';
  const t = fmtSec(r.remaining_sec || 0);
  if (r.status === 'running') {
    document.title = `⏱ ${t} · ${runName}${modeLabel ? ' – ' + modeLabel : ''}`;
  } else if (r.status === 'paused') {
    document.title = `⏸ ${t} · ${runName}`;
  } else if (r.status === 'finishing') {
    const ft = fmtSec(r.finish_remaining_sec || 0);
    document.title = `🏁 ${ft} ${runName}`;
  }
}

function updateFloatTimer() {
  const el    = document.getElementById('float-timer');
  const val   = document.getElementById('float-timer-value');
  const label = document.getElementById('float-timer-label');
  const status = document.getElementById('float-timer-status');
  if (!state.activeRun || ['none','done','skipped'].includes(state.activeRun.status)) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  const r = state.activeRun;
  const sec = r.remaining_sec || 0;
  label.textContent = (state.runs.find(x => x.id === r.id) || {}).name || '–';
  val.textContent = fmtSec(sec);
  // Letzte Minute = orange+blinkend, letzte 10s = rot+schneller
  val.className = sec <= 10 ? 'crit' : sec <= 60 ? 'warn' : '';
  const statusMap = { armed: 'SCHARF', running: 'LÄUFT', paused: 'PAUSE',
                      finishing: 'ENDET...', done: 'FERTIG' };
  status.textContent = statusMap[r.status] || r.status || '';

  // Ring-Rahmen je nach Status
  el.classList.remove('state-armed', 'state-running', 'state-paused', 'state-finishing');
  if (r.status === 'armed') {
    el.classList.add('state-armed');
    el.style.setProperty('--ring-angle', '360deg');
  } else if (r.status === 'running') {
    el.classList.add('state-running');
    const total = r.duration_sec
      || (state.runs.find(x => x.id === r.id) || {}).duration_sec
      || sec || 1;
    const pct = Math.max(0, Math.min(1, sec / total));
    // Gegen den Uhrzeigersinn abbauen: 360° = voll, 0° = leer
    el.style.setProperty('--ring-angle', (pct * 360).toFixed(2) + 'deg');
  } else if (r.status === 'finishing') {
    el.classList.add('state-finishing');
    el.style.setProperty('--ring-angle', '360deg');
  } else if (r.status === 'paused') {
    el.classList.add('state-paused');
    el.style.setProperty('--ring-angle', '360deg');
  } else {
    el.style.setProperty('--ring-angle', '0deg');
  }
}

// Float timer click → jump to timing tab
document.getElementById('float-timer').addEventListener('click', () => {
  document.querySelectorAll('#nav-tabs button').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const btn = document.querySelector('#nav-tabs button[data-view="timing"]');
  if (btn) btn.classList.add('active');
  const view = document.getElementById('view-timing');
  if (view) view.classList.add('active');
});

// ── Sidebar ───────────────────────────────────────────────────────────────────

function renderRunList() {
  const list = document.getElementById('run-list');
  const picker = document.getElementById('day-picker');
  if (picker && picker.value !== state.currentDate) picker.value = state.currentDate;

  const isToday = state.currentDate === today();
  document.getElementById('btn-add-run').style.display = isToday ? '' : 'none';

  const otherActive = state.runs.some(r =>
    ['armed','running','paused','finishing'].includes(r.status)
  );

  list.innerHTML = state.runs.map(r => {
    const isActive   = state.activeRun && state.activeRun.id === r.id;
    const isSelected = state.selectedRunId === r.id;
    const status     = isActive ? (state.activeRun.status || r.status) : r.status;
    const isGp       = r.mode === 'gp_time' || r.mode === 'gp_laps';

    let icon = '';
    let timeStr = '';
    if (status === 'done') {
      icon = '<span class="status-done">✓</span>';
      // Start- und End-Uhrzeit anzeigen (z.B. "12:10 – 12:19")
      const fmtHM = ts => {
        const d = new Date(ts * 1000);
        return String(d.getHours()).padStart(2,'0') + ':' +
               String(d.getMinutes()).padStart(2,'0');
      };
      if (r.started_at && r.finished_at) {
        timeStr = `${fmtHM(r.started_at)} – ${fmtHM(r.finished_at)}`;
      }
    }
    else if (status === 'skipped') icon = '<span style="color:var(--text-muted)">⏭</span>';
    else if (status === 'armed')   icon = '<span class="status-armed pulse">◉</span>';
    else if (status === 'running') {
      icon = '<span class="status-running pulse">●</span>';
      if (isActive) timeStr = fmtSec(state.activeRun.remaining_sec);
    } else if (status === 'paused') {
      icon = '<span class="status-paused">⏸</span>';
      if (isActive) timeStr = fmtSec(state.activeRun.remaining_sec);
    } else if (status === 'finishing') {
      icon = '<span class="status-finishing pulse">⚑</span>';
    } else {
      icon = '<span style="color:var(--text-muted)">○</span>';
    }

    const badge  = isGp ? `<span class="run-item-badge">GP</span>` : '';
    const canArm = isToday && status === 'pending' && !otherActive;
    let actionBtn = '';
    if (isToday && status === 'pending') {
      actionBtn = `<button class="run-item-arm ${canArm ? '' : 'disabled'}"
                 data-run-id="${r.id}" data-action="arm" title="Scharf schalten"
                 ${canArm ? '' : 'disabled'}>▶</button>`;
    } else if (isToday && status === 'armed') {
      // Scharf aber noch nicht aktiv → gelber Disarm-Button im Sidebar.
      actionBtn = `<button class="run-item-arm disarm"
                 data-run-id="${r.id}" data-action="disarm"
                 title="Unscharf schalten">✕</button>`;
    }

    const catCls = runCategoryClass(r.classes_raced || []);

    return `<div class="run-item ${r.mode} ${catCls} ${isSelected ? 'selected' : ''}"
                 data-run-id="${r.id}" data-run-status="${status}">
      <span class="run-item-icon">${icon}</span>
      <span class="run-item-name">${r.name}</span>
      ${badge}
      <span class="run-item-time" id="sidebar-time-${r.id}">${timeStr}</span>
      ${actionBtn}
    </div>`;
  }).join('');

  list.querySelectorAll('.run-item').forEach(el => {
    el.addEventListener('click', e => {
      if (e.target.closest('.run-item-arm')) return;
      selectRun(+el.dataset.runId);
    });
    el.addEventListener('contextmenu', e => openCtxMenu(e, +el.dataset.runId));
  });

  list.querySelectorAll('.run-item-arm').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const runId = +btn.dataset.runId;
      const action = btn.dataset.action || 'arm';
      const url = action === 'disarm'
        ? `/api/runs/${runId}/disarm`
        : `/api/runs/${runId}/arm`;
      const res = await fetch(url, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.detail ||
          (action === 'disarm' ? 'Fehler beim Unscharf schalten'
                                : 'Fehler beim Scharf schalten'));
        return;
      }
      if (action === 'arm') selectRun(runId);
    });
  });
}

function updateSidebarTimers() {
  if (!state.activeRun) return;
  const { id, remaining_sec, status } = state.activeRun;
  if (!['running', 'paused', 'finishing'].includes(status)) return;
  const el = document.getElementById(`sidebar-time-${id}`);
  if (el) el.textContent = fmtSec(remaining_sec);
}

async function selectRun(runId) {
  state.selectedRunId = runId;
  renderRunList();
  await refreshSelectedRun();
}

async function refreshSelectedRun() {
  const runId = state.selectedRunId;
  if (!runId) return;
  try {
    const r = await fetch(`/api/runs/${runId}`).then(r => r.json());
    state.karts = r.karts || [];
    renderKartTable();
    if (state.activeRun && state.activeRun.id === runId) {
      updateRunHeader();
    } else {
      updateRunHeaderForRun(r);
    }
  } catch(_) {}
}

function updateRunHeader() {
  if (!state.activeRun || state.selectedRunId !== state.activeRun.id) {
    const run = state.runs.find(r => r.id === state.selectedRunId);
    if (run) updateRunHeaderForRun(run);
    return;
  }
  const r = state.activeRun;
  updateRunHeaderForRun({ ...state.runs.find(x => x.id === r.id), ...r });
}

function updateRunHeaderForRun(run) {
  if (!run) return;
  document.getElementById('run-title').textContent = run.name || '–';

  const badge = document.getElementById('run-mode-badge');
  const isGp  = run.mode === 'gp_time' || run.mode === 'gp_laps';
  badge.className = 'run-item-badge' + (isGp ? ' gp' : '');
  badge.textContent = modeLabel(run.mode);

  const statusMap = { pending:'Bereit', armed:'● Scharf', running:'▶ Läuft',
    paused:'⏸ Pausiert', finishing:'⚑ Endet...', done:'✓ Beendet',
    skipped:'⏭ Übersprungen', none:'–' };
  document.getElementById('run-status-text').textContent =
    statusMap[run.status] || run.status || '';

  updateTimer();
  updateFinishTimer();
  updateProgressBar(run);
  updateButtons(run);
}

function updateProgressBar(run) {
  const bar = document.getElementById('run-progress-bar');
  if (!bar) return;
  const isActive = state.activeRun && run && state.activeRun.id === run.id;
  const status = isActive ? state.activeRun.status : (run ? run.status : 'none');
  const total = (run && run.duration_sec) || 0;

  if (!isActive || !total || ['none','done','skipped','pending'].includes(status)) {
    bar.style.width = '0%';
    bar.classList.remove('finishing');
    return;
  }
  if (status === 'finishing') {
    bar.style.width = '100%';
    bar.classList.add('finishing');
    return;
  }
  bar.classList.remove('finishing');
  const remaining = state.activeRun.remaining_sec || 0;
  const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
  bar.style.width = pct + '%';
}

function updateFinishTimer() {
  const box = document.getElementById('run-finish-timer');
  const val = document.getElementById('run-finish-value');
  const lbl = document.getElementById('run-finish-label');
  if (!box || !val) return;
  const r = state.activeRun;
  if (!r || r.status !== 'finishing' || state.selectedRunId !== r.id) {
    box.style.display = 'none'; return;
  }
  box.style.display = '';
  val.textContent = fmtSec(r.finish_remaining_sec || 0);
  lbl.textContent = 'Warte auf Karts';
}

function updateTimer() {
  const el = document.getElementById('run-timer');
  if (!state.activeRun || state.selectedRunId !== state.activeRun.id) {
    el.textContent = '--:--'; el.className = ''; return;
  }
  const sec = state.activeRun.remaining_sec || 0;
  el.textContent = fmtSec(sec);
  el.className = sec <= 30 ? 'crit' : sec <= 120 ? 'warn' : '';
}

function updateButtons(run) {
  const status   = run ? run.status : 'none';
  const isActive = state.activeRun && state.activeRun.id === (run && run.id);
  const isGp     = run && (run.mode === 'gp_time' || run.mode === 'gp_laps');
  const isToday  = state.currentDate === today();
  const isDone   = status === 'done';

  const arm    = document.getElementById('btn-arm');
  const disarm = document.getElementById('btn-disarm');
  const start  = document.getElementById('btn-start');
  const pause  = document.getElementById('btn-pause');
  const resume = document.getElementById('btn-resume');
  const abort  = document.getElementById('btn-abort');
  const print  = document.getElementById('btn-print');

  // Reset
  arm.style.display    = '';
  disarm.style.display = 'none';
  start.style.display  = 'none';
  pause.style.display  = '';
  resume.style.display = 'none';
  print.style.display  = 'none';

  arm.disabled   = true;
  pause.disabled = true;
  abort.disabled = true;

  // Print button: show for done runs
  if (isDone) print.style.display = '';

  if (!run || !isToday) return;

  if (status === 'pending') {
    const otherActive = state.runs.some(r =>
      r.id !== run.id && ['armed','running','paused','finishing'].includes(r.status)
    );
    arm.disabled = otherActive;
  }

  if (status === 'armed' && isActive) {
    disarm.style.display = '';
    if (isGp) { arm.style.display = 'none'; start.style.display = ''; }
    abort.disabled = false;
  }

  if (status === 'running' && isActive) {
    arm.style.display  = 'none';
    pause.disabled     = false;
    abort.disabled     = false;
  }

  if (status === 'paused' && isActive) {
    arm.style.display    = 'none';
    pause.style.display  = 'none';
    resume.style.display = '';
    abort.disabled       = false;
  }

  if (status === 'finishing' && isActive) {
    arm.style.display = 'none';
    abort.disabled    = false;
  }
}

// ── Kart Table ────────────────────────────────────────────────────────────────

function renderKartTable() {
  const empty = document.getElementById('empty-state');
  const table = document.getElementById('kart-table');
  const tbody = document.getElementById('kart-tbody');

  if (!state.karts || state.karts.length === 0) {
    const run = state.runs.find(r => r.id === state.selectedRunId);
    empty.style.display = 'flex';
    empty.innerHTML = run && run.status === 'pending'
      ? `<div class="empty-icon">🏁</div><p>Lauf scharf schalten zum Starten</p>`
      : `<div class="empty-icon">🏁</div><p>Keine Karts in diesem Lauf</p>`;
    table.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  table.style.display = '';

  const noise      = state.decoder.noise || 8;
  const isFinishing = state.activeRun && state.activeRun.status === 'finishing'
                    && state.selectedRunId === state.activeRun.id;

  // GP-Modus: andere Spalten-Sichtbarkeit (Abstand statt Ø5/Trend).
  const run     = state.runs.find(r => r.id === state.selectedRunId);
  const isGp    = run && (run.mode === 'gp_time' || run.mode === 'gp_laps');
  const head    = document.querySelector('#kart-table thead tr');
  if (head) {
    head.querySelector('.col-avg5').style.display  = isGp ? 'none' : '';
    head.querySelector('.col-trend').style.display = isGp ? 'none' : '';
    head.querySelector('.col-gap').style.display   = isGp ? '' : 'none';
  }

  tbody.innerHTML = state.karts.map(k => {
    const posClass  = k.position <= 3 ? `pos-${k.position}` : '';
    const sc        = sigClass(k.strength, noise);
    const finishCls = isFinishing && k.seen_after_finish ? 'finished' : '';

    // GP: Abstand zum Führenden
    let gapText = '';
    if (isGp) {
      if (k.position === 1)            gapText = '–';
      else if (k.gap_laps && k.gap_laps > 0) gapText = `+${k.gap_laps} Rdn`;
      else if (k.gap_us != null)       gapText = '+' + fmtTime(k.gap_us);
      else                             gapText = '–';
    }

    return `
    <tr class="kart-row ${finishCls}" data-kart-nr="${k.kart_nr}">
      <td class="pos ${posClass}">${k.position}</td>
      <td class="num">${k.kart_nr}</td>
      <td class="kart-name">${k.name}</td>
      <td class="num">${k.laps}</td>
      <td class="best-time num">${fmtTime(k.best_us)}</td>
      <td class="time num">${fmtTime(k.last_us)}</td>
      <td class="time num col-avg5" ${isGp ? 'style="display:none"' : ''}>${fmtTime(k.avg5_us)}</td>
      <td class="num col-trend" ${isGp ? 'style="display:none"' : ''}>${trendSymbol(k.trend)}</td>
      <td class="time num col-gap" ${isGp ? '' : 'style="display:none"'}>${gapText}</td>
      <td class="prog-cell">
        <div class="prog-bar-bg">
          <div class="prog-bar-fill" id="prog-${k.kart_nr}"
               data-last-ts="${k.last_passing_ts}"
               data-avg-us="${k.avg5_us || 0}"></div>
        </div>
      </td>
      <td class="sig-cell ${sc}">${k.strength || '–'}</td>
    </tr>
    <tr class="lap-detail" id="lap-detail-${k.kart_nr}" style="display:none">
      <td colspan="11">
        <div class="lap-detail-inner" id="lap-inner-${k.kart_nr}"></div>
      </td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.kart-row').forEach(row => {
    row.addEventListener('click', () => toggleLapDetail(+row.dataset.kartNr));
  });

  if (state.expandedKart) showLapDetail(state.expandedKart);
}

function toggleLapDetail(kart_nr) {
  const row = document.getElementById(`lap-detail-${kart_nr}`);
  if (!row) return;
  if (state.expandedKart === kart_nr) {
    row.style.display = 'none'; state.expandedKart = null;
  } else {
    if (state.expandedKart) {
      const old = document.getElementById(`lap-detail-${state.expandedKart}`);
      if (old) old.style.display = 'none';
    }
    state.expandedKart = kart_nr;
    showLapDetail(kart_nr);
  }
}

function showLapDetail(kart_nr) {
  const row   = document.getElementById(`lap-detail-${kart_nr}`);
  const inner = document.getElementById(`lap-inner-${kart_nr}`);
  if (!row || !inner) return;
  const kart = state.karts.find(k => k.kart_nr === kart_nr);
  if (!kart) return;
  const laps = kart.lap_times_us || [];
  const best = kart.best_us;
  inner.innerHTML = laps.map((us, i) =>
    `<span class="lap-chip ${us === best ? 'best' : ''}">${i+1}: ${fmtTime(us)}</span>`
  ).join('') || '<span style="color:var(--text-muted);font-size:11px">Noch keine Runden</span>';
  row.style.display = '';
  // Mit display:block auf TR/TD verliert der Flex-Container seinen
  // Width-Kontext (TR/TD in einem TBODY mit display:table-row-group
  // bekommen kein sauberes width:100%). Daher setzen wir die Breite
  // explizit auf die aktuelle Tabellen-Breite.
  const tbl = document.getElementById('kart-table');
  if (tbl) {
    const w = tbl.offsetWidth + 'px';
    row.style.width = w;
    const td = row.querySelector('td');
    if (td) td.style.width = w;
    inner.style.width = w;
  }
}

function flashKartRow(kart_nr) {
  document.querySelectorAll(`tr.kart-row[data-kart-nr="${kart_nr}"]`).forEach(row => {
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 800);
  });
}

// ── Progress Bars (RAF) ───────────────────────────────────────────────────────

function updateProgressBars() {
  const run = state.runs.find(r => r.id === state.selectedRunId);
  const isLive = state.activeRun
              && state.selectedRunId === state.activeRun.id
              && ['running','finishing'].includes(state.activeRun.status);
  const now = Date.now() / 1000;
  document.querySelectorAll('.prog-bar-fill').forEach(el => {
    if (!isLive) { el.style.width = '0%'; el.className = 'prog-bar-fill'; return; }
    const lastTs = +el.dataset.lastTs;
    const avgUs  = +el.dataset.avgUs;
    if (!avgUs || !lastTs) { el.style.width = '0%'; return; }
    const elapsed = (now - lastTs) * 1_000_000;
    const pct = Math.min((elapsed / avgUs) * 100, 120);
    el.style.width = Math.min(pct, 100) + '%';
    el.className = 'prog-bar-fill' + (pct >= 110 ? ' over' : pct >= 90 ? ' warn' : '');
  });
  requestAnimationFrame(updateProgressBars);
}

// ── Context Menu ──────────────────────────────────────────────────────────────

const ctxMenu = document.getElementById('ctx-menu');

function openCtxMenu(e, runId) {
  e.preventDefault();
  state.ctxRunId = runId;
  const run = state.runs.find(r => r.id === runId);
  const skipItem = document.getElementById('ctx-skip');
  if (skipItem) {
    const canSkip = run && ['pending','armed'].includes(run.status);
    skipItem.style.color = canSkip ? '' : 'var(--text-dim)';
    skipItem.style.pointerEvents = canSkip ? '' : 'none';
  }
  ctxMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 200)}px`;
  ctxMenu.style.top  = `${Math.min(e.clientY, window.innerHeight - 140)}px`;
  ctxMenu.classList.add('visible');
}

document.addEventListener('click', () => ctxMenu.classList.remove('visible'));
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

document.getElementById('ctx-settings').addEventListener('click', () => {
  if (state.ctxRunId) openRunSettingsModal(state.ctxRunId);
  ctxMenu.classList.remove('visible');
});

document.getElementById('ctx-kart-name').addEventListener('click', () => {
  if (state.ctxRunId) openKartNameModal(state.ctxRunId);
  ctxMenu.classList.remove('visible');
});

document.getElementById('ctx-skip').addEventListener('click', async () => {
  ctxMenu.classList.remove('visible');
  if (!state.ctxRunId) return;
  const run = state.runs.find(r => r.id === state.ctxRunId);
  if (!run || !['pending','armed'].includes(run.status)) return;
  const res = await fetch(`/api/runs/${state.ctxRunId}/skip`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    alert(data.detail || 'Fehler beim Überspringen');
  }
});

// ── Modal helpers ─────────────────────────────────────────────────────────────

const modalOverlay = document.getElementById('modal-overlay');
let _modalRunId = null;

function showModal(id) {
  document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
  const m = document.getElementById(id);
  if (m) m.style.display = '';
  modalOverlay.classList.add('visible');
}

function closeModal() {
  modalOverlay.classList.remove('visible');
  document.querySelectorAll('.modal').forEach(m => m.style.display = 'none');
  _modalRunId = null;
}

modalOverlay.addEventListener('click', e => {
  if (e.target === modalOverlay) closeModal();
});

// ── Run Settings Modal ────────────────────────────────────────────────────────

function openRunSettingsModal(runId) {
  _modalRunId = runId;
  const run = state.runs.find(r => r.id === runId);
  if (!run) return;
  showModal('modal-run-settings');
  document.getElementById('ms-name').value = run.name || '';
  const mode = run.mode || 'training';
  document.getElementById('ms-mode').value = mode;
  const dur = run.duration_sec || 420;
  document.getElementById('ms-hours').value   = Math.floor(dur / 3600);
  document.getElementById('ms-minutes').value = Math.floor((dur % 3600) / 60);
  document.getElementById('ms-seconds').value = dur % 60;
  document.getElementById('ms-gp-laps').value = run.gp_laps || 15;
  updateModeFields(mode);
}

document.getElementById('ms-mode').addEventListener('change', e => updateModeFields(e.target.value, true));

async function updateModeFields(mode, loadDefault = false) {
  const isLaps = mode === 'gp_laps';
  document.getElementById('ms-laps-group').style.display     = isLaps ? '' : 'none';
  document.getElementById('ms-duration-group').style.display = isLaps ? 'none' : '';

  // Beim Moduswechsel: Standardzeit aus Einstellungen übernehmen
  if (loadDefault && !isLaps) {
    try {
      const s = await fetch('/api/settings').then(r => r.json());
      const dur = mode === 'gp_time' ? (s.gp_time_duration_sec || 720)
                                     : (s.training_duration_sec || 420);
      document.getElementById('ms-hours').value   = Math.floor(dur / 3600);
      document.getElementById('ms-minutes').value = Math.floor((dur % 3600) / 60);
      document.getElementById('ms-seconds').value = dur % 60;
    } catch(_) {}
  }
}

// Spinner buttons
document.querySelectorAll('.spinner-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const inp = document.getElementById(btn.dataset.target);
    if (!inp) return;
    const delta = +btn.dataset.delta;
    const min = +inp.min || 0;
    const max = inp.max !== '' ? +inp.max : Infinity;
    inp.value = Math.max(min, Math.min(max, (+inp.value || 0) + delta));
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
  });
});

document.getElementById('ms-save').addEventListener('click', async () => {
  if (!_modalRunId) return;
  const mode = document.getElementById('ms-mode').value;
  const h = +document.getElementById('ms-hours').value || 0;
  const m = +document.getElementById('ms-minutes').value || 0;
  const s = +document.getElementById('ms-seconds').value || 0;
  const duration_sec = h * 3600 + m * 60 + s;
  const gp_laps = +document.getElementById('ms-gp-laps').value || 15;
  const name = document.getElementById('ms-name').value.trim();
  await fetch(`/api/runs/${_modalRunId}`, {
    method: 'PATCH',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ mode, duration_sec, gp_laps, name }),
  });
  closeModal();
});

document.getElementById('ms-cancel').addEventListener('click', closeModal);

// ── Kart Name Modal ───────────────────────────────────────────────────────────

async function openKartNameModal(runId) {
  _modalRunId = runId;
  showModal('modal-kart-name');
  const list = document.getElementById('kart-name-list');
  list.innerHTML = '<p style="color:var(--text-muted);font-size:12px">Lade...</p>';

  let transponders = [];
  try { transponders = await fetch('/api/transponders').then(r => r.json()); } catch(_) {}

  // Lauf-spezifische Kart-Namen IMMER vom Server holen – auch wenn der
  // Lauf gerade aktiv ist. Sonst werden vor dem ersten Passing nur die
  // globalen Namen angezeigt obwohl Operator schon "Bastian" gespeichert
  // hatte. Quelle der Wahrheit ist die Tabelle run_kart_names in der DB.
  const runKartNames = {};
  try {
    const r = await fetch(`/api/runs/${runId}`).then(r => r.json());
    // kart_names: {kart_nr: name} – direkt aus run_kart_names Tabelle
    if (r.kart_names) {
      for (const [nr, name] of Object.entries(r.kart_names)) {
        runKartNames[+nr] = name;
      }
    }
    // Fallback für Karts die noch keinen Override haben aber schon
    // Passings → nimm den Live-Namen aus karts.
    (r.karts || []).forEach(k => {
      if (runKartNames[k.kart_nr] == null) runKartNames[k.kart_nr] = k.name;
    });
  } catch(_) {}

  if (!transponders.length) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:12px">Keine Transponder konfiguriert.</p>';
    return;
  }

  list.innerHTML = transponders.map(t => {
    const displayName = runKartNames[t.kart_nr] || t.name || `Kart ${t.kart_nr}`;
    return `<div class="form-group">
      <label>Kart ${t.kart_nr} <span style="color:var(--text-dim);font-size:10px">(${t.class})</span></label>
      <input type="text" class="kart-name-input" data-kart-nr="${t.kart_nr}"
             value="${displayName}" placeholder="${t.name || `Kart ${t.kart_nr}`}">
    </div>`;
  }).join('');
}

document.getElementById('kn-save').addEventListener('click', async () => {
  if (_modalRunId) {
    for (const inp of document.querySelectorAll('.kart-name-input')) {
      const name = inp.value.trim();
      if (name) await fetch(`/api/runs/${_modalRunId}/kart-name`, {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ kart_nr: +inp.dataset.kartNr, name }),
      });
    }
  }
  closeModal();
});

document.getElementById('kn-cancel').addEventListener('click', closeModal);

// ── Control Buttons ───────────────────────────────────────────────────────────

document.getElementById('btn-arm').addEventListener('click', async () => {
  if (!state.selectedRunId) return;
  const res = await fetch(`/api/runs/${state.selectedRunId}/arm`, { method: 'POST' });
  if (!res.ok) alert((await res.json().catch(() => ({}))).detail || 'Fehler');
});

document.getElementById('btn-disarm').addEventListener('click', async () => {
  if (!state.selectedRunId) return;
  const res = await fetch(`/api/runs/${state.selectedRunId}/disarm`, { method: 'POST' });
  if (!res.ok) alert((await res.json().catch(() => ({}))).detail || 'Fehler');
});

document.getElementById('btn-start').addEventListener('click', async () => {
  if (!state.selectedRunId) return;
  await fetch(`/api/runs/${state.selectedRunId}/start`, { method: 'POST' });
});

document.getElementById('btn-pause').addEventListener('click', async () => {
  if (!state.selectedRunId) return;
  await fetch(`/api/runs/${state.selectedRunId}/pause`, { method: 'POST' });
});

document.getElementById('btn-resume').addEventListener('click', async () => {
  if (!state.selectedRunId) return;
  await fetch(`/api/runs/${state.selectedRunId}/resume`, { method: 'POST' });
});

document.getElementById('btn-abort').addEventListener('click', async () => {
  if (!state.selectedRunId) return;
  if (!confirm('Lauf wirklich beenden?')) return;
  await fetch(`/api/runs/${state.selectedRunId}/abort`, { method: 'POST' });
});

document.getElementById('btn-print').addEventListener('click', async () => {
  if (!state.selectedRunId) return;
  const opts = document.getElementById('print-options');
  const runId = state.selectedRunId;

  // Karts aus aktivem Lauf oder DB laden
  // Feld heißt je nach Quelle "laps" (DB) oder "lap_count" (engine)
  const hasLaps = k => (k.lap_count || k.laps || 0) > 0;
  let karts = [];
  if (state.activeRun && state.activeRun.id === runId) {
    karts = (state.karts || []).filter(hasLaps);
  } else {
    try {
      const r = await fetch(`/api/runs/${runId}`).then(r => r.json());
      karts = (r.karts || []).filter(hasLaps);
    } catch(_) {}
  }

  // Einzelne Kart-Buttons (sortiert nach Position)
  const kartBtns = karts
    .sort((a, b) => a.kart_nr - b.kart_nr)
    .map(k => `<button class="kart-single" data-kart="${k.kart_nr}" data-action="print-kart">
      🖨 Kart ${k.kart_nr}${k.name && k.name !== 'Kart ' + k.kart_nr ? ' – ' + k.name : ''}
    </button>`).join('');

  opts.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:6px;">
      <button data-action="print-all">🖨 Alle Karts drucken (1 Auftrag)</button>
      <button data-action="preview-all">👁 Vorschau alle Karts</button>
      ${karts.length ? `<hr style="margin:4px 0;border-color:#333;">
      <div style="font-size:11px;color:#888;margin-bottom:2px;">Einzelnes Kart drucken:</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;">${kartBtns}</div>` : ''}
    </div>
  `;

  async function doPrint(url, btn) {
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = 'Wird gedruckt…';
    try {
      const res = await fetch(url, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        btn.textContent = `✓ An ${data.printer || 'Drucker'} gesendet`;
        setTimeout(closeModal, 1800);
      } else {
        btn.textContent = '✗ ' + (data.detail || 'Fehler');
        btn.disabled = false;
      }
    } catch (e) {
      btn.textContent = '✗ ' + e.message;
      btn.disabled = false;
    }
  }

  opts.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', async () => {
      const action = b.dataset.action;
      if (action === 'print-all') {
        await doPrint(`/api/runs/${runId}/print`, b);
      } else if (action === 'print-kart') {
        await doPrint(`/api/runs/${runId}/print?kart_nr=${b.dataset.kart}`, b);
      } else if (action === 'preview-all') {
        window.open(`/api/runs/${runId}/print-preview`, '_blank');
      }
    });
  });

  showModal('modal-print');
});

document.getElementById('print-close').addEventListener('click', closeModal);

document.getElementById('btn-add-run').addEventListener('click', async () => {
  const r = await fetch('/api/runs', { method: 'POST' }).then(r => r.json());
  state.runs.push(r);
  renderRunList();
});

// ── Day Navigation ────────────────────────────────────────────────────────────

document.getElementById('day-prev').addEventListener('click', () => changeDay(-1));
document.getElementById('day-next').addEventListener('click', () => changeDay(+1));

document.getElementById('day-picker').addEventListener('change', async e => {
  const next = e.target.value;
  if (!next || next > today()) { e.target.value = state.currentDate; return; }
  await loadDate(next);
});

function changeDay(delta) {
  const d = new Date(state.currentDate);
  d.setDate(d.getDate() + delta);
  const next = d.toISOString().slice(0, 10);
  if (next > today()) return;
  loadDate(next);
}

async function loadDate(dateStr) {
  state.currentDate = dateStr;
  state.selectedRunId = null;
  state.karts = [];
  try {
    state.runs = await fetch(`/api/runs?date=${dateStr}`).then(r => r.json());
  } catch(_) { state.runs = []; }
  renderRunList();
  renderKartTable();
  updateRunHeader();
}

// ── Nav Tabs ──────────────────────────────────────────────────────────────────

document.querySelectorAll('#nav-tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#nav-tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    const target = document.getElementById(`view-${btn.dataset.view}`);
    if (target) {
      target.classList.add('active');
      if (btn.dataset.view === 'settings')     loadSettings();
      if (btn.dataset.view === 'transponders') loadTransponders();
      if (btn.dataset.view === 'rankings')     loadRankings();
      if (btn.dataset.view === 'timing') {
        if (state.selectedRunId && (!state.karts || state.karts.length === 0)) {
          refreshSelectedRun();
        } else {
          renderKartTable();
        }
        updateRunHeader();
      }
    }
  });
});

// ── Rankings Page ─────────────────────────────────────────────────────────────

let _rkInit = false;

async function loadRankings() {
  // Klassen-Dropdown befüllen (einmalig / refreshbar)
  const classSel = document.getElementById('rk-class');
  if (classSel) {
    let classes = [];
    try { classes = await fetch('/api/classes').then(r => r.json()); } catch(_) {}
    const prev = classSel.value;
    classSel.innerHTML = '';
    if (!classes.length) {
      classSel.innerHTML = '<option value="">(keine Klassen konfiguriert)</option>';
    } else {
      classes.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.name;
        opt.textContent = c.name;
        classSel.appendChild(opt);
      });
      if (prev && classes.some(c => c.name === prev)) classSel.value = prev;
    }
  }

  if (!_rkInit) {
    _rkInit = true;
    document.getElementById('rk-class')?.addEventListener('change', renderRankings);
    document.getElementById('rk-period')?.addEventListener('change', renderRankings);
    document.getElementById('btn-rk-refresh')?.addEventListener('click', renderRankings);
  }

  renderRankings();
}

async function renderRankings() {
  const tbody = document.getElementById('rk-tbody');
  const empty = document.getElementById('rk-empty');
  const klass = document.getElementById('rk-class')?.value || '';
  const period = document.getElementById('rk-period')?.value || 'month';
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" style="padding:12px;color:var(--text-muted)">Lade…</td></tr>';
  empty.style.display = 'none';

  if (!klass) {
    tbody.innerHTML = '';
    empty.textContent = 'Bitte eine Klasse wählen.';
    empty.style.display = 'block';
    return;
  }

  let data = { entries: [] };
  try {
    data = await fetch(`/api/bestof?kart_class=${encodeURIComponent(klass)}&period=${period}`).then(r => r.json());
  } catch(e) {
    tbody.innerHTML = `<tr><td colspan="6" style="padding:12px;color:var(--red)">Fehler: ${e.message}</td></tr>`;
    return;
  }

  const entries = data.entries || [];
  if (!entries.length) {
    tbody.innerHTML = '';
    empty.textContent = 'Keine Einträge für die Auswahl.';
    empty.style.display = 'block';
    return;
  }

  tbody.innerHTML = entries.map((e, i) => {
    const dt = e.run_started_at
      ? new Date(e.run_started_at * 1000).toLocaleDateString('de-DE')
      : (e.run_date || '—');
    const pidAttr = e.pid != null ? `data-pid="${e.pid}"` : '';
    // Bei Customer-Claim: kleinen Reset-Button (✕) zusätzlich zum Lösch-Button.
    // Reset = nur Customer-Name entfernen, Runde bleibt in der Bestenliste.
    const claimBadge = e.claimed
      ? `<span style="display:inline-block;padding:1px 6px;margin-left:6px;background:rgba(255,214,0,.18);color:#ffd600;border-radius:8px;font-size:10px;font-weight:600">Customer</span>`
      : '';
    const resetBtn = e.claimed && e.pid != null
      ? `<button class="btn btn-sm rk-claim-del" ${pidAttr}
                title="Customer-Eintrag zurücksetzen (Runde bleibt)">✕ Name</button>`
      : '';
    const delBtn = e.pid != null
      ? `<button class="btn btn-sm btn-red rk-del" ${pidAttr} title="Komplette Runde löschen">🗑</button>`
      : '<span style="color:var(--text-muted);font-size:10px">—</span>';
    return `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:6px 8px;color:var(--text-dim)">${i + 1}</td>
      <td style="padding:6px 8px"><b>${e.kart_nr ?? '?'}</b> &nbsp;<span style="color:var(--text-dim)">${e.name || ''}</span>${claimBadge}</td>
      <td style="padding:6px 8px">${klass}</td>
      <td style="padding:6px 8px;text-align:right;font-family:monospace;font-weight:600">${fmtTime(e.lap_time_us)}</td>
      <td style="padding:6px 8px;color:var(--text-dim)">${dt}</td>
      <td style="padding:6px 8px;text-align:right;white-space:nowrap">${resetBtn} ${delBtn}</td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.rk-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pid = btn.dataset.pid;
      if (!pid) return;
      if (!confirm(`Rundenzeit-Eintrag wirklich endgültig löschen?\n(ID: ${pid})`)) return;
      btn.disabled = true;
      try {
        const res = await fetch(`/api/passing/${pid}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(await res.text());
        showToast && showToast('Eintrag gelöscht', 'ok');
        renderRankings();
      } catch(err) {
        showToast && showToast('Fehler: ' + err.message, 'err');
        btn.disabled = false;
      }
    });
  });

  // Customer-Claim zurücksetzen (Runde bleibt, nur Name geht weg)
  tbody.querySelectorAll('.rk-claim-del').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pid = btn.dataset.pid;
      if (!pid) return;
      if (!confirm('Customer-Namen zurücksetzen?\nDie Runde bleibt in der Bestenliste, nur der eingetragene Name wird gelöscht.')) return;
      btn.disabled = true;
      try {
        const res = await fetch(`/api/bestof/claim/${pid}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(await res.text());
        showToast && showToast('Customer-Name zurückgesetzt', 'ok');
        renderRankings();
      } catch(err) {
        showToast && showToast('Fehler: ' + err.message, 'err');
        btn.disabled = false;
      }
    });
  });
}

// ── Settings Page ─────────────────────────────────────────────────────────────

// Defekt-Erkennung Settings – aktuell ausgewählte Klasse + Edit-Buffer.
let _defectCategoriesEdit = {};
let _defectActiveClass = null;

function _renderDefectPills(classes) {
  const div = document.getElementById('s-defect-pills');
  if (!div) return;
  div.innerHTML = classes.map(c =>
    `<button type="button" class="range-pill ${c.name === _defectActiveClass ? 'active' : ''}"
             data-class="${c.name}">${c.name}</button>`
  ).join('');
  div.querySelectorAll('.range-pill').forEach(b => {
    b.addEventListener('click', () => {
      // Aktuelle Werte ins Edit-Buffer übernehmen, dann Klasse wechseln
      _captureDefectCategoryFields();
      _defectActiveClass = b.dataset.class;
      div.querySelectorAll('.range-pill').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      _showDefectCategoryFields();
    });
  });
}

function _showDefectCategoryFields() {
  const cls = _defectActiveClass;
  if (!cls) return;
  const cat = _defectCategoriesEdit[cls] ||
    (_defectCategoriesEdit[cls] = { enabled: false, threshold_sec: 60, window: 5, outlier_factor: 1.5 });
  document.getElementById('s-defect-cat-enabled').value   = cat.enabled ? '1' : '0';
  document.getElementById('s-defect-cat-threshold').value = cat.threshold_sec;
  document.getElementById('s-defect-cat-window').value    = cat.window;
  document.getElementById('s-defect-cat-outlier').value   = cat.outlier_factor ?? 1.5;
}

function _captureDefectCategoryFields() {
  const cls = _defectActiveClass;
  if (!cls) return;
  _defectCategoriesEdit[cls] = {
    enabled:        document.getElementById('s-defect-cat-enabled').value === '1',
    threshold_sec:  +document.getElementById('s-defect-cat-threshold').value || 60,
    window:         +document.getElementById('s-defect-cat-window').value    || 5,
    outlier_factor: +document.getElementById('s-defect-cat-outlier').value   || 1.5,
  };
}

// ── Signal-Defekt-Erkennung Settings (analog Defekt-Erkennung) ─────────────
let _sigdefCategoriesEdit = {};
let _sigdefActiveClass = null;
const _SIGDEF_DEFAULTS = {
  enabled: false, window: 50, baseline_window: 100,
  stddev_warn_factor: 1.5, stddev_alert_factor: 2.0,
  slope_warn: -0.05, slope_alert: -0.10,
  min_drop_warn: 15, min_drop_alert: 30,
  mean_drop_warn: 10, mean_drop_alert: 20,
};

function _renderSigdefPills(classes) {
  const div = document.getElementById('s-sigdef-pills');
  if (!div) return;
  div.innerHTML = classes.map(c =>
    `<button type="button" class="range-pill ${c.name === _sigdefActiveClass ? 'active' : ''}"
             data-class="${c.name}">${c.name}</button>`
  ).join('');
  div.querySelectorAll('.range-pill').forEach(b => {
    b.addEventListener('click', () => {
      _captureSigdefCategoryFields();
      _sigdefActiveClass = b.dataset.class;
      div.querySelectorAll('.range-pill').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      _showSigdefCategoryFields();
    });
  });
}

function _showSigdefCategoryFields() {
  const cls = _sigdefActiveClass;
  if (!cls) return;
  const cat = _sigdefCategoriesEdit[cls] ||
    (_sigdefCategoriesEdit[cls] = { ..._SIGDEF_DEFAULTS });
  document.getElementById('s-sigdef-cat-enabled').value      = cat.enabled ? '1' : '0';
  document.getElementById('s-sigdef-cat-window').value       = cat.window;
  document.getElementById('s-sigdef-cat-baseline').value     = cat.baseline_window;
  document.getElementById('s-sigdef-cat-stddev-warn').value  = cat.stddev_warn_factor;
  document.getElementById('s-sigdef-cat-stddev-alert').value = cat.stddev_alert_factor;
  document.getElementById('s-sigdef-cat-slope-warn').value   = cat.slope_warn;
  document.getElementById('s-sigdef-cat-slope-alert').value  = cat.slope_alert;
  document.getElementById('s-sigdef-cat-min-warn').value     = cat.min_drop_warn;
  document.getElementById('s-sigdef-cat-min-alert').value    = cat.min_drop_alert;
  document.getElementById('s-sigdef-cat-mean-warn').value    = cat.mean_drop_warn ?? 10;
  document.getElementById('s-sigdef-cat-mean-alert').value   = cat.mean_drop_alert ?? 20;
}

function _captureSigdefCategoryFields() {
  const cls = _sigdefActiveClass;
  if (!cls) return;
  // ‖x‖ ?? d : nicht || (sonst würde 0 z.B. zum Default wechseln, was bei
  // Slope/Drop-Werten manchmal gewollt ist).
  const num = (id, def) => {
    const v = document.getElementById(id).value;
    return v === '' || v == null ? def : +v;
  };
  _sigdefCategoriesEdit[cls] = {
    enabled:             document.getElementById('s-sigdef-cat-enabled').value === '1',
    window:              num('s-sigdef-cat-window',       _SIGDEF_DEFAULTS.window),
    baseline_window:     num('s-sigdef-cat-baseline',     _SIGDEF_DEFAULTS.baseline_window),
    stddev_warn_factor:  num('s-sigdef-cat-stddev-warn',  _SIGDEF_DEFAULTS.stddev_warn_factor),
    stddev_alert_factor: num('s-sigdef-cat-stddev-alert', _SIGDEF_DEFAULTS.stddev_alert_factor),
    slope_warn:          num('s-sigdef-cat-slope-warn',   _SIGDEF_DEFAULTS.slope_warn),
    slope_alert:         num('s-sigdef-cat-slope-alert',  _SIGDEF_DEFAULTS.slope_alert),
    min_drop_warn:       num('s-sigdef-cat-min-warn',     _SIGDEF_DEFAULTS.min_drop_warn),
    min_drop_alert:      num('s-sigdef-cat-min-alert',    _SIGDEF_DEFAULTS.min_drop_alert),
    mean_drop_warn:      num('s-sigdef-cat-mean-warn',    _SIGDEF_DEFAULTS.mean_drop_warn),
    mean_drop_alert:     num('s-sigdef-cat-mean-alert',   _SIGDEF_DEFAULTS.mean_drop_alert),
  };
}

async function loadSettings() {
  const s = await fetch('/api/settings').then(r => r.json());
  document.getElementById('s-runs-per-day').value = s.runs_per_day;

  // Darstellung
  const themeSel = document.getElementById('s-theme');
  const zoomInp  = document.getElementById('s-zoom');
  if (themeSel) themeSel.value = (localStorage.getItem('ui.theme') || 'dark');
  if (zoomInp)  zoomInp.value  = +localStorage.getItem('ui.zoom') || 100;

  // Hardware gesperrt starten
  const hwGrid = document.getElementById('hw-settings-grid');
  if (hwGrid) hwGrid.classList.add('hw-locked');
  const unlockBtn = document.getElementById('btn-unlock-hw');
  if (unlockBtn) unlockBtn.textContent = '🔒 Entsperren';
  const seqBtn = document.getElementById('btn-ampel-seq');
  if (seqBtn) { seqBtn.disabled = true; seqBtn.style.opacity = '0.45'; }

  const trainSec = s.training_duration_sec || 420;
  document.getElementById('s-train-h').value = Math.floor(trainSec / 3600);
  document.getElementById('s-train-m').value = Math.floor((trainSec % 3600) / 60);
  document.getElementById('s-train-s').value = trainSec % 60;

  const gpSec = s.gp_time_duration_sec || 720;
  document.getElementById('s-gp-h').value = Math.floor(gpSec / 3600);
  document.getElementById('s-gp-m').value = Math.floor((gpSec % 3600) / 60);
  document.getElementById('s-gp-s').value = gpSec % 60;

  document.getElementById('s-gp-laps').value     = s.gp_laps_count;
  document.getElementById('s-wait-time').value   = s.wait_time_sec;
  document.getElementById('s-wait-time-gp').value= s.wait_time_gp_sec;

  // Defekt-Erkennung pro Klasse: Pills + lokales State-Objekt damit
  // wir beim Klick zwischen Klassen wechseln können ohne sofort zu speichern.
  const cats = JSON.parse(JSON.stringify(s.defect_categories || {}));
  // Falls eine Klasse aus s.classes noch nicht in cats ist → leere Defaults
  for (const c of (s.classes || [])) {
    if (!cats[c.name]) {
      cats[c.name] = { enabled: false, threshold_sec: 60, window: 5 };
    }
  }
  _defectCategoriesEdit = cats;
  _defectActiveClass = (s.classes || [])[0]?.name || null;
  _renderDefectPills(s.classes || []);
  _showDefectCategoryFields();

  // Signal-Defekt-Erkennung pro Klasse (analog zur normalen Defekt-Erkennung)
  const sigCats = JSON.parse(JSON.stringify(s.signal_defect_categories || {}));
  for (const c of (s.classes || [])) {
    if (!sigCats[c.name]) sigCats[c.name] = { ..._SIGDEF_DEFAULTS };
  }
  _sigdefCategoriesEdit = sigCats;
  _sigdefActiveClass = (s.classes || [])[0]?.name || null;
  _renderSigdefPills(s.classes || []);
  _showSigdefCategoryFields();

  // In state.settings cachen damit Transponder-Modal Bescheid weiß
  state.settings = state.settings || {};
  state.settings.defect_categories        = s.defect_categories        || {};
  state.settings.signal_defect_categories = s.signal_defect_categories || {};
  document.getElementById('s-decoder-ip').value  = s.decoder_ip;
  document.getElementById('s-decoder-port').value= s.decoder_port;
  document.getElementById('s-http-port').value   = s.http_port;
  document.getElementById('s-ws-port').value     = s.websocket_port;
  document.getElementById('s-emulator-port').value= s.emulator_port;

  document.getElementById('s-ampel-ip').value           = s.ampel_ip || '192.168.178.128';
  document.getElementById('s-ampel-port').value         = s.ampel_port || 80;
  document.getElementById('s-ampel-username').value     = s.ampel_username || 'admin';
  document.getElementById('s-ampel-password').value     = s.ampel_password || '';
  document.getElementById('s-ampel-enabled').checked    = !!s.ampel_enabled;
  document.getElementById('s-ampel-relay-red').value    = s.ampel_relay_red   ?? 4;
  document.getElementById('s-ampel-relay-green').value  = s.ampel_relay_green ?? 6;
  document.getElementById('ampel-settings-grid')?.classList.add('hw-locked');

  // Emulator enable state
  const emuCb  = document.getElementById('debug-emulator-enabled');
  const emuLbl = document.getElementById('debug-emulator-enabled-label');
  if (emuCb) emuCb.checked = s.emulator_enabled !== false;
  if (emuLbl) { emuLbl.textContent = (s.emulator_enabled !== false) ? 'Aktiv' : 'Deaktiviert'; emuLbl.style.color = (s.emulator_enabled !== false) ? 'var(--green)' : 'var(--red)'; }

  const netArea = document.getElementById('s-network-printers');
  if (netArea) netArea.value = (s.network_printers || []).join('\n');

  // QR-Code (Bestenliste)
  const qrEn = document.getElementById('s-qr-enabled');
  const qrUrl = document.getElementById('s-qr-base-url');
  if (qrEn)  qrEn.value  = s.qr_enabled ? '1' : '0';
  if (qrUrl) qrUrl.value = s.qr_base_url || '';

  // Mitarbeiter-Mobile URL
  const mobUrl = document.getElementById('s-mobile-base-url');
  if (mobUrl) mobUrl.value = s.mobile_base_url || '';

  // Bestenliste-Modus
  const bom = document.getElementById('s-bestof-mode');
  if (bom) bom.value = s.bestof_mode || 'per_kart';

  await loadPrinters(s.printer);
}

async function loadPrinters(selected) {
  const sel = document.getElementById('s-printer');
  if (!sel) return;
  try {
    const data = await fetch('/api/printers').then(r => r.json());
    const current = selected != null ? selected : data.selected;
    sel.innerHTML = '<option value="">– kein Drucker –</option>' +
      (data.printers || []).map(p =>
        `<option value="${p.name}" ${p.name === current ? 'selected' : ''}>${p.name} (${p.kind})</option>`
      ).join('');
  } catch(_) {
    sel.innerHTML = '<option value="">(Fehler beim Laden)</option>';
  }
}

// Theme + Zoom live anwenden
document.getElementById('s-theme').addEventListener('change', e => applyTheme(e.target.value));
document.getElementById('s-zoom').addEventListener('change', e => applyZoom(e.target.value));
document.getElementById('s-zoom').addEventListener('input', e => applyZoom(e.target.value));

// Hardware-Entsperren mit Warnung
document.getElementById('btn-unlock-hw').addEventListener('click', () => {
  const grid = document.getElementById('hw-settings-grid');
  const btn  = document.getElementById('btn-unlock-hw');
  const seqBtn2 = document.getElementById('btn-ampel-seq');
  if (grid.classList.contains('hw-locked')) {
    if (!confirm('⚠ KRITISCHE EINSTELLUNGEN\n\n' +
                 'Änderungen an Decoder-IP, Ports und Netzwerk können dazu ' +
                 'führen, dass die Zeitnahme nicht mehr funktioniert.\n\n' +
                 'Bist du sicher, dass du weißt, was du tust?')) return;
    grid.classList.remove('hw-locked');
    document.getElementById('ampel-settings-grid')?.classList.remove('hw-locked');
    btn.textContent = '🔓 Gesperrt';
    if (seqBtn2) { seqBtn2.disabled = false; seqBtn2.style.opacity = ''; }
  } else {
    grid.classList.add('hw-locked');
    document.getElementById('ampel-settings-grid')?.classList.add('hw-locked');
    btn.textContent = '🔒 Entsperren';
    if (seqBtn2) { seqBtn2.disabled = true; seqBtn2.style.opacity = '0.45'; }
  }
});

document.getElementById('btn-printer-refresh').addEventListener('click', () => loadPrinters());

// Logo-Upload
document.getElementById('btn-logo-upload').addEventListener('click', () => {
  document.getElementById('logo-file').click();
});
document.getElementById('logo-file').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append('file', f);
  const res = await fetch('/api/logo', { method: 'POST', body: fd });
  if (res.ok) {
    const img = document.getElementById('logo-preview');
    img.src = '/api/logo?t=' + Date.now();
    img.style.display = '';
  } else {
    const d = await res.json().catch(() => ({}));
    alert('Fehler: ' + (d.detail || 'Upload fehlgeschlagen'));
  }
  e.target.value = '';
});
document.getElementById('btn-logo-delete').addEventListener('click', async () => {
  if (!confirm('Logo wirklich entfernen?')) return;
  await fetch('/api/logo', { method: 'DELETE' });
  const img = document.getElementById('logo-preview');
  img.src = ''; img.style.display = 'none';
});

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const th = +document.getElementById('s-train-h').value || 0;
  const tm = +document.getElementById('s-train-m').value || 0;
  const ts = +document.getElementById('s-train-s').value || 0;
  const gh = +document.getElementById('s-gp-h').value || 0;
  const gm = +document.getElementById('s-gp-m').value || 0;
  const gs = +document.getElementById('s-gp-s').value || 0;
  const body = {
    runs_per_day:          +document.getElementById('s-runs-per-day').value,
    training_duration_sec: th * 3600 + tm * 60 + ts,
    gp_time_duration_sec:  gh * 3600 + gm * 60 + gs,
    gp_laps_count:         +document.getElementById('s-gp-laps').value,
    wait_time_sec:         +document.getElementById('s-wait-time').value,
    wait_time_gp_sec:      +document.getElementById('s-wait-time-gp').value,
    decoder_ip:             document.getElementById('s-decoder-ip').value,
    decoder_port:          +document.getElementById('s-decoder-port').value,
    http_port:             +document.getElementById('s-http-port').value,
    websocket_port:        +document.getElementById('s-ws-port').value,
    emulator_port:         +document.getElementById('s-emulator-port').value,
    printer:                document.getElementById('s-printer').value || '',
    network_printers:      (document.getElementById('s-network-printers').value || '')
                             .split('\n').map(s => s.trim()).filter(Boolean),
    ampel_ip:           document.getElementById('s-ampel-ip').value,
    ampel_port:         +document.getElementById('s-ampel-port').value || 80,
    ampel_username:     document.getElementById('s-ampel-username').value || 'admin',
    ampel_password:     document.getElementById('s-ampel-password').value,
    ampel_enabled:      document.getElementById('s-ampel-enabled').checked,
    ampel_relay_red:    +document.getElementById('s-ampel-relay-red').value   || 4,
    ampel_relay_green:  +document.getElementById('s-ampel-relay-green').value || 6,
    qr_enabled:         document.getElementById('s-qr-enabled')?.value === '1',
    qr_base_url:       (document.getElementById('s-qr-base-url')?.value || '').trim(),
    mobile_base_url:   (document.getElementById('s-mobile-base-url')?.value || '').trim(),
    bestof_mode:        document.getElementById('s-bestof-mode')?.value || 'per_kart',
  };
  // Aktuell sichtbare Defekt-Kategorie ins Buffer übernehmen, dann ALLE
  // Kategorien mit speichern (Pill-Wechsel hat sie schon vorher geflusht).
  _captureDefectCategoryFields();
  _captureSigdefCategoryFields();
  body.defect_categories        = _defectCategoriesEdit;
  body.signal_defect_categories = _sigdefCategoriesEdit;
  await fetch('/api/settings', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body),
  });
  // Cache aktualisieren damit Transponder-Modal die neue Konfig nutzt
  state.settings = state.settings || {};
  state.settings.defect_categories        = JSON.parse(JSON.stringify(_defectCategoriesEdit));
  state.settings.signal_defect_categories = JSON.parse(JSON.stringify(_sigdefCategoriesEdit));
  // Falls Transponder-Modal offen ist → sofort neu zeichnen mit neuen Schwellwerten
  if (_tdChartData && _tdChartData.length) _redrawTdChart();
  // Mobile-QR-Vorschau neu laden (URL kann sich geändert haben).
  // Cache-Buster via Query-Parameter, sonst zeigt der Browser den alten QR.
  const qrImg = document.getElementById('mobile-qr-preview');
  if (qrImg) qrImg.src = '/api/mobile-qr?_t=' + Date.now();
  const saved = document.getElementById('settings-saved');
  saved.style.display = '';
  setTimeout(() => saved.style.display = 'none', 2000);
});

// ── Transponder Page ──────────────────────────────────────────────────────────

let _tdEditId   = null;
let _tdDays     = 0;
let _healthDays = 0;

async function loadTransponders() {
  await loadClasses();
  const data = await fetch('/api/transponders').then(r => r.json());
  renderTransponderTable(data);
  await loadHealthChart(_healthDays);
}

async function loadClasses() {
  state.classes = await fetch('/api/classes').then(r => r.json());
}

function renderTransponderTable(data) {
  const tbody = document.getElementById('transponder-tbody');
  tbody.innerHTML = data.map(t => {
    const color    = classColor(t.class);
    const totalStr = t.total_us ? fmtUs(t.total_us) : '–';
    const defectIcon = t.defect
      ? `<span class="defect-warn" title="Defekt-Verdacht – WMA über Schwelle">⚠</span>`
      : '';
    return `<tr class="transponder-row ${t.defect ? 'has-defect' : ''}" data-transponder-id="${t.transponder_id}" style="cursor:pointer">
      <td>${t.kart_nr}</td>
      <td>${defectIcon}${t.name}</td>
      <td><span class="class-badge" style="background:${color}22;color:${color};border:1px solid ${color}44">${t.class}</span></td>
      <td style="color:var(--text-dim)">${t.transponder_id}</td>
      <td class="num">${t.passing_count}</td>
      <td class="num">${totalStr}</td>
      <td class="num ${t.avg_strength >= 100 ? 'sig-good' : t.avg_strength >= 68 ? 'sig-ok' : 'sig-bad'}">${t.avg_strength || '–'}</td>
      <td><canvas class="sparkline" id="spark-${t.transponder_id}" width="100" height="24"></canvas></td>
      <td></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.transponder-row').forEach(row => {
    row.addEventListener('click', () => openTransponderModal(+row.dataset.transponderId));
  });

  data.forEach(async t => {
    const hist = await fetch(`/api/transponders/${t.transponder_id}/history?days=0`).then(r => r.json());
    drawSparkline(`spark-${t.transponder_id}`, hist.map(h => h.strength).reverse());
  });
}

async function openTransponderModal(transponder_id) {
  _tdEditId = transponder_id;
  _tdDays = 0;
  await loadClasses();

  const data = await fetch('/api/transponders').then(r => r.json());
  const t = data.find(x => x.transponder_id === transponder_id);
  if (!t) return;

  document.getElementById('td-title').textContent = `Transponder ${transponder_id} bearbeiten`;
  document.getElementById('td-id').value      = t.transponder_id;
  document.getElementById('td-kart-nr').value = t.kart_nr;
  document.getElementById('td-name').value    = t.name;
  populateClassSelect('td-class', t.class);

  const offset = t.offset_sec || 0;
  document.getElementById('td-offset-h').value = Math.floor(offset / 3600);
  document.getElementById('td-offset-m').value = Math.floor((offset % 3600) / 60);
  document.getElementById('td-offset-s').value = offset % 60;

  // Activate first range pill
  document.querySelectorAll('#td-range-pills .range-pill').forEach((p,i) => p.classList.toggle('active', i===0));

  showModal('modal-transponder');

  _tdKartClass = t.class;
  try {
    const hist = await fetch(`/api/transponders/${transponder_id}/history?days=0`).then(r => r.json());
    _tdChartData = hist.map(h => ({ strength: h.strength, ts: h.timestamp_us ? h.timestamp_us / 1_000_000 : null })).reverse();
    _redrawTdChart();
  } catch(_) {}

  // Letzte 50 Rundenzeiten + gleitende Durchschnitte laden
  try {
    const lt = await fetch(`/api/transponders/${transponder_id}/lap-times?limit=50`).then(r => r.json());
    renderLapTimes(lt, t.class);
  } catch(_) {
    document.getElementById('td-laps-list').innerHTML =
      '<span style="color:var(--text-muted)">Fehler beim Laden</span>';
  }

  // Fahrhistorie laden (Datum → Lauf → Runden, Accordion-Stil)
  const histEl = document.getElementById('td-history-list');
  histEl.innerHTML = '<span style="color:var(--text-muted)">Lade…</span>';
  try {
    const grouped = await fetch(`/api/transponders/${transponder_id}/history-grouped`).then(r => r.json());
    renderTransponderHistory(grouped);
  } catch(_) {
    histEl.innerHTML = '<span style="color:var(--text-muted)">Fehler beim Laden</span>';
  }
}

// ── Fahrhistorie-Accordion: Datum → Lauf → Runden ──────────────────────────
function renderTransponderHistory(days) {
  const wrap = document.getElementById('td-history-list');
  const summary = document.getElementById('td-history-summary');
  if (!days || !days.length) {
    wrap.innerHTML = '<span style="color:var(--text-muted)">Keine Fahrten vorhanden.</span>';
    if (summary) summary.textContent = '';
    return;
  }
  // Summary: Anzahl Tage / Läufe / Runden gesamt
  const nLaps = days.reduce((sum, d) => sum + (d.lap_count || 0), 0);
  const nRuns = days.reduce((sum, d) => sum + (d.runs ? d.runs.length : 0), 0);
  if (summary) summary.textContent = `${days.length} Tag(e) · ${nRuns} Lauf/Läufe · ${nLaps} Runden`;

  const modeLabel = (m) =>
    m === 'gp_time'  ? 'GP Zeit'   :
    m === 'gp_laps'  ? 'GP Runden' :
    m === 'training' ? 'Training'  : (m || '');

  const fmtDate = (s) => {
    if (!s) return '–';
    const [y,m,d] = s.split('-');
    return `${d}.${m}.${y}`;
  };

  // Erstes Datum (= neuestes) ist standardmäßig offen, ältere zugeklappt.
  wrap.innerHTML = days.map((day, di) => {
    const dayOpen = di === 0;
    const runsHtml = day.runs.map((run, ri) => {
      const runOpen = di === 0 && ri === 0;   // erster Lauf des neuesten Tags offen
      const lapsHtml = run.laps.map(l => {
        return `<div style="display:flex;justify-content:space-between;padding:1px 8px;font-variant-numeric:tabular-nums">
                  <span style="color:var(--text-dim)">${l.lap_nr}.</span>
                  <span>${fmtTime(l.lap_time_us)}</span>
                </div>`;
      }).join('');
      return `<div class="hist-run" style="margin-left:14px;border-left:1px solid var(--border);padding-left:8px">
        <div class="hist-run-head" data-target="histrun-${day.date}-${run.run_id}"
             style="cursor:pointer;padding:3px 0;display:flex;justify-content:space-between;align-items:center;gap:6px;user-select:none">
          <span><span class="hist-caret">${runOpen ? '▼' : '▶'}</span>
            ${run.run_name || ('Lauf ' + run.run_number)}
            <span style="color:var(--text-dim);font-size:10px;margin-left:4px">${modeLabel(run.mode)}</span>
          </span>
          <span style="color:var(--text-dim);font-size:10px">${run.laps.length} Runden</span>
        </div>
        <div class="hist-run-body" id="histrun-${day.date}-${run.run_id}"
             style="display:${runOpen ? 'block' : 'none'};padding:3px 0">${lapsHtml || '<span style="color:var(--text-muted);padding-left:8px">Keine gewerteten Runden</span>'}</div>
      </div>`;
    }).join('');
    return `<div class="hist-day" style="margin-bottom:4px">
      <div class="hist-day-head" data-target="histday-${day.date}"
           style="cursor:pointer;padding:4px 4px;display:flex;justify-content:space-between;align-items:center;gap:6px;background:var(--bg2);border-radius:3px;user-select:none">
        <span><span class="hist-caret">${dayOpen ? '▼' : '▶'}</span>
          <b style="margin-left:4px">${fmtDate(day.date)}</b>
        </span>
        <span style="color:var(--text-dim);font-size:10px">${day.runs.length} Lauf · ${day.lap_count} Runden</span>
      </div>
      <div class="hist-day-body" id="histday-${day.date}"
           style="display:${dayOpen ? 'block' : 'none'};padding:4px 0">${runsHtml}</div>
    </div>`;
  }).join('');

  // Klick-Toggles für Day- und Run-Köpfe
  wrap.querySelectorAll('.hist-day-head, .hist-run-head').forEach(head => {
    head.addEventListener('click', () => {
      const id = head.dataset.target;
      const body = document.getElementById(id);
      if (!body) return;
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : 'block';
      const caret = head.querySelector('.hist-caret');
      if (caret) caret.textContent = open ? '▶' : '▼';
    });
  });
}

function renderLapTimes(data, kart_class) {
  // Defekt-Konfig für diese Klasse holen
  const cats = (state.settings || {}).defect_categories || {};
  const cat  = cats[kart_class] || {};
  const enabled    = !!cat.enabled;
  const window     = Math.max(2, +cat.window || 5);
  const thresholdS = +cat.threshold_sec || 70;
  const thresholdUs = thresholdS * 1_000_000;
  const factor     = +cat.outlier_factor || 1.5;

  // WMA über die in Settings konfigurierten N Runden berechnen.
  // data.lap_times ist DESC (neueste zuerst) → wir nehmen die ersten window.
  const times = (data.lap_times || []).map(l => l.lap_time_us).filter(x => x);
  const recent = times.slice(0, window);

  // Ausreißer-Filter: Runden über (median * factor) verwerfen
  // (Pit-Stops, Dreher, Crashs verfälschen sonst den WMA).
  let cleaned = recent;
  let outliers = 0;
  if (recent.length >= 3) {
    const srt = [...recent].sort((a,b)=>a-b);
    const median = srt[Math.floor(srt.length/2)];
    cleaned = recent.filter(t => t <= median * factor);
    outliers = recent.length - cleaned.length;
  }

  let wma = null;
  if (cleaned.length >= 3) {
    // Linear gewichtet: neueste = höchstes Gewicht
    const weights = cleaned.map((_, i) => cleaned.length - i); // [N, N-1, ..., 1]
    const totalW = weights.reduce((a,b) => a+b, 0);
    wma = Math.round(
      cleaned.reduce((sum, x, i) => sum + weights[i] * x, 0) / totalW
    );
  }

  document.getElementById('td-laps-count').textContent = data.count;
  const wmaLabel = outliers > 0
    ? `WMA${cleaned.length} (${outliers} Ausreißer):`
    : `WMA${cleaned.length}:`;
  document.getElementById('td-laps-wma-label').textContent = wmaLabel;
  document.getElementById('td-laps-wma').textContent = fmtTime(wma);

  // Defekt-Badge: nur wenn aktiviert + WMA > Schwelle + Fenster gefüllt
  const warn = document.getElementById('td-laps-warn');
  const windowFull = recent.length >= window;
  warn.style.display = (enabled && windowFull && wma && wma > thresholdUs) ? '' : 'none';

  const list = document.getElementById('td-laps-list');
  if (!data.lap_times || !data.lap_times.length) {
    list.innerHTML = '<span style="color:var(--text-muted)">Noch keine Runden</span>';
    return;
  }

  // Median für Farb-Heuristik (Ausreißer hervorheben)
  const sorted = [...times].sort((a,b)=>a-b);
  const median = sorted[Math.floor(sorted.length/2)] || 0;
  const slow = median * 1.15;
  const fast = median * 0.95;

  // Index 1 = neueste Runde (data.lap_times[0]), Index 50 = älteste.
  list.innerHTML = data.lap_times.map((l, i) => {
    const us = l.lap_time_us;
    let cls = '';
    if (us > slow) cls = 'lap-slow';
    else if (us < fast) cls = 'lap-fast';
    const date = l.run_started_at
      ? new Date(l.run_started_at * 1000).toLocaleString('de-DE',
          { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })
      : '';
    const idx = i + 1;   // 1 = neueste, aufsteigend
    return `<span class="lap-chip-td ${cls}" title="${date}">${idx}: ${fmtTime(us)}</span>`;
  }).join('');
}

let _tdChartData = [];
let _tdChartZoom = 'detail';   // 'detail' (Y 100–200) | 'full' (Y 0–255)
let _tdKartClass = null;       // Klasse des aktuell offenen Transponders

// Range pills – transponder modal
// Zentrale Funktion: Chart + Status neu zeichnen für aktuellen Transponder.
// Wird aufgerufen bei Daten-Fetch, Zoom-Wechsel, Settings-Änderung.
function _redrawTdChart() {
  if (!_tdChartData || !_tdChartData.length) {
    drawStrengthChart('td-strength-chart', _tdChartData || [], 'td-chart-tooltip', _tdChartZoom);
    document.getElementById('td-signal-status').style.display = 'none';
    return;
  }
  // Signal-Analyse mit aktuellen Settings holen.
  // Timestamps parallel zu Werten extrahieren – braucht's für die
  // Baseline-Herkunfts-Anzeige im Status-Badge.
  const sigCats = (state.settings || {}).signal_defect_categories || {};
  const sigCfg  = _tdKartClass ? sigCats[_tdKartClass] : null;
  const values  = _tdChartData.map(d => typeof d === 'object' ? d.strength : d);
  const tss     = _tdChartData.map(d => typeof d === 'object' ? d.ts : null);
  const analysis = analyzeSignal(values, sigCfg, tss);

  drawStrengthChart('td-strength-chart', _tdChartData,
    'td-chart-tooltip', _tdChartZoom,
    analysis ? analysis.statuses : null,
    analysis);

  // Status-Badge aktualisieren
  const badge = document.getElementById('td-signal-status');
  if (!sigCfg || !sigCfg.enabled) {
    badge.style.display = 'none';
    return;
  }
  if (!analysis || !analysis.hasData) {
    badge.style.display = '';
    badge.style.background = 'var(--bg2)';
    badge.style.color = 'var(--text-dim)';
    badge.innerHTML = `<b>Transponder-Analyse:</b> noch nicht genug Datenpunkte für eine Bewertung (mindestens ${(sigCfg.baseline_window||100) + (sigCfg.window||50)} nötig, aktuell ${values.length}).`;
    return;
  }
  const labels = ['STABIL', 'INSTABIL', 'DEFEKT-VERDACHT'];
  const colors = [
    {bg:'rgba(63,185,80,.12)',  fg:'var(--green)'},
    {bg:'rgba(210,153,34,.15)', fg:'var(--yellow)'},
    {bg:'rgba(248,81,73,.15)',  fg:'var(--red)'},
  ];
  const c = colors[analysis.current];
  const d = analysis.details || {};
  const b = analysis.baseline || {};
  badge.style.display = '';
  badge.style.background = c.bg;
  badge.style.color = c.fg;
  const fmt = (n, p=2) => n == null ? '—' : (+n).toFixed(p);

  // Baseline-Herkunft formatieren
  let baseInfo = `Baseline: Punkt 1–${b.window || '?'}`;
  if (b.ts_start && b.ts_end) {
    const fmtDate = (ts) => {
      const d = new Date(ts * 1000);
      return d.toLocaleDateString('de-DE', {day:'2-digit', month:'2-digit', year:'2-digit'});
    };
    const ageDays = Math.floor((Date.now()/1000 - b.ts_end) / 86400);
    const ageStr = ageDays < 1 ? 'heute'
                 : ageDays < 7 ? `vor ${ageDays} Tag${ageDays>1?'en':''}`
                 : ageDays < 60 ? `vor ${Math.round(ageDays/7)} Wochen`
                 : ageDays < 365 ? `vor ${Math.round(ageDays/30)} Monaten`
                 : `vor ${(ageDays/365).toFixed(1)} Jahren`;
    baseInfo = `Baseline: ${fmtDate(b.ts_start)}–${fmtDate(b.ts_end)} (${ageStr})`;
  }

  // Indikator-Helfer
  const sym = (s) => s === 2 ? '🔴' : s === 1 ? '🟡' : '🟢';
  const info = (title) =>
    `<span class="info-icon" title="${title}" style="cursor:help;font-size:10px;color:var(--text-dim);opacity:.7;margin-left:1px">ⓘ</span>`;

  const INFO_STDDEV =
    'Standardabweichung der letzten N Punkte (Window). ' +
    'Misst wie stark die Linie zappelt. ' +
    'Aktueller Wert vs. Baseline-Stddev × Faktor: bei 1.5 = WARN, bei 2.0 = ALARM. ' +
    'Klassisches Frühwarnsignal: Vor einem Defekt fängt das Signal an zu zucken.';
  const INFO_SLOPE =
    'Linearer Trend der letzten N Punkte. ' +
    'Negativ = Signal fällt aktuell, positiv = Signal steigt. ' +
    'ACHTUNG: misst nur den LOKALEN Trend (Window), nicht den Gesamttrend ' +
    'über die ganze Messreihe. Wenn das Signal sich auf niedrigem Niveau ' +
    'eingependelt hat, ist der Slope wieder ≈ 0 obwohl es insgesamt gefallen ist – ' +
    'dafür ist der Mean-Drop-Indikator zuständig.';
  const INFO_MIN_DROP =
    'Differenz zwischen aktuellem Tiefstwert (Window) und Baseline-Tiefstwert. ' +
    'Erkennt einzelne Signal-Aussetzer: Wenn das Signal jetzt auf 145 fällt ' +
    'obwohl es früher nie unter 163 ging → 18 Punkte Drop. ' +
    'Indikator für beginnende Hardware-Probleme (lose Antenne, kalte Lötstelle).';
  const INFO_MEAN_DROP =
    'Differenz zwischen Baseline-Mittelwert und aktuellem Mittelwert. ' +
    'Erkennt langsamen Verschleiß auch wenn der Slope schon wieder flach ist. ' +
    'Beispiel: Baseline-Ø 175, aktueller Ø 153 → Mean-Drop 22. ' +
    'Stärkster Indikator wenn ein Transponder über Wochen schlechter wird.';

  badge.innerHTML =
    `<div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">` +
      `<b>Transponder: ${labels[analysis.current]}</b>` +
      `<span style="font-size:10px;color:var(--text-dim);font-weight:normal">${baseInfo}` +
        info('Die Baseline ist der „Soll-Zustand" gegen den die aktuellen Werte verglichen werden. ' +
             'Sie wird aus den ÄLTESTEN „baseline_window" Punkten im aktuell gewählten Chart-Range gebildet. ' +
             'Wechselst du oben die Range (Letzte 1000 / 7 Tage / ... / 2 Jahre), wandert auch die Baseline mit. ' +
             'Hinweis: Tooltip-Hover auf einen Punkt im Chart zeigt die Indikator-Werte zu genau diesem Zeitpunkt.') +
      `</span>` +
    `</div>` +
    `<div style="margin-top:4px;font-size:10px;color:var(--text-dim);line-height:1.6">` +
      `${sym(d.sStddev)} <b>Stddev:</b>${info(INFO_STDDEV)} ${fmt(d.rStddev)} (Baseline ${fmt(d.baseStddev)})` +
      ` &nbsp;·&nbsp; ${sym(d.sSlope)} <b>Slope:</b>${info(INFO_SLOPE)} ${fmt(d.rSlope, 3)}` +
      ` &nbsp;·&nbsp; ${sym(d.sMin)} <b>Min-Drop:</b>${info(INFO_MIN_DROP)} ${fmt(d.drop, 0)} (Baseline-Min ${fmt(d.baseMin, 0)})` +
      ` &nbsp;·&nbsp; ${sym(d.sMean)} <b>Mean-Drop:</b>${info(INFO_MEAN_DROP)} ${fmt(d.meanDrop, 1)} (Baseline-Ø ${fmt(d.baseMean, 0)} → aktuell ${fmt(d.rMean, 0)})` +
    `</div>`;
}

// Zoom-Toggle (Y-Achse 100-200 / 0-255) – nur neu zeichnen, kein Fetch
document.getElementById('td-zoom-pills').addEventListener('click', e => {
  const pill = e.target.closest('.range-pill');
  if (!pill) return;
  document.querySelectorAll('#td-zoom-pills .range-pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  _tdChartZoom = pill.dataset.zoom || 'detail';
  _redrawTdChart();
});

document.getElementById('td-range-pills').addEventListener('click', async e => {
  const pill = e.target.closest('.range-pill');
  if (!pill || !_tdEditId) return;
  document.querySelectorAll('#td-range-pills .range-pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  _tdDays = +pill.dataset.days;
  const hist = await fetch(`/api/transponders/${_tdEditId}/history?days=${_tdDays}`).then(r => r.json());
  _tdChartData = hist.map(h => ({ strength: h.strength, ts: h.timestamp_us ? h.timestamp_us / 1_000_000 : null })).reverse();
  _redrawTdChart();
});

// Range pills – health chart
document.getElementById('health-range-pills').addEventListener('click', async e => {
  const pill = e.target.closest('.range-pill');
  if (!pill) return;
  document.querySelectorAll('#health-range-pills .range-pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  _healthDays = +pill.dataset.days;
  await loadHealthChart(_healthDays);
});

async function loadHealthChart(days) {
  const health = await fetch(`/api/decoder/health?days=${days}`).then(r => r.json());
  drawHealthChart(health.reverse());
}

function populateClassSelect(selectId, selectedClass) {
  const sel = document.getElementById(selectId);
  sel.innerHTML = state.classes.map(c =>
    `<option value="${c.name}" ${c.name === selectedClass ? 'selected' : ''}>${c.name}</option>`
  ).join('');
}

document.getElementById('td-save').addEventListener('click', async () => {
  if (!_tdEditId) return;
  const h = +document.getElementById('td-offset-h').value || 0;
  const m = +document.getElementById('td-offset-m').value || 0;
  const s = +document.getElementById('td-offset-s').value || 0;
  await fetch(`/api/transponders/${_tdEditId}`, {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      name:       document.getElementById('td-name').value.trim(),
      kart_nr:    +document.getElementById('td-kart-nr').value,
      class:      document.getElementById('td-class').value,
      offset_sec: h * 3600 + m * 60 + s,
    }),
  });
  closeModal(); loadTransponders();
});

document.getElementById('td-delete').addEventListener('click', async () => {
  if (!_tdEditId || !confirm(`Transponder ${_tdEditId} wirklich löschen?`)) return;
  await fetch(`/api/transponders/${_tdEditId}`, { method: 'DELETE' });
  closeModal(); loadTransponders();
});
document.getElementById('td-cancel').addEventListener('click', closeModal);

// Add Transponder
document.getElementById('btn-add-transponder').addEventListener('click', async () => {
  await loadClasses();
  document.getElementById('at-id').value      = '';
  document.getElementById('at-kart-nr').value = '';
  document.getElementById('at-name').value    = '';
  populateClassSelect('at-class', 'Leihkart');
  showModal('modal-add-transponder');
});

document.getElementById('at-save').addEventListener('click', async () => {
  const t_id   = +document.getElementById('at-id').value;
  const kart_nr = +document.getElementById('at-kart-nr').value;
  if (!t_id || !kart_nr) { alert('Transponder-ID und Kart-Nummer sind erforderlich'); return; }
  const res = await fetch('/api/transponders', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      transponder_id: t_id, kart_nr,
      name:  document.getElementById('at-name').value.trim() || `Kart ${kart_nr}`,
      class: document.getElementById('at-class').value,
    }),
  });
  if (!res.ok) { alert((await res.json().catch(() => ({}))).detail || 'Fehler'); return; }
  closeModal(); loadTransponders();
});
document.getElementById('at-cancel').addEventListener('click', closeModal);

// ── Class Management Modal ────────────────────────────────────────────────────

document.getElementById('btn-manage-classes').addEventListener('click', async () => {
  await loadClasses();
  renderClassList();
  showModal('modal-classes');
});

function renderClassList() {
  const container = document.getElementById('class-list');
  container.innerHTML = state.classes.map((c, i) => `
    <div class="class-list-item" data-index="${i}">
      <div class="class-color-dot" style="background:${c.color}"></div>
      <input type="text" class="class-name-input" value="${c.name}" data-orig="${c.name}">
      <input type="color" class="class-color-input" value="${c.color}" data-orig-name="${c.name}">
      <button class="cls-save" data-orig="${c.name}">✓</button>
      <button class="cls-delete" data-name="${c.name}">✕</button>
    </div>`).join('');

  container.querySelectorAll('.cls-save').forEach(btn => {
    btn.addEventListener('click', async () => {
      const item  = btn.closest('.class-list-item');
      const origName = btn.dataset.orig;
      const newName  = item.querySelector('.class-name-input').value.trim();
      const newColor = item.querySelector('.class-color-input').value;
      await fetch(`/api/classes/${encodeURIComponent(origName)}`, {
        method: 'PUT', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ name: newName, color: newColor }),
      });
      await loadClasses(); renderClassList();
    });
  });

  container.querySelectorAll('.cls-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Klasse "${btn.dataset.name}" wirklich löschen?`)) return;
      await fetch(`/api/classes/${encodeURIComponent(btn.dataset.name)}`, { method: 'DELETE' });
      await loadClasses(); renderClassList();
    });
  });

  container.querySelectorAll('.class-color-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const dot = inp.closest('.class-list-item').querySelector('.class-color-dot');
      if (dot) dot.style.background = inp.value;
    });
  });
}

document.getElementById('btn-add-class').addEventListener('click', async () => {
  const name  = document.getElementById('new-class-name').value.trim();
  const color = document.getElementById('new-class-color').value;
  if (!name) return;
  const res = await fetch('/api/classes', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name, color }),
  });
  if (!res.ok) { alert((await res.json().catch(() => ({}))).detail || 'Fehler'); return; }
  document.getElementById('new-class-name').value = '';
  await loadClasses(); renderClassList();
});

document.getElementById('cls-close').addEventListener('click', closeModal);

// ── Charts ────────────────────────────────────────────────────────────────────

function _themeColors() {
  const s = getComputedStyle(document.documentElement);
  const get = (v, fb) => (s.getPropertyValue(v).trim() || fb);
  return {
    green:  get('--green',  '#3fb950'),
    yellow: get('--yellow', '#d29922'),
    red:    get('--red',    '#f85149'),
    grid:   get('--border', '#30363d'),
    dim:    get('--text-dim','#8b949e'),
  };
}

// ── Signal-Defekt-Analyse (Rolling) ────────────────────────────────────────
// Liefert pro Datenpunkt einen Status 0/1/2 (grün/gelb/rot) basierend auf
// drei Indikatoren: Stddev-Wachstum, negativer Trend, Min-Drop.
// Wird gegen die Baseline (erste N Punkte) verglichen, damit auch ein
// Transponder analysiert werden kann, der schon immer schwächeres Signal
// hatte – wir interessieren uns für die *Veränderung*, nicht den Absolutwert.
function _stddev(arr) {
  if (!arr.length) return 0;
  const m = arr.reduce((a,b) => a+b, 0) / arr.length;
  const v = arr.reduce((a,b) => a + (b-m)*(b-m), 0) / arr.length;
  return Math.sqrt(v);
}
function _slope(arr) {
  // Linear-Regression Slope über Index 0..n-1
  const n = arr.length;
  if (n < 2) return 0;
  const mx = (n-1) / 2;
  const my = arr.reduce((a,b)=>a+b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - mx) * (arr[i] - my);
    den += (i - mx) * (i - mx);
  }
  return den === 0 ? 0 : num / den;
}

function _mean(arr) {
  return arr.length ? arr.reduce((a,b)=>a+b, 0) / arr.length : 0;
}

function analyzeSignal(values, settings, timestamps) {
  // values: Array von Strength-Werten (älteste zuerst, wie im Chart).
  // settings: signal_defect_categories[kart_class] – kann undefined sein
  //   wenn Feature für diese Klasse aus.
  // timestamps: optional Array (Unix-Sekunden) parallel zu values – wird
  //   nur für die Baseline-Herkunft-Anzeige genutzt.
  if (!values || !values.length) return null;
  if (!settings || !settings.enabled) return null;

  const window         = Math.max(5, +settings.window         || 50);
  const baselineWindow = Math.max(10, +settings.baseline_window || 100);
  const sWarn  = +settings.stddev_warn_factor  || 1.5;
  const sAlert = +settings.stddev_alert_factor || 2.0;
  const slWarn  = +settings.slope_warn  || -0.05;
  const slAlert = +settings.slope_alert || -0.10;
  const mWarn  = +settings.min_drop_warn  || 15;
  const mAlert = +settings.min_drop_alert || 30;
  const meanWarn  = +settings.mean_drop_warn  || 10;
  const meanAlert = +settings.mean_drop_alert || 20;

  const n = values.length;
  if (n < baselineWindow + 1) {
    return { statuses: new Array(n).fill(0), current: 0, hasData: false };
  }

  // Baseline aus den ersten ``baseline_window`` Datenpunkten
  const baseline = values.slice(0, baselineWindow);
  const baseStddev = _stddev(baseline);
  const baseMin    = Math.min(...baseline);
  const baseMean   = _mean(baseline);

  // Baseline-Zeitstempel (falls verfügbar) für Herkunfts-Anzeige
  let baseTsStart = null, baseTsEnd = null;
  if (timestamps && timestamps.length === n) {
    baseTsStart = timestamps[0];
    baseTsEnd   = timestamps[baselineWindow - 1];
  }

  const statuses = new Array(n).fill(0);
  // Pro-Punkt-Details für nachträgliche Inspektion (Hover-Tooltip).
  // Nur Punkte mit gültiger Rolling-Analyse haben hier Werte, alle
  // anderen bleiben null (für Speicher: 260 Punkte × ~80 B = ~20 KB).
  const perPoint = new Array(n).fill(null);
  let lastDetails = null;
  for (let i = 0; i < n; i++) {
    if (i < baselineWindow + window) { statuses[i] = 0; continue; }
    const recent = values.slice(i - window + 1, i + 1);
    const rStddev = _stddev(recent);
    const rMin    = Math.min(...recent);
    const rSlope  = _slope(recent);
    const rMean   = _mean(recent);

    let sStddev = 0;
    if (baseStddev > 0) {
      if (rStddev > baseStddev * sAlert) sStddev = 2;
      else if (rStddev > baseStddev * sWarn) sStddev = 1;
    }
    let sSlope = 0;
    if (rSlope < slAlert) sSlope = 2;
    else if (rSlope < slWarn) sSlope = 1;

    let sMin = 0;
    const drop = baseMin - rMin;
    if (drop > mAlert) sMin = 2;
    else if (drop > mWarn) sMin = 1;

    let sMean = 0;
    const meanDrop = baseMean - rMean;
    if (meanDrop > meanAlert) sMean = 2;
    else if (meanDrop > meanWarn) sMean = 1;

    statuses[i] = Math.max(sStddev, sSlope, sMin, sMean);
    const d = {
      rStddev, rSlope, rMin, rMean, drop, meanDrop,
      sStddev, sSlope, sMin, sMean,
      status: statuses[i],
    };
    perPoint[i] = d;
    lastDetails = { ...d, baseStddev, baseMin, baseMean };
  }

  return {
    statuses,
    perPoint,
    current: statuses[n-1] || 0,
    details: lastDetails,
    hasData: true,
    baseline: {
      stddev: baseStddev, min: baseMin, mean: baseMean,
      window: baselineWindow,
      ts_start: baseTsStart, ts_end: baseTsEnd,
    },
  };
}

function drawSparkline(canvasId, values) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !values.length) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (values.length < 2) return;
  const c = _themeColors();
  const step = w / (values.length - 1);
  ctx.beginPath(); ctx.strokeStyle = c.green; ctx.lineWidth = 1.25;
  values.forEach((v, i) => {
    const x = i * step, y = h - (Math.min(v, 255) / 255) * h;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// Generic canvas chart with hover tooltip
function _bindChartHover(canvas, tooltip, data, xFn, yFn, labelFn) {
  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    if (!data.length) return;
    const step = canvas.width / (data.length - 1);
    const idx = Math.round(mx / step);
    if (idx < 0 || idx >= data.length) { tooltip.style.display = 'none'; return; }
    const d = data[idx];
    // innerHTML: erlaubt HTML in Labels (Indikator-Werte mit Formatierung).
    // Sicher solange Datenquelle vertrauenswürdig ist (= unser Backend).
    tooltip.innerHTML = labelFn(d, idx);
    const pct = idx / (data.length - 1);
    tooltip.style.display = '';
    tooltip.style.left = `${pct * 100}%`;
    tooltip.style.top  = `${(1 - yFn(d) / 255) * 100}%`;
  });
  canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
}

function drawStrengthChart(canvasId, data, tooltipId, zoom, statuses, analysis) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Y-Skala je nach Zoom-Modus.
  // - "detail" (Default): 100-200 → typische Signalwerte gespreizt sichtbar.
  //   Werte außerhalb dieses Bereichs werden geclippt.
  // - "full": 0-255 → volle Byte-Range, alles sichtbar aber gestaucht.
  const z = zoom || 'detail';
  const yMin = z === 'full' ? 0   : 100;
  const yMax = z === 'full' ? 255 : 200;
  const yRng = yMax - yMin;
  const ticks = z === 'full'
    ? [0, 50, 100, 150, 200]
    : [100, 125, 150, 175, 200];
  const mapY = (v) => h - Math.max(0, Math.min(1, (v - yMin) / yRng)) * h;

  const values = data.map(d => typeof d === 'object' ? d.strength : d);

  if (!values || values.length < 2) {
    ctx.fillStyle = 'var(--text-muted)';
    ctx.font = '12px monospace';
    ctx.fillText(values && values.length === 0 ? 'Keine Daten im gewählten Zeitraum' : 'Noch keine Daten', 20, h / 2);
  } else {
    const c = _themeColors();
    const step = w / (values.length - 1);
    // Grid lines – dünn & halbtransparent
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = c.grid; ctx.lineWidth = 0.75;
    ticks.forEach(v => {
      const y = mapY(v);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    });
    ctx.restore();
    ctx.fillStyle = c.dim; ctx.font = '9px monospace';
    ticks.forEach(v => {
      const y = mapY(v);
      ctx.fillText(String(v), 2, y - 2);
    });

    // Statusband-Hintergrund (gelb/rot Felder) – damit die kritischen
    // Bereiche schon mit Peripherie-Blick erkennbar sind.
    if (statuses && statuses.length === values.length) {
      ctx.save();
      ctx.globalAlpha = 0.10;
      let runStart = 0, runStatus = statuses[0];
      for (let i = 1; i <= statuses.length; i++) {
        const s = i < statuses.length ? statuses[i] : -1;
        if (s !== runStatus) {
          if (runStatus > 0) {
            const x0 = runStart * step;
            const x1 = (i - 1) * step;
            ctx.fillStyle = runStatus === 2 ? c.red : c.yellow;
            ctx.fillRect(x0, 0, Math.max(1, x1 - x0), h);
          }
          runStart = i;
          runStatus = s;
        }
      }
      ctx.restore();
    }

    // Kurve – Segment-weise gezeichnet damit jedes Segment seine eigene
    // Farbe je nach Status haben kann.
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.lineWidth = 1.75;
    const colorFor = (s) => (s === 2 ? c.red : s === 1 ? c.yellow : c.green);
    if (statuses && statuses.length === values.length) {
      // Pro Statuswechsel ein neuer Pfad mit passender Farbe.
      let i = 0;
      while (i < values.length - 1) {
        const s = statuses[i + 1];   // Segment i→i+1 bekommt Farbe des Zielpunkts
        let j = i + 1;
        while (j < values.length - 1 && statuses[j + 1] === s) j++;
        ctx.beginPath();
        ctx.strokeStyle = colorFor(s);
        ctx.moveTo(i * step, mapY(values[i]));
        for (let k = i + 1; k <= j; k++) {
          ctx.lineTo(k * step, mapY(values[k]));
        }
        ctx.stroke();
        i = j;
      }
    } else {
      // Kein Status → komplett grün wie früher
      ctx.beginPath(); ctx.strokeStyle = c.green;
      values.forEach((v, i) => {
        const x = i * step, y = mapY(v);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  if (tooltipId) {
    const tooltip = document.getElementById(tooltipId);
    if (tooltip) {
      _bindChartHover(canvas, tooltip, data,
        (d,i) => i, d => typeof d === 'object' ? d.strength : d,
        (d, i) => {
          const v = typeof d === 'object' ? d.strength : d;
          const ts = typeof d === 'object' && d.ts ? new Date(d.ts * 1000).toLocaleString('de-DE') : '';
          let html = `<div><b>Stärke:</b> ${v}</div>`;
          if (ts) html += `<div style="opacity:.7;font-size:10px">${ts}</div>`;
          // Indikator-Details für diesen Punkt – nur wenn Analyse aktiv
          // und Punkt im analysierten Bereich (nach Baseline + Window).
          if (analysis && analysis.perPoint && analysis.perPoint[i]) {
            const p = analysis.perPoint[i];
            const sym = (s) => s === 2 ? '🔴' : s === 1 ? '🟡' : '🟢';
            const labels = ['STABIL', 'INSTABIL', 'DEFEKT'];
            const fmt = (n, dp=2) => n == null ? '—' : (+n).toFixed(dp);
            html += `<div style="margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,.15);font-size:10px;line-height:1.5">`;
            html += `<div style="margin-bottom:2px"><b>Status zu diesem Zeitpunkt: ${labels[p.status]}</b></div>`;
            html += `${sym(p.sStddev)} Stddev: ${fmt(p.rStddev)}<br>`;
            html += `${sym(p.sSlope)} Slope: ${fmt(p.rSlope, 3)}<br>`;
            html += `${sym(p.sMin)} Min-Drop: ${fmt(p.drop, 0)}<br>`;
            html += `${sym(p.sMean)} Mean-Drop: ${fmt(p.meanDrop, 1)}`;
            html += `</div>`;
          } else if (analysis && analysis.hasData) {
            html += `<div style="margin-top:4px;font-size:10px;opacity:.6">Noch in Baseline / Aufwärmphase</div>`;
          }
          return html;
        }
      );
    }
  }
}

let _healthChartData = [];

function drawHealthChart(records) {
  _healthChartData = records;
  const canvas = document.getElementById('health-chart');
  if (!canvas) return;
  const ctx2 = canvas.getContext('2d');
  if (!records.length) {
    ctx2.clearRect(0, 0, canvas.width, canvas.height);
    ctx2.fillStyle = 'var(--text-muted)';
    ctx2.font = '12px monospace';
    ctx2.fillText('Keine Daten im gewählten Zeitraum', 20, canvas.height / 2);
    return;
  }
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const noiseArr = records.map(r => r.noise       || 0);
  const loopArr  = records.map(r => r.loop_signal || 0);
  const n = records.length;
  if (n < 2) return;
  const step = w / (n - 1);

  const c = _themeColors();
  ctx.save();
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = c.grid; ctx.lineWidth = 0.75;
  [[40,'40'],[80,'80'],[100,'100']].forEach(([v, label]) => {
    const y = h - (v / 255) * h;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  });
  ctx.restore();
  ctx.fillStyle = c.dim; ctx.font = '9px monospace';
  [[40,'40'],[80,'80'],[100,'100']].forEach(([v, label]) => {
    const y = h - (v / 255) * h;
    ctx.fillText(label, 2, y - 2);
  });

  const drawLine = (data, color) => {
    ctx.beginPath(); ctx.strokeStyle = color; ctx.lineWidth = 1.75;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    data.forEach((v, i) => {
      const x = i * step, y = h - (Math.min(v, 255) / 255) * h;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  };
  drawLine(loopArr,  c.green);
  drawLine(noiseArr, c.yellow);

  // Tooltip
  const tooltip = document.getElementById('health-tooltip');
  if (tooltip) {
    canvas.onmousemove = e => {
      const rect = canvas.getBoundingClientRect();
      const mx = (e.clientX - rect.left) * (w / rect.width);
      const idx = Math.round(mx / step);
      if (idx < 0 || idx >= n) { tooltip.style.display = 'none'; return; }
      const r = records[idx];
      const ts = r.recorded_at ? new Date(r.recorded_at*1000).toLocaleString('de-DE') : '';
      tooltip.textContent = `N:${r.noise || 0}  L:${r.loop_signal || 0}${ts ? '  ' + ts : ''}`;
      const pct = idx / (n - 1);
      tooltip.style.display = '';
      tooltip.style.left = `${pct * 100}%`;
      tooltip.style.top  = `${(1 - (r.loop_signal || 0) / 255) * 100}%`;
    };
    canvas.onmouseleave = () => { tooltip.style.display = 'none'; };
  }
}

// ── Debug Page ────────────────────────────────────────────────────────────────

const MAX_DEBUG_ENTRIES = 2000;
const DEBUG_TTL_MS = 30 * 60 * 1000;  // 30 Minuten
let _debugPaused = false;
let _showHeartbeats = false;

document.getElementById('debug-pause').addEventListener('change', e => {
  _debugPaused = e.target.checked;
});

document.getElementById('debug-show-heartbeat').addEventListener('change', e => {
  _showHeartbeats = e.target.checked;
  // Bestehende Heartbeat-Einträge ein-/ausblenden
  document.querySelectorAll('.debug-entry.hb').forEach(el => {
    el.style.display = _showHeartbeats ? '' : 'none';
  });
});

document.getElementById('btn-debug-clear').addEventListener('click', () => {
  document.getElementById('debug-decoder-log').innerHTML = '';
  document.getElementById('debug-emulator-log').innerHTML = '';
});

// Ampel: manuelle Befehle
async function _sendAmpel(state) {
  // force=true: Debug-Buttons senden immer, auch wenn Ampel deaktiviert
  try {
    const res = await fetch('/api/ampel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, force: true }),
    });
    const data = await res.json();
    const cmdEl = document.getElementById('debug-ampel-cmd');
    if (cmdEl && data.cmd) cmdEl.textContent = data.cmd;
  } catch(_) {}
}
document.getElementById('btn-ampel-off')  ?.addEventListener('click', () => _sendAmpel('off'));
document.getElementById('btn-ampel-green')?.addEventListener('click', () => _sendAmpel('green'));
document.getElementById('btn-ampel-red')  ?.addEventListener('click', () => _sendAmpel('red'));

// ── Ampel Ablauf Modal ────────────────────────────────────────────────────────

const AMPEL_SEQ_OPTIONS = [
  { value: 'none',  label: '— keine Änderung —' },
  { value: 'off',   label: '⬛ AUS' },
  { value: 'green', label: '🟢 GRÜN' },
  { value: 'red',   label: '🔴 ROT' },
];

const AMPEL_SEQ_FIELDS = [
  { id: 'seq-training-arm',    key: 'ampel_seq_training_arm' },
  { id: 'seq-training-start',  key: 'ampel_seq_training_start' },
  { id: 'seq-training-finish', key: 'ampel_seq_training_finish' },
  { id: 'seq-gp-start',        key: 'ampel_seq_gp_start' },
  { id: 'seq-gp-finish',       key: 'ampel_seq_gp_finish' },
  { id: 'seq-done',            key: 'ampel_seq_done' },
  { id: 'seq-disarm',          key: 'ampel_seq_disarm' },
];

// Populate all sequence dropdowns once
document.querySelectorAll('.ampel-seq-sel').forEach(sel => {
  sel.innerHTML = AMPEL_SEQ_OPTIONS.map(o =>
    `<option value="${o.value}">${o.label}</option>`
  ).join('');
});

async function openAmpelSeqModal() {
  // Gesperrt prüfen
  if (document.getElementById('ampel-settings-grid')?.classList.contains('hw-locked')) {
    alert('Bitte zuerst die Hardware-Einstellungen entsperren (🔒 Entsperren).');
    return;
  }
  const s = await fetch('/api/settings').then(r => r.json()).catch(() => ({}));
  AMPEL_SEQ_FIELDS.forEach(f => {
    const el = document.getElementById(f.id);
    if (el) el.value = s[f.key] || 'none';
  });
  showModal('modal-ampel-seq');
}

document.getElementById('btn-ampel-seq')?.addEventListener('click', openAmpelSeqModal);

document.getElementById('seq-cancel')?.addEventListener('click', () => closeModal());

document.getElementById('seq-save')?.addEventListener('click', async () => {
  const body = {};
  AMPEL_SEQ_FIELDS.forEach(f => {
    const el = document.getElementById(f.id);
    if (el) body[f.key] = el.value;
  });
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  closeModal();
  showToast('✓ Ampel-Ablauf gespeichert', 'ok');
});

// Ampel: Enable-Toggle speichert in Config
document.getElementById('debug-ampel-enabled')?.addEventListener('change', async e => {
  await fetch('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ampel_enabled: e.target.checked }),
  });
});

// Emulator: Enable-Toggle
document.getElementById('debug-emulator-enabled')?.addEventListener('change', async e => {
  const enabled = e.target.checked;
  const lbl = document.getElementById('debug-emulator-enabled-label');
  if (lbl) { lbl.textContent = enabled ? 'Aktiv' : 'Deaktiviert'; lbl.style.color = enabled ? 'var(--green)' : 'var(--red)'; }
  await fetch('/api/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emulator_enabled: enabled }),
  });
});

function appendDebugEntry(type, msg) {
  if (_debugPaused) return;
  const logId = type === 'decoder' ? 'debug-decoder-log' : 'debug-emulator-log';
  const log = document.getElementById(logId);
  if (!log) return;

  const isHeartbeat = type === 'decoder' && msg.heartbeat;
  const ts = fmtTs(msg.ts);
  let body = '';
  if (type === 'decoder') {
    if (isHeartbeat) {
      body = `<span class="dim">♥ Heartbeat</span> Noise:<span class="hi">${msg.noise}</span> Loop:<span class="hi">${msg.loop}</span>`;
    } else {
      const kn = msg.transponder_id;
      body = `<span class="hi">T:${kn}</span> <span class="dim">ts=${msg.timestamp_us}</span> Sig:<span class="hi">${msg.strength}</span> Hits:${msg.hits}`;
    }
  } else {
    const sentInfo = msg.enabled === false
      ? `<span style="color:var(--yellow)">(nicht gesendet – deaktiviert)</span>`
      : `<span class="dim">(${msg.clients} Empfänger)</span>`;
    body = `<span class="hi-emu">${msg.line}</span> ${sentInfo}`;
  }

  const entry = document.createElement('div');
  entry.className = 'debug-entry' + (isHeartbeat ? ' hb' : '');
  entry.dataset.ts = (msg.ts || Date.now() / 1000) * 1000;
  if (isHeartbeat && !_showHeartbeats) entry.style.display = 'none';
  entry.innerHTML = `<span class="debug-ts">${ts}</span><span class="debug-body">${body}</span>`;
  log.appendChild(entry);

  // Time-basiertes Trimmen (älter als DEBUG_TTL_MS entfernen)
  const cutoff = Date.now() - DEBUG_TTL_MS;
  while (log.firstChild && +log.firstChild.dataset.ts < cutoff) {
    log.removeChild(log.firstChild);
  }
  // Harte Obergrenze als Schutz
  while (log.children.length > MAX_DEBUG_ENTRIES) log.removeChild(log.firstChild);

  if (log.scrollTop + log.clientHeight >= log.scrollHeight - 40) {
    log.scrollTop = log.scrollHeight;
  }
}

// ── Darstellung: Theme + Zoom ─────────────────────────────────────────────────

function applyZoom(percent) {
  percent = Math.max(60, Math.min(200, +percent || 100));
  const ratio = percent / 100;
  document.documentElement.style.zoom = ratio;
  document.documentElement.style.fontSize = (16 * ratio) + 'px';
  try { localStorage.setItem('ui.zoom', percent); } catch(_) {}
}

const THEMES = ['dark', 'contrast-dark', 'racing-orange', 'racing-red', 'pitwall', 'light'];
function applyTheme(theme) {
  const t = THEMES.includes(theme) ? theme : 'dark';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('ui.theme', t); } catch(_) {}
  // Canvas-Charts mit neuen Theme-Farben neu zeichnen
  try {
    if (_healthChartData && _healthChartData.length) drawHealthChart(_healthChartData);
    if (_tdChartData && _tdChartData.length) _redrawTdChart();
  } catch(_) {}
}

(function initUi() {
  try {
    applyTheme(localStorage.getItem('ui.theme') || 'dark');
    applyZoom(+localStorage.getItem('ui.zoom') || 100);
  } catch(_) {}
})();

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  const picker = document.getElementById('day-picker');
  if (picker) picker.value = state.currentDate;

  await loadClasses();

  try {
    state.runs = await fetch(`/api/runs?date=${today()}`).then(r => r.json());
    renderRunList();
  } catch(_) {}

  connectWs();
  requestAnimationFrame(updateProgressBars);
}

init();
