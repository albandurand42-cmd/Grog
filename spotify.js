import { supabase } from './supabase.js';

let cachedToken = null;
let tokenExpiresAt = 0;

async function getSpotifyToken() {
  // Réutilise le token tant qu'il est encore valide
  if (cachedToken && Date.now() < tokenExpiresAt) {
    return cachedToken;
  }

  const { data, error } = await supabase.functions.invoke('spotify-token', {
    body: {}
  });

  if (error) {
    console.error('Erreur Edge Function Spotify :', error);
    throw new Error('Impossible de contacter Spotify');
  }

  if (!data?.access_token) {
    console.error('Réponse Spotify invalide :', data);
    throw new Error('Token Spotify manquant');
  }

  cachedToken = data.access_token;

  // Petite marge de sécurité de 60 secondes
  tokenExpiresAt =
    Date.now() + ((data.expires_in || 3600) - 60) * 1000;

  return cachedToken;
}

export async function searchTracks(query) {
  const search = query.trim();

  if (!search) {
    return [];
  }

  const token = await getSpotifyToken();

  const response = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(search)}&type=track&limit=10`,
    {
      headers: {
        Authorization: `Bearer ${token}`
      }
    }
  );

  if (!response.ok) {
    const error = await response.text();
    console.error('Erreur recherche Spotify :', error);
    throw new Error('La recherche Spotify a échoué');
  }

  const data = await response.json();

  return (data.tracks?.items || []).map(track => ({
    id: track.id,
    spotify_track_id: track.id,
    title: track.name,
    artist: track.artists.map(artist => artist.name).join(', '),
    album: track.album?.name || '',
    image_url: track.album?.images?.[0]?.url || '',
    uri: track.uri,
    external_url: track.external_urls?.spotify || ''
  }));
}
