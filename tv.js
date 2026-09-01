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
// Les paroles changent LYRICS_OFFSET_MS avant le timing officiel
const LYRICS_OFFSET_MS = 300;

let _progressMs = 0;
let _durationMs = 0;
let _isPlaying = false;
let _syncedAtMs = Date.now(); // Timestamp en ms (Date.parse() résultat)
let _tickInterval = null;
let _lyricsState = null;
let _currentTrackId = null;
let _lyricsCacheTrackId = null;
let _lyricsRequestId = null; // Identifiant unique de la requête de paroles en cours

function fmt(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function currentProgress() {
  const elapsed = _isPlaying ? (Date.now() - _syncedAtMs) : 0;
  return Math.min(_durationMs || Infinity, Math.max(0, _progressMs + elapsed));
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

  // Log de diagnostic au changement de ligne
  if (lyricsEl && curr) {
    console.log('[LYRICS SYNC]', Math.round(progressMs), 'ms → ligne', idx, '/', lines.length, ':', curr.substring(0, 50));
  }

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

  // Générer un ID unique pour cette requête
  const requestId = Math.random();
  _lyricsRequestId = requestId;

  console.log('[TV] track changé:', row.spotify_track_id, row.title);
  console.log('[TV] demande paroles');

  // Ne pas attendre les paroles : mettre à jour l'UI immédiatement
  if (lyricsEl) lyricsEl.innerHTML = '<p class="lyric-line">Chargement des paroles…</p>';

  // Charger les paroles en arrière-plan sans bloquer
  try {
    const result = await getSyncedLyrics({
      spotify_track_id: row.spotify_track_id,
      track_name: row.title ?? '',
      artist_name: row.artist ?? '',
      album_name: row.album ?? '',
      duration_ms: row.duration_ms ?? 0,
    });

    // Ignorer si une nouvelle requête a été lancée entre-temps
    if (requestId !== _lyricsRequestId) {
      console.log('[TV] Résultat de paroles ignoré (morceau changé)');
      return;
    }

    _lyricsState = result;
    console.log('[TV] paroles reçues:', result?.lines?.length ?? (result?.type === 'plain' ? 'plain' : 0));
    if (!_lyricsState) {
      if (lyricsEl) lyricsEl.innerHTML = '<p class="lyric-line lyric-active">Paroles indisponibles pour ce morceau</p>';
    } else if (_lyricsState.type === 'plain') {
      if (lyricsEl) lyricsEl.innerHTML = '<p class="lyric-line lyric-active">Paroles disponibles mais non synchronisées</p>';
    } else {
      // Paroles synchronisées chargées, mettre à jour immédiatement
      tick();
    }
  } catch (error) {
    console.error('[TV] erreur LRCLIB:', error);
    // Ignorer si une nouvelle requête a été lancée
    if (requestId !== _lyricsRequestId) return;
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

  // Récupérer l'ID ancien pour détecter changement de morceau
  const oldTrackId = _currentTrackId;

  // Mettre à jour immédiatement : titre, artiste, pochette
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

  // Mettre à jour le timer : RECALIBRAGE À CHAQUE UPDATE
  _durationMs = row.duration_ms ?? 0;
  _progressMs = row.progress_ms ?? 0;
  _isPlaying = row.is_playing ?? false;
  
  // 🔧 FIX PRINCIPAL : Utiliser synced_at comme référence temporelle
  // et non Date.now() qui créerait une dérive immédiate
  _syncedAtMs = row.synced_at ? Date.parse(row.synced_at) : Date.now();
  
  // Validation : si synced_at invalide, utiliser Date.now()
  if (isNaN(_syncedAtMs)) {
    _syncedAtMs = Date.now();
  }

  console.log('[TV SYNC]', {
    track: row.spotify_track_id,
    progress_ms: row.progress_ms,
    duration_ms: row.duration_ms,
    is_playing: row.is_playing,
    synced_at: row.synced_at,
    _syncedAtMs: _syncedAtMs
  });

  // Mettre à jour l'affichage du timer IMMÉDIATEMENT
  tick();

  // Gérer l'état du lecteur
  if (_isPlaying && _durationMs > 0) startTick();
  else stopTick();

  // Détecter changement de morceau
  const trackChanged = oldTrackId !== row.spotify_track_id;
  _currentTrackId = row.spotify_track_id;

  // Si changement de morceau : charger les paroles EN ARRIÈRE-PLAN
  if (trackChanged && typeof row.duration_ms === 'number' && row.duration_ms > 0) {
    loadLyricsForTrack(row);
  } else if (!trackChanged) {
    // Même morceau mais progression mise à jour : on a juste recalibré le timer
    // Les paroles restent en mémoire, elles vont se repositionner au prochain tick
    console.log('[TV] Même morceau, recalibrage du timer effectué');
  }
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
      // Utiliser directement payload.new si disponible
      if (payload.new && Object.keys(payload.new).length) {
        console.log('[TV] Realtime update reçu, application immédiate');
        applyTrack(payload.new);
      } else {
        // Fallback si payload vide ou suppression
        console.log('[TV] Fallback loadCurrent après event Realtime');
        await loadCurrent();
      }
    })
    .subscribe((status) => console.log('[TV] Realtime status:', status));
}

