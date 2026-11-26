#!/usr/bin/env bash
# The spec's fixture suites (spec/README.md), in one place for both workflows: spec-tests.yml on a
# push or pull request, and fork-sync-release.yml after it merged upstream, so the merged code that
# is signed and published is the code that was tested.
#
#   bash scripts/run_spec.sh        (stops at the first failing suite)
set -euo pipefail
cd "$(dirname "$0")/.."
step() { echo; echo "== $*"; }

step "Automix planner against the golden plans";  node scripts/automix_fixtures.mjs
step "Automix planner unit tests";                node --test scripts/test_automix_plan.mjs
step "Automix engine (the cross-check of 2026-11-26)"; node --test scripts/automix_engine_audit_tests.mjs
step "Transition editor (presets, lanes, window positions)"; node scripts/editor_cases.mjs
step "Addon matcher (BitChord's cases)";          node scripts/addon_matcher_fixtures.mjs --matcher src/addons/track-matcher.js
step "Addon pick rules and client readings";      node scripts/addon_pick_tests.mjs
step "Addon offset fit and level";                node scripts/addon_offset_fixtures.mjs
step "Addon client, store and page"
node scripts/addon_client_tests.mjs
node scripts/addon_store_tests.mjs
node scripts/addon_file_cache_tests.mjs
node scripts/addon_stream_tests.mjs
node scripts/addon_page_tests.mjs
step "Canvas"
node scripts/video_canvas_tests.mjs
node scripts/canvas_spotify_tests.mjs
node scripts/canvas_cases_tests.mjs
step "Lyrics";                                    node scripts/lyrics_cases_tests.mjs
step "Analysis, synthetic songs on the real analyser"; node scripts/analysis_cases.mjs
step "Upstream merge script";                     "$(command -v python3 || command -v python)" scripts/merge_upstream_tests.py
