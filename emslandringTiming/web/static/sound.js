// sound.js — Audio-Notifications für den Operator-Browser
//
// Alle Töne werden clientseitig via Web Audio API synthetisiert – keine
// Sound-Dateien, kein Netz-Traffic, keine externen Assets. Konfiguration
// (Ein/Aus pro Event, Master-Lautstärke, Global-Mute) kommt aus
// /api/settings → config.json → "sounds".
//
// Autoplay-Policy: Browser blockieren AudioContext bis der Nutzer die
// Seite berührt hat. Deshalb wird der Kontext lazy beim ersten Klick
// (oder Tastendruck) initialisiert. Solange gesperrt zeigt das Badge
// "🔇 Sounds gesperrt" in den Settings.

(function () {
  'use strict';

  let ctx = null;
  let masterGain = null;

  const state = {
    config: {
      master_volume:  0.7,
      muted:          false,
      print_sent:     true,
      orphan_passing: true,
      gp_last_minute: true,
    },
    lastPlayed: {},  // "event|throttleKey" → ms-Timestamp für Rate-Limit
  };

  function isReady() {
    return !!ctx && ctx.state === 'running';
  }

  function updateLockedBadge() {
    const badge = document.getElementById('sound-locked-badge');
    if (!badge) return;
    badge.style.display = isReady() ? 'none' : '';
  }

  function init() {
    if (ctx) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      ctx = new AudioCtx();
      masterGain = ctx.createGain();
      applyVolumeToGain();
      masterGain.connect(ctx.destination);
    } catch (e) {
      console.warn('[sound] init failed:', e);
    }
  }

  function unlock() {
    if (!ctx) init();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().then(updateLockedBadge, () => {});
    } else {
      updateLockedBadge();
    }
  }

  function applyVolumeToGain() {
    if (!masterGain) return;
    masterGain.gain.value = state.config.muted ? 0 : state.config.master_volume;
  }

  // Basis-Ton (Oszillator + ADSR-artige Hüllkurve).
  //   freq       Startfrequenz Hz
  //   durationMs Länge in ms
  //   opts.freqTo   optional Zielfrequenz für linearen Sweep
  //   opts.type     'sine' (default), 'square', 'triangle', 'sawtooth'
  //   opts.vol      0..1, Peak-Volume vor Master-Gain (default 0.5)
  //   opts.attack   Fade-In ms (default 8)
  //   opts.release  Fade-Out ms (default 30)
  function tone(freq, durationMs, opts) {
    if (!isReady()) return;
    opts = opts || {};
    const now = ctx.currentTime;
    const dur = durationMs / 1000;
    const attack  = (opts.attack  != null ? opts.attack  : 8)  / 1000;
    const release = (opts.release != null ? opts.release : 30) / 1000;
    const vol = opts.vol != null ? opts.vol : 0.5;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(freq, now);
    if (opts.freqTo) {
      osc.frequency.linearRampToValueAtTime(opts.freqTo, now + dur);
    }

    // Hüllkurve: 0 → vol (attack) → vol (sustain) → 0 (release)
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(vol, now + attack);
    const sustainEnd = Math.max(attack, dur - release);
    gain.gain.setValueAtTime(vol, now + sustainEnd);
    gain.gain.linearRampToValueAtTime(0, now + dur);

    osc.connect(gain).connect(masterGain);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  // ── Sound-Definitionen ─────────────────────────────────────────────

  // Druck gesendet: Doppel-Beep hoch, positive Bestätigung
  function playPrintSent() {
    tone(880, 90, { vol: 0.55 });
    setTimeout(() => tone(880, 90, { vol: 0.55 }), 130);
  }

  // Transponder ohne Lauf: drei kurze scharfe Beeps, Attention aber
  // nicht bedrohlich. Rechteck-Wellenform für "harter" wahrnehmbaren Klang.
  function playOrphanPassing() {
    tone(1000, 70, { type: 'square', vol: 0.35 });
    setTimeout(() => tone(1000, 70, { type: 'square', vol: 0.35 }), 130);
    setTimeout(() => tone(1000, 70, { type: 'square', vol: 0.35 }), 260);
  }

  // GP letzte Minute: langer absteigender Ton (600→400 Hz, 500 ms)
  // erinnert an klassisches "Boxen-Warnsignal"
  function playGpLastMinute() {
    tone(600, 500, { freqTo: 400, vol: 0.55, release: 120 });
  }

  const SOUNDS = {
    print_sent:     { play: playPrintSent,     label: 'Druck gesendet' },
    orphan_passing: { play: playOrphanPassing, label: 'Transponder ohne aktiven Lauf' },
    gp_last_minute: { play: playGpLastMinute,  label: 'Grand Prix letzte Minute' },
  };

  // ── Public API ─────────────────────────────────────────────────────

  function setConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    for (const k of Object.keys(state.config)) {
      if (cfg[k] != null) state.config[k] = cfg[k];
    }
    applyVolumeToGain();
  }

  function setVolume(v01) {
    state.config.master_volume = Math.max(0, Math.min(1, +v01 || 0));
    applyVolumeToGain();
  }

  function setMuted(b) {
    state.config.muted = !!b;
    applyVolumeToGain();
  }

  // Regulärer Event-Aufruf (nur wenn Event enabled + nicht gemutet + ready).
  // opts.throttleMs + opts.throttleKey: max. 1× pro Zeitfenster pro Key.
  function play(event, opts) {
    if (!isReady()) return;
    if (state.config.muted) return;
    if (state.config[event] === false) return;  // per-Event disabled
    const s = SOUNDS[event];
    if (!s) return;
    opts = opts || {};
    if (opts.throttleMs) {
      const key = event + '|' + (opts.throttleKey != null ? opts.throttleKey : '');
      const now = Date.now();
      const last = state.lastPlayed[key] || 0;
      if (now - last < opts.throttleMs) return;
      state.lastPlayed[key] = now;
    }
    try { s.play(); } catch (e) { console.warn('[sound] play failed:', e); }
  }

  // Test-Button: spielt IMMER (auch wenn per-Event disabled), aber
  // respektiert Mute + Master-Volume. Löst gleichzeitig Autoplay-Unlock aus.
  function preview(event) {
    unlock();
    if (!isReady()) return;
    if (state.config.muted) return;
    const s = SOUNDS[event];
    if (!s) return;
    try { s.play(); } catch (e) { console.warn('[sound] preview failed:', e); }
  }

  // Autoplay-Unlock: erster Klick/Tastendruck irgendwo auf der Seite.
  document.addEventListener('click',   unlock);
  document.addEventListener('keydown', unlock);

  window.sound = {
    play, preview, setConfig, setVolume, setMuted,
    unlock, isReady,
    SOUNDS,
  };
})();
