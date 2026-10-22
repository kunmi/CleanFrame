/* CleanFrame background audio.
   Original generative Web Audio: no audio files and no copyrighted music.
   Playback belongs to the visible CleanFrame app; main.js pauses it before
   another app is launched and resumes it when CleanFrame becomes visible. */
(function () {
  'use strict';

  var MODES = ['off', 'relaxing', 'music'];
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

  var context = null, master = null, noise = null;
  var desired = 'off', activeMode = 'off', lastError = null;
  var timer = 0, generation = 0, nodes = [];
  var step = 0, nextStep = 0, chordIndex = 0, nextChord = 0;

  function valid(mode) { return MODES.indexOf(mode) >= 0; }
  function forget(node) {
    var i = nodes.indexOf(node);
    if (i >= 0) nodes.splice(i, 1);
  }
  function ensureContext() {
    var AC;
    if (context) return context;
    AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { lastError = 'Web Audio is not available on this TV.'; return null; }
    try {
      context = new AC();
      master = context.createGain();
      master.gain.value = 0;
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
  function clearTimer() { if (timer) clearInterval(timer); timer = 0; }
  function stopEngine(fade) {
    var old = nodes.slice(), delay = Math.round((fade || 0) * 1000);
    clearTimer();
    activeMode = 'off';
    nodes = [];
    if (master && context) {
      try { master.gain.setTargetAtTime(0.0001, context.currentTime, Math.max(0.03, (fade || 0) / 3)); } catch (e) {}
    }
    function stopOld() {
      old.forEach(function (node) { try { node.stop(); } catch (e) {} try { node.disconnect(); } catch (e) {} });
    }
    if (delay) setTimeout(stopOld, delay); else stopOld();
  }
  function tone(frequency, start, duration, type, peak, attack) {
    var osc, gain, end = start + duration;
    if (!context || !master) return null;
    osc = context.createOscillator(); gain = context.createGain();
    osc.type = type; osc.frequency.setValueAtTime(frequency, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + (attack || 0.02));
    gain.gain.setTargetAtTime(0.0001, Math.max(start, end - Math.min(1.2, duration * 0.35)), Math.max(0.05, duration * 0.12));
    osc.connect(gain); gain.connect(master);
    nodes.push(osc);
    osc.onended = function () { forget(osc); try { osc.disconnect(); gain.disconnect(); } catch (e) {} };
    try { osc.start(start); osc.stop(end + 0.1); } catch (e) { forget(osc); return null; }
    return osc;
  }
  function makeNoise() {
    var buffer, data, i;
    if (noise) return noise;
    buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
    data = buffer.getChannelData(0);
    for (i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    noise = buffer;
    return buffer;
  }
  function hat(start) {
    var source, filter, gain;
    if (!context || !master) return;
    source = context.createBufferSource(); source.buffer = makeNoise();
    filter = context.createBiquadFilter(); filter.type = 'highpass'; filter.frequency.value = 7000;
    gain = context.createGain();
    gain.gain.setValueAtTime(0.055, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.045);
    source.connect(filter); filter.connect(gain); gain.connect(master);
    nodes.push(source);
    source.onended = function () { forget(source); try { source.disconnect(); filter.disconnect(); gain.disconnect(); } catch (e) {} };
    try { source.start(start); source.stop(start + 0.06); } catch (e) { forget(source); }
  }
  function kick(start) {
    var osc, gain;
    if (!context || !master) return;
    osc = context.createOscillator(); gain = context.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(120, start);
    osc.frequency.exponentialRampToValueAtTime(42, start + 0.12);
    gain.gain.setValueAtTime(0.20, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
    osc.connect(gain); gain.connect(master); nodes.push(osc);
    osc.onended = function () { forget(osc); try { osc.disconnect(); gain.disconnect(); } catch (e) {} };
    try { osc.start(start); osc.stop(start + 0.18); } catch (e) { forget(osc); }
  }
  function scheduleChord(start, index) {
    var chord = CHORDS[index % CHORDS.length], i;
    for (i = 0; i < 4; i++) tone(chord[i], start, 13, i % 2 ? 'sine' : 'triangle', i === 0 ? 0.055 : 0.038, 2.4);
    tone(chord[[4, 3, 2, 4][index % 4]], start + 2.2, 3.6, 'sine', 0.030, 0.7);
    tone(chord[[2, 4, 3, 2][index % 4]], start + 5.6, 3.2, 'sine', 0.026, 0.7);
  }
  function scheduleRelaxing() {
    if (!context || activeMode !== 'relaxing') return;
    while (nextChord < context.currentTime + 2) {
      scheduleChord(nextChord, chordIndex);
      chordIndex++;
      nextChord += 10.5;
    }
  }
  function scheduleStep(number, start) {
    var bar = Math.floor(number / 8) % 4, local = number % 8, chord = CHORDS[bar], lead = LEAD[number % LEAD.length], i;
    if (local === 0 || local === 3 || local === 6) tone(BASS[bar] * 2, start, 0.30, 'sine', 0.105, 0.012);
    if (local === 0 || local === 4) for (i = 1; i < 4; i++) tone(chord[i], start, 0.42, 'triangle', 0.026, 0.012);
    if (lead >= 0) tone(chord[lead], start, 0.34, 'sine', 0.052, 0.012);
    if (local === 0 || local === 4) kick(start);
    if (local % 2) hat(start);
  }
  function scheduleMusic() {
    var stepDuration = 60 / 84 / 2;
    if (!context || activeMode !== 'music') return;
    while (nextStep < context.currentTime + 0.30) {
      scheduleStep(step, nextStep);
      step++;
      nextStep += stepDuration;
    }
  }
  function startEngine(mode) {
    var gen = generation;
    if (!ensureContext()) return false;
    resumeContext();
    stopEngine(0.12);
    generation = gen;
    activeMode = mode;
    step = 0; chordIndex = 0;
    try { master.gain.setTargetAtTime(mode === 'music' ? 0.62 : 0.48, context.currentTime, mode === 'music' ? 0.18 : 0.8); } catch (e) {}
    if (mode === 'relaxing') {
      nextChord = context.currentTime + 0.05;
      scheduleRelaxing();
      timer = setInterval(scheduleRelaxing, 900);
    } else if (mode === 'music') {
      nextStep = context.currentTime + 0.05;
      scheduleMusic();
      timer = setInterval(scheduleMusic, 110);
    }
    lastError = context.state === 'suspended' ? 'Audio is waiting for a remote key press.' : null;
    return true;
  }
  function setMode(mode) {
    if (!valid(mode)) return false;
    generation++;
    desired = mode;
    if (mode === 'off') { stopEngine(0.25); return true; }
    return startEngine(mode);
  }
  function pause() {
    generation++;
    stopEngine(0.18);
  }
  function resume() {
    if (desired === 'off') return true;
    if (activeMode === desired && context) { resumeContext(); return true; }
    generation++;
    return startEngine(desired);
  }
  function state() {
    return {
      preference: desired,
      active: activeMode,
      context: context ? context.state : 'none',
      sources: nodes.length,
      error: lastError
    };
  }

  window.FrameAudio = { setMode: setMode, pause: pause, resume: resume, state: state };
}());
