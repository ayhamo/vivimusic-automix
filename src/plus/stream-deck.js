/* Vivimusic Web+ — stream-deck.js  (content script, isolated world)
 *
 * The full-stream deck: plays a whole song from our own copy of its audio
 * while YouTube's player keeps playing it, muted, as the clock. YouTube stays
 * in charge of everything the listener sees and does (play, pause, seek,
 * next, history); the deck only follows its position.
 *
 *   source   a hidden <audio> on a blob: URL of the song's bytes (YouTube's
 *            own audio today, an addon's later). Same-origin, so Web Audio
 *            hears it; decoded as it plays, so it costs only the file's size.
 *   clock    every SERVO_MS the deck compares its position with the song's
 *            (YouTube's element time minus the song's offset, plus the
 *            source's own offset) and follows: play/pause with it, small
 *            errors trimmed with the rate, big ones with one seek.
 *   level    YouTube's element volume (the listener's volume times YouTube's
 *            own down-only loudness factor) times the source's correction
 *            (1 for YouTube's own audio).
 *   handback on a failure the deck fades out and YouTube's sound comes back
 *            (the caller's gate); YouTube is already at the same spot, so
 *            nothing is sought and nothing is missed.
 *
 * window.__viviStreamDeck.create(ctx, destination) -> deck
 *   deck.load(bytes, mime)               the song's audio; resolves when playable
 *   deck.follow({ clock, level, gate, onHandback, takeAt, takeSec })
 *        clock(): { pos, playing } in source seconds, or null when the song is gone;
 *                 playing is false while YouTube buffers or seeks (its time stands still)
 *        level(): the gain the deck should play at
 *        gate:    YouTube's AudioParam, faded down while the deck plays
 *        takeAt:  audio-clock time the deck takes over (when in step by then; later if not),
 *                 over takeSec (default FADE_SEC); the caller fades its own source out there
 *   deck.audible                          the deck plays the song now (YouTube's gate is down)
 *   deck.release(at, sec)                 fade out from `at`, YouTube's gate left down (the caller's mix goes on)
 *   deck.handBack(why)                    fade back to YouTube and stop following
 *   deck.stats()                          drift, seeks, state, for tests
 *   deck.dispose()
 */
