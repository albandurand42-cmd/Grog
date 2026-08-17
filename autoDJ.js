import { AUTO_DJ_FUNCTION_URL } from './config.js';
import { searchTracks } from './spotify.js';

export async function requestAutoDjSuggestions(payload) {
  const response = await fetch(AUTO_DJ_FUNCTION_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error || 'Erreur Auto-DJ');
  }

  if (!Array.isArray(data?.suggestions) || data.suggestions.length !== 3) {
    throw new Error('Réponse Auto-DJ invalide');
  }

  return data.suggestions;
}

export async function verifySuggestionsOnSpotify(
  suggestions,
  currentTrackId = null,
  recentTrackIds = []
) {
  const verified = [];

  for (const suggestion of suggestions) {
    const query = `${suggestion.title} ${suggestion.artist}`;

    const results = await searchTracks(query, 5);

    if (!Array.isArray(results) || results.length === 0) continue;

    const best = results.find((track) => {
      if (!track?.id) return false;
      if (track.id === currentTrackId) return false;
      if (recentTrackIds.includes(track.id)) return false;
      return true;
    });

    if (!best) continue;

    verified.push({
      spotify_track_id: best.id,
      title: best.name,
      artist: best.artists?.map((a) => a.name).join(', ') || suggestion.artist,
      albumArt: best.album?.images?.[0]?.url || null,
      uri: best.uri || null,
      externalUrl: best.external_urls?.spotify || null,
      reason: suggestion.reason,
    });

    if (verified.length === 3) break;
  }

  return verified;
}

export function renderAutoDjSuggestions(container, suggestions) {
  if (!container) return;

  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        Aucune suggestion disponible pour le moment.
      </div>
    `;
    return;
  }

  container.innerHTML = suggestions
    .map((s, index) => {
      const cover = s.albumArt
        ? `<img class="auto-dj-cover" src="${s.albumArt}" alt="">`
        : `<div class="auto-dj-cover auto-dj-cover-placeholder">🎵</div>`;

      const spotifyLink = s.externalUrl
        ? `<a
            class="secondary auto-dj-open"
            href="${s.externalUrl}"
            target="_blank"
            rel="noopener"
          >
            Ouvrir dans Spotify
          </a>`
        : '';

      return `
        <article class="auto-dj-suggestion">
          <div class="auto-dj-rank">${index + 1}</div>

          ${cover}

          <div class="auto-dj-info">
            <strong>${escapeHtml(s.title)}</strong>
            <span>${escapeHtml(s.artist)}</span>
            <p>${escapeHtml(s.reason)}</p>
          </div>

          ${spotifyLink}
        </article>
      `;
    })
    .join('');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
