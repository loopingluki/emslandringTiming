// sound.js — Audio-Notifications für den Operator-Browser
//
// Alle Töne werden clientseitig via Web Audio API synthetisiert – keine
// Sound-Dateien, kein Netz-Traffic, keine externen Assets. Konfiguration
// (Ein/Aus + Ton-Auswahl pro Event, Master-Lautstärke, Global-Mute)
// kommt aus /api/settings → config.json → "sounds".
//
// Ton-Palette: fixe Liste von 8 vordefinierten Sounds (siehe PALETTE
// unten). Pro Event wählt der Operator im Settings-UI aus welcher
// Palette-Eintrag gespielt wird. Erweitern = neue Funktion in PALETTE
// eintragen, in TONES-Liste im HTML als Option ergänzen.
//
// Autoplay-Policy: Browser blockieren AudioContext bis der Nutzer die
// Seite berührt hat. Deshalb wird der Kontext lazy beim ersten Klick
// initialisiert. Solange gesperrt zeigt das Badge "🔇 Sounds gesperrt".

(function () {
  'use strict';

  let ctx = null;
  let masterGain = null;

  // Standard-Ton pro Event. Wird verwendet wenn config.json noch keinen
  // tone-Wert für ein Event enthält oder bei Legacy-Boolean-Configs.
  const DEFAULT_TONES = {
    print_sent:     'beep_double',
    orphan_passing: 'beep_triple',
    gp_last_minute: 'horn',
  };

  const state = {
    config: {
      master_volume: 0.7,
      muted:         false,
      print_sent:     { enabled: true, tone: DEFAULT_TONES.print_sent },
      orphan_passing: { enabled: true, tone: DEFAULT_TONES.orphan_passing },
      gp_last_minute: { enabled: true, tone: DEFAULT_TONES.gp_last_minute },
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

  // ── Ton-Bausteine ──────────────────────────────────────────────────

  // Einzelner Oszillator-Ton mit ADSR-artiger Hüllkurve.
  //   freq       Startfrequenz Hz
  //   durationMs Länge in ms
  //   opts.freqTo   optionaler linearer Sweep auf Zielfrequenz
  //   opts.type     'sine' (default) | 'square' | 'triangle' | 'sawtooth'
  //   opts.vol      Peak-Volume vor Master-Gain (0..1, default 0.6)
  //   opts.attack   Fade-In ms (default 8)
  //   opts.release  Fade-Out ms (default 30)
  //   opts.decayTo  wenn gesetzt: exp. Decay auf diesen Level statt release
  function tone(freq, durationMs, opts) {
    if (!isReady()) return;
    opts = opts || {};
    const now = ctx.currentTime;
    const dur = durationMs / 1000;
    const attack  = (opts.attack  != null ? opts.attack  : 8)  / 1000;
    const release = (opts.release != null ? opts.release : 30) / 1000;
    const vol = opts.vol != null ? opts.vol : 0.6;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = opts.type || 'sine';
    osc.frequency.setValueAtTime(freq, now);
    if (opts.freqTo) osc.frequency.linearRampToValueAtTime(opts.freqTo, now + dur);

    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(vol, now + attack);
    if (opts.decayTo != null) {
      // Exponentieller Ausklang wie bei einer angeschlagenen Glocke
      gain.gain.exponentialRampToValueAtTime(Math.max(0.001, opts.decayTo), now + dur);
    } else {
      const sustainEnd = Math.max(attack, dur - release);
      gain.gain.setValueAtTime(vol, now + sustainEnd);
      gain.gain.linearRampToValueAtTime(0, now + dur);
    }

    osc.connect(gain).connect(masterGain);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  // ── Ton-Palette (8 Einträge) ───────────────────────────────────────
  // Jeder Eintrag ist eine Funktion die den kompletten Sound abspielt.
  // Neue Sounds hier hinzufügen + im HTML als <option> ergänzen.

  const PALETTE = {
    beep_short: function () {
      tone(700, 120, { vol: 0.7 });
    },
    beep_double: function () {
      tone(800, 90, { vol: 0.7 });
      setTimeout(() => tone(800, 90, { vol: 0.7 }), 140);
    },
    beep_triple: function () {
      tone(900, 70, { vol: 0.65 });
      setTimeout(() => tone(900, 70, { vol: 0.65 }), 130);
      setTimeout(() => tone(900, 70, { vol: 0.65 }), 260);
    },
    ding: function () {
      // Glocken-Anschlag: schneller Attack, exponentieller Ausklang.
      tone(1200, 500, { vol: 0.7, attack: 3, decayTo: 0.001 });
    },
    chime_up: function () {
      // Aufsteigender Akkord C5-E5-G5
      tone(523, 120, { vol: 0.65, release: 40 });
      setTimeout(() => tone(659, 120, { vol: 0.65, release: 40 }), 110);
      setTimeout(() => tone(784, 180, { vol: 0.7,  release: 60 }), 220);
    },
    chime_down: function () {
      tone(784, 120, { vol: 0.7,  release: 40 });
      setTimeout(() => tone(659, 120, { vol: 0.65, release: 40 }), 110);
      setTimeout(() => tone(523, 180, { vol: 0.65, release: 80 }), 220);
    },
    horn: function () {
      // Warmes Signalhorn (Sägezahn mit weichem Attack) – klingt nach
      // klassischer Boxen-/Startaufstellungs-Warnung, kein Whistle.
      tone(350, 550, { type: 'sawtooth', vol: 0.5, attack: 40, release: 120 });
    },
    buzzer: function () {
      // Härtere Rechteck-Welle, kürzer und dringlich
      tone(450, 320, { type: 'square', vol: 0.4, attack: 5, release: 40 });
    },
  };

  // ── Config-Normalisierung ──────────────────────────────────────────
  // Akzeptiert sowohl neue Object-Form { enabled, tone } als auch alte
  // Boolean-Form true/false (Legacy vor der Palette-Umstellung).

  function normalizeEventCfg(raw, defaultTone) {
    if (raw && typeof raw === 'object') {
      return {
        enabled: raw.enabled !== false,
        tone:    (raw.tone && PALETTE[raw.tone]) ? raw.tone : defaultTone,
      };
    }
    return { enabled: raw !== false, tone: defaultTone };
  }

  // ── Public API ─────────────────────────────────────────────────────

  function setConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    if (cfg.master_volume != null) state.config.master_volume = +cfg.master_volume;
    if (cfg.muted         != null) state.config.muted         = !!cfg.muted;
    for (const ev of Object.keys(DEFAULT_TONES)) {
      if (cfg[ev] !== undefined) {
        state.config[ev] = normalizeEventCfg(cfg[ev], DEFAULT_TONES[ev]);
      }
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

  // Regulärer Event-Aufruf: spielt den für event konfigurierten Ton,
  // NUR wenn enabled + nicht gemutet + Kontext ready.
  // opts.throttleMs + opts.throttleKey: max. 1× pro Zeitfenster pro Key.
  function play(event, opts) {
    if (!isReady()) return;
    if (state.config.muted) return;
    const ec = state.config[event];
    if (!ec || !ec.enabled) return;
    const fn = PALETTE[ec.tone];
    if (!fn) return;
    opts = opts || {};
    if (opts.throttleMs) {
      const key = event + '|' + (opts.throttleKey != null ? opts.throttleKey : '');
      const now = Date.now();
      const last = state.lastPlayed[key] || 0;
      if (now - last < opts.throttleMs) return;
      state.lastPlayed[key] = now;
    }
    try { fn(); } catch (e) { console.warn('[sound] play failed:', e); }
  }

  // Test-Button-Preview: spielt einen konkreten Palette-Eintrag direkt,
  // unabhängig vom Event-Enabled-State. Löst Autoplay-Unlock aus – da
  // ctx.resume() async ist wird der Ton NACH dem Resume gespielt sonst
  // wäre der erste Klick still.
  function preview(toneName) {
    const fn = PALETTE[toneName];
    if (!fn) return;
    const doPlay = () => {
      if (state.config.muted) return;
      try { fn(); } catch (e) { console.warn('[sound] preview failed:', e); }
    };
    if (!ctx) init();
    if (!ctx) return;
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => { updateLockedBadge(); doPlay(); }, () => {});
    } else {
      doPlay();
    }
  }

  // Autoplay-Unlock: erster Klick/Tastendruck irgendwo auf der Seite
  document.addEventListener('click',   unlock);
  document.addEventListener('keydown', unlock);

  window.sound = {
    play, preview, setConfig, setVolume, setMuted,
    unlock, isReady,
    PALETTE, DEFAULT_TONES,
  };
})();
