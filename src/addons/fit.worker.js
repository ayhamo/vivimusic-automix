/* Vivimusic Web+ — addons/fit.worker.js (a Worker of the hidden analysis frame, automix/host.js)
 *
 * The addon copy's fit and level, off YouTube Music's main thread: on it, the fit alone held the
 * page for about 0.9 s per song (measured on 24-bit/96 kHz files), and the next song's runs while
 * the current one plays.
 *   { id, op: 'fit', yt, ad, opt }  -> { fit, ytLufs, addonLufs }   (both at offset-fit's FIT_RATE)
 *   { id, op: 'gain', args }        -> { lvl }                       (sourceGainDb, with the channels)
 * answered as { id, ok: true, result } or { id, ok: false, error }.
 */
'use strict';
importScripts('offset-fit.js');
const F = globalThis.__viviOffsetFit;

onmessage = (e) => {
  const d = e.data || {};
  try {
    let result;
    if (d.op === 'fit') {
      const fit = F.fit(d.yt, d.ad, d.opt || {});
      result = fit.none ? { fit } : { fit, ytLufs: F.integratedLufs(d.yt, F.FIT_RATE), addonLufs: F.integratedLufs(d.ad, F.FIT_RATE) };
    } else if (d.op === 'gain') {
      result = { lvl: F.sourceGainDb(d.args) };
    } else throw new Error('unknown op ' + d.op);
    postMessage({ id: d.id, ok: true, result });
  } catch (err) {
    postMessage({ id: d.id, ok: false, error: String(err?.message || err) });
  }
};