(() => {
  'use strict';
  if (window.__viviStreamDeck) return;

  const SERVO_MS = 50;
  const SEEK_ERROR_SEC = 0.12;      // off by more than this: one seek
  // Measured in Firefox: the deck and YouTube's element run at the same speed (no drift over
  // 30 s); the deck only starts about 70 ms late. So it lines up while still silent, where a
  // fast rate costs nothing, and once audible it corrects only when it slips past a deadband,
  // at a rate too small to hear, until it is back in step.
  const ALIGN_SEEKS = 4;            // silent alignment: seeks that learn the start lag...
  const ALIGN_RATE = 0.05;          // ...then (still off) up to 5% (a rate change leaves Firefox's reported time unsettled for a while)
  const LOCK_SEC = 0.012;           // in step: the median of three readings within this
  const median3 = (a) => [...a.slice(-3)].sort((x, y) => x - y)[Math.min(1, a.length - 1)];   // (currentTime moves in audio-callback steps)
  const DEADBAND_SEC = 0.03;        // audible: left alone up to this...
  const TRIM_RATE = 0.003;          // ...then 0.3% (about 5 cents) until back within LOCK_SEC
  const FADE_SEC = 0.05;            // deck <-> YouTube
  const START_TIMEOUT_MS = 8000;    // not playing this long after asked: hand back
  const MAX_SEEKS_PER_10S = 4;      // seeking more than this: it can't follow, hand back
  const log = (...a) => console.log('%c[ViVi stream deck]', 'color:#7c9cff', ...a);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  let startLag = 0;                 // how late a seek of the deck lands (learnt, kept for the next song's deck)

  class StreamDeck {
    constructor(ctx, destination) {
      this.ctx = ctx;
      this.el = new Audio();
      this.el.preload = 'auto';
      this.el.preservesPitch = false;   // the trims are tiny; pitch-kept rate changes restart the stretcher
      this.src = ctx.createMediaElementSource(this.el);
      this.gain = new GainNode(ctx, { gain: 0 });
      this.src.connect(this.gain).connect(destination);
      this.url = '';
      this.state = 'empty';             // empty | loading | ready | following | handed-back | failed
      this.seekTimes = [];
      this.errors = [];
      this.maxAbsError = 0;
      this.onError = () => this.handBack('the deck could not play the audio' + (this.el.error ? ` (code ${this.el.error.code})` : ''));
      this.el.addEventListener('error', this.onError);
    }

    load(bytes, mime = 'audio/webm') {
      this.cancelLoad?.('another load');
      this.state = 'loading';
      if (this.url) URL.revokeObjectURL(this.url);
      this.url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      this.el.src = this.url;
      return new Promise((resolve, reject) => {
        const ok = () => { done(); this.state = 'ready'; resolve(this.el.duration); };
        const bad = () => { done(); this.state = 'failed'; reject(new Error('the audio would not load')); };
        const done = () => { this.el.removeEventListener('canplay', ok); this.el.removeEventListener('error', bad); this.cancelLoad = null; };
        // (closed or loaded again before it was ready: the wait ends there, it never hangs)
        this.cancelLoad = (why) => { done(); reject(new Error('the deck was ' + (why === 'another load' ? 'loaded again' : 'closed') + ' while loading')); };
        this.el.addEventListener('canplay', ok);
        this.el.addEventListener('error', bad);
      });
    }

    follow({ clock, level, gate, onHandback, trim = true, takeAt = 0, takeSec = FADE_SEC }) {
      Object.assign(this, { clock, level, gate, onHandback, trim, takeAt, takeSec });
      this.audibleAt = Infinity;
      this.state = 'following';
      this.askedAt = performance.now();
      this.started = false;
      const c = clock();
      if (!c) { this.handBack('the song is gone'); return; }
      this.el.currentTime = c.pos + startLag;
      this.trimming = false; this.alignSeeks = 0; this.recent = [];
      if (c.playing) this.el.play().catch((e) => this.handBack('play() refused: ' + (e?.message || e)));
      this.timer = setInterval(() => this.tick(), SERVO_MS);
    }

    tick() {
      if (this.state !== 'following') return;
      const c = this.clock(), el = this.el, now = this.ctx.currentTime;
      if (!c) { this.handBack('the song is gone'); return; }
      if (el.ended || (Number.isFinite(el.duration) && c.pos > el.duration - 0.05)) { this.handBack('the deck\'s audio ended'); return; }
      // YouTube paused or playing: the deck does the same
      if (!c.playing) { if (!el.paused) el.pause(); return; }
      if (el.paused) { el.play().catch((e) => this.handBack('play() refused: ' + (e?.message || e))); return; }
      if (el.seeking || el.readyState < 3) {
        if (!this.started && performance.now() - this.askedAt > START_TIMEOUT_MS) this.handBack('the deck never started');
        return;
      }
      const error = el.currentTime - c.pos, abs = Math.abs(error);
      if (abs > SEEK_ERROR_SEC) {
        // off again right after a seek: that seek landed this late (a cold element), so the next aims that much ahead
        if (performance.now() - (this.seekTimes[this.seekTimes.length - 1] ?? -Infinity) < 1500) startLag = clamp(startLag - error, 0, 0.3);
        this.seekTo(c.pos, `${Math.round(error * 1000)} ms at ${c.pos.toFixed(2)} s`);
        return;
      }
      let rate = 1;
      this.recent.push(error);
      if (this.recent.length > 3) this.recent.shift();
      if (this.recent.length < 3) return;
      const m = median3(this.recent), absM = Math.abs(m);
      if (!this.started) {
        // silent: line up, then the deck takes over the sound
        if (absM < LOCK_SEC || !this.trim) {
          // in step: takes over now, or at takeAt (committed just before it, scheduled on the clock)
          if (this.takeAt - now < 0.2) {
            const at = Math.max(now, this.takeAt), sec = this.takeAt >= now ? this.takeSec : FADE_SEC;
            this.started = true;
            this.audibleAt = at + sec;
            this.fade(this.level(), 0, at, sec);
            log(`playing in step (${(m * 1000).toFixed(0)} ms), taking over the sound${at > now ? ` in ${((at - now) * 1000).toFixed(0)} ms` : ''}`);
          }
        } else {
          if (performance.now() - this.askedAt > START_TIMEOUT_MS) { this.handBack('the deck never got in step'); return; }
          if (this.alignSeeks < ALIGN_SEEKS) {
            // a seek lands late by the time the element takes to start again: learnt from each try
            startLag = clamp(startLag - m, 0, 0.3);
            this.alignSeeks++;
            this.recent = [];
            el.currentTime = c.pos + startLag;
            return;
          }
          rate = 1 - clamp(m * 2, -ALIGN_RATE, ALIGN_RATE);
        }
      } else {
        if (now > this.audibleAt) this.gain.gain.setTargetAtTime(this.level(), now, 0.03);   // follows the listener's volume
        this.errors.push(error);
        if (this.errors.length > 200) this.errors.shift();
        this.maxAbsError = Math.max(this.maxAbsError, abs);
        // audible: leave small errors alone; past the deadband, a slow trim until back in step
        if (this.trim) {
          if (absM > DEADBAND_SEC) this.trimming = true;
          else if (absM < LOCK_SEC) this.trimming = false;
          if (this.trimming) rate = 1 - Math.sign(m) * TRIM_RATE;
        }
      }
      if (el.playbackRate !== rate) el.playbackRate = rate;
    }

    seekTo(pos, why = '') {
      const t = performance.now();
      this.seekTimes = this.seekTimes.filter((x) => t - x < 10000);
      this.seekTimes.push(t);
      this.seekWhys = [...(this.seekWhys || []), why].slice(-MAX_SEEKS_PER_10S - 1);
      if (this.seekTimes.length > MAX_SEEKS_PER_10S) { this.handBack(`the deck kept losing its place (off by ${this.seekWhys.join(', ')})`); return; }
      this.el.playbackRate = 1;
      this.trimming = false; this.alignSeeks = 0; this.recent = [];
      // YouTube plays while the deck lines up again silently, then it takes back over
      if (this.started) { this.started = false; this.takeAt = 0; this.audibleAt = Infinity; this.askedAt = performance.now(); this.fade(0, 1, this.ctx.currentTime); }
      this.el.currentTime = pos + startLag;
    }

    get audible() { return this.state === 'following' && !!this.started; }

    // deck to `deckTo`, YouTube to `ytTo`, together, from `at` (now or scheduled; until then both hold)
    fade(deckTo, ytTo, at, sec = FADE_SEC) {
      for (const [p, to] of [[this.gain.gain, deckTo], [this.gate, ytTo]]) {
        if (!p || to === null) continue;
        p.cancelScheduledValues(at); p.setValueAtTime(p.value, at); p.linearRampToValueAtTime(to, at + sec);
      }
    }

    stop(state) {
      this.state = state;
      clearInterval(this.timer); this.timer = null;
    }

    // the caller's mix takes over from `at`: the deck fades out, YouTube's gate stays as it is
    release(at, sec = FADE_SEC) {
      if (this.state !== 'following') return;
      const was = this.started;
      this.stop('released');
      if (was) this.fade(0, null, Math.max(at, this.ctx.currentTime), sec);
      else this.fade(0, null, this.ctx.currentTime);
      const wait = Math.max(0, at - this.ctx.currentTime + sec) * 1000 + 100;
      setTimeout(() => { try { this.el.pause(); } catch { /* gone */ } }, wait);
      log('released at the next mix');
    }

    handBack(why) {
      if (this.state !== 'following') { if (this.state !== 'empty') this.state = 'handed-back'; return; }
      const was = this.started;
      this.stop('handed-back');
      // (a deck that never took the sound leaves the gate alone: the caller's mix may hold it down)
      this.fade(0, was ? 1 : null, this.ctx.currentTime);
      setTimeout(() => { try { this.el.pause(); } catch { /* gone */ } }, FADE_SEC * 1000 + 50);
      log(`handed back to YouTube: ${why}`);
      this.onHandback?.(why);
    }

    stats() {
      const e = this.errors.slice(-100), abs = e.map(Math.abs).sort((a, b) => a - b);
      return {
        state: this.state, started: !!this.started, seeks: this.seekTimes.length,
        errorMs: this.errors.length ? Math.round(this.errors[this.errors.length - 1] * 1000) : null,
        medianAbsMs: abs.length ? Math.round(abs[abs.length >> 1] * 1000) : null,
        maxAbsMs: Math.round(this.maxAbsError * 1000), rate: this.el.playbackRate, gain: this.gain.gain.value,
      };
    }

    dispose(why = 'closed') {
      this.cancelLoad?.(why);
      this.handBack(why);
      clearInterval(this.timer); this.timer = null;
      this.el.removeEventListener('error', this.onError);
      const url = this.url;
      setTimeout(() => {   // (after any fade-out)
        try { this.src.disconnect(); this.gain.disconnect(); } catch { /* gone */ }
        this.el.removeAttribute('src'); this.el.load();
        if (url) URL.revokeObjectURL(url);
      }, 1500);
      this.url = ''; this.state = 'empty';
    }
  }

  window.__viviStreamDeck = { create: (ctx, destination) => new StreamDeck(ctx, destination) };
})();
