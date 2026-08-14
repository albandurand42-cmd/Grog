// Contrôleur de la page TV (tv.html).
// Affiche le morceau en cours via Supabase Realtime et calcule le timer localement.

import { supabase } from './supabase.js';
import { getSyncedLyrics } from './lyrics.js';

const coverEl = document.getElementById('tv-cover');
const coverPlaceholder = document.getElementById('tv-cover-placeholder');
const titleEl = document.getElementById('tv-title');
const artistEl = document.getElementById('tv-artist');
const progressFill = document.getElementById('tv-progress-fill');
const timerEl = document.getElementById('tv-timer');
const lyricsEl = document.getElementById('tv-lyrics');
const statusEl = document.getElementById('tv-status');

let _progressMs = 0;
let _durationMs = 0;
let _isPlaying = false;
let _baseSyncTime = Date.now();
let _tickInterval = null;
let _currentTrackId = null;
let _lyricsState = null;
let _lyricsCacheTrackId = null;

function fmt(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getCurrentProgress() {
  const delta = _isPlaying ? (Date.now() - _baseSyncTime) : 0;
  return Math.min(_durationMs || Infinity, _progressMs + delta);
}

function renderEmptyLyrics(message) {
  if (lyricsEl) {
    lyricsEl.innerHTML = `<p class="lyric-line lyric-active">${message}</p>`;
  }
}

function stopTick() {
  if (_tickInterval) {
    clearInterval(_tickInterval);
    _tickInterval = null;
  }
}

function startTick() {
  if (_tickInterval) return;
  _tickInterval = setInterval(tick, 125);
}

function tick() {
  const progress = getCurrentProgress();
  const duration = _durationMs;
  if (timerEl) timerEl.textContent = `${fmt(progress)} / ${fmt(duration)}`;
  if (progressFill && duration > 0) {
    progressFill.style.width = `${Math.min(100, (progress / duration) * 100).toFixed(2)}%`;
  }
  renderLyricsAt(progress);
}

function parseLyricsState(payload) {
  if (!payload) return null;
  if (payload.type === 'synced' && Array.isArray(payload.lines)) return payload;
  if (payload.type === 'plain') return payload;
  return null;
}

function renderLyricsAt(progressMs) {
  if (!_lyricsState) {
    renderEmptyLyrics('Paroles indisponibles pour ce morceau');
    return;
  }

  if (_lyricsState.type === 'plain') {
    if (lyricsEl) lyricsEl.innerHTML = `<p class="lyric-line lyric-active">Paroles disponibles mais non synchronisées</p>`;
    return;
  }

  const lines = _lyricsState.lines || [];
  if (!lines.length) {
    renderEmptyLyrics('Paroles indisponibles pour ce morceau');
    return;
  }

  let current = 0;
  while (current < lines.length - 1 && lines[current + 1].time <= progressMs) current += 1;
  const previous = lines[current - 1]?.text || '';
  const active = lines[current]?.text || '';
  const next = lines[current + 1]?.text || '';

  if (!lyricsEl) return;
  lyricsEl.innerHTML = `
    <p class="lyric-line lyric-prev">${previous}</p>
    <p class="lyric-line lyric-active">${active}</p>
    <p class="lyric-line lyric-next">${next}</p>
  `;
}

async function loadLyricsForTrack(row) {
  if (!row?.spotify_track_id) {
    _lyricsState = null;
    renderEmptyLyrics('Paroles indisponibles pour ce morceau');
    return;
  }
  if (_lyricsCacheTrackId === row.spotify_track_id && _lyricsState) return;
  _lyricsCacheTrackId = row.spotify_track_id;
  _lyricsState = null;
  renderEmptyLyrics('Chargement des paroles…');
  try {
    const result = await getSyncedLyrics({
      spotify_track_id: row.spotify_track_id,
      track_name: row.title ?? '',
      artist_name: row.artist ?? '',
      album_name: row.album ?? '',
      duration_ms: row.duration_ms ?? 0,
    });
    _lyricsState = parseLyricsState(result);
    if (!_lyricsState) {
      renderEmptyLyrics('Paroles indisponibles pour ce morceau');
    } else if (_lyricsState.type === 'plain') {
      renderEmptyLyrics('Paroles disponibles mais non synchronisées');
    }
  } catch (error) {
    console.error('[Lyrics] erreur LRCLIB:', error);
    _lyricsState = null;
    renderEmptyLyrics('Paroles indisponibles pour ce morceau');
  }
}

async function applyTrack(row) {
  if (!row) {
    if (coverEl) { coverEl.src = ''; coverEl.style.display = 'none'; }
    if (coverPlaceholder) coverPlaceholder.style.display = 'flex';
    if (titleEl) titleEl.textContent = 'Aucun morceau en cours';
    if (artistEl) artistEl.textContent = '';
    if (timerEl) timerEl.textContent = '0:00 / 0:00';
    if (progressFill) progressFill.style.width = '0%';
    renderEmptyLyrics('Paroles indisponibles pour ce morceau');
    stopTick();
    return;
  }

  if (titleEl) titleEl.textContent = row.title ?? '';
  if (artistEl) artistEl.textContent = row.artist ?? '';
  if (coverEl && row.image_url && /^https:\/\//.test(row.image_url)) {
    coverEl.src = row.image_url;
    coverEl.style.display = 'block';
    if (coverPlaceholder) coverPlaceholder.style.display = 'none';
  }

  _durationMs = row.duration_ms ?? 0;
  _progressMs = row.progress_ms ?? 0;
  _isPlaying = row.is_playing ?? false;
  _baseSyncTime = Date.now();

  console.log('[now_playing] TV data:', row.title, row.duration_ms, row.progress_ms);
  await loadLyricsForTrack(row);
  tick();
  if (_isPlaying) startTick(); else stopTick();
}

async function loadCurrent() {
  if (statusEl) statusEl.textContent = 'Chargement…';
  try {
    const { data, error } = await supabase
      .from('now_playing')
      .select('spotify_track_id, title, artist, album, image_url, duration_ms, progress_ms, is_playing, synced_at')
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (statusEl) statusEl.textContent = '';
    await applyTrack(data);
  } catch (err) {
    console.error('[TV] erreur Supabase:', err);
    if (statusEl) statusEl.textContent = 'Aucun morceau en cours';
  }
}

function subscribeRealtime() {
  supabase
    .channel('tv:now_playing')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'now_playing' }, async (payload) => {
      const row = payload.new ?? null;
      await applyTrack(row && Object.keys(row).length ? row : null);
    })
    .subscribe((status) => console.log('[TV] Realtime status :', status));
}

loadCurrent();
subscribeRealtime();
