import { searchTracks } from './spotify.js';

import {
  fetchPendingRequests,
  submitRequest,
  subscribeToQueue
} from './queue.js';

import { supabase } from './supabase.js';


const searchInput =
  document.getElementById('spotify-search');

const searchButton =
  document.getElementById('search-button');

const searchResults =
  document.getElementById('search-results');

const searchStatus =
  document.getElementById('search-status');

const requestList =
  document.getElementById('request-list');

const guestName =
  document.getElementById('guest-name');

const louderButton =
  document.getElementById('louder-button');

const quieterButton =
  document.getElementById('quieter-button');

const volumeStatus =
  document.getElementById('volume-status');


/* -------------------------
   IDENTIFIANT ANONYME
------------------------- */

function getVoterId() {

  let id = localStorage.getItem('grog_voter_id');

  if (!id) {

    id = crypto.randomUUID();

    localStorage.setItem(
      'grog_voter_id',
      id
    );
  }

  return id;
}


/* -------------------------
   NOM FACULTATIF
------------------------- */

const savedName =
  localStorage.getItem('grog_guest_name');

if (savedName) {
  guestName.value = savedName;
}

guestName.addEventListener(
  'input',
  () => {

    localStorage.setItem(
      'grog_guest_name',
      guestName.value.trim()
    );

  }
);


/* -------------------------
   RECHERCHE SPOTIFY
------------------------- */

async function runSearch() {

  const query =
    searchInput.value.trim();

  if (!query) return;

  searchStatus.textContent =
    'Recherche...';

  searchResults.innerHTML = '';

  try {

    const tracks =
      await searchTracks(query);

    searchStatus.textContent =
      tracks.length
        ? ''
        : 'Aucun résultat.';

    tracks.forEach(track => {

      const card =
        document.createElement('div');

      card.className =
        'request-card';

      card.innerHTML = `
        ${
          track.image_url
            ? `<img
                src="${track.image_url}"
                alt=""
                width="70"
                height="70"
              >`
            : ''
        }

        <div class="request-info">
          <strong></strong>
          <p class="muted"></p>
        </div>

        <button
          type="button"
          class="primary"
        >
          Demander
        </button>
      `;

      card.querySelector('strong')
        .textContent = track.title;

      card.querySelector('p')
        .textContent = track.artist;

      card
        .querySelector('button')
        .addEventListener(
          'click',
          async event => {

            const button =
              event.currentTarget;

            button.disabled = true;

            button.textContent =
              'Ajout...';

            try {

              const result =
                await submitRequest(
                  track,
                  guestName.value.trim()
                );

              button.textContent =
                result.existing
                  ? 'Demande ajoutée +1'
                  : 'Demandé ✓';

              await loadRequests();

            } catch (error) {

              console.error(error);

              button.disabled = false;

              button.textContent =
                'Erreur';

            }

          }
        );

      searchResults.appendChild(card);

    });

  } catch (error) {

    console.error(error);

    searchStatus.textContent =
      'Erreur pendant la recherche Spotify.';

  }

}


searchButton.addEventListener(
  'click',
  runSearch
);

searchInput.addEventListener(
  'keydown',
  event => {

    if (event.key === 'Enter') {
      runSearch();
    }

  }
);


/* -------------------------
   LISTE DES DEMANDES
------------------------- */

async function loadRequests() {

  try {

    const requests =
      await fetchPendingRequests();

    requestList.innerHTML = '';

    if (!requests.length) {

      requestList.innerHTML =
        '<p class="muted">Aucun morceau demandé pour le moment.</p>';

      return;

    }

    requests.forEach(item => {

      const card =
        document.createElement('div');

      card.className =
        'request-card';

      if (item.image_url) {

        const img =
          document.createElement('img');

        img.src =
          item.image_url;

        img.alt = '';

        img.width = 64;
        img.height = 64;

        card.appendChild(img);

      }

      const info =
        document.createElement('div');

      info.className =
        'request-info';

      const title =
        document.createElement('strong');

      title.textContent =
        item.title;

      const artist =
        document.createElement('p');

      artist.className =
        'muted';

      artist.textContent =
        item.artist;

      const count =
        document.createElement('p');

      count.className =
        'muted';

      count.textContent =
        item.request_count > 1
          ? `🔥 ${item.request_count} demandes`
          : '🔥 1 demande';

      info.appendChild(title);
      info.appendChild(artist);
      info.appendChild(count);

      card.appendChild(info);

      requestList.appendChild(card);

    });

  } catch (error) {

    console.error(error);

    requestList.innerHTML =
      '<p class="muted">Impossible de charger les demandes.</p>';

  }

}


/* -------------------------
   VOTE VOLUME
------------------------- */

async function castVolumeVote(vote) {

  const voterId =
    getVoterId();

  const existingVote =
    localStorage.getItem(
      'grog_volume_vote'
    );

  if (existingVote) {

    volumeStatus.textContent =
      'Tu as déjà donné ton avis 👍';

    return;

  }

  const { error } =
    await supabase
      .from('volume_votes')
      .insert({
        voter_id: voterId,
        vote
      });

  if (error) {

    console.error(error);

    volumeStatus.textContent =
      'Impossible d’enregistrer ton vote.';

    return;

  }

  localStorage.setItem(
    'grog_volume_vote',
    vote
  );

  volumeStatus.textContent =
    vote === 'louder'
      ? '🔊 Demande “plus fort” envoyée !'
      : '🔉 Demande “moins fort” envoyée !';

}


louderButton.addEventListener(
  'click',
  () => castVolumeVote('louder')
);

quieterButton.addEventListener(
  'click',
  () => castVolumeVote('quieter')
);


/* -------------------------
   REALTIME
------------------------- */

subscribeToQueue(
  loadRequests
);

loadRequests();
