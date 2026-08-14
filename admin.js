// Contrôleur de la page admin DJ (admin.html).
// Gère l'authentification Spotify PKCE, la lecture, les demandes invités et les votes volume.

import { startPKCE, handleCallback, getStoredTokens, logout } from './auth.js';
import { fetchPendingRequests, subscribeToQueue } from './queue.js';
import { supabase } from './supabase.js';
import { escHtml } from './utils.js';

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
const volDownCount = document.getElementById('vol-down-count');
const volUpCount = document.getElementById('vol-up-count');
const btnResetVotes = document.getElementById('btn-reset-votes');

let accessToken = null;

// ----- Auth -----

async function init() {
  // Gérer le retour du callback Spotify PKCE
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
  loadVoteCounts();
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
  const rows = await fetchPendingRequests();
  renderRequests(rows);
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
  article.innerHTML = `
    ${row.album_art ? `<img class="cover" src="${escHtml(row.album_art)}" alt="pochette" width="56" height="56" loading="lazy">` : '<div class="cover placeholder" aria-hidden="true"></div>'}
    <div class="request-info">
      <strong>${escHtml(row.title)}</strong>
      <span class="muted">${escHtml(row.artist)}</span>
    </div>
    <span class="vote-count">${row.request_count ?? 1}×</span>
    <button type="button" class="badge-accept" data-action="accept">✓</button>
    <button type="button" class="badge-reject" data-action="reject">✕</button>
  `;
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

function handleRealtimeChange() {
  loadRequests();
}

// ----- Votes volume -----

async function loadVoteCounts() {
  const { data } = await supabase
    .from('volume_votes')
    .select('direction, count:id.count()')
    .order('direction');

  if (!data) return;
  for (const row of data) {
    if (row.direction === 'down') volDownCount.textContent = '👇 ' + row.count;
    if (row.direction === 'up') volUpCount.textContent = '👆 ' + row.count;
  }
}

btnResetVotes.addEventListener('click', async () => {
  if (!confirm('Réinitialiser tous les votes volume ?')) return;
  // Supprimer toutes les lignes de la table volume_votes via une RPC dédiée.
  // La condition `neq('id', NIL_UUID)` est un filtre universel car Supabase
  // n'expose pas DELETE sans filtre via l'API REST cliente.
  await supabase.from('volume_votes').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await supabase
    .channel('admin-reset')
    .send({ type: 'broadcast', event: 'reset_votes', payload: {} });
  volDownCount.textContent = '👇 0';
  volUpCount.textContent = '👆 0';
});

init();
