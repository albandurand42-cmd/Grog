// Contrôleur de la page admin DJ (admin.html).
// Gère l'authentification Spotify PKCE, la lecture, les demandes invités, les votes volume et now_playing.

import { startPKCE, handleCallback, getStoredTokens, logout, refreshAccessToken } from './auth.js';
import { fetchPendingRequests, subscribeToQueue } from './queue.js';
import { APP_VERSION } from './config.js';
import { supabase } from './supabase.js';
import { escHtml } from './utils.js';
import { fetchVolumeScore } from './votes.js';
import { requestAutoDjSuggestions, verifySuggestionsOnSpotify, renderAutoDjSuggestions, recordSuggestionsToHistory, markSuggestionAsPlayed } from './autoDJ.js';

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
const autoDjList = document.getElementById('auto-dj-list');
const btnAutoDjRefresh = document.getElementById('btn-auto-dj-refresh');
const autoDjDirBtns = document.querySelectorAll('.auto-dj-dir-btn');
const autoDjEnabledSwitch = document.getElementById('auto-dj-enabled');
const autoDjBody = document.getElementById('auto-dj-body');
const autoDjInstructionInput = document.getElementById('auto-dj-instruction');
const btnApplyInstruction = document.getElementById('auto-dj-apply-instruction');
const btnClearInstruction = document.getElementById('auto-dj-clear-instruction');
const appVersionEl = document.getElementById('app-version');

let _autoDjDirection = document.querySelector('.auto-dj-dir-btn.active')?.dataset?.dir ?? 'up';
let _autoDjEnabled = localStorage.getItem('grog_auto_dj_enabled') !== 'false';
let _autoDjInstruction = localStorage.getItem('grog_auto_dj_instruction') ?? '';

let _lastHistoryTrackId = null;
let _lastAutoDjTrackId = null;
let _autoDjLoading = false;
let _autoDjTimer = null;
let _pendingAutoDjReason = null;

let accessToken = null;
let _lastSyncedTrackId = null;
let _lastSyncedIsPlaying = null;
let _lastPeriodicWrite = 0;
let _syncInterval = null;
const PERIODIC_WRITE_MS = 8000;

if (appVersionEl) {
  appVersionEl.textContent = `GROG v${APP_VERSION}`;
}

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

function setAutoDjDirection(direction) {
  _autoDjDirection = direction === 'down' ? 'down' : 'up';
  autoDjDirBtns.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.dir === _autoDjDirection);
  });
}

function updateAutoDjVisibility() {
  if (!autoDjBody) return;
  autoDjBody.style.display = _autoDjEnabled ? '' : 'none';
}

function scheduleAutoDjRefresh(reason = 'manual') {
  if (!_autoDjEnabled) {
    console.log('[AUTO-DJ] schedule blocked: disabled');
    return;
  }

  if (_autoDjTimer) {
    clearTimeout(_autoDjTimer);
    _autoDjTimer = null;
  }

  if (_autoDjLoading) {
    _pendingAutoDjReason = reason;
    if (autoDjList) autoDjList.innerHTML = '<p class="muted">Analyse en cours...</p>';
    return;
  }

  refreshAutoDjSuggestions(reason);
}

function setAuthUI(connected) {
  authStatus.textContent = connected ? 'Connecté' : 'Hors connexion';
  authStatus.style.background = connected ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.1)';
  btnPlay.disabled = !connected;
  btnPause.disabled = !connected;
  btnPrev.disabled = !connected;
  btnNext.disabled = !connected;
  if (connected) controlsNote.textContent = '';
  else setSyncStatus('disconnected');
}

async function loadCurrentUser() {
  if (!accessToken) return;
  try {
    const res = await fetch('https://api.spotify.com/v1/me', { headers: { Authorization: 'Bearer ' + accessToken } });
    if (!res.ok) return;
    const user = await res.json();
    connectedUser.textContent = user.display_name || user.id;
  } catch {
    // silently ignore
  }
}

