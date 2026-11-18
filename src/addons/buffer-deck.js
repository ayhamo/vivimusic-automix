/* Vivimusic Web+ — addons/buffer-deck.js  (content script, isolated world)
 *
 * The addon deck (spec/addons/protocol.md §8, PC): an addon's whole song,
 * decoded, played on the audio clock in step with YouTube's player, which
 * keeps playing it muted as the clock (play, pause, seek, next stay YouTube's).
 *
 *   source   AudioBufferSourceNodes on the decoded file (the context's rate, the
 *            file's own samples otherwise): no element in between, no rate trims.
 *   anchor   where the file is at a given audio frame: YouTube's own output (a
 *            tap worklet on its source, exact frame numbers) matched against the
 *            file, sample-exact; YouTube's time when the tap is silent (muted).
 *            After a blend the caller gives it: the mix's schedule says where the
 *            song is when the deck takes over.
 *   follow   it then runs free (one clock: no drift). YouTube paused or buffering:
 *            the deck stops too. YouTube elsewhere (a seek): anchored again.
 *   level    the caller's level() (YouTube's volume times the file's correction).
 *
 * window.__viviBufferDeck
 *   .create(ctx, destination) -> deck
 *     deck.load(buffer, off)      off: file seconds = song seconds + off
 *     deck.follow({ clock, level, gate, tap, onHandback, takeAt, takeSec, startPos })
 *          clock(): { pos, playing } song seconds (YouTube's), or null when the song is gone
 *          tap:     a tap (below) on YouTube's source, for the anchor
 *          startPos: the song's position at takeAt (the mix's schedule): no anchor needed
 *     deck.audible / release(at, sec) / handBack(why) / stats() / dispose(why)
 *     deck.out                    its output node (for tests)
 *   .tap(ctx, source, opts) -> Promise<tap>   a worklet keeping the last frames it heard
 *     tap.grab(frames) -> { chans, end }      end: the audio frame after the last one
 *     tap.record(on) / tap.take() -> { start, chans }   everything heard between (tests)
 */
