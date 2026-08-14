// Gestion de la file d'attente via Supabase.
// submitRequest   → insère ou déduplique un morceau demandé par un invité.
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
    .select('id, title, artist, album_art, request_count, guest_name, created_at')
    .eq('status', 'pending')
    .order('request_count', { ascending: false })
    .order('created_at', { ascending: true });
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
