// Votes anonymes sur le volume.
// Anti-spam par localStorage : un seul vote par session de navigateur.

const STORAGE_KEY = 'grog_volume_vote';

/**
 * Retourne true si l'utilisateur a déjà voté dans cette session.
 * @returns {boolean}
 */
export function hasVoted() {
  return !!localStorage.getItem(STORAGE_KEY);
}

/**
 * Retourne la direction du vote en cours ('up' | 'down'), ou null.
 * @returns {'up'|'down'|null}
 */
export function getVote() {
  return localStorage.getItem(STORAGE_KEY);
}

/**
 * Enregistre un vote de volume.
 * @param {'up'|'down'} direction
 * @returns {boolean} true si le vote a été enregistré, false si déjà voté
 */
export function castVote(direction) {
  if (hasVoted()) return false;
  localStorage.setItem(STORAGE_KEY, direction);
  return true;
}

/**
 * Réinitialise le vote (utile pour un nouvel événement).
 * Typiquement appelé par l'admin via un message Supabase Realtime.
 */
export function resetVote() {
  localStorage.removeItem(STORAGE_KEY);
}
