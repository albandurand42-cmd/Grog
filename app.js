// Contrôleur principal de la page invité (index.html).

import { searchTracks } from './spotify.js';
import { submitRequest, fetchPendingRequests, subscribeToQueue, getSessionId } from './queue.js';
import { canVote, recordVote, fetchVolumeScore } from './votes.js';
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
const volScore = document.getElementById('vol-score');
const volHint = document.getElementById('vol-hint');
const nowPlayingDisplay = document.getElementById('now-playing-display');

// Comment DOM
const commentMessageInput = document.getElementById('comment-message');
const btnSendComment = document.getElementById('btn-send-comment');
const commentFeedback = document.getElementById('comment-feedback');
const commentCharCount = document.getElementById('comment-char-count');

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
  // Remove any previous error message
  const prevErr = searchResults.nextElementSibling;
  if (prevErr && prevErr.classList.contains('error-state')) prevErr.remove();
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
      `<p class="muted error-state">Impossible d'ajouter cette musique. Réessaie.</p>`
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

// ----- Votes volume (fenêtre glissante 2 min) -----

async function loadVolumeScore() {
  try {
    const score = await fetchVolumeScore();
    renderVolumeScore(score);
  } catch (err) {
    console.error('Erreur chargement score volume :', err);
  }
}

function renderVolumeScore(score) {
  const sign = score > 0 ? '+' : '';
  volScore.textContent = sign + score;
  if (score > 0) {
    volHint.textContent = 'Le public demande un peu plus fort';
  } else if (score < 0) {
    volHint.textContent = 'Le public demande un peu moins fort';
  } else {
    volHint.textContent = 'Le volume semble bon';
  }
}

async function handleVolClick(value) {
  if (!canVote()) return;
  recordVote();
  // Feedback visuel immédiat
  const btn = value > 0 ? volUp : volDown;
  btn.disabled = true;
  setTimeout(() => { btn.disabled = false; }, 2000);
  try {
    const { error } = await supabase
      .from('volume_votes')
      .insert({ value, session_id: getSessionId() });
    if (error) throw error;
    await loadVolumeScore();
  } catch (err) {
    console.error('Erreur vote volume :', err);
    btn.disabled = false;
    alert('Impossible d\'envoyer ton vote.');
  }
}

// Refresh périodique du score (fenêtre glissante)
setInterval(loadVolumeScore, 8000);

// Realtime sur volume_votes
supabase
  .channel('public:volume_votes')
  .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'volume_votes' }, () => loadVolumeScore())
  .subscribe();

// ----- Now Playing -----

let _currentTrackId = null; // Stocke l'ID du morceau actuellement affiché

async function loadNowPlaying() {
  try {
    const { data, error } = await supabase
      .from('now_playing')
      .select('spotify_track_id, title, artist, image_url')
      .order('id', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    console.log('[now_playing] Données reçues :', data);
    renderNowPlaying(data);
  } catch (err) {
    console.error('Erreur chargement morceau en cours :', err);
    nowPlayingDisplay.innerHTML = '<div class="empty-state error-state">Impossible de charger le morceau en cours.</div>';
  }
}

function renderNowPlaying(data) {
  if (!data) {
    nowPlayingDisplay.innerHTML = '<div class="empty-state">Le DJ n\'a pas encore renseigné le morceau en cours.</div>';
    _currentTrackId = null;
    return;
  }
  
  // Mettre à jour uniquement si le morceau a changé
  if (_currentTrackId === data.spotify_track_id) {
    return; // Aucun changement, ne pas refaire le DOM
  }
  
  _currentTrackId = data.spotify_track_id;
  nowPlayingDisplay.innerHTML = `
    <div class="np-public-card">
      ${data.image_url
        ? `<img class="np-public-cover" src="${escHtml(data.image_url)}" alt="pochette" width="72" height="72" loading="lazy">`
        : '<div class="np-public-cover placeholder" aria-hidden="true"></div>'}
      <div class="np-public-info">
        <strong class="np-public-title">${escHtml(data.title)}</strong>
        <span class="muted">${escHtml(data.artist)}</span>
      </div>
    </div>
  `;
}

// Realtime now_playing (méthode principale)
supabase
  .channel('public:now_playing')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'now_playing' }, (payload) => {
    console.log('[now_playing] Realtime event :', payload);
    // Utiliser directement payload.new si disponible
    if (payload.new && payload.new.title) {
      renderNowPlaying(payload.new);
    } else {
      loadNowPlaying();
    }
  })
  .subscribe((status) => console.log('[now_playing] Realtime subscribe status :', status));

// Fallback de sécurité : vérifier toutes les 2 secondes
setInterval(loadNowPlaying, 2000);

// ----- Bootstrap -----

searchBtn.addEventListener('click', handleSearch);
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSearch(); });

volUp.addEventListener('click', () => handleVolClick(1));
volDown.addEventListener('click', () => handleVolClick(-1));

// ----- Commentaires -----

const COMMENT_MAX = 160;
const NAME_MAX = 30;

if (commentMessageInput) {
  commentMessageInput.addEventListener('input', () => {
    const len = commentMessageInput.value.length;
    if (commentCharCount) commentCharCount.textContent = len;
  });
}

if (btnSendComment) {
  btnSendComment.addEventListener('click', handleSendComment);
}

async function handleSendComment() {
  if (!commentMessageInput) return;
  const message = commentMessageInput.value.trim().slice(0, COMMENT_MAX);
  const rawName = guestNameInput ? guestNameInput.value.trim() : '';
  const guest_name = rawName ? rawName.slice(0, NAME_MAX) : null;

  btnSendComment.disabled = true;
  btnSendComment.textContent = '…';
  try {
    const { error } = await supabase
      .from('comments')
      .insert({ guest_name, message, status: 'pending' });
    if (error) throw error;
    showCommentFeedback('Commentaire envoyé au DJ 👍', true);
    commentMessageInput.value = '';
    if (commentCharCount) commentCharCount.textContent = '0';
  } catch (err) {
    console.error('Erreur envoi commentaire :', err);
    showCommentFeedback('Impossible d\'envoyer le commentaire. Réessaie.', false);
  } finally {
    btnSendComment.disabled = false;
    btnSendComment.textContent = 'Envoyer';
  }
}

function showCommentFeedback(msg, success) {
  if (!commentFeedback) return;
  commentFeedback.textContent = msg;
  commentFeedback.style.color = success ? 'var(--accent-2)' : '#f87171';
  setTimeout(() => { commentFeedback.textContent = ''; }, 4000);
}

loadNowPlaying();
loadQueue();
loadVolumeScore();
subscribeToQueue(handleRealtimeChange);
