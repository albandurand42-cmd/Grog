// Couche d'accès à l'API Spotify.
// Les invités n'ont pas besoin de s'authentifier : un token est obtenu
// via la Supabase Edge Function configurée dans config.js.

import { SPOTIFY_TOKEN_PROXY_URL } from './config.js';

/** @type {string|null} */
let _cachedToken = null;
/** @type {number} Token expiry (ms since epoch) */
let _tokenExpiry = 0;

/**
 * Récupère un token Spotify valide via le proxy Edge Function.
 * Le token est mis en cache jusqu'à expiration.
 * @returns {Promise<string>}
 */
async function getToken() {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;

  const res = await fetch(SPOTIFY_TOKEN_PROXY_URL, { method: 'POST' });
  if (!res.ok) throw new Error(`Token proxy error: ${res.status}`);

  const { access_token, expires_in } = await res.json();
  _cachedToken = access_token;
  // Expire 60 s avant la date réelle pour éviter les courses
  _tokenExpiry = Date.now() + (expires_in - 60) * 1000;
  return _cachedToken;
}

/**
 * @typedef {Object} Track
 * @property {string} id          Spotify track ID
 * @property {string} uri         Spotify URI (spotify:track:…)
 * @property {string} title       Nom du morceau
 * @property {string} artist      Artiste(s) — joint par ", "
 * @property {string|null} albumArt URL de la pochette (640px)
 */

/**
 * Recherche des morceaux sur Spotify.
 * @param {string} query
 * @param {number} [limit=10]
 * @returns {Promise<Track[]>}
 */
export async function searchTracks(query, limit = 10) {
  if (!query.trim()) return [];

  const token = await getToken();
  const params = new URLSearchParams({ q: query, type: 'track', limit: String(limit) });
  const res = await fetch(`https://api.spotify.com/v1/search?${params}`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error(`Spotify search error: ${res.status}`);

  const data = await res.json();
  return (data.tracks?.items ?? []).map((item) => ({
    id: item.id,
    uri: item.uri,
    title: item.name,
    artist: item.artists.map((a) => a.name).join(', '),
    albumArt: item.album.images?.[0]?.url ?? null,
  }));
}
