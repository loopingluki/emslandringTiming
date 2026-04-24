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
  const redEl   = document.getElementById('debug-ampel-red');
  const greenEl = document.getElementById('debug-ampel-green');
  const label   = document.getElementById('debug-ampel-state-label');
  const okLbl   = document.getElementById('debug-ampel-ok-label');
  const enabledCb  = document.getElementById('debug-ampel-enabled');
  const enabledLbl = document.getElementById('debug-ampel-enabled-label');

  if (redEl) {
    redEl.style.background   = d.state === 'red'   ? '#e53935' : '#3a0000';
    redEl.style.borderColor  = d.state === 'red'   ? '#ff6659' : '#600';
    redEl.style.boxShadow    = d.state === 'red'   ? '0 0 10px #e53935' : 'none';
  }
  if (greenEl) {
    greenEl.style.background  = d.state === 'green' ? '#43a047' : '#003a00';
    greenEl.style.borderColor = d.state === 'green' ? '#76d275' : '#060';
    greenEl.style.boxShadow   = d.state === 'green' ? '0 0 10px #43a047' : 'none';
  }
  if (label) {
    const map = { off: 'AUS', green: 'GRÜN', red: 'ROT' };
    label.textContent = map[d.state] || d.state;
    label.style.color = d.state === 'green' ? 'var(--green)' : d.state === 'red' ? 'var(--red)' : 'var(--text-dim)';
  }
  if (okLbl) {
    if (d.ok === true)        okLbl.textContent = d.forced ? '✓ Gesendet (manuell)' : '✓ Gesendet';
    else if (d.ok === false)  okLbl.textContent = '✗ Fehler – TCP fehlgeschlagen';
    else if (d.ok === null && !d.enabled) okLbl.textContent = 'deaktiviert (kein TCP)';
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
    if (status === 'done')     icon = '<span class="status-done">✓</span>';
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
    const armBtn = isToday && status === 'pending'
      ? `<button class="run-item-arm ${canArm ? '' : 'disabled'}"
                 data-run-id="${r.id}" title="Scharf schalten"
                 ${canArm ? '' : 'disabled'}>▶</button>` : '';

    const catCls = runCategoryClass(r.classes_raced || []);

    return `<div class="run-item ${r.mode} ${catCls} ${isSelected ? 'selected' : ''}"
                 data-run-id="${r.id}" data-run-status="${status}">
      <span class="run-item-icon">${icon}</span>
      <span class="run-item-name">${r.name}</span>
      ${badge}
      <span class="run-item-time" id="sidebar-time-${r.id}">${timeStr}</span>
      ${armBtn}
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
      const res = await fetch(`/api/runs/${runId}/arm`, { method: 'POST' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.detail || 'Fehler beim Scharf schalten');
        return;
      }
      selectRun(runId);
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

  tbody.innerHTML = state.karts.map(k => {
    const posClass  = k.position <= 3 ? `pos-${k.position}` : '';
    const sc        = sigClass(k.strength, noise);
    const finishCls = isFinishing && k.seen_after_finish ? 'finished' : '';

    return `
    <tr class="kart-row ${finishCls}" data-kart-nr="${k.kart_nr}">
      <td class="pos ${posClass}">${k.position}</td>
      <td class="num">${k.kart_nr}</td>
      <td class="kart-name">${k.name}</td>
      <td class="num">${k.laps}</td>
      <td class="best-time num">${fmtTime(k.best_us)}</td>
      <td class="time num">${fmtTime(k.last_us)}</td>
      <td class="time num">${fmtTime(k.avg5_us)}</td>
      <td class="num">${trendSymbol(k.trend)}</td>
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
      <td colspan="10">
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

  const runKartNames = {};
  if (state.activeRun && state.activeRun.id === runId) {
    state.karts.forEach(k => { runKartNames[k.kart_nr] = k.name; });
  } else {
    try {
      const r = await fetch(`/api/runs/${runId}`).then(r => r.json());
      (r.karts || []).forEach(k => { runKartNames[k.kart_nr] = k.name; });
    } catch(_) {}
  }

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
    const delBtn = e.pid != null
      ? `<button class="btn btn-sm btn-red rk-del" ${pidAttr} title="Eintrag löschen">🗑 Löschen</button>`
      : '<span style="color:var(--text-muted);font-size:10px">—</span>';
    return `<tr style="border-bottom:1px solid var(--border)">
      <td style="padding:6px 8px;color:var(--text-dim)">${i + 1}</td>
      <td style="padding:6px 8px"><b>${e.kart_nr ?? '?'}</b> &nbsp;<span style="color:var(--text-dim)">${e.name || ''}</span></td>
      <td style="padding:6px 8px">${klass}</td>
      <td style="padding:6px 8px;text-align:right;font-family:monospace;font-weight:600">${fmtTime(e.lap_time_us)}</td>
      <td style="padding:6px 8px;color:var(--text-dim)">${dt}</td>
      <td style="padding:6px 8px;text-align:right">${delBtn}</td>
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
}

// ── Settings Page ─────────────────────────────────────────────────────────────

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
  document.getElementById('s-decoder-ip').value  = s.decoder_ip;
  document.getElementById('s-decoder-port').value= s.decoder_port;
  document.getElementById('s-http-port').value   = s.http_port;
  document.getElementById('s-ws-port').value     = s.websocket_port;
  document.getElementById('s-emulator-port').value= s.emulator_port;

  document.getElementById('s-ampel-ip').value           = s.ampel_ip || '192.168.178.128';
  document.getElementById('s-ampel-port').value         = s.ampel_port || 17494;
  document.getElementById('s-ampel-enabled').checked    = !!s.ampel_enabled;
  document.getElementById('s-ampel-relay-red').value    = s.ampel_relay_red   ?? 1;
  document.getElementById('s-ampel-relay-green').value  = s.ampel_relay_green ?? 2;

  // Emulator enable state
  const emuCb  = document.getElementById('debug-emulator-enabled');
  const emuLbl = document.getElementById('debug-emulator-enabled-label');
  if (emuCb) emuCb.checked = s.emulator_enabled !== false;
  if (emuLbl) { emuLbl.textContent = (s.emulator_enabled !== false) ? 'Aktiv' : 'Deaktiviert'; emuLbl.style.color = (s.emulator_enabled !== false) ? 'var(--green)' : 'var(--red)'; }

  const netArea = document.getElementById('s-network-printers');
  if (netArea) netArea.value = (s.network_printers || []).join('\n');
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
  if (grid.classList.contains('hw-locked')) {
    if (!confirm('⚠ KRITISCHE EINSTELLUNGEN\n\n' +
                 'Änderungen an Decoder-IP, Ports und Netzwerk können dazu ' +
                 'führen, dass die Zeitnahme nicht mehr funktioniert.\n\n' +
                 'Bist du sicher, dass du weißt, was du tust?')) return;
    grid.classList.remove('hw-locked');
    btn.textContent = '🔓 Gesperrt';
  } else {
    grid.classList.add('hw-locked');
    btn.textContent = '🔒 Entsperren';
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
    ampel_port:         +document.getElementById('s-ampel-port').value || 17494,
    ampel_enabled:      document.getElementById('s-ampel-enabled').checked,
    ampel_relay_red:    +document.getElementById('s-ampel-relay-red').value   || 1,
    ampel_relay_green:  +document.getElementById('s-ampel-relay-green').value || 2,
  };
  await fetch('/api/settings', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body),
  });
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
    return `<tr class="transponder-row" data-transponder-id="${t.transponder_id}" style="cursor:pointer">
      <td>${t.kart_nr}</td>
      <td>${t.name}</td>
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

  try {
    const hist = await fetch(`/api/transponders/${transponder_id}/history?days=0`).then(r => r.json());
    _tdChartData = hist.map(h => ({ strength: h.strength, ts: h.timestamp_us ? h.timestamp_us / 1_000_000 : null })).reverse();
    drawStrengthChart('td-strength-chart', _tdChartData, 'td-chart-tooltip');
  } catch(_) {}
}