loadCurrent();
subscribeRealtime();

// ----- Commentaires TV -----

const commentOverlay = document.getElementById('tv-comment-overlay');
const _shownCommentIds = new Set();
let _commentQueue = [];
let _commentDisplaying = false;

function enqueueComment(row) {
  if (_shownCommentIds.has(row.id)) return;
  _shownCommentIds.add(row.id);
  _commentQueue.push(row);
  if (!_commentDisplaying) processCommentQueue();
}

function processCommentQueue() {
  if (!_commentQueue.length || !commentOverlay) {
    _commentDisplaying = false;
    return;
  }
  _commentDisplaying = true;
  const row = _commentQueue.shift();
  showComment(row, () => {
    // Petite pause entre deux commentaires
    setTimeout(processCommentQueue, 800);
  });
}

function showComment(row, onDone) {
  if (!commentOverlay) { onDone(); return; }
  // Construire le contenu en utilisant textContent pour éviter XSS
  const bubble = document.createElement('div');
  bubble.className = 'tv-comment-bubble';
  const nameEl = document.createElement('div');
  nameEl.className = 'tv-comment-name';
  nameEl.textContent = '💬 ' + (row.guest_name || 'Anonyme');
  const textEl = document.createElement('div');
  textEl.className = 'tv-comment-text';
  textEl.textContent = row.message;
  bubble.appendChild(nameEl);
  bubble.appendChild(textEl);
  commentOverlay.innerHTML = '';
  commentOverlay.appendChild(bubble);

  // Apparition
  requestAnimationFrame(() => {
    requestAnimationFrame(() => { commentOverlay.classList.add('visible'); });
  });

  // Disparition après 6 s
  setTimeout(() => {
    commentOverlay.classList.remove('visible');
    setTimeout(onDone, 300); // attendre la transition de sortie
  }, 6000);
}

async function loadRecentApprovedComments() {
  try {
    const since = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 dernières minutes
    const { data, error } = await supabase
      .from('comments')
      .select('id, guest_name, message')
      .eq('status', 'approved')
      .gte('approved_at', since)
      .order('approved_at', { ascending: true });
    if (error) throw error;
    for (const row of (data ?? [])) enqueueComment(row);
  } catch (err) {
    console.error('[TV] erreur chargement commentaires récents :', err);
  }
}

function subscribeComments() {
  supabase
    .channel('tv:comments')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'comments' }, (payload) => {
      const row = payload.new;
      if (row?.status === 'approved') enqueueComment(row);
    })
    .subscribe((status) => console.log('[TV] Comments Realtime status:', status));
}

loadRecentApprovedComments();
subscribeComments();
