// Gestion de la file d'attente via Supabase.
// submitRequest   → insère un morceau demandé par un invité.
// subscribeToQueue → écoute les changements en temps réel sur les requêtes "pending".

import { supabase } from './supabase.js';

const TABLE = 'song_requests';

/**
 * Retourne un identifiant de session anonyme persistent dans localStorage.
 * @returns {string}
 */
function getSessionId() {
  let id = localStorage.getItem('grog_session_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('grog_session_id', id);
  }
  return id;
}

/**
 * Soumet une demande de morceau dans Supabase.
 * @param {{id: string, title: string, artist: string, albumArt: string|null, uri: string}} track
 * @returns {Promise<void>}
 */
export async function submitRequest(track) {
  const { error } = await supabase.from(TABLE).insert({
    spotify_id: track.id,
    title: track.title,
    artist: track.artist,
    album_art: track.albumArt,
    session_id: getSessionId(),
  });
  if (error) throw error;
}

/**
 * Charge les requêtes "pending" existantes.
 * @returns {Promise<Array>}
 */
export async function fetchPendingRequests() {
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, title, artist, album_art, votes, created_at')
    .eq('status', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
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
 * S'abonne aux changements de la table song_requests (INSERT/UPDATE/DELETE sur pending).
 * @param {function(payload: object): void} callback
 * @returns {import('@supabase/supabase-js').RealtimeChannel}
 */
export function subscribeToQueue(callback) {
  return supabase
    .channel('song_requests')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: TABLE },
      callback,
    )
    .subscribe();
}
