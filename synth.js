/* synth.js — a playable subtractive synthesizer built on the Web Audio API.
   Signal chain, per voice:  Oscillator → Lowpass filter → ADSR amp gain
   ...then a shared bus:      voices → dry + convolver reverb → master → limiter → out
   Two AnalyserNode-fed canvases draw the live scope and spectrum.
   No libraries, no samples, no external assets. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ------------------------------------------------------------------ *
   * State + presets
   * ------------------------------------------------------------------ */
  const state = {
    wave:   "sawtooth",
    cutoff: 8000,  // Hz
    res:    2,     // filter Q, 0..20
    a:      0.005, // attack  (s)
    d:      0.15,  // decay   (s)
    s:      0.75,  // sustain (0..1)
    r:      0.25,  // release (s)
    space:  0.12,  // reverb amount (0..1)
    master: 0.8,   // master volume (0..1)
    octave: 4,     // base octave for the keyboard
  };

  // each preset is a full patch (everything except master volume + octave)
  const PRESETS = {
    saw:   { wave: "sawtooth", cutoff: 8000, res: 2,  a: 0.005, d: 0.15, s: 0.75, r: 0.25, space: 0.12 },
    pad:   { wave: "sawtooth", cutoff: 900,  res: 4,  a: 0.60,  d: 0.40, s: 0.80, r: 1.40, space: 0.55 },
    pluck: { wave: "triangle", cutoff: 3500, res: 6,  a: 0.002, d: 0.18, s: 0.00, r: 0.14, space: 0.16 },
    bass:  { wave: "square",   cutoff: 600,  res: 8,  a: 0.005, d: 0.12, s: 0.70, r: 0.12, space: 0.05 },
  };

  const WAVE_NAME = { sine: "Sine", sawtooth: "Sawtooth", square: "Square", triangle: "Triangle" };

  const VOICE_PEAK = 0.24;         // per-voice ceiling so chords don't clip
  const CUT_MIN = 50, CUT_MAX = 12000; // filter cutoff slider range (log)

  /* ------------------------------------------------------------------ *
   * Small helpers
   * ------------------------------------------------------------------ */
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const posToHz = (p) => CUT_MIN * Math.pow(CUT_MAX / CUT_MIN, clamp(p, 0, 1));
  const hzToPos = (hz) => Math.log(clamp(hz, CUT_MIN, CUT_MAX) / CUT_MIN) / Math.log(CUT_MAX / CUT_MIN);
  const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const baseMidi = () => 12 * (state.octave + 1); // C of the current octave
  const wetFromSpace = (s) => s * 0.9;

  const fmtHz = (hz) => (hz >= 1000 ? (hz / 1000).toFixed(1) + " kHz" : Math.round(hz) + " Hz");
  const fmtSec = (s) => (s < 1 ? Math.round(s * 1000) + " ms" : s.toFixed(2) + " s");
  const fmtPct = (v) => Math.round(v * 100) + "%";

  function hexToRgba(hex, a) {
    hex = hex.replace("#", "").trim();
    if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
    const n = parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  const css = getComputedStyle(document.documentElement);
  const ACCENT = (css.getPropertyValue("--accent").trim() || "#c07cff");
  const ACCENT_DIM = hexToRgba(ACCENT, 0.35);
  const GRID = "rgba(255,255,255,0.05)";

  /* ------------------------------------------------------------------ *
   * Audio graph (built lazily on first gesture)
   * ------------------------------------------------------------------ */
  let audio = null;               // holds ctx + shared nodes once created
  const voices = new Map();       // semitone-offset -> { osc, filter, amp }
  let sculpting = false;

  function makeImpulse(ctx, seconds, decay) {
    // a stereo burst of noise that fades out — a cheap but decent reverb IR
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  function ensureAudio() {
    if (audio) {
      if (audio.ctx.state !== "running") audio.ctx.resume().then(updateEnable);
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();

    const busIn = ctx.createGain();  busIn.gain.value = 1;   // every voice lands here
    const dry   = ctx.createGain();  dry.gain.value = 1;
    const wet   = ctx.createGain();  wet.gain.value = wetFromSpace(state.space);
    const conv  = ctx.createConvolver(); conv.buffer = makeImpulse(ctx, 2.4, 2.4);
    const master = ctx.createGain(); master.gain.value = state.master;

    // a gentle limiter so aggressive patches / big chords can't clip nastily
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -8; comp.knee.value = 6; comp.ratio.value = 6;
    comp.attack.value = 0.003; comp.release.value = 0.25;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.8;

    // wiring: busIn splits into dry + reverb, recombines at master
    busIn.connect(dry);  dry.connect(master);
    busIn.connect(conv); conv.connect(wet); wet.connect(master);
    master.connect(comp); comp.connect(ctx.destination);
    master.connect(analyser); // tap the master for the visualisers

    audio = {
      ctx, busIn, dry, wet, conv, master, comp, analyser,
      timeData: new Uint8Array(analyser.fftSize),
      freqData: new Uint8Array(analyser.frequencyBinCount),
    };

    ctx.onstatechange = updateEnable;
    ctx.resume().then(updateEnable);
    startDraw();
    updateEnable();
  }

  /* ------------------------------------------------------------------ *
   * Voices — one oscillator + filter + gain per held note
   * ------------------------------------------------------------------ */
  function createVoice(semi) {
    const ctx = audio.ctx, now = ctx.currentTime;
    const freq = midiToFreq(baseMidi() + semi);

    const osc = ctx.createOscillator();
    osc.type = state.wave;
    osc.frequency.setValueAtTime(freq, now);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(state.cutoff, now);
    filter.Q.setValueAtTime(state.res, now);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0.0001, now);

    osc.connect(filter); filter.connect(amp); amp.connect(audio.busIn);

    // ADSR attack → decay → sustain, ramped so there are no clicks
    const atk = Math.max(0.001, state.a);
    const dec = Math.max(0.001, state.d);
    const sus = Math.max(0.0001, state.s * VOICE_PEAK);
    amp.gain.linearRampToValueAtTime(VOICE_PEAK, now + atk);
    amp.gain.linearRampToValueAtTime(sus, now + atk + dec);

    osc.start(now);
    return { osc, filter, amp };
  }

  function releaseVoice(v) {
    const ctx = audio.ctx, now = ctx.currentTime;
    const g = v.amp.gain;
    // hold whatever the envelope is at right now, then ramp down over release
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(now);
    else { g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); }
    const rel = Math.max(0.005, state.r);
    g.linearRampToValueAtTime(0.0001, now + rel);
    try { v.osc.stop(now + rel + 0.03); } catch (e) { /* already stopped */ }
    v.osc.onended = () => {
      try { v.osc.disconnect(); v.filter.disconnect(); v.amp.disconnect(); } catch (e) {}
    };
  }

  function noteOn(semi) {
    ensureAudio();
    if (voices.has(semi)) return; // already sounding
    voices.set(semi, createVoice(semi));
    lightKey(semi, true);
  }

  function noteOff(semi) {
    const v = voices.get(semi);
    if (!v) return;
    voices.delete(semi);
    releaseVoice(v);
    lightKey(semi, false);
  }

  function releaseAll() {
    for (const semi of [...voices.keys()]) noteOff(semi);
    pointerNotes.clear();
  }

  /* ------------------------------------------------------------------ *
   * On-screen keyboard (~1.5 octaves)
   * ------------------------------------------------------------------ */
  const SEMIS = 18; // C .. F an octave and a half up
  const WHITE = new Set([0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 17]);
  const KEYCHAR = { 0: "A", 1: "W", 2: "S", 3: "E", 4: "D", 5: "F", 6: "T", 7: "G", 8: "Y", 9: "H", 10: "U", 11: "J", 12: "K" };
  const keyEls = {};              // semi -> element
  const pointerNotes = new Map(); // pointerId -> semi (for touch/mouse tracking)

  function buildKeyboard() {
    const kb = $("keyboard");
    kb.innerHTML = "";
    const nWhite = [...WHITE].filter((s) => s < SEMIS).length;
    const wW = 100 / nWhite;       // white-key width, %
    const bW = wW * 0.62;          // black-key width, %

    const blacks = [];
    let whiteCount = 0;
    for (let s = 0; s < SEMIS; s++) {
      if (WHITE.has(s)) {
        kb.appendChild(makeKey(s, false, whiteCount * wW, wW));
        whiteCount++;
      } else {
        blacks.push({ s, boundary: whiteCount }); // whites already placed = whites below it
      }
    }
    // black keys straddle the boundary between two whites, drawn on top
    blacks.forEach(({ s, boundary }) => {
      kb.appendChild(makeKey(s, true, boundary * wW - bW / 2, bW));
    });
  }

  function makeKey(semi, black, leftPct, widthPct) {
    const el = document.createElement("div");
    el.className = "key " + (black ? "black" : "white");
    el.style.left = leftPct + "%";
    el.style.width = widthPct + "%";
    el.dataset.semi = semi;
    el.setAttribute("role", "button");
    const ch = KEYCHAR[semi];
    if (ch) {
      const lab = document.createElement("span");
      lab.className = "lab";
      lab.textContent = ch;
      el.appendChild(lab);
    }
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      ensureAudio();
      pointerNotes.set(e.pointerId, semi);
      noteOn(semi);
    });
    keyEls[semi] = el;
    return el;
  }

  function lightKey(semi, on) {
    const el = keyEls[semi];
    if (el) el.classList.toggle("on", on);
  }

  // pointer released anywhere → release whatever note that pointer started
  function endPointer(e) {
    const semi = pointerNotes.get(e.pointerId);
    if (semi !== undefined) { pointerNotes.delete(e.pointerId); noteOff(semi); }
  }
  window.addEventListener("pointerup", endPointer);
  window.addEventListener("pointercancel", endPointer);

  /* ------------------------------------------------------------------ *
   * Computer-keyboard input
   * ------------------------------------------------------------------ */
  const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12 };

  window.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // ignore only genuine text entry; sliders (range) should still let you play
    const t = e.target;
    if (t && (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && t.type !== "range"))) return;
    const k = e.key.toLowerCase();
    if (k === "z") { setOctave(state.octave - 1); return; }
    if (k === "x") { setOctave(state.octave + 1); return; }
    if (k in KEYMAP) {
      if (e.repeat) return; // ignore auto-repeat while held
      ensureAudio();
      noteOn(KEYMAP[k]);
    }
  });
  window.addEventListener("keyup", (e) => {
    const k = e.key.toLowerCase();
    if (k in KEYMAP) noteOff(KEYMAP[k]);
  });

  // never leave a note stuck when focus leaves the page
  window.addEventListener("blur", releaseAll);
  document.addEventListener("visibilitychange", () => { if (document.hidden) releaseAll(); });

  function setOctave(oct) {
    state.octave = clamp(oct, 1, 6);
    $("oct-val").textContent = state.octave;
    updateReadouts();
  }

  /* ------------------------------------------------------------------ *
   * Controls: chips, sliders, presets
   * ------------------------------------------------------------------ */
  function updateReadouts() {
    $("cutoff-val").textContent = fmtHz(state.cutoff);
    $("resonance-val").textContent = state.res.toFixed(1);
    $("attack-val").textContent = fmtSec(state.a);
    $("decay-val").textContent = fmtSec(state.d);
    $("sustain-val").textContent = fmtPct(state.s);
    $("release-val").textContent = fmtSec(state.r);
    $("space-val").textContent = fmtPct(state.space);
    $("master-val").textContent = fmtPct(state.master);
    // live signal-chain readout
    $("chain-osc").textContent = WAVE_NAME[state.wave] + " · oct " + state.octave;
    $("chain-filter").textContent = "Lowpass " + fmtHz(state.cutoff) + " · Q " + state.res.toFixed(1);
    $("chain-env").textContent = "A " + fmtSec(state.a) + " · S " + fmtPct(state.s) + " · R " + fmtSec(state.r);
    $("chain-space").textContent = "Reverb " + fmtPct(state.space);
  }

  // push slider positions + chips to match `state`, then refresh readouts
  function syncControls() {
    document.querySelectorAll("#waves .chip").forEach((c) =>
      c.setAttribute("aria-pressed", String(c.dataset.wave === state.wave)));
    $("cutoff").value = hzToPos(state.cutoff);
    $("resonance").value = state.res;
    $("attack").value = state.a;
    $("decay").value = state.d;
    $("sustain").value = state.s;
    $("release").value = state.r;
    $("space").value = state.space;
    $("master").value = state.master;
    updateReadouts();
  }

  function clearPresetHighlight() {
    document.querySelectorAll("#presets .chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
  }

  function setLiveFilter() {
    if (!audio) return;
    const now = audio.ctx.currentTime;
    voices.forEach((v) => {
      v.filter.frequency.setTargetAtTime(state.cutoff, now, 0.02);
      v.filter.Q.setTargetAtTime(state.res, now, 0.02);
    });
  }

  function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    Object.assign(state, { wave: p.wave, cutoff: p.cutoff, res: p.res, a: p.a, d: p.d, s: p.s, r: p.r, space: p.space });
    syncControls();
    if (audio) {
      const now = audio.ctx.currentTime;
      voices.forEach((v) => { v.osc.type = state.wave; });
      setLiveFilter();
      audio.wet.gain.setTargetAtTime(wetFromSpace(state.space), now, 0.03);
    }
    document.querySelectorAll("#presets .chip").forEach((c) =>
      c.setAttribute("aria-pressed", String(c.dataset.preset === name)));
  }

  function wireControls() {
    // waveform chips
    document.querySelectorAll("#waves .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        state.wave = chip.dataset.wave;
        document.querySelectorAll("#waves .chip").forEach((c) =>
          c.setAttribute("aria-pressed", String(c === chip)));
        if (audio) voices.forEach((v) => { v.osc.type = state.wave; });
        clearPresetHighlight();
        updateReadouts();
      });
    });

    // preset chips
    document.querySelectorAll("#presets .chip").forEach((chip) => {
      chip.addEventListener("click", () => applyPreset(chip.dataset.preset));
    });

    // sliders
    $("cutoff").addEventListener("input", (e) => {
      state.cutoff = posToHz(+e.target.value); setLiveFilter(); clearPresetHighlight(); updateReadouts();
    });
    $("resonance").addEventListener("input", (e) => {
      state.res = +e.target.value; setLiveFilter(); clearPresetHighlight(); updateReadouts();
    });
    $("attack").addEventListener("input", (e) => { state.a = +e.target.value; clearPresetHighlight(); updateReadouts(); });
    $("decay").addEventListener("input", (e) => { state.d = +e.target.value; clearPresetHighlight(); updateReadouts(); });
    $("sustain").addEventListener("input", (e) => { state.s = +e.target.value; clearPresetHighlight(); updateReadouts(); });
    $("release").addEventListener("input", (e) => { state.r = +e.target.value; clearPresetHighlight(); updateReadouts(); });
    $("space").addEventListener("input", (e) => {
      state.space = +e.target.value;
      if (audio) audio.wet.gain.setTargetAtTime(wetFromSpace(state.space), audio.ctx.currentTime, 0.03);
      clearPresetHighlight(); updateReadouts();
    });
    $("master").addEventListener("input", (e) => {
      state.master = +e.target.value;
      if (audio) audio.master.gain.setTargetAtTime(state.master, audio.ctx.currentTime, 0.02);
      updateReadouts();
    });

    // octave buttons
    $("oct-down").addEventListener("click", () => setOctave(state.octave - 1));
    $("oct-up").addEventListener("click", () => setOctave(state.octave + 1));

    // sculpt-a-pad + enable overlay
    $("sculpt").addEventListener("click", sculptPad);
    const enableEl = $("enable");
    enableEl.addEventListener("click", ensureAudio);
    enableEl.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ensureAudio(); } });
  }

  function updateEnable() {
    const on = audio && audio.ctx.state === "running";
    $("enable").classList.toggle("hidden", !!on);
  }

  /* ------------------------------------------------------------------ *
   * The wow moment: automate a bright saw into a warm pad over ~1.5s
   * ------------------------------------------------------------------ */
  function sculptPad() {
    ensureAudio();
    if (sculpting) return;
    sculpting = true;
    $("sculpt").disabled = true;

    applyPreset("saw"); // start bright + buzzy so the transformation is audible

    const chord = [0, 4, 7, 12]; // C major, plus the octave
    chord.forEach(noteOn);

    const dur = 1.5;
    const t0 = audio.ctx.currentTime;

    // audio: sweep every sounding voice's filter down, open reverb up
    chord.forEach((semi) => {
      const v = voices.get(semi);
      if (!v) return;
      v.filter.frequency.cancelScheduledValues(t0);
      v.filter.frequency.setValueAtTime(9000, t0);
      v.filter.frequency.exponentialRampToValueAtTime(PRESETS.pad.cutoff, t0 + dur);
      v.filter.Q.setValueAtTime(2, t0);
      v.filter.Q.linearRampToValueAtTime(PRESETS.pad.res, t0 + dur);
    });
    audio.wet.gain.cancelScheduledValues(t0);
    audio.wet.gain.setValueAtTime(wetFromSpace(state.space), t0);
    audio.wet.gain.linearRampToValueAtTime(wetFromSpace(PRESETS.pad.space), t0 + dur);

    // visual: slide the knobs from saw → pad so you SEE the same move
    tweenUI(dur * 1000);

    // let the (now long) release ring out, then settle firmly on the pad patch
    setTimeout(() => chord.forEach(noteOff), dur * 1000 + 220);
    setTimeout(() => {
      applyPreset("pad");
      sculpting = false;
      $("sculpt").disabled = false;
    }, dur * 1000 + 280);
  }

  // animate the slider values (not the audio) from the current patch to the pad
  function tweenUI(ms) {
    const from = { cutoff: state.cutoff, res: state.res, a: state.a, d: state.d, s: state.s, r: state.r, space: state.space };
    const to = PRESETS.pad;
    if (reducedMotion) {
      Object.assign(state, { cutoff: to.cutoff, res: to.res, a: to.a, d: to.d, s: to.s, r: to.r, space: to.space });
      syncControls();
      return;
    }
    const t0 = performance.now();
    (function step(now) {
      const k = clamp((now - t0) / ms, 0, 1);
      const e = k * k * (3 - 2 * k); // smoothstep
      state.cutoff = lerp(from.cutoff, to.cutoff, e);
      state.res = lerp(from.res, to.res, e);
      state.a = lerp(from.a, to.a, e);
      state.d = lerp(from.d, to.d, e);
      state.s = lerp(from.s, to.s, e);
      state.r = lerp(from.r, to.r, e);
      state.space = lerp(from.space, to.space, e);
      syncControls(); // moves the sliders + readouts + chain, but does NOT touch the voices
      if (k < 1) requestAnimationFrame(step);
    })(t0);
  }

  /* ------------------------------------------------------------------ *
   * Visualisers — oscilloscope + spectrum, driven by the AnalyserNode
   * ------------------------------------------------------------------ */
  const scopeCv = $("scope"), specCv = $("spectrum");
  let scope = null, spec = null, rafId = null;

  function setupCanvas(cv) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = cv.getBoundingClientRect();
    const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
    cv.width = Math.floor(w * dpr);
    cv.height = Math.floor(h * dpr);
    const g = cv.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  }

  function resizeCanvases() {
    scope = setupCanvas(scopeCv);
    spec = setupCanvas(specCv);
    if (!audio) drawIdle();
  }

  function drawGrid(o) {
    const { g, w, h } = o;
    g.strokeStyle = GRID; g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i < 4; i++) { const y = (h / 4) * i; g.moveTo(0, y); g.lineTo(w, y); }
    for (let i = 1; i < 8; i++) { const x = (w / 8) * i; g.moveTo(x, 0); g.lineTo(x, h); }
    g.stroke();
  }

  function drawIdle() {
    if (scope) {
      const { g, w, h } = scope;
      g.clearRect(0, 0, w, h); drawGrid(scope);
      g.strokeStyle = ACCENT_DIM; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
    }
    if (spec) { const { g, w, h } = spec; g.clearRect(0, 0, w, h); drawGrid(spec); }
  }

  function drawScope() {
    const { g, w, h } = scope;
    const data = audio.timeData;
    const n = data.length;
    g.clearRect(0, 0, w, h);
    drawGrid(scope);
    g.lineWidth = 2;
    g.strokeStyle = ACCENT;
    g.shadowColor = ACCENT; g.shadowBlur = 6;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const v = (data[i] - 128) / 128;           // -1 .. 1
      const x = (i / (n - 1)) * w;
      const y = h / 2 - v * (h / 2) * 0.92;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
    g.shadowBlur = 0;
  }

  function drawSpectrum() {
    const { g, w, h } = spec;
    const bins = audio.freqData;
    const binHz = audio.ctx.sampleRate / audio.analyser.fftSize;
    const maxBin = Math.min(bins.length, Math.ceil(14000 / binHz)); // show up to ~14 kHz
    const BARS = 64;
    const bw = w / BARS;

    g.clearRect(0, 0, w, h);
    drawGrid(spec);

    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, hexToRgba(ACCENT, 1));
    grad.addColorStop(1, hexToRgba(ACCENT, 0.32));
    g.fillStyle = grad;

    for (let b = 0; b < BARS; b++) {
      const start = Math.floor((b / BARS) * maxBin);
      const end = Math.max(start + 1, Math.floor(((b + 1) / BARS) * maxBin));
      let m = 0;
      for (let i = start; i < end; i++) if (bins[i] > m) m = bins[i];
      const bh = (m / 255) * h;
      g.fillRect(b * bw, h - bh, Math.max(1, bw - 1), bh);
    }

    // dashed marker showing where the lowpass cutoff sits on the axis
    const cutoffX = clamp((state.cutoff / (maxBin * binHz)) * w, 0, w);
    g.strokeStyle = hexToRgba(ACCENT, 0.8);
    g.lineWidth = 1.5;
    g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(cutoffX, 0); g.lineTo(cutoffX, h); g.stroke();
    g.setLineDash([]);
  }

  function draw() {
    rafId = requestAnimationFrame(draw);
    if (!audio) return;
    audio.analyser.getByteTimeDomainData(audio.timeData);
    audio.analyser.getByteFrequencyData(audio.freqData);
    drawScope();
    drawSpectrum();
  }

  function startDraw() {
    if (rafId == null) draw();
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */
  function init() {
    buildKeyboard();
    wireControls();
    syncControls();
    resizeCanvases();
    drawIdle();

    let rt;
    window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(resizeCanvases, 150); });

    // any first interaction unlocks/creates the audio context
    ["pointerdown", "keydown"].forEach((ev) =>
      window.addEventListener(ev, ensureAudio, { once: true, capture: true }));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