(() => {
  'use strict';
  if (window.__viviBufferDeck) return;

  const log = (...a) => console.log('%c[ViVi addon deck]', 'color:#7c9cff', ...a);
  const SERVO_MS = 50;
  const FADE_SEC = 0.05;            // deck <-> YouTube
  const VOICE_SEC = 0.012;          // a voice's own fade (a re-anchor, a stop)
  const LOST_SEC = 0.25;            // YouTube this far from the deck (a median of 5): it moved (a seek)
  const SETTLE_SEC = 1.5;           // after a start, YouTube's time may still settle (the mix's quiet seeks)
  // steadily this far off YouTube's place (the median of DRIFT_N errors, each ±10 ms of noise in
  // the element's time): the deck's place is checked on YouTube's output, and only more than
  // TAP_EXACT_SEC off there is it moved. After a mix's take-over the schedule and the player
  // differed by 26 ms, and nothing below LOST_SEC ever put that right; the element's time alone
  // read ±11-19 ms on a deck the output matched exactly
  const DRIFT_SEC = 0.008, DRIFT_N = 40, REALIGN_GAP_SEC = 10, TAP_EXACT_SEC = 0.003;
  const START_LEAD = 0.12;          // a start is scheduled this far ahead (the anchor's work, the worklet's hop)
  const ANCHOR_SEC = 0.25, SEARCH_SEC = 0.35, DECIM = 8;
  // after YouTube (re)starts, this much of its new sound in the tap before a match is tried, and
  // that many tries 0.25 s apart before its time is used (it plays meanwhile: nothing goes unheard)
  const FRESH_SEC = ANCHOR_SEC + 0.15, TAP_TRIES = 4, RETRY_SEC = 0.25;
  // how far YouTube's output runs ahead of its element's currentTime (Firefox: ~150 ms), learnt
  // from each anchor on the tap: for the anchor by time (a muted YouTube) and for telling a seek
  let timeBias = null;

  // ───────── the tap ─────────
  const TAP_NAME = 'vivi-tap';
  // (the processor is src/addons/tap-worklet.js: a page's CSP refuses a blob: module)
  const tapModules = new WeakMap();
  async function tap(ctx, source, { frames = 65536 } = {}) {
    if (!tapModules.has(ctx)) tapModules.set(ctx, ctx.audioWorklet.addModule(chrome.runtime.getURL('src/addons/tap-worklet.js')));
    await tapModules.get(ctx);
    const node = new AudioWorkletNode(ctx, TAP_NAME, { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
    node.port.postMessage({ cmd: 'size', frames });
    source.connect(node);
    let seq = 0;
    const waits = new Map(), chunks = [];
    node.port.onmessage = (e) => {
      const m = e.data;
      if (m.chunk) { chunks.push(m); return; }
      const w = waits.get(m.id);
      if (w) { waits.delete(m.id); w(m); }
    };
    // (a closed tap answers at once, empty: a deck anchoring on it must not wait forever)
    let closed = false;
    const empty = () => ({ chans: [new Float32Array(0), new Float32Array(0)], end: 0, filled: 0, closed: true });
    const ask = (msg) => new Promise((resolve) => {
      if (closed) { resolve(empty()); return; }
      const id = ++seq; waits.set(id, resolve); node.port.postMessage({ ...msg, id });
    });
    return {
      node,
      grab: (n) => ask({ cmd: 'grab', frames: n }),
      record: (on) => { if (on) chunks.length = 0; return on ? (node.port.postMessage({ cmd: 'record', on: true }), Promise.resolve()) : ask({ cmd: 'record', on: false }); },
      take() {
        if (!chunks.length) return { start: 0, chans: [new Float32Array(0), new Float32Array(0)] };
        const start = chunks[0].start, len = chunks[chunks.length - 1].start + chunks[chunks.length - 1].chans[0].length - start;
        const chans = [new Float32Array(len), new Float32Array(len)];
        let gaps = 0, prev = start;
        for (const c of chunks) { if (c.start !== prev) gaps++; prev = c.start + c.chans[0].length; for (let k = 0; k < 2; k++) chans[k].set(c.chans[k], c.start - start); }
        const count = chunks.length;
        chunks.length = 0;
        return { start, chans, chunks: count, gaps };   // gaps: frames the worklet never handed over (0 expected)
      },
      close() {
        try { source.disconnect(node); } catch { /* gone */ }
        node.port.postMessage({ cmd: 'close' }); node.port.onmessage = null;
        closed = true;
        for (const w of waits.values()) w(empty());
        waits.clear();
      },
    };
  }

  // the file's best match for `tmpl` (YouTube's last ANCHOR_SEC) near `guess` (a file sample index):
  // coarse on an 8x average, then sample by sample; { index, score }
  // a buffer's mono mix (what the tap's audio is found in), through one scratch channel
  function monoOf(buffer) {
    const n = buffer.numberOfChannels, len = buffer.length, mono = new Float32Array(len), x = new Float32Array(len);
    for (let c = 0; c < n; c++) { buffer.copyFromChannel(x, c); for (let i = 0; i < len; i++) mono[i] += x[i] / n; }
    return mono;
  }
  function locate(file, tmpl, guess, range) {
    const L = tmpl.length;
    const dec = (x, from, n) => { const out = new Float32Array(Math.floor(n / DECIM)); for (let i = 0; i < out.length; i++) { let s = 0; for (let j = 0; j < DECIM; j++) s += x[from + i * DECIM + j] || 0; out[i] = s; } return out; };
    const ncc = (a, b, bFrom, n, step = 1) => {
      let ab = 0, aa = 0, bb = 0;
      for (let i = 0; i < n; i += step) { const x = a[i], y = b[bFrom + i] || 0; ab += x * y; aa += x * x; bb += y * y; }
      return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
    };
    const lo = Math.max(0, guess - range), hi = Math.min(file.length - L, guess + range);
    if (hi <= lo) return null;
    const t8 = dec(tmpl, 0, L), f8 = dec(file, lo, hi - lo + L);
    let best = -2, at = lo;
    for (let k = 0; k * DECIM <= hi - lo; k++) { const s = ncc(t8, f8, k, t8.length); if (s > best) { best = s; at = lo + k * DECIM; } }
    let fine = -2, fAt = at;
    for (let i = Math.max(lo, at - 2 * DECIM); i <= Math.min(hi, at + 2 * DECIM); i++) { const s = ncc(tmpl, file, i, L); if (s > fine) { fine = s; fAt = i; } }
    return { index: fAt, score: fine };
  }

  class BufferDeck {
    constructor(ctx, destination) {
      this.ctx = ctx;
      this.out = new GainNode(ctx, { gain: 0 });
      this.out.connect(destination);
      this.state = 'empty';             // empty | ready | following | released | handed-back
      this.voices = [];
      this.anchor = null;               // { t: audio time, at: file seconds there }
      this.started = false;
      this.recent = [];
      this.errors = [];
      this.anchors = [];
      this.maxAbsError = 0;
    }

    // `mono`: the file's mono mix when the caller keeps one (made once per file, shared by its decks)
    load(buffer, off, mono = monoOf(buffer)) {
      this.buf = buffer; this.off = off;
      this.mono = mono;
      this.state = 'ready';
    }

    // file seconds the deck plays at audio time t (while running)
    fileAt(t) { return this.anchor ? this.anchor.at + (t - this.anchor.t) : null; }

    follow({ clock, level, gate, tap: tp = null, onHandback, takeAt = 0, takeSec = FADE_SEC, startPos = null }) {
      Object.assign(this, { clock, level, gate, tp, onHandback, takeAt, takeSec });
      this.state = 'following';
      this.tapMisses = 0; this.retryAt = 0;   // (unset, ++ gave NaN and the first anchor got no retries)
      this.audibleAt = Infinity;
      const c = clock();
      if (!c) { this.handBack('the song is gone'); return; }
      if (startPos != null) {
        // the mix's schedule: the song is at startPos at takeAt
        this.startVoice(takeAt, startPos + this.off, 0);
        this.takeOver(takeAt, takeSec);
        this.settleUntil = takeAt + SETTLE_SEC;
        this.scheduled = true;
      }
      this.timer = setInterval(() => this.tick(), SERVO_MS);
    }

    takeOver(at, sec) {
      this.started = true;
      this.audibleAt = at + sec;
      this.fade(this.level(), 0, at, sec);
      log(`taking over the sound${at > this.ctx.currentTime ? ` in ${Math.round((at - this.ctx.currentTime) * 1000)} ms` : ''}`);
    }

    // a voice from audio time t at file second `at` (a negative `at`: silence until the file starts)
    startVoice(t, at, fadeSec = VOICE_SEC) {
      // on a whole frame, at a whole sample of the file: the output is then the file's own samples
      // (a fractional start is interpolated); half a sample off YouTube is 10 µs at 48 kHz
      const sr = this.ctx.sampleRate;
      t = Math.round(t * sr) / sr; at = Math.round(at * sr) / sr;
      const src = new AudioBufferSourceNode(this.ctx, { buffer: this.buf });
      const g = new GainNode(this.ctx, { gain: fadeSec ? 0 : 1 });
      src.connect(g).connect(this.out);
      if (at >= 0) src.start(t, at); else src.start(t - at, 0);
      if (fadeSec) { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + fadeSec); }
      this.voices.push({ src, g });
      this.anchor = { t, at };
      this.anchors.push({ t, at });
      this.recent = [];
      this.driftMark = this.nErr || 0;   // (the drift check only reads errors of this start)
    }

    stopVoices(at = this.ctx.currentTime) {
      for (const { src, g } of this.voices) {
        g.gain.cancelScheduledValues(at); g.gain.setValueAtTime(g.gain.value, at); g.gain.linearRampToValueAtTime(0, at + VOICE_SEC);
        try { src.stop(at + VOICE_SEC + 0.005); } catch { /* not started */ }
        src.onended = () => { try { g.disconnect(); } catch { /* gone */ } };
      }
      this.voices = [];
      this.anchor = null;
    }

    // where the file is now: YouTube's output matched against it, else YouTube's time
    async findAnchor(c) {
      const sr = this.ctx.sampleRate, L = Math.round(ANCHOR_SEC * sr), tRead = this.ctx.currentTime;
      const est = (t) => c.pos + this.off + (timeBias ?? 0) + (t - tRead);   // the file second at audio time t, by YouTube's time
      if (this.tp) {
        let g = await this.tp.grab(L + Math.round(0.05 * sr));
        // a tap only just made holds too little yet
        for (let i = 0; i < 10 && !g.closed && g.filled < L + 128; i++) { await new Promise((r) => setTimeout(r, 100)); g = await this.tp.grab(L + Math.round(0.05 * sr)); }
        if (g.closed || g.chans[0].length < L) return { t: tRead, at: est(tRead), score: null, by: 'time' };   // the tap closed meanwhile
        const guess = Math.round(est(g.end / sr) * sr) - L;
        const tmpl = new Float32Array(L), A = g.chans[0], B = g.chans[1], from = A.length - L;
        let e = 0;
        for (let i = 0; i < L; i++) { tmpl[i] = (A[from + i] + B[from + i]) / 2; e += tmpl[i] * tmpl[i]; }
        if (Math.sqrt(e / L) > 1e-5) {
          const hit = locate(this.mono, tmpl, guess, Math.round(SEARCH_SEC * sr));
          if (hit && hit.score > 0.8) {
            const at = (hit.index + L) / sr;
            timeBias = (timeBias ?? 0) + at - est(g.end / sr);
            return { t: g.end / sr, at, score: hit.score, by: 'tap', biasMs: Math.round(timeBias * 1000) };
          }
          log(`no match on YouTube's output (score ${hit ? hit.score.toFixed(3) : '-'})`);
          return { t: tRead, at: est(tRead), score: null, by: 'time', missed: true };
        }
      }
      return { t: tRead, at: est(tRead), score: null, by: 'time' };
    }

    // the deck's place against YouTube's output (the tap): moved only when it is off there too
    async checkPlace(c, timeErr) {
      if (this.anchoring) return;
      this.anchoring = true;
      let a;
      try { a = await this.findAnchor(c); } finally { this.anchoring = false; }
      if (this.state !== 'following' || !this.anchor || a.by !== 'tap') return;
      const off = a.at - this.fileAt(a.t);
      this.checks = (this.checks || 0) + 1;
      this.lastCheckMs = Math.round(off * 10000) / 10;
      if (Math.abs(off) <= TAP_EXACT_SEC) return;
      log(`${Math.round(off * 1000)} ms off YouTube's output (its time read ${Math.round(timeErr * 1000)} ms): in step again`);
      this.realigns = (this.realigns || 0) + 1;
      const t = Math.max(this.ctx.currentTime + START_LEAD, a.t + START_LEAD);
      this.stopVoices(t);
      this.startVoice(t, a.at + (t - a.t), VOICE_SEC);
      this.settleUntil = t + 0.5;
    }

    async anchorAndStart(c, first) {
      if (this.anchoring) return;
      this.anchoring = true;
      try {
        const a = await this.findAnchor(c);
        if (this.state !== 'following') return;
        // no match yet: YouTube keeps playing, another try shortly (its time is only a last resort:
        // after a seek it can be ~0.1 s off what is heard)
        if (a.missed && ++this.tapMisses < TAP_TRIES) { this.retryAt = this.ctx.currentTime + RETRY_SEC; return; }
        this.tapMisses = 0;
        const t = Math.max(this.ctx.currentTime + START_LEAD, a.t + START_LEAD);
        this.stopVoices(t);
        this.startVoice(t, a.at + (t - a.t), first ? 0 : VOICE_SEC);
        this.lastAnchor = { ...a, startAt: t };
        if (first) this.takeOver(t, FADE_SEC);
        this.settleUntil = t + 0.5;
        log(`${first ? 'in step' : 'again in step'} at file ${(a.at + (t - a.t)).toFixed(3)} s (by ${a.by}${a.score != null ? ', match ' + a.score.toFixed(3) : ''})`);
      } finally { this.anchoring = false; }
    }

    tick() {
      if (this.state !== 'following' || this.anchoring) return;
      const c = this.clock(), now = this.ctx.currentTime;
      if (!c) { this.handBack('the song is gone'); return; }
      const at = this.fileAt(now);
      if (at != null && at > this.buf.duration - 0.05) { this.handBack('the deck\'s audio ended'); return; }
      // a start on the mix's schedule: until it has settled the schedule is the place, whatever
      // the player does meanwhile (the mix seeks and holds it, silent, to its own timeline)
      if (this.scheduled && now < this.settleUntil) return;
      // YouTube paused, seeking or buffering (its time stands still): the deck stops too, and the
      // sound is YouTube's until the deck finds its place again on what YouTube then plays
      if (!c.playing) { this.playingSince = null; if (this.anchor) { this.lose(now); this.paused = true; } return; }
      this.playingSince ??= now;
      if (!this.anchor) {
        if (now < this.retryAt || now - this.playingSince < FRESH_SEC) return;
        this.anchorAndStart(c, !this.started);
        return;
      }
      if (now < this.settleUntil) return;
      const error = c.pos + this.off + (timeBias ?? 0) - at;
      this.recent.push(error);
      if (this.recent.length > 5) this.recent.shift();
      if (this.recent.length < 5) return;
      const m = [...this.recent].sort((x, y) => x - y)[2];
      this.errors.push(m);
      this.nErr = (this.nErr || 0) + 1;
      if (this.errors.length > 200) this.errors.shift();
      this.maxAbsError = Math.max(this.maxAbsError, Math.abs(m));
      if (Math.abs(m) > LOST_SEC) { log(`YouTube moved ${Math.round(m * 1000)} ms: anchoring again`); this.lose(now); this.playingSince = now; return; }
      if (this.nErr - (this.driftMark || 0) >= DRIFT_N && now - (this.realignedAt ?? -Infinity) > REALIGN_GAP_SEC) {
        const w = this.errors.slice(-DRIFT_N).sort((x, y) => x - y)[DRIFT_N >> 1];
        if (Math.abs(w) > DRIFT_SEC) {
          this.realignedAt = now;
          this.checkPlace(c, w);
          return;
        }
      }
      if (this.started && now > this.audibleAt) this.out.gain.setTargetAtTime(this.level(), now, 0.03);
    }

    // the deck lost its place: YouTube's sound again (a voice's fade), the deck takes over anew
    lose(now) {
      this.stopVoices(now);
      if (this.started) { this.fade(0, 1, now, VOICE_SEC); this.started = false; this.audibleAt = Infinity; }
      this.tapMisses = 0; this.retryAt = 0;
    }

    get audible() { return this.state === 'following' && !!this.started && !!this.anchor; }

    fade(deckTo, ytTo, at, sec = FADE_SEC) {
      for (const [p, to] of [[this.out.gain, deckTo], [this.gate, ytTo]]) {
        if (!p || to === null) continue;
        p.cancelScheduledValues(at); p.setValueAtTime(p.value, at); p.linearRampToValueAtTime(to, at + sec);
      }
    }

    stop(state) { this.state = state; clearInterval(this.timer); this.timer = null; }

    // the caller's mix takes over from `at`: the deck fades out, YouTube's gate stays as it is
    release(at, sec = FADE_SEC) {
      if (this.state !== 'following') return;
      this.stop('released');
      const t = Math.max(at, this.ctx.currentTime);
      this.fade(0, null, t, sec);
      for (const { src } of this.voices) { try { src.stop(t + sec + 0.01); } catch { /* not started */ } }
      log('released at the next mix');
    }

    handBack(why) {
      if (this.state !== 'following') { if (this.state !== 'empty') this.state = 'handed-back'; return; }
      const was = this.started;
      this.stop('handed-back');
      this.fade(0, was ? 1 : null, this.ctx.currentTime);
      this.stopVoices(this.ctx.currentTime + FADE_SEC);
      log(`handed back to YouTube: ${why}`);
      this.onHandback?.(why);
    }

    stats() {
      const e = this.errors.slice(-100), abs = e.map(Math.abs).sort((a, b) => a - b);
      return {
        state: this.state, started: !!this.started, anchors: this.anchors.length, lastAnchor: this.lastAnchor || null, anchor: this.anchor,
        errorMs: e.length ? Math.round(e[e.length - 1] * 1000) : null,
        medianAbsMs: abs.length ? Math.round(abs[abs.length >> 1] * 1000) : null,
        maxAbsMs: Math.round(this.maxAbsError * 1000), gain: this.out.gain.value, realigns: this.realigns || 0, checks: this.checks || 0, lastCheckMs: this.lastCheckMs ?? null,
      };
    }

    dispose(why = 'closed') {
      this.handBack(why);
      this.stop(this.state === 'empty' ? 'empty' : this.state);
      const out = this.out;
      setTimeout(() => { this.stopVoices(); try { out.disconnect(); } catch { /* gone */ } this.buf = null; this.mono = null; }, 1500);
    }
  }

  window.__viviBufferDeck = { create: (ctx, destination) => new BufferDeck(ctx, destination), tap, locate, monoOf };
})();
