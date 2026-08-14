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

// Offset pour synchronisation des paroles (en millisecondes)
// Les paroles changent L_OFFSET_MS avant le timing officiel
const LYRICS_OFFSET_MS = 300;

let _progressMs = 0;
let _durationMs = 0;
let _isPlaying = false;
let _syncedAt = Date.now(); // Timestamp du serveur en millisecondes
let _baseSyncTime = Date.now(); // Référence locale au moment de la sync
let _tickInterval = null;
let _lyricsState = null;
let _currentTrackId = null;
let _lyricsCacheTrackId = null;

function fmt(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function currentProgress() {
  // Si lecture : progression = progress_ms + (maintenant - moment de sync)
  // Sinon : progression statique = progress_ms
  const elapsed = _isPlaying ? (Date.now() - _baseSyncTime) : 0;
  return Math.min(_durationMs || Infinity, _progressMs + elapsed);
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

function renderLyricsAt(progressMs) {
  if (!_lyricsState) {
    if (lyricsEl) lyricsEl.innerHTML = '<p class="lyric-line lyric-active">Paroles indisponibles pour ce morceau</p>';
    return;
  }

  if (_lyricsState.type === 'plain') {
    if (lyricsEl) lyricsEl.innerHTML = '<p class="lyric-line lyric-active">Paroles disponibles mais non synchronisées</p>';
    return;
  }

  const lines = _lyricsState.lines || [];
  if (!lines.length) {
    if (lyricsEl) lyricsEl.innerHTML = '<p class="lyric-line lyric-active">Paroles indisponibles pour ce morceau</p>';
    return;
  }

  // Appliquer l'offset pour avancer les paroles
  const lyricsProgress = progressMs + LYRICS_OFFSET_MS;

  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].time <= lyricsProgress) idx = i;
    else break;
  }
  const prev = lines[idx - 1]?.text || '';
  const curr = lines[idx]?.text || '';
  const next = lines[idx + 1]?.text || '';

  if (lyricsEl) {
    lyricsEl.innerHTML = `
      <p class="lyric-line lyric-prev">${prev}</p>
      <p class="lyric-line lyric-active">${curr}</p>
      <p class="lyric-line lyric-next">${next}</p>
    `;
  }
}

function tick() {
  const progress = currentProgress();
  if (timerEl) timerEl.textContent = `${fmt(progress)} / ${fmt(_durationMs)}`;
  if (progressFill && _durationMs > 0) {
    progressFill.style.width = `${Math.min(100, (progress / _durationMs) * 100).toFixed(2)}%`;
  }
  renderLyricsAt(progress);
}

async function loadLyricsForTrack(row) {
  if (!row?.spotify_track_id) {
    _lyricsState = null;
    renderLyricsAt(0);
    return;
  }
  if (_lyricsCacheTrackId === row.spotify_track_id && _lyricsState) return;
  _lyricsCacheTrackId = row.spotify_track_id;
  _lyricsState = null;
  if (lyricsEl) lyricsEl.innerHTML = '<p class="lyric-line">Chargement des paroles…</p>';
  try {
    const result = await getSyncedLyrics({
      spotify_track_id: row.spotify_track_id,
      track_name: row.title ?? '',
      artist_name: row.artist ?? '',
      album_name: row.album ?? '',
      duration_ms: row.duration_ms ?? 0,
    });
    _lyricsState = result;
    if (!_lyricsState) {
      if (lyricsEl) lyricsEl.innerHTML = '<p class="lyric-line lyric-active">Paroles indisponibles pour ce morceau</p>';
    } else if (_lyricsState.type === 'plain') {
      if (lyricsEl) lyricsEl.innerHTML = '<p class="lyric-line lyric-active">Paroles disponibles mais non synchronisées</p>';
    }
  } catch (error) {
    console.error('[Lyrics] erreur LRCLIB:', error);
    _lyricsState = null;
    if (lyricsEl) lyricsEl.innerHTML = '<p class="lyric-line lyric-active">Paroles indisponibles pour ce morceau</p>';
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
    if (lyricsEl) lyricsEl.innerHTML = '<p class="lyric-line lyric-active">Paroles indisponibles pour ce morceau</p>';
    stopTick();
    return;
  }

  if (titleEl) titleEl.textContent = row.title ?? '';
  if (artistEl) artistEl.textContent = row.artist ?? '';
  if (coverEl) {
    if (row.image_url && /^https:\/\//.test(row.image_url)) {
      coverEl.src = row.image_url;
      coverEl.style.display = 'block';
      if (coverPlaceholder) coverPlaceholder.style.display = 'none';
    } else {
      coverEl.src = '';
      coverEl.style.display = 'none';
      if (coverPlaceholder) coverPlaceholder.style.display = 'flex';
    }
  }

  _durationMs = row.duration_ms ?? 0;
  _progressMs = row.progress_ms ?? 0;
  _isPlaying = row.is_playing ?? false;
  // Utiliser synced_at du serveur comme référence temporelle
  _syncedAt = row.synced_at ? new Date(row.synced_at).getTime() : Date.now();
  _baseSyncTime = Date.now();

  console.log('[TV] données:', row.title, row.duration_ms, row.progress_ms, row.is_playing);

  // Ne charger les paroles que si duration_ms est un nombre > 0
  if (typeof row.duration_ms === 'number' && row.duration_ms > 0) {
    await loadLyricsForTrack(row);
  } else {
    _lyricsState = null;
    if (lyricsEl) lyricsEl.innerHTML = '<p class="lyric-line lyric-active">Durée indisponible - paroles désactivées</p>';
  }

  tick();
  if (_isPlaying && _durationMs > 0) startTick(); else stopTick();
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