async function buildDjProfile() {
  try {
    const [historyResult, suggestionsResult] = await Promise.all([
      supabase
        .from('play_history')
        .select('spotify_track_id, title, artist, played_at')
        .order('played_at', { ascending: false })
        .limit(100),
      supabase
        .from('suggestion_history')
        .select('spotify_track_id, title, artist, was_played, suggested_at')
        .order('suggested_at', { ascending: false })
        .limit(200),
    ]);

    const history = historyResult.data ?? [];
    const suggestions = suggestionsResult.data ?? [];

    // Top artists from play history
    const artistPlayCount = new Map();
    for (const t of history) {
      const key = String(t.artist ?? '').trim();
      if (key) artistPlayCount.set(key, (artistPlayCount.get(key) || 0) + 1);
    }
    const topArtists = [...artistPlayCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([artist, count]) => ({ artist, count }));

    // Top tracks from play history
    const trackPlayCount = new Map();
    for (const t of history) {
      const key = `${String(t.title ?? '').trim()}::${String(t.artist ?? '').trim()}`;
      if (key !== '::') trackPlayCount.set(key, { title: t.title, artist: t.artist, count: (trackPlayCount.get(key)?.count || 0) + 1 });
    }
    const topTracks = [...trackPlayCount.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Ignored artists: suggested but never played
    const artistSuggested = new Map();
    const artistPlayed = new Map();
    for (const s of suggestions) {
      const key = String(s.artist ?? '').trim();
      if (!key) continue;
      artistSuggested.set(key, (artistSuggested.get(key) || 0) + 1);
      if (s.was_played) artistPlayed.set(key, (artistPlayed.get(key) || 0) + 1);
    }
    const ignoredArtists = [...artistSuggested.entries()]
      .filter(([artist]) => !(artistPlayed.get(artist) > 0))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([artist, ignored]) => ({ artist, ignored }));

    // Overall ratio
    const totalSuggested = suggestions.length;
    const totalPlayed = suggestions.filter((s) => s.was_played).length;
    const playRatio = totalSuggested > 0 ? Math.round((totalPlayed / totalSuggested) * 100) : null;

    return {
      top_artists: topArtists,
      top_tracks: topTracks,
      ignored_artists: ignoredArtists,
      total_suggestions: totalSuggested,
      total_played: totalPlayed,
      play_ratio_pct: playRatio,
    };
  } catch (err) {
    console.warn('[AUTO-DJ] buildDjProfile error:', err?.message ?? String(err));
    return null;
  }
}

