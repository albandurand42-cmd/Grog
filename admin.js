// Contrôleur de la page admin DJ (admin.html).
// Gère l'authentification Spotify PKCE, la lecture, les demandes invités, les votes volume et now_playing.

import { startPKCE, handleCallback, getStoredTokens, logout, refreshAccessToken } from './auth.js';
import { fetchPendingRequests, subscribeToQueue } from './queue.js';
import { supabase } from './supabase.js';
import { escHtml } from './utils.js';
import { fetchVolumeScore } from './votes.js';

// ----- Sélecteurs DOM -----
const authStatus = document.getElementById('auth-status');
const connectedUser = document.getElementById('connected-user');
const btnLogin = document.getElementById('btn-login');
const btnLogout = document.getElementById('btn-logout');
const btnPlay = document.getElementById('btn-play');
const btnPause = document.getElementById('btn-pause');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const controlsNote = document.getElementById('controls-note');
const requestsList = document.getElementById('requests-list');
const volScoreAdmin = document.getElementById('vol-score-admin');
const syncStatus = document.getElementById('sync-status');

let accessToken = null;
/** Spotify track ID du dernier morceau écrit dans now_playing */
let _lastSyncedTrackId = null;
/** Intervalle de polling Spotify */
let _syncInterval = null;

// ----- Auth -----

async function init() {
  const tokens = await handleCallback().catch(() => null);
  const stored = tokens ?? getStoredTokens();
  if (stored) {
    accessToken = stored.access_token;
    setAuthUI(true);
    await loadCurrentUser();
    startSpotifySync();
  } else {
    setAuthUI(false);
  }

  loadRequests();
  subscribeToQueue(handleRealtimeChange);
  loadVolumeScore();
  setInterval(loadVolumeScore, 8000);
}

function setAuthUI(connected) {
  authStatus.textContent = connected ? 'Connecté' : 'Hors connexion';
  authStatus.style.background = connected
    ? 'rgba(34,197,94,0.15)'
    : 'rgba(239,68,68,0.1)';
  btnPlay.disabled = !connected;
  btnPause.disabled = !connected;
  btnPrev.disabled = !connected;
  btnNext.disabled = !connected;
  if (connected) {
    controlsNote.textContent = '';
  } else {
    setSyncStatus('disconnected');
  }
}

