// Abstraction pour les paroles synchronisées.
// Connecter ici une API de paroles autorisée/licenciée.
//
// Format attendu en retour :
// [
//   { time: 0,     text: "Premier couplet..." },
//   { time: 15200, text: "Deuxième ligne..."  },
//   ...
// ]
// `time` est en millisecondes depuis le début du morceau.
//
// Retourner null si aucune source de paroles n'est configurée.

/**
 * Récupère les paroles synchronisées pour un morceau.
 * @param {string} title
 * @param {string} artist
 * @param {number} duration  durée en ms
 * @returns {Promise<Array<{time: number, text: string}>|null>}
 */
export async function getSyncedLyrics(title, artist, duration) { // eslint-disable-line no-unused-vars
  // Aucune source de paroles configurée pour le moment.
  // Pour intégrer une API, remplacer ce bloc par votre implémentation.
  return null;
}