async function refreshAutoDjSuggestions(reason = 'manual') {
  if (!_autoDjEnabled) {
    console.log('[AUTO-DJ] refresh blocked: disabled');
    return;
  }
  if (_autoDjLoading) {
    _pendingAutoDjReason = reason;
    if (autoDjList) autoDjList.innerHTML = '<p class="muted">Analyse en cours...</p>';
    return;
  }
  _autoDjLoading = true;

  try {
    if (autoDjList) autoDjList.innerHTML = '<p class="muted">Analyse en cours...</p>';
    if (btnAutoDjRefresh) btnAutoDjRefresh.disabled = true;

    const { data: nowPlaying, error: nowErr } = await supabase
      .from('now_playing')
      .select('spotify_track_id, title, artist, album')
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (nowErr) throw nowErr;

    const { data: recentTracksRaw, error: recentErr } = await supabase
      .from('play_history')
      .select('spotify_track_id, title, artist, played_at')
      .order('played_at', { ascending: false })
      .limit(10);
    if (recentErr) throw recentErr;
    const recentTracks = [...(recentTracksRaw ?? [])].reverse();

    const { data: requestsRaw, error: reqErr } = await supabase
      .from('song_requests')
      .select('title, artist, request_count, status')
      .eq('status', 'pending')
      .order('request_count', { ascending: false });
    if (reqErr) throw reqErr;

    const requests = (requestsRaw ?? []).map((r) => ({
      title: r.title,
      artist: r.artist,
      votes: Number(r.request_count ?? 1),
    }));

    const { data: recentSuggestionsRaw, error: suggestErr } = await supabase
      .from('suggestion_history')
      .select('spotify_track_id, title, artist, was_played')
      .order('suggested_at', { ascending: false })
      .limit(30);
    if (suggestErr) console.warn('[AUTO-DJ] recent suggestions query warning:', suggestErr.message);
    const recentSuggestions = recentSuggestionsRaw ?? [];

    const djProfile = await buildDjProfile();

    const payload = {
      now_playing: {
        spotify_track_id: nowPlaying?.spotify_track_id ?? '',
        title: nowPlaying?.title ?? '',
        artist: nowPlaying?.artist ?? '',
      },
      recent_tracks: recentTracks.map((t) => ({
        spotify_track_id: t.spotify_track_id ?? '',
        title: t.title ?? '',
        artist: t.artist ?? '',
        played_at: t.played_at ?? null,
      })),
      requests,
      dj_context: {
        direction: _autoDjDirection,
        instruction: _autoDjInstruction,
      },
      ...(djProfile ? { dj_profile: djProfile } : {}),
    };

    console.log('[AUTO-DJ] context sent:', payload.dj_context);
    console.log('[AUTO-DJ] payload instruction exact:', payload.dj_context.instruction);
    const aiSuggestions = await requestAutoDjSuggestions(payload);

    const verified = await verifySuggestionsOnSpotify(aiSuggestions, {
      nowPlaying: nowPlaying ?? null,
      recentTracks: recentTracks ?? [],
      requests,
      recentSuggestions,
      instruction: _autoDjInstruction,
    });
    console.log('[AUTO-DJ] spotify verified', verified);

    renderAutoDjSuggestions(autoDjList, verified);

    const generationId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await recordSuggestionsToHistory(verified.suggestions, generationId, {
      direction: _autoDjDirection,
      context_style: aiSuggestions?.analysis?.current_style ?? null,
    });

    console.log('[AUTO-DJ] suggestions refreshed:', reason, 'count=', verified.suggestions?.length ?? 0);
  } catch (err) {
    console.error('[AUTO-DJ] refresh error', err);
    if (autoDjList) autoDjList.innerHTML = '<div class="empty-state error-state">Impossible de générer les suggestions.</div>';
  } finally {
    _autoDjLoading = false;
    if (btnAutoDjRefresh) btnAutoDjRefresh.disabled = false;

    if (_pendingAutoDjReason) {
      const pendingReason = _pendingAutoDjReason;
      _pendingAutoDjReason = null;
      scheduleAutoDjRefresh(pendingReason);
    }
  }
}

async function addTrackToPlayHistoryIfNeeded(track) {
  if (!track?.spotify_track_id) return;
  if (_lastHistoryTrackId === track.spotify_track_id) return;

  _lastHistoryTrackId = track.spotify_track_id;

  try {
    const { error } = await supabase.from('play_history').insert({
      spotify_track_id: track.spotify_track_id,
      title: track.title ?? 'Titre inconnu',
      artist: track.artist ?? 'Artiste inconnu',
      played_at: new Date().toISOString(),
    });
    if (error) console.warn('[AUTO-DJ] play_history insert warning:', error.message);
  } catch (err) {
    console.warn('[AUTO-DJ] play_history insert exception:', err?.message ?? String(err));
  }
}

function triggerAutoDjOnTrackChange(track) {
  if (!track?.spotify_track_id) return;
  if (_lastAutoDjTrackId === track.spotify_track_id) return; // 1 appel IA max / changement

  _lastAutoDjTrackId = track.spotify_track_id;

  if (!_autoDjEnabled) return; // OFF : pas d'appel IA automatique

  if (_autoDjTimer) clearTimeout(_autoDjTimer);
  _autoDjTimer = setTimeout(() => {
    _autoDjTimer = null;
    scheduleAutoDjRefresh('track_change');
  }, 1500);
}

