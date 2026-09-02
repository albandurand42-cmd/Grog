// Gestion de la file d'attente via Supabase.
// submitRequest   → insère ou déduplique un morceau demandé par un invité.
// subscribeToQueue → écoute les changements en temps réel sur les requêtes "pending".

import { supabase } from './supabase.js';

const TABLE = 'song_requests';

/**
 * Retourne un identifiant de session anonyme persistent dans localStorage.
 * Crée et sauvegarde un UUID si aucun n'existe encore.
 * @returns {string}
 */
export function getSessionId() {
  let id = localStorage.getItem('grog_session_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('grog_session_id', id);
  }
  return id;
}

/**
 * Soumet une demande de morceau dans Supabase.
 * Si le morceau est déjà en attente (même spotify_id, status='pending'),
 * incrémente request_count au lieu de créer un doublon.
 * @param {{id: string, title: string, artist: string, albumArt: string|null, uri: string}} track
 * @param {string} [guestName='']
 * @returns {Promise<void>}
 */
export async function submitRequest(track, guestName = '') {
  // Vérifie si le morceau est déjà en attente
  const { data: existing, error: fetchErr } = await supabase
    .from(TABLE)
    .select('id, request_count')
    .eq('spotify_id', track.id)
    .eq('status', 'pending')
    .maybeSingle();

  if (fetchErr) throw fetchErr;

  if (existing) {
    // Incrémenter request_count
    const { error: updateErr } = await supabase
      .from(TABLE)
      .update({ request_count: (existing.request_count ?? 1) + 1 })
      .eq('id', existing.id);
    if (updateErr) throw updateErr;
  } else {
    // Créer une nouvelle demande
    const { error: insertErr } = await supabase.from(TABLE).insert({
      spotify_id: track.id,
      title: track.title,
      artist: track.artist,
      album_art: track.albumArt,
      session_id: getSessionId(),
      guest_name: guestName || null,
      request_count: 1,
    });
    if (insertErr) throw insertErr;
  }
}

/**
 * Charge les requêtes "pending" existantes, triées par nombre de demandes décroissant.
 * @returns {Promise<Array>}
 */
export async function fetchPendingRequests() {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, status, spotify_id, title, artist, album_art, request_count, guest_name, created_at')
    .eq('status', 'pending')
    .order('request_count', { ascending: false })
    .order('created_at', { ascending: true });
  if (error) throw error;
  console.log(
    '[QUEUE DEBUG] pending after reload',
    data?.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
    }))
  );
  return data ?? [];
}

/**
 * Incrémente les votes d'une requête.
 * @param {string} requestId UUID de la requête
 * @returns {Promise<void>}
 */
export async function upvoteRequest(requestId) {
  const { error } = await supabase.rpc('increment_request_votes', { request_id: requestId });
  if (error) throw error;
}

/**
 * S'abonne aux changements de la table song_requests (INSERT/UPDATE/DELETE).
 * @param {function(payload: object): void} callback
 * @returns {import('@supabase/supabase-js').RealtimeChannel}
 */
export function subscribeToQueue(callback) {
  return supabase
    .channel('public:song_requests')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: TABLE },
      callback,
    )
    .subscribe();
}

function isValidSpotifyTrackId(value) {
  return /^[A-Za-z0-9]{22}$/.test(value);
}

function resolveSpotifyTrackUri(request) {
  const spotifyUri = typeof request?.spotify_uri === 'string' ? request.spotify_uri.trim() : '';
  if (spotifyUri) {
    if (/^spotify:track:[A-Za-z0-9]{22}$/.test(spotifyUri)) return spotifyUri;
    throw new Error(`URI Spotify invalide: ${spotifyUri}`);
  }

  const trackIdRaw = typeof request?.spotify_track_id === 'string'
    ? request.spotify_track_id.trim()
    : typeof request?.spotify_id === 'string'
      ? request.spotify_id.trim()
      : '';

  if (!trackIdRaw) throw new Error('Identifiant Spotify manquant pour cette demande');
  if (!isValidSpotifyTrackId(trackIdRaw)) throw new Error(`ID Spotify invalide: ${trackIdRaw}`);

  return `spotify:track:${trackIdRaw}`;
}

/**
 * Ajoute une requête à la file Spotify du compte admin connecté.
 * @param {object} request
 * @param {(url: string, init?: RequestInit) => Promise<Response|null>} spotifyFetch
 * @returns {Promise<{status: number, uri: string, url: string, deviceId: string}>}
 */
export async function addToSpotifyQueue(request, spotifyFetch) {
  console.log('[SPOTIFY QUEUE] track request:', request);

  const uri = resolveSpotifyTrackUri(request);

  const devicesResponse = await spotifyFetch('https://api.spotify.com/v1/me/player/devices');
  if (!devicesResponse) throw new Error('Connexion Spotify nécessaire');
  const devicesData = await devicesResponse.json().catch(() => ({ devices: [] }));
  const devices = Array.isArray(devicesData?.devices) ? devicesData.devices : [];
  console.log('[SPOTIFY QUEUE] devices:', devices);

  const activeDevice = devices.find((d) => d?.is_active);
  if (!activeDevice?.id) {
    throw new Error('Aucun appareil Spotify actif. Lance une musique sur Spotify puis réessaie.');
  }

  const url = `https://api.spotify.com/v1/me/player/queue?${new URLSearchParams({
    uri,
    device_id: activeDevice.id,
  }).toString()}`;

  const response = await spotifyFetch(url, { method: 'POST' });
  if (!response) throw new Error('Connexion Spotify nécessaire');

  const responseText = await response.text();

  console.log('[SPOTIFY QUEUE]', {
    status: response.status,
    statusText: response.statusText,
    response: responseText,
    uri,
    url,
    device_id: activeDevice.id,
  });

  if (!response.ok) {
    const scopeHint = response.status === 403
      && /insufficient scope|scope/i.test(responseText || response.statusText)
      ? ' — Scope insuffisant: déconnecte-toi de Spotify puis reconnecte-toi pour régénérer le token OAuth avec user-modify-playback-state.'
      : '';
    throw new Error(`Spotify queue ${response.status}: ${responseText || response.statusText}${scopeHint}`);
  }

  return { status: response.status, uri, url, deviceId: activeDevice.id };
}
