/* Vivimusic Web+ — addons/tap-worklet.js (AudioWorklet module, loaded by buffer-deck.js)
 *
 * Keeps the last frames it hears with their exact audio frame numbers ('grab'),
 * and records everything it hears ('record', tests): the addon deck's anchor
 * on YouTube's output, and the test Firefox's recordings.
 */
registerProcessor('vivi-tap', class extends AudioWorkletProcessor {
  constructor() {
    super();
    this.n = 65536;
    this.ring = [new Float32Array(this.n), new Float32Array(this.n)];
    this.w = 0; this.end = 0; this.count = 0; this.rec = null;
    this.port.onmessage = (e) => {
      const m = e.data;
      // (the ring's size comes as a message: a content script's processorOptions can't be cloned in Firefox)
      if (m.cmd === 'size') { this.n = m.frames; this.ring = [new Float32Array(this.n), new Float32Array(this.n)]; this.w = 0; }
      else if (m.cmd === 'grab') {
        const k = Math.min(m.frames, this.n);
        const out = this.ring.map((r) => { const a = new Float32Array(k); for (let i = 0; i < k; i++) a[i] = r[(this.w - k + i + 2 * this.n) % this.n]; return a; });
        this.port.postMessage({ id: m.id, chans: out, end: this.end, filled: Math.min(this.count, this.n) }, out.map((a) => a.buffer));
      } else if (m.cmd === 'record') {
        if (m.on) this.rec = { start: -1, size: m.chunk || 16384, at: 0, cur: null };
        else { this.flush(); this.rec = null; this.port.postMessage({ id: m.id, stopped: true, end: this.end }); }
      }
    };
  }
  flush() {
    const r = this.rec;
    if (!r || !r.cur || !r.at) return;
    const chans = r.cur.map((a) => a.slice(0, r.at));
    this.port.postMessage({ chunk: true, start: r.curStart, chans }, chans.map((a) => a.buffer));
    r.cur = null; r.at = 0;
  }
  process(inputs) {
    const inp = inputs[0] || [], n = (inp[0] && inp[0].length) || 128;
    for (let c = 0; c < 2; c++) {
      const x = inp[c] || inp[0], r = this.ring[c];
      for (let i = 0; i < n; i++) r[(this.w + i) % this.n] = x ? x[i] : 0;
    }
    const r = this.rec;
    if (r) {
      if (!r.cur) { r.cur = [new Float32Array(r.size), new Float32Array(r.size)]; r.curStart = currentFrame; r.at = 0; }
      for (let c = 0; c < 2; c++) { const x = inp[c] || inp[0]; if (x) r.cur[c].set(x, r.at); }
      r.at += n;
      if (r.at + 128 > r.size) this.flush();
    }
    this.w = (this.w + n) % this.n;
    this.end = currentFrame + n;
    this.count += n;
    return true;
  }
});
