// Utilitaires partagés.

/**
 * Échappe les caractères HTML spéciaux pour prévenir les injections XSS.
 * @param {string} str
 * @returns {string}
 */
export function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
