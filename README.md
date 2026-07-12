# How a synth makes sound

Start with a raw electrical buzz, then carve it, shape it, and drop it into a room —
live, in your browser, one key at a time.

**[▶ Live demo](https://moshejs.github.io/subtractive-synth/)**

A playable **subtractive synthesizer** built on the Web Audio API. The signal chain —
oscillator → lowpass filter → amplitude envelope → reverb — is drawn live on an
oscilloscope and spectrum analyzer, so you can *see* the sound as you make it. Play it
with your computer keyboard, twist the knobs, and sculpt a buzzy sawtooth into a warm
pad by ear.

## Run it

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## How it's built

Vanilla HTML/CSS/JS, **zero dependencies**. A Web Audio graph with per-voice polyphony,
a convolver reverb whose impulse response is synthesized in JS (no audio files), and
canvas visualizers driven by an `AnalyserNode`.

Part of [The Lab](https://github.com/moshejs) — handmade interactive explainers.

## License

MIT
