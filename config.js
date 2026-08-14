// Configuration globale de l'application.
// Les clés publiques (anon key, client ID) peuvent résider ici en toute sécurité.
// Ne jamais placer client_secret ou service_role_key dans ce fichier.

export const APP_NAME = 'Grog';

// ----- Supabase -----
// Remplacer par les vraies valeurs du projet Supabase.
export const SUPABASE_URL = 'https://VOTRE_PROJET.supabase.co';
export const SUPABASE_ANON_KEY = 'VOTRE_ANON_KEY';

// ----- Spotify -----
// Client ID (non secret) de l'application Spotify Developer.
export const SPOTIFY_CLIENT_ID = 'VOTRE_CLIENT_ID';

// URL de la Supabase Edge Function qui échange le code contre un token Spotify.
// Nécessaire pour les recherches côté invité (pas de client_secret dans le navigateur).
export const SPOTIFY_TOKEN_PROXY_URL = `${SUPABASE_URL}/functions/v1/spotify-token`;
