// Insula soundscape, all generated live with Web Audio (no audio files):
// ocean swell, birds by day, crickets at night, a soft generative melody,
// and effects for coins, pickaxe hits, splashes and speech.

export class Sound {
  constructor() {
    this.on = false;
    this.ctx = null;
    this.night = 0;
    this.lastClink = 0;
  }

  async toggle() {
    if (!this.ctx) this.#init();
    this.on = !this.on;
    if (this.on) await this.ctx.resume();
    this.master.gain.setTargetAtTime(this.on ? 0.7 : 0, this.ctx.currentTime, 0.4);
    return this.on;
  }

  setNight(n) {
    this.night = n;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.crickets.gain.setTargetAtTime(Math.max(0, n - 0.3) * 0.05, t, 1.5);
  }

  #init() {
    const ctx = (this.ctx = new (window.AudioContext || window.webkitAudioContext)());
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    // Shared echo for music and chirps
    this.echo = ctx.createDelay(1);
    this.echo.delayTime.value = 0.33;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const echoTone = ctx.createBiquadFilter();
    echoTone.type = 'lowpass';
    echoTone.frequency.value = 2200;
    this.echo.connect(echoTone).connect(fb).connect(this.echo);
    echoTone.connect(this.master);

    // Noise source used by waves, hits and splashes
    const len = ctx.sampleRate * 3;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02; // brown noise
      d[i] = last * 3.5;
    }

    // Ocean: brown noise through a lowpass, swelling slowly
    const sea = ctx.createBufferSource();
    sea.buffer = this.noise;
    sea.loop = true;
    const seaLp = ctx.createBiquadFilter();
    seaLp.type = 'lowpass';
    seaLp.frequency.value = 520;
    const seaGain = ctx.createGain();
    seaGain.gain.value = 0.16;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.09;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 0.08;
    lfo.connect(lfoAmt).connect(seaGain.gain);
    sea.connect(seaLp).connect(seaGain).connect(this.master);
    sea.start();
    lfo.start();

    // Crickets: a high tone gated into short trills
    const cr = ctx.createOscillator();
    cr.type = 'square';
    cr.frequency.value = 4300;
    const crBp = ctx.createBiquadFilter();
    crBp.type = 'bandpass';
    crBp.frequency.value = 4300;
    crBp.Q.value = 12;
    const gate = ctx.createGain();
    gate.gain.value = 0;
    const gateLfo = ctx.createOscillator();
    gateLfo.type = 'square';
    gateLfo.frequency.value = 14;
    const gateAmt = ctx.createGain();
    gateAmt.gain.value = 0.5;
    gateLfo.connect(gateAmt).connect(gate.gain);
    this.crickets = ctx.createGain();
    this.crickets.gain.value = 0;
    cr.connect(crBp).connect(gate).connect(this.crickets).connect(this.master);
    cr.start();
    gateLfo.start();

    this.#loopMusic();
    this.#loopBirds();
  }

  #loopMusic() {
    const day = [0, 2, 4, 7, 9, 12, 14, 16]; // major pentatonic
    const night = [0, 3, 5, 7, 10, 12, 15, 17]; // minor pentatonic
    const play = () => {
      if (this.on) {
        const scale = this.night > 0.5 ? night : day;
        const root = this.night > 0.5 ? 57 : 60;
        const notes = 1 + (Math.random() < 0.35 ? 1 : 0);
        for (let i = 0; i < notes; i++) {
          const n = root + scale[Math.floor(Math.random() * scale.length)];
          this.#pluck(440 * Math.pow(2, (n - 69) / 12), 0.055, i * 0.18);
        }
      }
      setTimeout(play, 900 + Math.random() * 1300);
    };
    setTimeout(play, 600);
  }

  #loopBirds() {
    const sing = () => {
      if (this.on && this.night < 0.4) {
        const base = 2400 + Math.random() * 1600;
        const n = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < n; i++) this.#chirp(base * (1 + Math.random() * 0.15), i * 0.11);
      }
      setTimeout(sing, 1800 + Math.random() * 4500);
    };
    setTimeout(sing, 2000);
  }

  #pluck(freq, vol, delay = 0) {
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    o.connect(g);
    g.connect(this.master);
    g.connect(this.echo);
    o.start(t);
    o.stop(t + 1.7);
  }

  #chirp(freq, delay) {
    const ctx = this.ctx, t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * 1.45, t + 0.07);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.025, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    o.connect(g).connect(pan).connect(this.master);
    o.start(t);
    o.stop(t + 0.1);
  }

  #noiseHit(type, freq, vol, dur, q = 1) {
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(freq * 0.4, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 2);
    src.stop(t + dur + 0.05);
  }

  // ---- Effects (no-ops while sound is off) ----
  clink(vol = 1) {
    if (!this.on) return;
    const now = this.ctx.currentTime;
    if (now - this.lastClink < 0.05) return;
    this.lastClink = now;
    const base = 1800 + Math.random() * 500;
    for (const [mult, v] of [[1, 0.05], [2.76, 0.025], [5.4, 0.012]]) {
      const o = this.ctx.createOscillator();
      o.frequency.value = base * mult;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(v * vol, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
      o.connect(g).connect(this.master);
      o.start(now);
      o.stop(now + 0.4);
    }
  }

  thunk(vol = 1) {
    if (!this.on || vol < 0.02) return;
    this.#noiseHit('lowpass', 900, 0.5 * vol, 0.16);
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.12);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.18 * vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.16);
  }

  splash(vol = 1) {
    if (!this.on || vol < 0.02) return;
    this.#noiseHit('bandpass', 2200, 0.6 * vol, 0.45, 0.8);
  }

  blip() {
    if (!this.on) return;
    this.#pluck(880 + Math.random() * 220, 0.03);
  }

  cheer() {
    if (!this.on) return;
    [0, 4, 7].forEach((s, i) => this.#pluck(523.25 * Math.pow(2, s / 12), 0.035, i * 0.07));
  }

  grumble() {
    if (!this.on) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(140, t);
    o.frequency.linearRampToValueAtTime(95, t + 0.35);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 600;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
    o.connect(f).connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.42);
  }
}