async function loadCurrentUser() {
  if (!accessToken) return;
  try {
    const res = await fetch('https://api.spotify.com/v1/me', {
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    if (!res.ok) return;
    const user = await res.json();
    connectedUser.textContent = user.display_name || user.id;
  } catch {
    // silently ignore
  }
}

btnLogin.addEventListener('click', startPKCE);
btnLogout.addEventListener('click', () => {
  logout();
  accessToken = null;
  connectedUser.textContent = 'Aucun';
  setAuthUI(false);
  stopSpotifySync();
  resetNowPlayingUI();
});

// ----- Spotify token refresh helper -----

/**
 * Effectue un appel à l'API Spotify avec rafraîchissement automatique du token en cas de 401.
 * @param {string} url
 * @returns {Promise<Response|null>}
 */
async function spotifyFetch(url) {
  let res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (res.status === 401) {
    const newToken = await refreshAccessToken();
    if (!newToken) {
      // Refresh impossible — déconnecter proprement
      logout();
      accessToken = null;
      setAuthUI(false);
      stopSpotifySync();
      return null;
    }
    accessToken = newToken;
    res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  }
  return res;
}

// ----- Commandes Spotify -----

async function spotifyControl(endpoint, method = 'POST') {
  if (!accessToken) return;
  await fetch('https://api.spotify.com/v1/me/player/' + endpoint, {
    method,
    headers: { Authorization: 'Bearer ' + accessToken },
  });
}

btnPlay.addEventListener('click', () => spotifyControl('play', 'PUT'));
btnPause.addEventListener('click', () => spotifyControl('pause', 'PUT'));
btnPrev.addEventListener('click', () => spotifyControl('previous'));
btnNext.addEventListener('click', () => spotifyControl('next'));

// ----- Synchronisation automatique Spotify → now_playing -----

function setSyncStatus(status) {
  if (!syncStatus) return;
  const labels = {
    playing:      '🟢 Spotify synchronisé',
    paused:       '⏸ Spotify en pause',
    idle:         '⚠ Aucun lecteur Spotify actif',
    disconnected: '🔴 Connexion Spotify nécessaire',
  };
  syncStatus.textContent = labels[status] ?? status;
}

function startSpotifySync() {
  if (_syncInterval) return;
  // Premier check immédiat
  syncNowPlaying();
  _syncInterval = setInterval(syncNowPlaying, 5000);
}

function stopSpotifySync() {
  if (_syncInterval) {
    clearInterval(_syncInterval);
    _syncInterval = null;
  }
  _lastSyncedTrackId = null;
  setSyncStatus('disconnected');
}

/**
 * Interroge l'API Spotify et met à jour Supabase si le morceau a changé.
 */
async function syncNowPlaying() {
  if (!accessToken) return;

  let res;
  try {
    res = await spotifyFetch('https://api.spotify.com/v1/me/player/currently-playing');
  } catch (err) {
    console.error('Erreur sync Spotify :', err);
    return;
  }

  if (!res) return; // token refresh failed — already handled

  // 204 = aucun lecteur actif
  if (res.status === 204) {
    setSyncStatus('idle');
    updateNowPlayingAdminUI(null);
    return;
  }

  if (!res.ok) {
    console.warn('Erreur currently-playing :', res.status);
    return;
  }

  const data = await res.json();
  const item = data?.item;

  if (!item || data.currently_playing_type !== 'track') {
    setSyncStatus('idle');
    updateNowPlayingAdminUI(null);
    return;
  }

  const track = {
    spotify_track_id: item.id,
    title: item.name,
    artist: item.artists.map((a) => a.name).join(', '),
    album: item.album.name,
    image_url: item.album.images?.[0]?.url ?? null,
    duration_ms: item.duration_ms,
    progress_ms: data.progress_ms ?? 0,
    is_playing: data.is_playing,
  };

  setSyncStatus(track.is_playing ? 'playing' : 'paused');
  updateNowPlayingAdminUI(track);

  // N'écrire dans Supabase que si le morceau a changé
  if (track.spotify_track_id === _lastSyncedTrackId) return;

  _lastSyncedTrackId = track.spotify_track_id;
  await writeNowPlayingToSupabase(track);
}

async function writeNowPlayingToSupabase(track) {
  try {
    // Supprimer l'ancienne ligne
    await supabase.from('now_playing').delete().gte('started_at', '1970-01-01');
    const { error } = await supabase.from('now_playing').insert({
      spotify_track_id: track.spotify_track_id,
      title: track.title,
      artist: track.artist,
      image_url: track.image_url,
    });
    if (error) throw error;
  } catch (err) {
    console.error('Erreur écriture now_playing :', err);
  }
}

function updateNowPlayingAdminUI(track) {
  const titleEl = document.getElementById('track-title');
  const artistEl = document.getElementById('track-artist');
  const coverEl = document.getElementById('np-cover');
  const timeEl = document.getElementById('track-time');
  const fillEl = document.getElementById('progress-fill');

  if (!track) {
    if (titleEl) titleEl.textContent = 'Aucun morceau';
    if (artistEl) artistEl.textContent = 'Aucun lecteur Spotify actif';
    if (coverEl) { coverEl.style.backgroundImage = ''; coverEl.className = 'cover placeholder'; }
    if (timeEl) timeEl.textContent = '0:00 / 0:00';
    if (fillEl) fillEl.style.width = '0%';
    return;
  }

  if (titleEl) titleEl.textContent = track.title;
  if (artistEl) artistEl.textContent = track.artist;
  if (coverEl && track.image_url) {
    coverEl.className = 'cover np-cover';
    coverEl.style.backgroundImage = `url('${track.image_url}')`;
  }
  if (timeEl) {
    const fmt = (ms) => {
      const s = Math.floor(ms / 1000);
      return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    timeEl.textContent = `${fmt(track.progress_ms)} / ${fmt(track.duration_ms)}`;
  }
  if (fillEl && track.duration_ms > 0) {
    fillEl.style.width = `${Math.min(100, (track.progress_ms / track.duration_ms) * 100).toFixed(1)}%`;
  }
}

function resetNowPlayingUI() {
  updateNowPlayingAdminUI(null);
}

// ----- Demandes invités -----

async function loadRequests() {
  try {
    const rows = await fetchPendingRequests();
    renderRequests(rows);
  } catch (err) {
    console.error('Erreur chargement demandes :', err);
    requestsList.innerHTML = '<div class="empty-state error-state">Impossible de charger les demandes.</div>';
  }
}

function renderRequests(rows) {
  if (!rows.length) {
    requestsList.innerHTML = '<div class="empty-state">Aucune demande pour le moment.</div>';
    return;
  }
  requestsList.innerHTML = '';
  for (const row of rows) {
    requestsList.appendChild(buildRequestItem(row));
  }
}

function buildRequestItem(row) {
  const article = document.createElement('article');
  article.className = 'request-card';
  article.dataset.id = row.id;
  const nameHtml = row.guest_name
    ? `<span class="muted guest-name">Demandé par ${escHtml(row.guest_name)}</span>`
    : `<span class="muted guest-name">Anonyme</span>`;
  article.innerHTML = `
    ${row.album_art ? `<img class="cover" src="${escHtml(row.album_art)}" alt="pochette" width="56" height="56" loading="lazy">` : '<div class="cover placeholder" aria-hidden="true"></div>'}
    <div class="request-info">
      <strong>${escHtml(row.title)}</strong>
      <span class="muted">${escHtml(row.artist)}</span>
      ${nameHtml}
    </div>
    <span class="vote-count">${row.request_count ?? 1}×</span>
    <button type="button" class="badge-play" data-action="play" title="Mettre en lecture">▶</button>
    <button type="button" class="badge-accept" data-action="accept" title="Marquer comme joué">✓</button>
    <button type="button" class="badge-reject" data-action="reject" title="Refuser">✕</button>
  `;
  article.querySelector('[data-action="play"]').addEventListener('click', () => setNowPlayingManual(row, article));
  article.querySelector('[data-action="accept"]').addEventListener('click', () => updateStatus(row.id, 'played', article));
  article.querySelector('[data-action="reject"]').addEventListener('click', () => updateStatus(row.id, 'rejected', article));
  return article;
}

async function updateStatus(id, status, articleEl) {
  const { error } = await supabase.from('song_requests').update({ status }).eq('id', id);
  if (error) {
    alert('Erreur mise à jour : ' + error.message);
    return;
  }
  articleEl.remove();
  if (!requestsList.querySelector('.request-card')) {
    requestsList.innerHTML = '<div class="empty-state">Aucune demande pour le moment.</div>';
  }
}

// ----- Now Playing manuel (fallback) -----

async function setNowPlayingManual(row, articleEl) {
  const btn = articleEl.querySelector('[data-action="play"]');
  btn.disabled = true;
  try {
    await supabase.from('now_playing').delete().gte('started_at', '1970-01-01');
    const { error } = await supabase.from('now_playing').insert({
      spotify_track_id: row.spotify_id ?? null,
      title: row.title,
      artist: row.artist,
      image_url: row.album_art ?? null,
    });
    if (error) throw error;
    // Mettre à jour l'état local pour éviter un re-sync immédiat si même track
    _lastSyncedTrackId = row.spotify_id ?? null;
    btn.textContent = '▶️';
    setTimeout(() => { btn.textContent = '▶'; btn.disabled = false; }, 2000);
  } catch (err) {
    console.error('Erreur now_playing :', err);
    btn.disabled = false;
    alert('Impossible de mettre à jour le morceau en cours.');
  }
}

function handleRealtimeChange() {
  loadRequests();
}

// ----- Score volume (lecture seule, fenêtre 2 min) -----

async function loadVolumeScore() {
  try {
    const score = await fetchVolumeScore();
    if (volScoreAdmin) volScoreAdmin.textContent = (score > 0 ? '+' : '') + score;
  } catch (err) {
    console.error('Erreur score volume admin :', err);
  }
}

init();
import { fetchPendingRequests, subscribeToQueue } from './queue.js';
import { supabase } from './supabase.js';
import { escHtml } from './utils.js';
import { fetchVolumeScore } from './votes.js';

// ----- Sélecteurs DOM -----
const authStatus = document.getElementById('auth-status');
const connectedUser = document.getElementById('connected-user');
const btnLogin = document.getElementById('btn-login');
const btnLogout = document.getElementById('btn-logout');
const btnPlay = document.getElementById('btn-play');
const btnPause = document.getElementById('btn-pause');
const btnPrev = document.getElementById('btn-prev');
const btnNext = document.getElementById('btn-next');
const controlsNote = document.getElementById('controls-note');
const requestsList = document.getElementById('requests-list');
const volScoreAdmin = document.getElementById('vol-score-admin');

let accessToken = null;

// ----- Auth -----

async function init() {
  const tokens = await handleCallback().catch(() => null);
  const stored = tokens ?? getStoredTokens();
  if (stored) {
    accessToken = stored.access_token;
    setAuthUI(true);
    await loadCurrentUser();
  } else {
    setAuthUI(false);
  }

  loadRequests();
  subscribeToQueue(handleRealtimeChange);
  loadVolumeScore();
  setInterval(loadVolumeScore, 8000);
}

function setAuthUI(connected) {
  authStatus.textContent = connected ? 'Connecté' : 'Hors connexion';
  authStatus.style.background = connected
    ? 'rgba(34,197,94,0.15)'
    : 'rgba(239,68,68,0.1)';
  btnPlay.disabled = !connected;
  btnPause.disabled = !connected;
  btnPrev.disabled = !connected;
  btnNext.disabled = !connected;
  if (connected) controlsNote.textContent = '';
}

async function loadCurrentUser() {
  if (!accessToken) return;
  try {
    const res = await fetch('https://api.spotify.com/v1/me', {
      headers: { Authorization: 'Bearer ' + accessToken },
    });
    if (!res.ok) return;
    const user = await res.json();
    connectedUser.textContent = user.display_name || user.id;
  } catch {
    // silently ignore
  }
}

btnLogin.addEventListener('click', startPKCE);
btnLogout.addEventListener('click', () => {
  logout();
  accessToken = null;
  connectedUser.textContent = 'Aucun';
  setAuthUI(false);
});

// ----- Commandes Spotify -----

async function spotifyControl(endpoint, method = 'POST') {
  if (!accessToken) return;
  await fetch('https://api.spotify.com/v1/me/player/' + endpoint, {
    method,
    headers: { Authorization: 'Bearer ' + accessToken },
  });
}

btnPlay.addEventListener('click', () => spotifyControl('play', 'PUT'));
btnPause.addEventListener('click', () => spotifyControl('pause', 'PUT'));
btnPrev.addEventListener('click', () => spotifyControl('previous'));
btnNext.addEventListener('click', () => spotifyControl('next'));

// ----- Demandes invités -----

async function loadRequests() {
  try {
    const rows = await fetchPendingRequests();
    renderRequests(rows);
  } catch (err) {
    console.error('Erreur chargement demandes :', err);
    requestsList.innerHTML = '<div class="empty-state error-state">Impossible de charger les demandes.</div>';
  }
}

function renderRequests(rows) {
  if (!rows.length) {
    requestsList.innerHTML = '<div class="empty-state">Aucune demande pour le moment.</div>';
    return;
  }
  requestsList.innerHTML = '';
  for (const row of rows) {
    requestsList.appendChild(buildRequestItem(row));
  }
}

function buildRequestItem(row) {
  const article = document.createElement('article');
  article.className = 'request-card';
  article.dataset.id = row.id;
  const nameHtml = row.guest_name
    ? `<span class="muted guest-name">Demandé par ${escHtml(row.guest_name)}</span>`
    : `<span class="muted guest-name">Anonyme</span>`;
  article.innerHTML = `
    ${row.album_art ? `<img class="cover" src="${escHtml(row.album_art)}" alt="pochette" width="56" height="56" loading="lazy">` : '<div class="cover placeholder" aria-hidden="true"></div>'}
    <div class="request-info">
      <strong>${escHtml(row.title)}</strong>
      <span class="muted">${escHtml(row.artist)}</span>
      ${nameHtml}
    </div>
    <span class="vote-count">${row.request_count ?? 1}×</span>
    <button type="button" class="badge-play" data-action="play" title="Mettre en lecture">▶</button>
    <button type="button" class="badge-accept" data-action="accept" title="Marquer comme joué">✓</button>
    <button type="button" class="badge-reject" data-action="reject" title="Refuser">✕</button>
  `;
  article.querySelector('[data-action="play"]').addEventListener('click', () => setNowPlaying(row, article));
  article.querySelector('[data-action="accept"]').addEventListener('click', () => updateStatus(row.id, 'played', article));
  article.querySelector('[data-action="reject"]').addEventListener('click', () => updateStatus(row.id, 'rejected', article));
  return article;
}

async function updateStatus(id, status, articleEl) {
  const { error } = await supabase.from('song_requests').update({ status }).eq('id', id);
  if (error) {
    alert('Erreur mise à jour : ' + error.message);
    return;
  }
  articleEl.remove();
  if (!requestsList.querySelector('.request-card')) {
    requestsList.innerHTML = '<div class="empty-state">Aucune demande pour le moment.</div>';
  }
}

// ----- Now Playing -----

async function setNowPlaying(row, articleEl) {
  const btn = articleEl.querySelector('[data-action="play"]');
  btn.disabled = true;
  try {
    // Delete the current now_playing row(s) using a date filter
    await supabase.from('now_playing').delete().gte('started_at', '1970-01-01');
    const { error } = await supabase.from('now_playing').insert({
      spotify_track_id: row.spotify_id ?? null,
      title: row.title,
      artist: row.artist,
      image_url: row.album_art ?? null,
    });
    if (error) throw error;
    // Feedback visuel
    btn.textContent = '▶️';
    setTimeout(() => { btn.textContent = '▶'; btn.disabled = false; }, 2000);
  } catch (err) {
    console.error('Erreur now_playing :', err);
    btn.disabled = false;
    alert('Impossible de mettre à jour le morceau en cours.');
  }
}

function handleRealtimeChange() {
  loadRequests();
}

// ----- Score volume (lecture seule, fenêtre 2 min) -----

async function loadVolumeScore() {
  try {
    const score = await fetchVolumeScore();
    if (volScoreAdmin) volScoreAdmin.textContent = (score > 0 ? '+' : '') + score;
  } catch (err) {
    console.error('Erreur score volume admin :', err);
  }
}

init();