let _tdChartData = [];

// Range pills – transponder modal
document.getElementById('td-range-pills').addEventListener('click', async e => {
  const pill = e.target.closest('.range-pill');
  if (!pill || !_tdEditId) return;
  document.querySelectorAll('#td-range-pills .range-pill').forEach(p => p.classList.remove('active'));
  pill.classList.add('active');
  _tdDays = +pill.dataset.days;
  const hist = await fetch(`/api/transponders/${_tdEditId}/history?days=${_tdDays}`).then(r => r.json());
  _tdChartData = hist.map(h => ({ strength: h.strength, ts: h.timestamp_us ? h.timestamp_us / 1_000_000 : null })).reverse();
  drawStrengthChart('td-strength-chart', _tdChartData, 'td-chart-tooltip');
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
    tooltip.textContent = labelFn(d, idx);
    const pct = idx / (data.length - 1);
    tooltip.style.display = '';
    tooltip.style.left = `${pct * 100}%`;
    tooltip.style.top  = `${(1 - yFn(d) / 255) * 100}%`;
  });
  canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
}

function drawStrengthChart(canvasId, data, tooltipId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

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
    [[50,'50'],[100,'100'],[150,'150'],[200,'200']].forEach(([v, label]) => {
      const y = h - (v / 255) * h;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    });
    ctx.restore();
    ctx.fillStyle = c.dim; ctx.font = '9px monospace';
    [[50,'50'],[100,'100'],[150,'150'],[200,'200']].forEach(([v, label]) => {
      const y = h - (v / 255) * h;
      ctx.fillText(label, 2, y - 2);
    });
    // Curve
    ctx.beginPath(); ctx.strokeStyle = c.green; ctx.lineWidth = 1.75;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    values.forEach((v, i) => {
      const x = i * step, y = h - (Math.min(v, 255) / 255) * h;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  if (tooltipId) {
    const tooltip = document.getElementById(tooltipId);
    if (tooltip) {
      _bindChartHover(canvas, tooltip, data,
        (d,i) => i, d => typeof d === 'object' ? d.strength : d,
        (d, i) => {
          const v = typeof d === 'object' ? d.strength : d;
          const ts = typeof d === 'object' && d.ts ? new Date(d.ts * 1000).toLocaleString('de-DE') : '';
          return `Stärke: ${v}${ts ? '  ' + ts : ''}`;
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
    if (_tdChartData && _tdChartData.length) drawStrengthChart('td-strength-chart', _tdChartData, 'td-chart-tooltip');
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
