// Gestion de l'authentification Spotify via PKCE.
// Utilisé uniquement par la page admin — les invités ne s'authentifient pas.

import { SPOTIFY_CLIENT_ID } from './config.js';

const REDIRECT_URI = window.location.origin + window.location.pathname.replace(/\/[^/]*$/, '/admin.html');
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
].join(' ');

// ----- Helpers PKCE -----

function randomBytes(length) {
  return crypto.getRandomValues(new Uint8Array(length));
}

function base64UrlEncode(buffer) {
  return btoa(String.fromCharCode(...buffer))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return crypto.subtle.digest('SHA-256', data);
}

function generateCodeVerifier() {
  return base64UrlEncode(randomBytes(32));
}

async function generateCodeChallenge(verifier) {
  const hash = await sha256(verifier);
  return base64UrlEncode(new Uint8Array(hash));
}

// ----- Public API -----

/**
 * Lance le flux PKCE — redirige vers Spotify.
 * @returns {Promise<void>}
 */
export async function startPKCE() {
  const verifier = generateCodeVerifier();
  const challenge = await generateCodeChallenge(verifier);
  sessionStorage.setItem('pkce_verifier', verifier);

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: SCOPES,
  });

  window.location.href = 'https://accounts.spotify.com/authorize?' + params;
}

/**
 * Échange le code de rappel contre un access token.
 * Appelé au chargement de admin.html si `?code=…` est présent dans l'URL.
 * @returns {Promise<{access_token: string, refresh_token: string, expires_in: number}|null>}
 */
export async function handleCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return null;

  const verifier = sessionStorage.getItem('pkce_verifier');
  if (!verifier) throw new Error('Code verifier manquant');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: SPOTIFY_CLIENT_ID,
    code_verifier: verifier,
  });

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) throw new Error('Échec échange token: ' + res.status);

  const tokens = await res.json();
  sessionStorage.removeItem('pkce_verifier');
  sessionStorage.setItem('spotify_token', JSON.stringify(tokens));

  // Nettoyer l'URL
  window.history.replaceState({}, document.title, window.location.pathname);
  return tokens;
}

/**
 * Retourne le token actuel depuis sessionStorage, ou null.
 * @returns {{access_token: string, expires_in: number}|null}
 */
export function getStoredTokens() {
  const raw = sessionStorage.getItem('spotify_token');
  return raw ? JSON.parse(raw) : null;
}

/** Supprime le token de session — déconnexion. */
export function logout() {
  sessionStorage.removeItem('spotify_token');
}
