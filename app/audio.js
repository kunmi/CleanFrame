/* CleanFrame background audio.
   Original generative Web Audio scenes: no audio files and no copyrighted
   music. A scene is a small live generator (oscillators, filtered noise,
   scheduled events) running under its own gain node; switching scenes
   crossfades between them. The Cycle choice rotates through every scene.
   Playback belongs to the visible CleanFrame app; main.js pauses it before
   another app is launched and resumes it when CleanFrame becomes visible. */
(function () {
  'use strict';

  var CYCLE_MS = 3 * 60 * 1000;
  var CHORDS = [
    [130.81, 164.81, 196.00, 246.94, 329.63],
    [110.00, 130.81, 164.81, 196.00, 261.63],
    [87.31, 130.81, 174.61, 220.00, 329.63],
    [98.00, 123.47, 146.83, 196.00, 293.66]
  ];
  var BASS = [65.41, 55.00, 43.65, 49.00];
  var LEAD = [4, -1, 3, -1, 2, -1, 3, -1,
              4, -1, 4, 3, 2, -1, 3, -1,
              3, -1, 4, -1, 4, 3, 2, -1,
              2, -1, 3, -1, 4, -1, -1, -1];

  var context = null, master = null, whiteBuffer = null, brownBuffer = null;
  var desired = 'off', activeMode = 'off', activeScene = 'off', lastError = null;
  var sessions = [];
  var cycleIndex = 0, cycleScene = null, cycleTimer = 0, cycleDeadline = 0, cycleRemaining = CYCLE_MS;

  function rand(a, b) { return a + Math.random() * (b - a); }
  function randInt(a, b) { return Math.floor(rand(a, b + 1)); }

  /* ---------- Audio context ---------- */
  function ensureContext() {
    var AC;
    if (context) return context;
    AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { lastError = 'Web Audio is not available on this TV.'; return null; }
    try {
      context = new AC();
      master = context.createGain();
      master.gain.value = 1;
      master.connect(context.destination);
      lastError = null;
      return context;
    } catch (e) {
      lastError = 'Web Audio could not start.';
      context = null; master = null;
      return null;
    }
  }
  function resumeContext() {
    var result;
    if (!context) return;
    try {
      if (context.state === 'suspended' && context.resume) {
        result = context.resume();
        if (result && result.catch) result.catch(function () { lastError = 'Audio is waiting for a remote key press.'; });
      }
    } catch (e) { /* The next remote key press retries. */ }
  }
  function makeWhite() {
    var buffer, data, i;
    if (whiteBuffer) return whiteBuffer;
    buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    data = buffer.getChannelData(0);
    for (i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    whiteBuffer = buffer;
    return buffer;
  }
  function makeBrown() {
    var buffer, data, i, last = 0, white;
    if (brownBuffer) return brownBuffer;
    buffer = context.createBuffer(1, context.sampleRate * 4, context.sampleRate);
    data = buffer.getChannelData(0);
    for (i = 0; i < data.length; i++) {
      white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    brownBuffer = buffer;
    return buffer;
  }

  /* ---------- Sessions ----------
     One live generator: its own gain under the master, every node and timer
     it creates is tracked so stop can fade it out and tear it all down. */
  function createSession(def) {
    var s = { id: def.id, alive: true, nodes: [], sources: 0, timers: [], intervals: [], gain: context.createGain() };
    s.gain.gain.value = 0;
    s.gain.connect(master);
    s.track = function (node, isSource) { s.nodes.push(node); if (isSource) s.sources++; return node; };
    s.untrack = function (node, isSource) {
      var i = s.nodes.indexOf(node);
      if (i >= 0) s.nodes.splice(i, 1);
      if (isSource && s.sources > 0) s.sources--;
    };
    s.every = function (ms, fn) { var id = setInterval(function () { if (s.alive) fn(); }, ms); s.intervals.push(id); return id; };
    s.after = function (ms, fn) { var id = setTimeout(function () { if (s.alive) fn(); }, ms); s.timers.push(id); return id; };
    return s;
  }
  function destroySession(s) {
    var i = sessions.indexOf(s);
    if (i >= 0) sessions.splice(i, 1);
    s.nodes.slice().forEach(function (node) {
      try { node.stop(); } catch (e) {}
      try { node.disconnect(); } catch (e) {}
    });
    s.nodes = []; s.sources = 0;
    try { s.gain.disconnect(); } catch (e) {}
  }
  function stopSession(s, fade) {
    var i;
    if (!s.alive) return;
    s.alive = false;
    s.timers.forEach(function (id) { clearTimeout(id); });
    s.intervals.forEach(function (id) { clearInterval(id); });
    s.timers = []; s.intervals = [];
    if (context) {
      try {
        s.gain.gain.cancelScheduledValues(context.currentTime);
        s.gain.gain.setTargetAtTime(0.0001, context.currentTime, Math.max(0.03, (fade || 0) / 3));
      } catch (e) {}
    }
    i = Math.round((fade || 0) * 1000) + 120;
    setTimeout(function () { destroySession(s); }, i);
  }
  function stopAllSessions(fade) { sessions.slice().forEach(function (s) { stopSession(s, fade); }); }
  function liveSession(id) {
    var found = null;
    sessions.forEach(function (s) { if (s.alive && s.id === id) found = s; });
    return found;
  }

  /* ---------- Node helpers (all connect into the session gain) ---------- */
  function tone(s, freq, start, dur, type, peak, attack, glideTo, dest) {
    var osc, gain, end = start + dur;
    if (!context || !s.alive) return null;
    osc = context.createOscillator(); gain = context.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq, start);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, glideTo), end);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + (attack || 0.02));
    gain.gain.setTargetAtTime(0.0001, Math.max(start, end - Math.min(1.2, dur * 0.35)), Math.max(0.05, dur * 0.12));
    osc.connect(gain); gain.connect(dest || s.gain);
    s.track(osc, true); s.track(gain, false);
    osc.onended = function () { s.untrack(osc, true); s.untrack(gain, false); try { osc.disconnect(); gain.disconnect(); } catch (e) {} };
    try { osc.start(start); osc.stop(end + 0.15); } catch (e) { s.untrack(osc, true); s.untrack(gain, false); return null; }
    return osc;
  }
  function padTone(s, freq, start, dur, type, peak, attack, dest) {
    var osc, gain, end = start + dur;
    if (!context || !s.alive) return null;
    osc = context.createOscillator(); gain = context.createGain();
    osc.type = type; osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + attack);
    gain.gain.setTargetAtTime(0.0001, Math.max(start + attack, end - Math.min(2.5, dur * 0.22)), Math.max(0.4, dur * 0.1));
    osc.connect(gain); gain.connect(dest || s.gain);
    s.track(osc, true); s.track(gain, false);
    osc.onended = function () { s.untrack(osc, true); s.untrack(gain, false); try { osc.disconnect(); gain.disconnect(); } catch (e) {} };
    try { osc.start(start); osc.stop(end + 0.2); } catch (e) { s.untrack(osc, true); s.untrack(gain, false); return null; }
    return osc;
  }
  function burst(s, start, dur, filterType, freq, q, peak, brown, rate) {
    var source, filter, gain;
    if (!context || !s.alive) return;
    source = context.createBufferSource(); source.buffer = brown ? makeBrown() : makeWhite();
    if (rate) source.playbackRate.value = rate;
    filter = context.createBiquadFilter(); filter.type = filterType; filter.frequency.value = freq;
    if (q) filter.Q.value = q;
    gain = context.createGain();
    gain.gain.setValueAtTime(Math.max(0.0002, peak), start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    source.connect(filter); filter.connect(gain); gain.connect(s.gain);
    s.track(source, true); s.track(filter, false); s.track(gain, false);
    source.onended = function () {
      s.untrack(source, true); s.untrack(filter, false); s.untrack(gain, false);
      try { source.disconnect(); filter.disconnect(); gain.disconnect(); } catch (e) {}
    };
    try { source.start(start); source.stop(start + dur + 0.05); } catch (e) { s.untrack(source, true); s.untrack(filter, false); s.untrack(gain, false); }
  }
  function loopNoise(s, brown, filterType, freq, q, level) {
    var source, filter, gain;
    source = context.createBufferSource(); source.buffer = brown ? makeBrown() : makeWhite(); source.loop = true;
    filter = context.createBiquadFilter(); filter.type = filterType; filter.frequency.value = freq;
    if (q) filter.Q.value = q;
    gain = context.createGain(); gain.gain.value = level;
    source.connect(filter); filter.connect(gain); gain.connect(s.gain);
    s.track(source, true); s.track(filter, false); s.track(gain, false);
    try { source.start(); } catch (e) {}
    return { source: source, filter: filter, gain: gain };
  }
  function lfo(s, rate, depth, param) {
    var osc, gain;
    osc = context.createOscillator(); gain = context.createGain();
    osc.type = 'sine'; osc.frequency.value = rate; gain.gain.value = depth;
    osc.connect(gain); gain.connect(param);
    s.track(osc, true); s.track(gain, false);
    try { osc.start(); } catch (e) {}
    return osc;
  }
  function kick(s, start) {
    var osc, gain;
    if (!context || !s.alive) return;
    osc = context.createOscillator(); gain = context.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, start);
    osc.frequency.exponentialRampToValueAtTime(42, start + 0.12);
    gain.gain.setValueAtTime(0.20, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
    osc.connect(gain); gain.connect(s.gain);
    s.track(osc, true); s.track(gain, false);
    osc.onended = function () { s.untrack(osc, true); s.untrack(gain, false); try { osc.disconnect(); gain.disconnect(); } catch (e) {} };
    try { osc.start(start); osc.stop(start + 0.18); } catch (e) { s.untrack(osc, true); s.untrack(gain, false); }
  }
  /* Look-ahead scheduler: state.next is the audio time of the next event;
     fn(state) schedules one event at state.next and advances it. */
  function scheduler(s, intervalMs, ahead, state, fn) {
    function tick() {
      if (!s.alive || !context) return;
      while (state.next < context.currentTime + ahead) fn(state);
    }
    state.next = context.currentTime + 0.06;
    tick();
    s.every(intervalMs, tick);
  }

  /* ---------- Scenes: tunes ---------- */
  function scheduleRelaxingChord(s, start, index) {
    var chord = CHORDS[index % CHORDS.length], i;
    for (i = 0; i < 4; i++) tone(s, chord[i], start, 13, i % 2 ? 'sine' : 'triangle', i === 0 ? 0.055 : 0.038, 2.4);
    tone(s, chord[[4, 3, 2, 4][index % 4]], start + 2.2, 3.6, 'sine', 0.030, 0.7);
    tone(s, chord[[2, 4, 3, 2][index % 4]], start + 5.6, 3.2, 'sine', 0.026, 0.7);
  }
  function startRelaxing(s) {
    var state = { next: 0, chord: 0 };
    scheduler(s, 900, 2, state, function () {
      scheduleRelaxingChord(s, state.next, state.chord);
      state.chord++; state.next += 10.5;
    });
  }
  function startMusic(s) {
    var state = { next: 0, step: 0 }, stepDuration = 60 / 84 / 2;
    scheduler(s, 110, 0.3, state, function () {
      var number = state.step, start = state.next;
      var bar = Math.floor(number / 8) % 4, local = number % 8, chord = CHORDS[bar], lead = LEAD[number % LEAD.length], i;
      if (local === 0 || local === 3 || local === 6) tone(s, BASS[bar] * 2, start, 0.30, 'sine', 0.105, 0.012);
      if (local === 0 || local === 4) for (i = 1; i < 4; i++) tone(s, chord[i], start, 0.42, 'triangle', 0.026, 0.012);
      if (lead >= 0) tone(s, chord[lead], start, 0.34, 'sine', 0.052, 0.012);
      if (local === 0 || local === 4) kick(s, start);
      if (local % 2) burst(s, start, 0.045, 'highpass', 7000, 0, 0.05);
      state.step++; state.next += stepDuration;
    });
  }
  var PIANO_CHORDS = [
    [261.63, 329.63, 392.00, 493.88],
    [220.00, 261.63, 329.63, 392.00],
    [174.61, 220.00, 261.63, 329.63],
    [196.00, 246.94, 293.66, 392.00]
  ];
  function pianoPluck(s, freq, start, peak) {
    tone(s, freq, start, 2.8, 'triangle', peak, 0.005);
    tone(s, freq * 2, start, 1.6, 'sine', peak * 0.32, 0.005);
  }
  function startPiano(s) {
    var state = { next: 0, bar: 0 };
    scheduler(s, 250, 1.2, state, function () {
      var start = state.next, chord = PIANO_CHORDS[state.bar % 4], i;
      for (i = 0; i < 4; i++) tone(s, chord[i], start, 7.5, 'sine', 0.020, 1.6);
      tone(s, BASS[state.bar % 4], start, 5, 'sine', 0.045, 0.8);
      pianoPluck(s, chord[(state.bar * 2 + 1) % 4] * 2, start + 0.4, 0.13);
      pianoPluck(s, chord[(state.bar * 3 + 2) % 4] * 2, start + 2.6, 0.10);
      if (state.bar % 2) pianoPluck(s, chord[(state.bar + 3) % 4], start + 4.6, 0.08);
      state.bar++; state.next += 7;
    });
  }
  var LOFI_CHORDS = [
    [174.61, 220.00, 261.63, 329.63],
    [164.81, 196.00, 246.94, 293.66],
    [146.83, 174.61, 220.00, 261.63],
    [130.81, 164.81, 196.00, 246.94]
  ];
  var LOFI_ROOTS = [87.31, 82.41, 73.42, 65.41];
  function startLofi(s) {
    var state = { next: 0, step: 0 }, stepDuration = 60 / 72 / 2;
    loopNoise(s, false, 'lowpass', 3600, 0, 0.006);
    scheduler(s, 120, 0.35, state, function () {
      var start = state.next, bar = Math.floor(state.step / 8) % 4, local = state.step % 8, chord = LOFI_CHORDS[bar], i;
      if (local === 0 || local === 5) for (i = 0; i < 4; i++) tone(s, chord[i], start, 0.55, 'triangle', 0.045, 0.01);
      if (local === 0 || local === 4) tone(s, LOFI_ROOTS[bar], start, 0.8, 'sine', 0.13, 0.01);
      if (local === 0 || local === 3 || local === 4) kick(s, start);
      if (local === 2 || local === 6) burst(s, start, 0.04, 'highpass', 7500, 0, 0.028);
      if (Math.random() < 0.3) burst(s, start + rand(0, 0.2), 0.015, 'bandpass', rand(2400, 4200), 1, 0.014);
      state.step++; state.next += stepDuration;
    });
  }
  var MUSICBOX_PATTERN = [0, -1, 4, -1, 7, -1, 4, -1, 9, -1, 7, -1, 4, -1, 2, -1,
                          0, -1, 2, -1, 4, -1, 2, -1, 0, -1, -1, -1, -1, -1, -1, -1];
  function musicboxNote(s, degree, start, peak) {
    var freq = 1046.5 * Math.pow(2, degree / 12);
    tone(s, freq, start, 2.2, 'sine', peak, 0.004);
    tone(s, freq * 3, start, 0.9, 'sine', peak * 0.18, 0.004);
  }
  function startMusicbox(s) {
    var state = { next: 0, step: 0 };
    scheduler(s, 140, 0.6, state, function () {
      var start = state.next, degree = MUSICBOX_PATTERN[state.step % MUSICBOX_PATTERN.length];
      if (degree >= 0) {
        musicboxNote(s, degree, start, 0.075);
        musicboxNote(s, degree, start + 0.42, 0.026);
      }
      if (state.step % 8 === 0) musicboxNote(s, (degree >= 0 ? degree : 0) - 12, start, 0.03);
      state.step++; state.next += 0.85;
    });
  }
  var STRING_CHORDS = [
    [110.00, 164.81, 220.00, 261.63],
    [87.31, 130.81, 174.61, 220.00],
    [130.81, 164.81, 196.00, 261.63],
    [98.00, 146.83, 196.00, 246.94]
  ];
  function startStrings(s) {
    var filter = context.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 640; filter.Q.value = 0.4;
    filter.connect(s.gain); s.track(filter, false);
    lfo(s, 0.03, 140, filter.frequency);
    var state = { next: 0, bar: 0 };
    scheduler(s, 400, 1.5, state, function () {
      var start = state.next, chord = STRING_CHORDS[state.bar % 4], i, f;
      for (i = 0; i < 4; i++) {
        f = chord[i];
        padTone(s, f * 0.997, start, 13.5, 'sawtooth', i === 0 ? 0.020 : 0.015, 4.2, filter);
        padTone(s, f * 1.003, start, 13.5, 'sawtooth', i === 0 ? 0.020 : 0.015, 4.2, filter);
      }
      state.bar++; state.next += 11.5;
    });
  }
  var JAZZ_CHORDS = [
    [146.83, 174.61, 220.00, 261.63],
    [196.00, 246.94, 293.66, 349.23],
    [130.81, 164.81, 196.00, 246.94],
    [220.00, 277.18, 329.63, 392.00]
  ];
  var JAZZ_ROOTS = [73.42, 98.00, 65.41, 55.00];
  var JAZZ_WALK = [0, 7, 4, 11];
  function startJazz(s) {
    var state = { next: 0, step: 0 }, stepDuration = 60 / 96 / 2;
    scheduler(s, 110, 0.3, state, function () {
      var number = state.step, start = state.next + (number % 2 ? stepDuration * 0.3 : 0);
      var bar = Math.floor(number / 8) % 4, local = number % 8, chord = JAZZ_CHORDS[bar], i;
      if (local % 2 === 0) tone(s, JAZZ_ROOTS[bar] * Math.pow(2, JAZZ_WALK[local / 2] / 12), start, 0.5, 'triangle', 0.13, 0.01);
      if (local === 2 || local === 6) for (i = 0; i < 4; i++) tone(s, chord[i], start, 0.3, 'triangle', 0.034, 0.008);
      if (local % 2 === 0) burst(s, start, 0.16, 'bandpass', 6200, 0.6, 0.016);
      else burst(s, start, 0.03, 'highpass', 8000, 0, 0.007);
      state.step++; state.next += stepDuration;
    });
  }
  var GUITAR_CHORDS = [
    [98.00, 123.47, 146.83, 196.00, 246.94, 293.66],
    [130.81, 164.81, 196.00, 261.63, 329.63],
    [146.83, 220.00, 293.66, 369.99],
    [82.41, 123.47, 164.81, 196.00, 246.94]
  ];
  var GUITAR_PATTERN = [0, 2, 4, 3, 0, 2, 4, 3];
  function guitarPluck(s, freq, start, peak) {
    tone(s, freq, start, 0.85, 'triangle', peak, 0.004);
    tone(s, freq * 2, start, 0.4, 'sine', peak * 0.25, 0.004);
    tone(s, freq, start + 0.27, 0.7, 'triangle', peak * 0.3, 0.004);
  }
  function startGuitar(s) {
    var state = { next: 0, step: 0 }, stepDuration = 0.3;
    scheduler(s, 110, 0.3, state, function () {
      var start = state.next, bar = Math.floor(state.step / 8) % 4, local = state.step % 8, chord = GUITAR_CHORDS[bar];
      var idx = GUITAR_PATTERN[local] % chord.length;
      guitarPluck(s, chord[idx], start, local === 0 ? 0.15 : 0.11);
      state.step++; state.next += stepDuration;
    });
  }

  /* ---------- Scenes: beach and landscape sounds ---------- */
  function startBeach(s) {
    var swell = loopNoise(s, false, 'bandpass', 520, 0.55, 0.5);
    lfo(s, 0.065, 240, swell.filter.frequency);
    lfo(s, 0.065, 0.30, swell.gain.gain);
    var foam = loopNoise(s, false, 'highpass', 5200, 0, 0.012);
    lfo(s, 0.11, 0.008, foam.gain.gain);
  }
  function rainBed(s, level) {
    loopNoise(s, false, 'lowpass', 850, 0, level);
    loopNoise(s, false, 'bandpass', 2400, 0.3, level * 0.16);
  }
  function startRain(s) {
    rainBed(s, 0.34);
    s.every(280, function () {
      var now = context.currentTime + 0.03, r = Math.random(), f;
      if (r < 0.65) { f = rand(1700, 3300); tone(s, f, now, 0.07, 'sine', 0.035, 0.004, f * 0.82); }
      else if (r < 0.8) { f = rand(1700, 3300); tone(s, f, now, 0.07, 'sine', 0.03, 0.004, f * 0.82); tone(s, f * 1.2, now + 0.09, 0.06, 'sine', 0.022, 0.004, f); }
    });
  }
  function startStorm(s) {
    loopNoise(s, false, 'lowpass', 750, 0, 0.20);
    var gust = loopNoise(s, false, 'bandpass', 350, 0.8, 0.03);
    lfo(s, 0.06, 0.028, gust.gain.gain);
    function rumble(delay) {
      s.after(delay, function () {
        var start = context.currentTime + 0.05, peak = rand(0.35, 0.6), dur = rand(2.5, 4.5);
        var source = context.createBufferSource(); source.buffer = makeBrown(); source.playbackRate.value = 0.5;
        var filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 110;
        var gain = context.createGain();
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(peak, start + rand(0.3, 0.7));
        gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
        source.connect(filter); filter.connect(gain); gain.connect(s.gain);
        s.track(source, true); s.track(filter, false); s.track(gain, false);
        source.onended = function () {
          s.untrack(source, true); s.untrack(filter, false); s.untrack(gain, false);
          try { source.disconnect(); filter.disconnect(); gain.disconnect(); } catch (e) {}
        };
        try { source.start(start); source.stop(start + dur + 0.1); } catch (e) {}
        rumble(rand(6000, 15000));
      });
    }
    rumble(2200);
  }
  function chirp(s, start) {
    var base = rand(2300, 3000), n = randInt(2, 4), i, f, osc, gain, t;
    for (i = 0; i < n; i++) {
      f = base * rand(0.95, 1.08); t = start + i * 0.11;
      osc = context.createOscillator(); gain = context.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(f, t);
      osc.frequency.linearRampToValueAtTime(f * 1.16, t + 0.04);
      osc.frequency.linearRampToValueAtTime(f * 0.92, t + 0.08);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.045, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
      osc.connect(gain); gain.connect(s.gain);
      s.track(osc, true); s.track(gain, false);
      (function (o, g) {
        o.onended = function () { s.untrack(o, true); s.untrack(g, false); try { o.disconnect(); g.disconnect(); } catch (e) {} };
      }(osc, gain));
      try { osc.start(t); osc.stop(t + 0.1); } catch (e) { s.untrack(osc, true); s.untrack(gain, false); }
    }
  }
  function startForest(s) {
    var windBed = loopNoise(s, false, 'bandpass', 480, 0.45, 0.05);
    lfo(s, 0.05, 130, windBed.filter.frequency);
    lfo(s, 0.037, 0.02, windBed.gain.gain);
    s.after(600, function () { chirp(s, context.currentTime + 0.05); });
    s.every(1300, function () { if (Math.random() < 0.55) chirp(s, context.currentTime + 0.05); });
  }
  function startStream(s) {
    var flow = loopNoise(s, false, 'bandpass', 900, 0.7, 0.17);
    lfo(s, 0.05, 300, flow.filter.frequency);
    lfo(s, 0.23, 120, flow.filter.frequency);
    s.every(200, function () {
      var f;
      if (Math.random() < 0.45) { f = rand(500, 1400); tone(s, f, context.currentTime + 0.03, 0.05, 'sine', 0.018, 0.006, f * 1.35); }
    });
  }
  function startWind(s) {
    var main = loopNoise(s, false, 'lowpass', 480, 0.4, 0.17);
    lfo(s, 0.043, 260, main.filter.frequency);
    lfo(s, 0.031, 0.07, main.gain.gain);
    var whistle = loopNoise(s, false, 'bandpass', 900, 6, 0.004);
    lfo(s, 0.07, 0.003, whistle.gain.gain);
    lfo(s, 0.017, 180, whistle.filter.frequency);
  }
  function startCrickets(s) {
    loopNoise(s, false, 'lowpass', 240, 0, 0.012);
    var flip = false;
    function train() {
      var start = context.currentTime + 0.05, freq = flip ? 4650 : 4200, i;
      flip = !flip;
      for (i = 0; i < 4; i++) tone(s, freq * rand(0.99, 1.01), start + i * 0.085, 0.05, 'sine', 0.030, 0.008);
      if (Math.random() < 0.3) for (i = 0; i < 3; i++) tone(s, 3900, start + 0.5 + i * 0.09, 0.05, 'sine', 0.012, 0.008);
    }
    train();
    s.every(1050, train);
  }
  function startCampfire(s) {
    loopNoise(s, true, 'lowpass', 240, 0, 0.5);
    function pop() {
      var big = Math.random() < 0.08;
      burst(s, context.currentTime + 0.02, big ? rand(0.09, 0.14) : rand(0.02, 0.05),
        'bandpass', big ? rand(300, 600) : rand(700, 3300), 1,
        big ? rand(0.14, 0.22) : rand(0.04, 0.18), false, rand(0.8, 1.3));
      s.after(rand(50, 380), pop);
    }
    s.after(150, pop);
  }
  function startOcean(s) {
    var deep = loopNoise(s, true, 'lowpass', 200, 0.4, 0.5);
    lfo(s, 0.04, 0.22, deep.gain.gain);
    lfo(s, 0.025, 60, deep.filter.frequency);
    var sub = context.createOscillator(), subGain = context.createGain();
    sub.type = 'sine'; sub.frequency.value = 54; subGain.gain.value = 0.05;
    sub.connect(subGain); subGain.connect(s.gain);
    s.track(sub, true); s.track(subGain, false);
    lfo(s, 0.04, 0.02, subGain.gain);
    try { sub.start(); } catch (e) {}
  }

  /* ---------- Scene catalogue (settings and Cycle order) ---------- */
  var SCENES = [
    { id: 'relaxing', name: 'Relaxing tunes', level: 0.48, start: startRelaxing },
    { id: 'music', name: 'Music', level: 0.62, start: startMusic },
    { id: 'piano', name: 'Piano dawn', level: 0.85, start: startPiano },
    { id: 'lofi', name: 'Lo-fi keys', level: 0.85, start: startLofi },
    { id: 'musicbox', name: 'Music box', level: 0.85, start: startMusicbox },
    { id: 'strings', name: 'String pads', level: 0.9, start: startStrings },
    { id: 'jazz', name: 'Jazz café', level: 0.85, start: startJazz },
    { id: 'guitar', name: 'Acoustic plucks', level: 0.9, start: startGuitar },
    { id: 'beach', name: 'Beach waves', level: 0.55, start: startBeach },
    { id: 'rain', name: 'Rain', level: 0.6, start: startRain },
    { id: 'storm', name: 'Thunderstorm', level: 0.6, start: startStorm },
    { id: 'forest', name: 'Forest birds', level: 0.75, start: startForest },
    { id: 'stream', name: 'Mountain stream', level: 0.6, start: startStream },
    { id: 'wind', name: 'Meadow wind', level: 0.55, start: startWind },
    { id: 'crickets', name: 'Night crickets', level: 0.85, start: startCrickets },
    { id: 'campfire', name: 'Campfire', level: 0.65, start: startCampfire },
    { id: 'ocean', name: 'Deep ocean', level: 0.65, start: startOcean }
  ];
  function sceneById(id) {
    var found = null;
    SCENES.forEach(function (scene) { if (scene.id === id) found = scene; });
    return found;
  }
  function sceneIndex(id) {
    var index = -1;
    SCENES.forEach(function (scene, i) { if (scene.id === id) index = i; });
    return index;
  }
  function validMode(mode) { return mode === 'off' || mode === 'cycle' || !!sceneById(mode); }

  /* ---------- Engine ---------- */
  function startSession(def, fade) {
    var s = createSession(def), now = context.currentTime;
    sessions.push(s);
    try {
      s.gain.gain.setValueAtTime(0.0001, now);
      s.gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, def.level), now + Math.max(0.1, fade));
    } catch (e) {}
    def.start(s);
    return s;
  }
  function crossfadeTo(id, fade) {
    var def = sceneById(id);
    if (!def || !context) return false;
    sessions.slice().forEach(function (s) { if (s.id !== id) stopSession(s, fade); });
    if (!liveSession(id)) startSession(def, fade);
    activeScene = id;
    if (desired === 'cycle') cycleScene = id;
    lastError = context.state === 'suspended' ? 'Audio is waiting for a remote key press.' : null;
    return true;
  }
  function clearCycleTimer() { if (cycleTimer) clearTimeout(cycleTimer); cycleTimer = 0; }
  function armCycle(ms) {
    clearCycleTimer();
    cycleDeadline = Date.now() + ms;
    cycleTimer = setTimeout(function () {
      cycleTimer = 0;
      if (desired !== 'cycle' || activeMode !== 'cycle') return;
      advanceCycle();
    }, ms);
  }
  function advanceCycle() {
    cycleIndex = (cycleIndex + 1) % SCENES.length;
    cycleRemaining = CYCLE_MS;
    crossfadeTo(SCENES[cycleIndex].id, 4);
    armCycle(CYCLE_MS);
  }
  function setMode(mode) {
    if (!validMode(mode)) return false;
    desired = mode;
    clearCycleTimer();
    if (mode === 'off') {
      activeMode = 'off'; activeScene = 'off';
      stopAllSessions(0.3);
      return true;
    }
    if (!ensureContext()) { activeMode = 'off'; activeScene = 'off'; return false; }
    resumeContext();
    if (mode === 'cycle') {
      if (activeMode === 'cycle' && liveSession(activeScene)) { armCycle(cycleRemaining > 0 ? cycleRemaining : CYCLE_MS); return true; }
      activeMode = 'cycle';
      cycleIndex = 0; cycleRemaining = CYCLE_MS;
      crossfadeTo(SCENES[0].id, 2.5);
      armCycle(CYCLE_MS);
      return true;
    }
    if (activeMode === mode && activeScene === mode && liveSession(mode)) { resumeContext(); return true; }
    activeMode = mode;
    crossfadeTo(mode, sessions.length ? 4 : 1.6);
    return true;
  }
  function pause() {
    if (activeMode === 'cycle') {
      cycleRemaining = Math.max(0, cycleDeadline - Date.now());
      clearCycleTimer();
    }
    stopAllSessions(0.2);
    activeMode = 'off'; activeScene = 'off';
  }
  function resume() {
    if (desired === 'off') return true;
    if (activeMode !== 'off' && liveSession(activeScene)) { resumeContext(); return true; }
    if (!ensureContext()) return false;
    resumeContext();
    if (desired === 'cycle') {
      var id = cycleScene || SCENES[cycleIndex].id;
      activeMode = 'cycle';
      cycleIndex = Math.max(0, sceneIndex(id));
      crossfadeTo(id, 1.2);
      armCycle(cycleRemaining > 0 ? cycleRemaining : CYCLE_MS);
      return true;
    }
    activeMode = desired;
    crossfadeTo(desired, 1.2);
    return true;
  }
  function next() {
    if (desired !== 'cycle' || activeMode !== 'cycle') return activeScene;
    advanceCycle();
    return activeScene;
  }
  function state() {
    var sources = 0;
    sessions.forEach(function (s) { sources += s.sources; });
    return {
      preference: desired,
      active: activeMode,
      scene: activeScene,
      context: context ? context.state : 'none',
      sources: sources,
      error: lastError
    };
  }
  function scenes() {
    return SCENES.map(function (scene) { return { id: scene.id, name: scene.name }; });
  }

  window.FrameAudio = { setMode: setMode, pause: pause, resume: resume, next: next, state: state, scenes: scenes };
}());