function handleManualAutoDjRefresh() {
  console.log('[AUTO-DJ] manual refresh click');
  refreshAutoDjSuggestions('manual_click');
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

async function spotifyFetch(url) {
  let res = await fetch(url, { headers: { Authorization: 'Bearer ' + accessToken } });
  if (res.status === 401) {
    const newToken = await refreshAccessToken();
    if (!newToken) {
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

async function spotifyControl(endpoint, method = 'POST') {
  if (!accessToken) return;
  await fetch('https://api.spotify.com/v1/me/player/' + endpoint, { method, headers: { Authorization: 'Bearer ' + accessToken } });
}

btnPlay.addEventListener('click', () => spotifyControl('play', 'PUT'));
btnPause.addEventListener('click', () => spotifyControl('pause', 'PUT'));
btnPrev.addEventListener('click', () => spotifyControl('previous'));
btnNext.addEventListener('click', () => spotifyControl('next'));

function setSyncStatus(status) {
  if (!syncStatus) return;
  const labels = {
    playing: '🟢 Spotify synchronisé',
    paused: '⏸ Spotify en pause',
    idle: '⚠ Aucun lecteur Spotify actif',
    disconnected: '🔴 Connexion Spotify nécessaire',
  };
  syncStatus.textContent = labels[status] ?? status;
}

function startSpotifySync() {
  if (_syncInterval) return;
  syncNowPlaying();
  _syncInterval = setInterval(syncNowPlaying, 500);
}

function stopSpotifySync() {
  if (_syncInterval) {
    clearInterval(_syncInterval);
    _syncInterval = null;
  }
  _lastSyncedTrackId = null;
  setSyncStatus('disconnected');
}

async function syncNowPlaying() {
  if (!accessToken) return;

  let res;
  try {
    res = await spotifyFetch('https://api.spotify.com/v1/me/player/currently-playing');
  } catch (err) {
    console.error('Erreur sync Spotify :', err);
    return;
  }

  if (!res) return;
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

const now = Date.now();
const trackChanged = track.spotify_track_id !== _lastSyncedTrackId;
const playStateChanged = track.is_playing !== _lastSyncedIsPlaying;
const periodicDue = now - _lastPeriodicWrite >= PERIODIC_WRITE_MS;

if (trackChanged) {
  _lastSyncedTrackId = track.spotify_track_id;

  await addTrackToPlayHistoryIfNeeded(track);
  await markSuggestionAsPlayed(track.spotify_track_id);
  triggerAutoDjOnTrackChange(track);
}

if (!trackChanged && !playStateChanged && !periodicDue) return;

_lastSyncedIsPlaying = track.is_playing;
_lastPeriodicWrite = now;

await writeNowPlayingToSupabase(track);
}

async function writeNowPlayingToSupabase(track) {
  try {
    console.log('[ADMIN SPOTIFY] track object:', { title: track.title, duration_ms: track.duration_ms, progress_ms: track.progress_ms, is_playing: track.is_playing });
    const { error: delErr } = await supabase.from('now_playing').delete().not('id', 'is', null);
    if (delErr) console.warn('[now_playing] Erreur delete :', delErr);
    const insertPayload = {
      spotify_track_id: track.spotify_track_id,
      title: track.title,
      artist: track.artist,
      album: track.album,
      image_url: track.image_url,
      duration_ms: track.duration_ms,
      progress_ms: track.progress_ms,
      is_playing: track.is_playing,
      synced_at: new Date().toISOString(),
    };
    console.log('[ADMIN INSERT] payload:', insertPayload);
    const { data, error } = await supabase.from('now_playing').insert(insertPayload).select();
    if (error) throw error;
    console.log('[ADMIN NOW_PLAYING]', {
      title: data[0]?.title,
      duration_ms: data[0]?.duration_ms,
      progress_ms: data[0]?.progress_ms,
      is_playing: data[0]?.is_playing,
    });
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
    const safeUrl = /^https:\/\//.test(track.image_url) ? track.image_url : '';
    if (safeUrl) {
      coverEl.className = 'cover np-cover';
      coverEl.style.backgroundImage = `url('${safeUrl.replace(/'/g, '%27')}')`;
    }
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
  for (const row of rows) requestsList.appendChild(buildRequestItem(row));
}

function buildRequestItem(row) {
  const article = document.createElement('article');
  article.className = 'request-card';
  article.dataset.id = row.id;
  const nameHtml = row.guest_name ? `<span class="muted guest-name">Demandé par ${escHtml(row.guest_name)}</span>` : `<span class="muted guest-name">Anonyme</span>`;
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
  if (!requestsList.querySelector('.request-card')) requestsList.innerHTML = '<div class="empty-state">Aucune demande pour le moment.</div>';
}

async function setNowPlayingManual(row, articleEl) {
  const btn = articleEl.querySelector('[data-action="play"]');
  btn.disabled = true;
  try {
    await supabase.from('now_playing').delete().not('id', 'is', null);
    const { data, error } = await supabase.from('now_playing').insert({
      spotify_track_id: row.spotify_id ?? null,
      title: row.title,
      artist: row.artist,
      album: row.album ?? null,
      image_url: row.album_art ?? null,
      started_at: new Date().toISOString(),
      duration_ms: null,
      progress_ms: 0,
      is_playing: true,
      synced_at: new Date().toISOString(),
    }).select();
    if (error) throw error;
    console.log('[now_playing] Écriture manuelle OK :', data);
    _lastSyncedTrackId = row.spotify_id ?? null;
    _lastSyncedIsPlaying = true;
    _lastPeriodicWrite = Date.now();
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

async function loadVolumeScore() {
  try {
    const score = await fetchVolumeScore();
    if (volScoreAdmin) volScoreAdmin.textContent = (score > 0 ? '+' : '') + score;
  } catch (err) {
    console.error('Erreur score volume admin :', err);
  }
}

init();
setAutoDjDirection(_autoDjDirection);

// Init instruction from localStorage
if (autoDjInstructionInput) {
  autoDjInstructionInput.value = _autoDjInstruction;
}

// Init ON/OFF switch from persisted value
if (autoDjEnabledSwitch) {
  autoDjEnabledSwitch.checked = _autoDjEnabled;
  updateAutoDjVisibility();
  autoDjEnabledSwitch.addEventListener('change', () => {
    _autoDjEnabled = autoDjEnabledSwitch.checked;
    localStorage.setItem(
      'grog_auto_dj_enabled',
      _autoDjEnabled ? 'true' : 'false'
    );
    updateAutoDjVisibility();

    if (!_autoDjEnabled) {
      if (_autoDjTimer) {
        clearTimeout(_autoDjTimer);
        _autoDjTimer = null;
      }
      _pendingAutoDjReason = null;
      return;
    }

    refreshAutoDjSuggestions('enabled');
  });
}

autoDjDirBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    setAutoDjDirection(btn.dataset.dir);
    if (_autoDjEnabled) {
      scheduleAutoDjRefresh(btn.dataset.dir === 'down' ? 'direction_down' : 'direction_up');
    }
  });
});

if (btnAutoDjRefresh) {
  btnAutoDjRefresh.removeEventListener('click', handleManualAutoDjRefresh);
  btnAutoDjRefresh.addEventListener('click', handleManualAutoDjRefresh);
}

// Instruction Apply / Clear
if (btnApplyInstruction) {
  btnApplyInstruction.addEventListener('click', () => {
    _autoDjInstruction = autoDjInstructionInput ? autoDjInstructionInput.value.trim() : '';
    localStorage.setItem('grog_auto_dj_instruction', _autoDjInstruction);
    console.log('[AUTO-DJ] instruction applied:', _autoDjInstruction);
    if (_autoDjEnabled) {
      refreshAutoDjSuggestions('instruction_apply');
    }
  });
}

if (btnClearInstruction) {
  btnClearInstruction.addEventListener('click', () => {
    _autoDjInstruction = '';
    if (autoDjInstructionInput) autoDjInstructionInput.value = '';
    localStorage.removeItem('grog_auto_dj_instruction');
    if (_autoDjEnabled) {
      refreshAutoDjSuggestions('instruction_clear');
    }
  });
}
