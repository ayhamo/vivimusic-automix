# Third-party notices: Vivimusic Web+ additions

Components that this fork bundles on top of upstream's. Upstream's own list is in
`THIRD_PARTY_NOTICES.md`, which is kept exactly as upstream ships it so merges stay clean.

| Component | Where | License | Copyright / source |
|---|---|---|---|
| signalsmith-stretch v1.3.2 | `src/vendor/signalsmith-stretch.js` (modified: copy-loop fix for multi-buffer loads, marked in the file) | MIT | © Geraint Luff / Signalsmith Audio — https://github.com/Signalsmith-Audio/signalsmith-stretch |
| open-unmix `umxhq` vocals model (int8 ONNX, as shipped by BitChord) | `src/vendor/automix/vocals_umxhq_int8.onnx` | MIT | © Inria / sigsep — https://github.com/sigsep/open-unmix-pytorch |
| Beat This! (`final0`, int8 ONNX, as shipped by BitChord) | `src/vendor/automix/beat_this_final0_q8.onnx` | MIT | © CP JKU — https://github.com/CPJKU/beat_this |
| ONNX Runtime Web (WASM) | `src/vendor/automix/ort-wasm-simd-threaded.wasm` | MIT | © Microsoft — https://github.com/microsoft/onnxruntime |
| Essentia.js (in BitChord's analysis worker) | `src/vendor/automix/analysis.worker.js` (modified: five embind functions replaced by non-eval equivalents) | AGPL-3.0 | © Music Technology Group, UPF — https://github.com/MTG/essentia.js |
| AutoMix (heydavidf), via BitChord web's automix | `src/automix/*` (ported and changed) | AGPL-3.0 | https://github.com/heydavidf/automix, https://github.com/ayhamo/BitChord |
| BitChord's TrackMatcher (`web/app/src/data/match/trackMatcher.ts` at a2d886e6) | `src/addons/track-matcher.js` (types stripped; a mashup rule added, marked in the file) | GPL-3.0 | © the BitChord authors — https://github.com/ayhamo/BitChord |
