// Contrôleur principal de la page invité (index.html).

console.log('GROG app.js chargé');

import { searchTracks } from './spotify.js';
import { submitRequest, fetchPendingRequests, subscribeToQueue, getSessionId } from './queue.js';
import { castVote, hasVoted, getVote } from './votes.js';
import { supabase } from './supabase.js';
import { escHtml } from './utils.js';

// ----- Sélecteurs DOM -----
const guestNameInput = document.getElementById('guest-name');
const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const searchResults = document.getElementById('search-results');
const queueList = document.getElementById('queue-list');
const volUp = document.getElementById('vol-up');
const volDown = document.getElementById('vol-down');

// ----- Recherche Spotify -----

async function handleSearch() {
  const query = searchInput.value.trim();
  if (!query) return;

  searchResults.innerHTML = '<p class="muted">Recherche en cours…</p>';
  try {
    const tracks = await searchTracks(query);
    renderResults(tracks);
  } catch (err) {
    console.error('Erreur recherche Spotify :', err);
    searchResults.innerHTML = `<div class="empty-state error-state">Impossible de rechercher les morceaux. Réessaie dans un instant.</div>`;
  }
}

/**
 * @param {import('./spotify.js').Track[]} tracks
 */
function renderResults(tracks) {
  if (!tracks.length) {
    searchResults.innerHTML = '<div class="empty-state">Aucun résultat.</div>';
    return;
  }

  searchResults.innerHTML = '';
  for (const track of tracks) {
    const article = document.createElement('article');
    article.className = 'request-card';
    article.innerHTML = `
      ${track.albumArt ? `<img class="cover" src="${escHtml(track.albumArt)}" alt="pochette" width="56" height="56" loading="lazy">` : '<div class="cover placeholder" aria-hidden="true"></div>'}
      <div class="request-info">
        <strong>${escHtml(track.title)}</strong>
        <span class="muted">${escHtml(track.artist)}</span>
      </div>
      <button type="button" class="primary request-btn" data-id="${escHtml(track.id)}">Demander</button>
    `;
    article.querySelector('.request-btn').addEventListener('click', () => onRequestClick(track, article));
    searchResults.appendChild(article);
  }
}

async function onRequestClick(track, articleEl) {
  const btn = articleEl.querySelector('.request-btn');
  btn.disabled = true;
  btn.textContent = '…';
  const guestName = guestNameInput ? guestNameInput.value.trim() : '';
  try {
    await submitRequest(track, guestName);
    btn.textContent = '✓ Demandé';
    btn.classList.replace('primary', 'secondary');
  } catch (err) {
    console.error('Erreur demande :', err);
    btn.disabled = false;
    btn.textContent = 'Demander';
    searchResults.insertAdjacentHTML(
      'afterend',
      `<p class="muted error-state">Impossible de soumettre la demande. Réessaie.</p>`
    );
  }
}

// ----- File d'attente en temps réel -----

async function loadQueue() {
  try {
    const rows = await fetchPendingRequests();
    renderQueue(rows);
  } catch (err) {
    console.error('Erreur chargement file :', err);
    queueList.innerHTML = '<div class="empty-state error-state">Impossible de charger les demandes.</div>';
  }
}

function renderQueue(rows) {
  if (!rows.length) {
    queueList.innerHTML = '<div class="empty-state">Aucune demande pour le moment.</div>';
    return;
  }
  queueList.innerHTML = '';
  for (const row of rows) {
    queueList.appendChild(buildQueueItem(row));
  }
}

function buildQueueItem(row) {
  const article = document.createElement('article');
  article.className = 'request-card';
  article.dataset.id = row.id;
  const count = row.request_count ?? 1;
  const nameHtml = row.guest_name ? ` <span class="muted guest-name">— ${escHtml(row.guest_name)}</span>` : '';
  article.innerHTML = `
    ${row.album_art ? `<img class="cover" src="${escHtml(row.album_art)}" alt="pochette" width="56" height="56" loading="lazy">` : '<div class="cover placeholder" aria-hidden="true"></div>'}
    <div class="request-info">
      <strong>${escHtml(row.title)}</strong>${nameHtml}
      <span class="muted">${escHtml(row.artist)}</span>
    </div>
    ${count > 1 ? `<span class="vote-count">${count}×</span>` : ''}
  `;
  return article;
}

function handleRealtimeChange() {
  loadQueue();
}

// ----- Votes volume -----

function updateVolumeUI() {
  if (hasVoted()) {
    const dir = getVote();
    volUp.disabled = true;
    volDown.disabled = true;
    volUp.classList.toggle('voted', dir === 'up');
    volDown.classList.toggle('voted', dir === 'down');
  }
}

async function handleVolClick(direction) {
  const voted = castVote(direction);
  if (!voted) return;
  updateVolumeUI();
  // Persister le vote dans Supabase pour que l'admin puisse voir les totaux
  try {
    await supabase.from('volume_votes').insert({ direction, session_id: getSessionId() });
  } catch (err) {
    console.error('Erreur vote volume :', err);
  }
}

// ----- Bootstrap -----

searchBtn.addEventListener('click', handleSearch);
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSearch(); });

volUp.addEventListener('click', () => handleVolClick('up'));
volDown.addEventListener('click', () => handleVolClick('down'));

updateVolumeUI();
loadQueue();
subscribeToQueue(handleRealtimeChange);
