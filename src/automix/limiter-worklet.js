/* Vivimusic Web+ — automix/limiter-worklet.js (AudioWorklet processor)
 *
 * versions.md "The mix's ceiling": the last node of the page's audio, after
 * upstream's safety compressor (equalizer.js). While a mix runs (engaged), a
 * look-ahead peak limiter: ceiling -1 dBFS, 5 ms look-ahead, ~100 ms release.
 * Otherwise every sample passes as it is (only the fixed 5 ms delay), so a
 * single song is never touched.
 *
 * Per sample: the gain the newest frame needs (ceiling / its peak, at most 1);
 * the lowest of those over the look-ahead window; that averaged over the
 * window (no step); a slow rise back (release). The frame leaving the delay
 * line is the one the window was built for, so it never passes the ceiling.
 */
class ViviLimiter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ceil = Math.pow(10, -1 / 20);
    this.L = Math.max(1, Math.round(0.005 * sampleRate));
    this.rel = 1 - Math.exp(-1 / (0.1 * sampleRate));
    this.engaged = false;
    this.delay = [new Float32Array(this.L + 1), new Float32Array(this.L + 1)];
    this.at = 0;                                   // write index of the delay lines
    // sliding minimum of the needed gain over the last L+1 frames (a monotonic queue)
    this.qv = new Float64Array(this.L + 2); this.qi = new Float64Array(this.L + 2);
    this.qh = 0; this.qn = 0; this.n = 0;
    // sliding mean of that minimum over the last L frames
    this.hold = new Float64Array(this.L).fill(1); this.hAt = 0; this.sum = this.L;
    this.g = 1;
    this.most = 1;                                 // the lowest gain since engaged (reported on release)
    this.port.onmessage = (e) => {
      if (typeof e.data?.engaged === 'boolean') {
        if (!e.data.engaged && this.engaged) this.port.postMessage({ minGainDb: 20 * Math.log10(Math.max(1e-6, this.most)) });
        if (e.data.engaged && !this.engaged) this.most = 1;
        this.engaged = e.data.engaged;
      }
    };
  }

  process(inputs, outputs) {
    const inp = inputs[0] || [], out = outputs[0];
    if (!out || !out[0]) return true;
    const frames = out[0].length;
    const L = this.L, size = L + 1, cap = this.qv.length;
    for (let i = 0; i < frames; i++) {
      // the newest frame into the delay line, and its peak
      let peak = 0;
      for (let c = 0; c < 2; c++) {
        const ch = inp[c] ?? inp[0];
        // (a sample that is not a number, or infinite, is played as silence: it would make the gain NaN)
        const x = ch && Number.isFinite(ch[i]) ? ch[i] : 0;
        this.delay[c][this.at] = x;
        const a = x < 0 ? -x : x;
        if (a > peak) peak = a;
      }
      const need = this.engaged && peak > this.ceil ? this.ceil / peak : 1;
      // sliding minimum over the last L+1 frames
      while (this.qn > 0 && this.qv[(this.qh + this.qn - 1) % cap] >= need) this.qn--;
      this.qv[(this.qh + this.qn) % cap] = need; this.qi[(this.qh + this.qn) % cap] = this.n; this.qn++;
      while (this.qi[this.qh] <= this.n - size) { this.qh = (this.qh + 1) % cap; this.qn--; }
      const h = this.qv[this.qh];
      // its mean over the last L frames
      this.sum += h - this.hold[this.hAt]; this.hold[this.hAt] = h; this.hAt = (this.hAt + 1) % L;
      const s = Math.max(0, Math.min(1, this.sum / L));
      // down at once to the smoothed need, back up slowly
      this.g = s < this.g ? s : this.g + (s - this.g) * this.rel;
      if (this.g > 0.99999 && s >= 1) this.g = 1;
      if (this.g < this.most) this.most = this.g;
      // the frame L behind leaves the delay line
      const from = (this.at + 1) % size;
      for (let c = 0; c < out.length; c++) out[c][i] = this.delay[c < 2 ? c : 1][from] * this.g;
      this.at = from;
      // (the running sum is summed afresh now and then, so rounding never builds up)
      if (++this.n % 65536 === 0) this.sum = this.hold.reduce((a, b) => a + b, 0);
    }
    return true;
  }
}
registerProcessor('vivi-limiter', ViviLimiter);
