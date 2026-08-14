// Votes anonymes sur le volume — compteur cumulatif +1 / -1.
// Anti-spam : un seul vote autorisé par tranche de 2 secondes depuis le même navigateur.

import { supabase } from './supabase.js';

const LAST_VOTE_KEY = 'grog_volume_last_vote_ts';
const COOLDOWN_MS = 2000; // 2 secondes entre deux votes

/**
 * Durée de la fenêtre glissante en secondes (2 minutes).
 */
export const VOLUME_WINDOW_SECONDS = 120;

/**
 * Retourne true si l'utilisateur peut voter (cooldown respecté).
 * @returns {boolean}
 */
export function canVote() {
  const last = parseInt(localStorage.getItem(LAST_VOTE_KEY) || '0', 10);
  return Date.now() - last >= COOLDOWN_MS;
}

/**
 * Enregistre localement le timestamp du dernier vote pour le cooldown.
 */
export function recordVote() {
  localStorage.setItem(LAST_VOTE_KEY, String(Date.now()));
}

/**
 * Calcule et retourne le score de volume sur la fenêtre glissante.
 * @returns {Promise<number>}
 */
export async function fetchVolumeScore() {
  const since = new Date(Date.now() - VOLUME_WINDOW_SECONDS * 1000).toISOString();
  const { data, error } = await supabase
    .from('volume_votes')
    .select('value')
    .gte('created_at', since);
  if (error) throw error;
  return (data ?? []).reduce((sum, r) => sum + (r.value ?? 0), 0);
}
