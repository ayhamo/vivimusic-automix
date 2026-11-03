/**
 * VIVIMUSIC WEB — listenbrainz.js
 */
'use strict';

const LISTENBRAINZ_API_ROOT = 'https://api.listenbrainz.org/1/';

async function listenbrainzValidateToken(token) {
  token = String(token || '').trim();
  if (!token) throw new Error('Token cannot be empty.');
  const res = await fetch(`${LISTENBRAINZ_API_ROOT}validate-token`, {
    headers: {
      Authorization: `Token ${token}`,
      Accept: 'application/json'
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.valid) {
    throw new Error(data.message || `ListenBrainz token invalid (${res.status})`);
  }
  return { valid: true, username: data.user_name };
}

async function listenbrainzSubmitListens(token, listenType, payload) {
  token = String(token || '').trim();
  if (!token) throw new Error('No ListenBrainz token configured.');
  const res = await fetch(`${LISTENBRAINZ_API_ROOT}submit-listens`, {
    method: 'POST',
    headers: {
      Authorization: `Token ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify({
      listen_type: listenType,
      payload
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.status !== 'ok') {
    throw new Error(data.error || `ListenBrainz submission failed (${res.status})`);
  }
  return data;
}

async function listenbrainzUpdateNowPlaying(token, track) {
  const item = {
    track_metadata: {
      artist_name: track.artist,
      track_name: track.song,
      additional_info: {
        submission_client: 'Vivimusic Web',
        submission_client_version: chrome.runtime.getManifest().version
      }
    }
  };
  if (track.duration) {
    item.track_metadata.additional_info.duration_ms = Math.round(track.duration * 1000);
  }
  return listenbrainzSubmitListens(token, 'playing_now', [item]);
}

async function listenbrainzScrobble(token, track, timestamp) {
  const item = {
    listened_at: timestamp,
    track_metadata: {
      artist_name: track.artist,
      track_name: track.song,
      additional_info: {
        submission_client: 'Vivimusic Web',
        submission_client_version: chrome.runtime.getManifest().version
      }
    }
  };
  return listenbrainzSubmitListens(token, 'single', [item]);
}
