/* ════════════════════════════════════════════════════════════════════════════
   emslandringTiming – Frontend
   ════════════════════════════════════════════════════════════════════════════ */

'use strict';

// ── State ────────────────────────────────────────────────────────────────────

const state = {
  runs:          [],          // heute's Läufe
  selectedRunId: null,        // in linker Spalte angeklickter Lauf
  activeRun:     null,        // laufender Lauf-State vom Server
  karts:         [],          // aktuell angezeigte Kart-Tabelle
  decoder:       { connected: false, noise: 0, loop: 0 },
  currentDate:   today(),
  ws:            null,
  wsOk:          false,
  expandedKart:  null,        // kart_nr mit geöffnetem Lap-Dropdown
  ctxRunId:      null,        // Rechtsklick-Ziel
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDate(d) {
  const [y, m, day] = d.split('-');
  return `${day}.${m}.${y}`;
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

// ── WebSocket ────────────────────────────────────────────────────────────────

let _wsRetry = 1000;

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  state.ws = ws;

  ws.onopen = () => {
    state.wsOk = true;
    _wsRetry = 1000;
  };

  ws.onmessage = e => {
    try { handleMsg(JSON.parse(e.data)); } catch (_) {}
  };

  ws.onclose = ws.onerror = () => {
    state.wsOk = false;
    updateDecoderStatus({ connected: false });
    setTimeout(connectWs, Math.min(_wsRetry, 10000));
    _wsRetry = Math.min(_wsRetry * 1.5, 10000);
  };
}

function handleMsg(msg) {
  switch (msg.type) {

    case 'snapshot':
      state.decoder = msg.decoder || state.decoder;
      if (msg.runs_today) {
        state.runs = msg.runs_today;
        renderRunList();
      }
      if (msg.run) {
        state.activeRun = msg.run;
        if (!state.selectedRunId && msg.run.id) {
          state.selectedRunId = msg.run.id;
        }
      }
      if (msg.karts && msg.run && state.selectedRunId === (msg.run && msg.run.id)) {
        state.karts = msg.karts;
        renderKartTable();
      }
      updateRunHeader();
      updateDecoderStatus(msg.decoder);
      break;

    case 'run_list':
      state.runs = msg.runs;
      renderRunList();
      break;

    case 'run_state':
      state.activeRun = msg;
      // Sync into runs array
      const ri = state.runs.findIndex(r => r.id === msg.id);
      if (ri >= 0) state.runs[ri].status = msg.status;
      renderRunList();
      updateRunHeader();
      break;

    case 'run_updated':
      const ru = state.runs.findIndex(r => r.id === msg.run.id);
      if (ru >= 0) state.runs[ru] = { ...state.runs[ru], ...msg.run };
      renderRunList();
      if (state.selectedRunId === msg.run.id) updateRunHeader();
      break;

    case 'run_finished':
      const rf = state.runs.findIndex(r => r.id === msg.run_id);
      if (rf >= 0) state.runs[rf].status = 'done';
      renderRunList();
      updateRunHeader();
      break;

    case 'kart_table':
      if (state.activeRun && state.selectedRunId === state.activeRun.id) {
        state.karts = msg.karts;
        renderKartTable();
      }
      break;

    case 'passing':
      if (state.activeRun && state.selectedRunId === state.activeRun.id) {
        flashKartRow(msg.kart_nr);
      }
      break;

    case 'timer_tick':
      if (state.activeRun) {
        state.activeRun.remaining_sec = msg.remaining_sec;
        state.activeRun.elapsed_sec   = msg.elapsed_sec;
        updateTimer();
      }
      break;

    case 'decoder_health':
      state.decoder = msg;
      updateDecoderStatus(msg);
      break;
  }
}

// ── Decoder Status ────────────────────────────────────────────────────────────

function updateDecoderStatus(d) {
  if (!d) return;
  const el = document.getElementById('decoder-status');
  const txt = document.getElementById('decoder-text');
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

// ── Sidebar ───────────────────────────────────────────────────────────────────

function renderRunList() {
  const list = document.getElementById('run-list');
  const label = document.getElementById('day-label');
  label.textContent = fmtDate(state.currentDate);

  // Ist heute? Nur heute darf neue Läufe haben
  const isToday = state.currentDate === today();
  document.getElementById('btn-add-run').style.display = isToday ? '' : 'none';

  list.innerHTML = state.runs.map(r => {
    const isActive = state.activeRun && state.activeRun.id === r.id;
    const isSelected = state.selectedRunId === r.id;
    const status = isActive ? (state.activeRun.status || r.status) : r.status;
    const isGp = r.mode === 'gp_time' || r.mode === 'gp_laps';

    let icon = '';
    let timeStr = '';
    if (status === 'done') {
      icon = '<span class="status-done">✓</span>';
    } else if (status === 'armed') {
      icon = '<span class="status-armed pulse">◉</span>';
    } else if (status === 'running') {
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

    const badge = isGp ? `<span class="run-item-badge">GP</span>` : '';

    return `<div class="run-item ${r.mode} ${isSelected ? 'selected' : ''}"
                 data-run-id="${r.id}"
                 data-run-status="${status}">
      <span class="run-item-icon">${icon}</span>
      <span class="run-item-name">${r.name}</span>
      ${badge}
      <span class="run-item-time">${timeStr}</span>
    </div>`;
  }).join('');

  list.querySelectorAll('.run-item').forEach(el => {
    el.addEventListener('click', () => selectRun(+el.dataset.runId));
    el.addEventListener('contextmenu', e => openCtxMenu(e, +el.dataset.runId));
  });
}

async function selectRun(runId) {
  state.selectedRunId = runId;
  renderRunList();

  // Wenn aktiver Lauf → Karts aus engine-state
  if (state.activeRun && state.activeRun.id === runId) {
    updateRunHeader();
    return;
  }

  // Historischer Lauf: Daten vom Server holen
  try {
    const r = await fetch(`/api/runs/${runId}`).then(r => r.json());
    state.karts = r.karts || [];
    renderKartTable();
    updateRunHeaderForRun(r);
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
  const isGp = run.mode === 'gp_time' || run.mode === 'gp_laps';
  badge.className = 'run-item-badge' + (isGp ? ' gp' : '');
  badge.textContent = modeLabel(run.mode);

  const statusMap = {
    pending:   'Bereit',
    armed:     '● Scharf',
    running:   '▶ Läuft',
    paused:    '⏸ Pausiert',
    finishing: '⚑ Endet...',
    done:      '✓ Beendet',
    none:      '–',
  };
  document.getElementById('run-status-text').textContent =
    statusMap[run.status] || run.status || '';

  updateTimer();
  updateButtons(run);
}

function updateTimer() {
  const el = document.getElementById('run-timer');
  if (!state.activeRun || state.selectedRunId !== state.activeRun.id) {
    el.textContent = '--:--';
    el.className = '';
    return;
  }
  const sec = state.activeRun.remaining_sec || 0;
  el.textContent = fmtSec(sec);
  el.className = sec <= 30 ? 'crit' : sec <= 120 ? 'warn' : '';
}

function updateButtons(run) {
  const status = run ? run.status : 'none';
  const isActive = state.activeRun && state.activeRun.id === (run && run.id);
  const isGp = run && (run.mode === 'gp_time' || run.mode === 'gp_laps');
  const isToday = state.currentDate === today();

  const arm    = document.getElementById('btn-arm');
  const start  = document.getElementById('btn-start');
  const pause  = document.getElementById('btn-pause');
  const resume = document.getElementById('btn-resume');
  const abort  = document.getElementById('btn-abort');

  // Reset
  arm.style.display    = '';
  start.style.display  = 'none';
  pause.style.display  = '';
  resume.style.display = 'none';

  arm.disabled   = true;
  pause.disabled = true;
  abort.disabled = true;

  if (!run || !isToday) return;

  if (status === 'pending' || (status === 'done' && !isActive)) {
    // Kann scharf geschaltet werden wenn kein anderer Lauf aktiv
    const otherActive = state.runs.some(r =>
      r.id !== run.id && ['armed','running','paused','finishing'].includes(r.status)
    );
    arm.disabled = otherActive;
  }

  if (status === 'armed' && isActive) {
    if (isGp) {
      arm.style.display   = 'none';
      start.style.display = '';
    }
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
    if (run && run.status === 'pending') {
      empty.style.display = 'flex';
      empty.innerHTML = `<div class="empty-icon">🏁</div><p>Lauf scharf schalten zum Starten</p>`;
    } else {
      empty.style.display = 'flex';
      empty.innerHTML = `<div class="empty-icon">🏁</div><p>Keine Karts in diesem Lauf</p>`;
    }
    table.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  table.style.display = '';

  const noise = state.decoder.noise || 8;
  tbody.innerHTML = state.karts.map(k => {
    const posClass = k.position <= 3 ? `pos-${k.position}` : '';
    const sc = sigClass(k.strength, noise);

    return `
    <tr class="kart-row" data-kart-nr="${k.kart_nr}" data-expanded="false">
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

  // Restore expanded state
  if (state.expandedKart) {
    showLapDetail(state.expandedKart);
  }
}

function toggleLapDetail(kart_nr) {
  const row = document.getElementById(`lap-detail-${kart_nr}`);
  if (!row) return;
  if (state.expandedKart === kart_nr) {
    row.style.display = 'none';
    state.expandedKart = null;
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
  const row = document.getElementById(`lap-detail-${kart_nr}`);
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
  const rows = document.querySelectorAll(`tr.kart-row[data-kart-nr="${kart_nr}"]`);
  rows.forEach(row => {
    row.classList.add('flash');
    setTimeout(() => row.classList.remove('flash'), 800);
  });
}

// ── Progress Bars (RAF) ───────────────────────────────────────────────────────

function updateProgressBars() {
  const now = Date.now() / 1000;
  document.querySelectorAll('.prog-bar-fill').forEach(el => {
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
  ctxMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 200)}px`;
  ctxMenu.style.top  = `${Math.min(e.clientY, window.innerHeight - 100)}px`;
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

// ── Run Settings Modal ────────────────────────────────────────────────────────

const modalOverlay = document.getElementById('modal-overlay');
let _modalRunId = null;

function openRunSettingsModal(runId) {
  _modalRunId = runId;
  const run = state.runs.find(r => r.id === runId);
  if (!run) return;

  document.getElementById('modal-run-settings').style.display = '';
  document.getElementById('modal-kart-name').style.display = 'none';
  modalOverlay.classList.add('visible');

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

document.getElementById('ms-mode').addEventListener('change', e => {
  updateModeFields(e.target.value);
});

function updateModeFields(mode) {
  const isLaps = mode === 'gp_laps';
  document.getElementById('ms-laps-group').style.display    = isLaps ? '' : 'none';
  document.getElementById('ms-duration-group').style.display = isLaps ? 'none' : '';
}

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

function openKartNameModal(runId) {
  document.getElementById('modal-run-settings').style.display = 'none';
  document.getElementById('modal-kart-name').style.display = '';
  modalOverlay.classList.add('visible');
  _modalRunId = runId;

  const list = document.getElementById('kart-name-list');
  if (state.karts.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:12px">Keine Karts in diesem Lauf.</p>';
    return;
  }
  list.innerHTML = state.karts.map(k => `
    <div class="form-group">
      <label>Kart ${k.kart_nr}</label>
      <input type="text" class="kart-name-input"
             data-kart-nr="${k.kart_nr}"
             value="${k.name}" placeholder="${k.name}">
    </div>`).join('');
}

document.getElementById('kn-close').addEventListener('click', async () => {
  if (_modalRunId) {
    const inputs = document.querySelectorAll('.kart-name-input');
    for (const inp of inputs) {
      const kart_nr = +inp.dataset.kartNr;
      const name = inp.value.trim();
      if (name) {
        await fetch(`/api/runs/${_modalRunId}/kart-name`, {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ kart_nr, name }),
        });
      }
    }
  }
  closeModal();
});

function closeModal() {
  modalOverlay.classList.remove('visible');
  _modalRunId = null;
}

modalOverlay.addEventListener('click', e => {
  if (e.target === modalOverlay) closeModal();
});

// ── Control Buttons ───────────────────────────────────────────────────────────

document.getElementById('btn-arm').addEventListener('click', async () => {
  if (!state.selectedRunId) return;
  await fetch(`/api/runs/${state.selectedRunId}/arm`, { method: 'POST' });
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

document.getElementById('btn-add-run').addEventListener('click', async () => {
  const r = await fetch('/api/runs', { method: 'POST' }).then(r => r.json());
  state.runs.push(r);
  renderRunList();
});

// ── Day Navigation ────────────────────────────────────────────────────────────

document.getElementById('day-prev').addEventListener('click', () => changeDay(-1));
document.getElementById('day-next').addEventListener('click', () => changeDay(+1));

async function changeDay(delta) {
  const d = new Date(state.currentDate);
  d.setDate(d.getDate() + delta);
  const next = d.toISOString().slice(0, 10);
  if (next > today()) return;
  state.currentDate = next;
  state.selectedRunId = null;
  state.karts = [];
  state.activeRun = state.activeRun; // keep active run state
  const runs = await fetch(`/api/runs?date=${next}`).then(r => r.json());
  state.runs = runs;
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
      if (btn.dataset.view === 'settings') loadSettings();
      if (btn.dataset.view === 'transponders') loadTransponders();
    }
  });
});

// ── Settings Page ─────────────────────────────────────────────────────────────

async function loadSettings() {
  const s = await fetch('/api/settings').then(r => r.json());
  document.getElementById('s-runs-per-day').value     = s.runs_per_day;
  document.getElementById('s-training-duration').value= s.training_duration_sec;
  document.getElementById('s-gp-time-duration').value = s.gp_time_duration_sec;
  document.getElementById('s-gp-laps').value          = s.gp_laps_count;
  document.getElementById('s-wait-time').value        = s.wait_time_sec;
  document.getElementById('s-wait-time-gp').value     = s.wait_time_gp_sec;
  document.getElementById('s-decoder-ip').value       = s.decoder_ip;
  document.getElementById('s-decoder-port').value     = s.decoder_port;
  document.getElementById('s-http-port').value        = s.http_port;
  document.getElementById('s-ws-port').value          = s.websocket_port;
  document.getElementById('s-emulator-port').value    = s.emulator_port;
}

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const body = {
    runs_per_day:          +document.getElementById('s-runs-per-day').value,
    training_duration_sec: +document.getElementById('s-training-duration').value,
    gp_time_duration_sec:  +document.getElementById('s-gp-time-duration').value,
    gp_laps_count:         +document.getElementById('s-gp-laps').value,
    wait_time_sec:         +document.getElementById('s-wait-time').value,
    wait_time_gp_sec:      +document.getElementById('s-wait-time-gp').value,
    decoder_ip:             document.getElementById('s-decoder-ip').value,
    decoder_port:          +document.getElementById('s-decoder-port').value,
    http_port:             +document.getElementById('s-http-port').value,
    websocket_port:        +document.getElementById('s-ws-port').value,
    emulator_port:         +document.getElementById('s-emulator-port').value,
  };
  await fetch('/api/settings', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body),
  });
  const saved = document.getElementById('settings-saved');
  saved.style.display = '';
  setTimeout(() => saved.style.display = 'none', 2000);
});

// ── Transponder Page ──────────────────────────────────────────────────────────

async function loadTransponders() {
  const data = await fetch('/api/transponders').then(r => r.json());
  const tbody = document.getElementById('transponder-tbody');
  const classColors = { Minikart:'class-mini', Leihkart:'class-leih', Rennkart:'class-renn', Superkart:'class-super' };

  tbody.innerHTML = data.map(t => {
    const cls = classColors[t.class] || '';
    const totalStr = t.total_us ? fmtUs(t.total_us) : '–';
    return `<tr data-transponder-id="${t.transponder_id}">
      <td>${t.kart_nr}</td>
      <td>${t.name}</td>
      <td class="${cls}">${t.class}</td>
      <td style="color:var(--text-dim)">${t.transponder_id}</td>
      <td class="num">${t.passing_count}</td>
      <td class="num">${totalStr}</td>
      <td class="num ${t.avg_strength >= 100 ? 'sig-good' : t.avg_strength >= 68 ? 'sig-ok' : 'sig-bad'}">${t.avg_strength || '–'}</td>
      <td><canvas class="sparkline" id="spark-${t.transponder_id}" width="100" height="24"></canvas></td>
    </tr>`;
  }).join('');

  // Load sparklines async
  data.forEach(async t => {
    const hist = await fetch(`/api/transponders/${t.transponder_id}/history`).then(r => r.json());
    drawSparkline(`spark-${t.transponder_id}`, hist.map(h => h.strength).reverse());
  });

  // Health chart
  const health = await fetch('/api/decoder/health').then(r => r.json());
  drawHealthChart(health.reverse());
}

function drawSparkline(canvasId, values) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !values.length) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (values.length < 2) return;
  const max = 255, min = 0;
  const step = w / (values.length - 1);
  ctx.beginPath();
  ctx.strokeStyle = '#3fb950';
  ctx.lineWidth = 1.5;
  values.forEach((v, i) => {
    const x = i * step;
    const y = h - ((v - min) / (max - min)) * h;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawHealthChart(records) {
  const canvas = document.getElementById('health-chart');
  if (!canvas || !records.length) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const noise  = records.map(r => r.noise  || 0);
  const loop   = records.map(r => r.loop_signal || 0);
  const n = records.length;
  if (n < 2) return;
  const step = w / (n - 1);

  // Grid lines at 40 (noise warn) and 100 (loop warn)
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  [40, 80, 100].forEach(v => {
    const y = h - (v / 255) * h;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  });

  const drawLine = (data, color) => {
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    data.forEach((v, i) => {
      const x = i * step;
      const y = h - (Math.min(v, 255) / 255) * h;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  };

  drawLine(loop,  '#3fb950');
  drawLine(noise, '#d29922');
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  // Load today's runs via HTTP first (fast)
  try {
    const runs = await fetch(`/api/runs?date=${today()}`).then(r => r.json());
    state.runs = runs;
    renderRunList();
  } catch(_) {}

  connectWs();
  requestAnimationFrame(updateProgressBars);
}

init();
