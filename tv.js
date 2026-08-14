// Contrôleur de la page TV (tv.html).
// Affiche le morceau en cours via Supabase Realtime et calcule le timer localement.

import { supabase } from './supabase.js';
import { getSyncedLyrics } from './lyrics.js';

// ----- Sélecteurs DOM -----
const coverEl        = document.getElementById('tv-cover');
const coverPlaceholder = document.getElementById('tv-cover-placeholder');
const titleEl        = document.getElementById('tv-title');
const artistEl       = document.getElementById('tv-artist');
const progressFill   = document.getElementById('tv-progress-fill');
const timerEl        = document.getElementById('tv-timer');
const lyricsEl       = document.getElementById('tv-lyrics');
const statusEl       = document.getElementById('tv-status');

// ----- État local -----
let _progressMs   = 0;
let _durationMs   = 0;
let _isPlaying    = false;
let _syncedAt     = null;   // Date object du dernier synced_at reçu
let _tickInterval = null;
let _currentTitle  = null;
let _currentArtist = null;
let _currentDuration = null;
let _lyrics        = null;  // tableau [{time, text}] ou null

// ----- Helpers -----

function fmt(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function localProgress() {
  if (!_isPlaying || !_syncedAt) return _progressMs;
  const elapsed = Date.now() - _syncedAt.getTime();
  return Math.min(_durationMs || Infinity, _progressMs + elapsed);
}

// ----- Paroles -----

async function loadLyrics(title, artist, duration) {
  _lyrics = null;
  if (lyricsEl) lyricsEl.textContent = 'Paroles indisponibles';
  try {
    const lines = await getSyncedLyrics(title, artist, duration);
    if (lines && lines.length > 0) {
      _lyrics = lines;
      renderLyrics(0);
    }
  } catch {
    // silently ignore
  }
}

function renderLyrics(progressMs) {
  if (!_lyrics || !lyricsEl) return;
  // Trouver la ligne courante : dernière ligne dont time <= progressMs
  let idx = 0;
  for (let i = 0; i < _lyrics.length; i++) {
    if (_lyrics[i].time <= progressMs) idx = i;
    else break;
  }
  lyricsEl.innerHTML = '';
  _lyrics.forEach((line, i) => {
    const p = document.createElement('p');
    p.textContent = line.text;
    p.className = 'lyric-line' + (i === idx ? ' lyric-active' : '');
    lyricsEl.appendChild(p);
  });
  // Faire défiler la ligne active
  const active = lyricsEl.querySelector('.lyric-active');
  if (active) {
    active.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// ----- Timer tick -----

function tick() {
  const progress = localProgress();
  const duration = _durationMs;

  // Timer
  if (timerEl) {
    timerEl.textContent = duration
      ? `${fmt(progress)} / ${fmt(duration)}`
      : fmt(progress);
  }

  // Barre de progression
  if (progressFill && duration > 0) {
    progressFill.style.width = `${Math.min(100, (progress / duration) * 100).toFixed(2)}%`;
  }

  // Paroles
  if (_lyrics) renderLyrics(progress);
}

function startTick() {
  if (_tickInterval) return;
  _tickInterval = setInterval(tick, 250);
}

function stopTick() {
  if (_tickInterval) {
    clearInterval(_tickInterval);
    _tickInterval = null;
  }
}

// ----- Mise à jour UI depuis données Supabase -----

async function applyTrack(row) {
  if (!row) {
    // Aucun morceau
    if (coverEl) { coverEl.src = ''; coverEl.style.display = 'none'; }
    if (coverPlaceholder) coverPlaceholder.style.display = 'flex';
    if (titleEl)  titleEl.textContent  = 'Aucun morceau en cours';
    if (artistEl) artistEl.textContent = '';
    if (timerEl)  timerEl.textContent  = '0:00 / 0:00';
    if (progressFill) progressFill.style.width = '0%';
    if (lyricsEl) lyricsEl.textContent = '';
    if (statusEl) statusEl.textContent = '';
    stopTick();
    return;
  }

  // Affichage de base
  if (titleEl)  titleEl.textContent  = row.title  ?? '';
  if (artistEl) artistEl.textContent = row.artist ?? '';

  // Pochette
  if (coverEl) {
    if (row.image_url && /^https:\/\//.test(row.image_url)) {
      coverEl.src = row.image_url;
      coverEl.style.display = 'block';
      coverEl.alt = `Pochette de ${row.title ?? ''}`;
      if (coverPlaceholder) coverPlaceholder.style.display = 'none';
    } else {
      coverEl.src = '';
      coverEl.style.display = 'none';
      if (coverPlaceholder) coverPlaceholder.style.display = 'flex';
    }
  }

  // Recaler le timer
  _durationMs  = row.duration_ms  ?? 0;
  _progressMs  = row.progress_ms  ?? 0;
  _isPlaying   = row.is_playing   ?? false;
  _syncedAt    = row.synced_at ? new Date(row.synced_at) : new Date();

  tick(); // affichage immédiat

  if (_isPlaying) startTick(); else stopTick();

  // Paroles (rechargement uniquement si morceau différent)
  const trackKey = `${row.title}::${row.artist}::${row.duration_ms}`;
  if (trackKey !== `${_currentTitle}::${_currentArtist}::${_currentDuration}`) {
    await loadLyrics(row.title ?? '', row.artist ?? '', row.duration_ms ?? 0);
    _currentTitle    = row.title;
    _currentArtist   = row.artist;
    _currentDuration = row.duration_ms;
  }
}

// ----- Chargement initial -----

async function loadCurrent() {
  if (statusEl) statusEl.textContent = 'Chargement…';
  try {
    const { data, error } = await supabase
      .from('now_playing')
      .select('title, artist, image_url, duration_ms, progress_ms, is_playing, synced_at')
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (statusEl) statusEl.textContent = '';
    await applyTrack(data);
  } catch (err) {
    console.error('[TV] Erreur chargement initial :', err);
    if (statusEl) statusEl.textContent = 'Erreur de connexion';
  }
}

// ----- Realtime -----

function subscribeRealtime() {
  supabase
    .channel('tv:now_playing')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'now_playing' }, async (payload) => {
      console.log('[TV] Realtime event :', payload);
      const row = payload.new ?? null;
      await applyTrack(row && Object.keys(row).length ? row : null);
    })
    .subscribe((status) => console.log('[TV] Realtime status :', status));
}

// ----- Init -----

loadCurrent();
subscribeRealtime();
