import { searchTracks } from './spotify.js';
import { escHtml } from './utils.js';
import { AUTO_DJ_FUNCTION_URL } from './config.js';

function norm(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function titleArtistKey(title, artist) {
  return `${norm(title)}::${norm(artist)}`;
}

export async function requestAutoDjSuggestions(payload) {
  const res = await fetch(AUTO_DJ_FUNCTION_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`auto-dj HTTP ${res.status} ${txt}`);
  }

  const json = await res.json();
  if (!json || !Array.isArray(json.suggestions) || json.suggestions.length !== 3) {
    throw new Error('Réponse auto-dj invalide: il faut exactement 3 suggestions');
  }

  const suggestions = json.suggestions.map((s) => ({
    title: String(s?.title ?? '').trim(),
    artist: String(s?.artist ?? '').trim(),
    reason: String(s?.reason ?? '').trim(),
    role: String(s?.role ?? '').trim().toLowerCase(),
    estimated_tension: Number.isFinite(Number(s?.estimated_tension)) ? Number(s.estimated_tension) : null,
  }));

  for (const s of suggestions) {
    if (!s.title || !s.artist || !s.reason) {
      throw new Error('Suggestion IA incomplète');
    }
  }

  return suggestions;
}

/**
 * @param {Array<{title:string,artist:string,reason:string}>} aiSuggestions
 * @param {{
 *   nowPlaying: { spotify_track_id?:string|null, title?:string, artist?:string }|null,
 *   recentTracks: Array<{spotify_track_id?:string|null,title?:string,artist?:string}>,
 *   requests: Array<{title:string,artist:string,votes:number}>
 * }} context
 */
export async function verifySuggestionsOnSpotify(aiSuggestions, context) {
  const now = context?.nowPlaying ?? null;
  const recentTracks = context?.recentTracks ?? [];
  const requests = context?.requests ?? [];

  const nowId = now?.spotify_track_id ?? null;
  const nowArtist = norm(now?.artist ?? '');

  const recentIds = new Set(recentTracks.map((t) => t.spotify_track_id).filter(Boolean));
  const recentKeys = new Set(recentTracks.map((t) => titleArtistKey(t.title, t.artist)));

  const pendingHighVotes = requests
    .filter((r) => r?.title && r?.artist)
    .sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0));

  // Mélange: d’abord IA, puis demandes populaires en fallback
  const candidates = [
    ...aiSuggestions.map((x) => ({ ...x, source: 'ai' })),
    ...pendingHighVotes.map((r) => ({
      title: r.title,
      artist: r.artist,
      reason: r.votes > 1 ? `Demande très votée (${r.votes} votes)` : 'Demande invitée',
      source: 'request',
    })),
  ];

  const usedIds = new Set();
  const usedKeys = new Set();
  const usedArtists = new Set();

  const out = [];

  for (const c of candidates) {
    const q = `${c.title} ${c.artist}`.trim();
    const results = await searchTracks(q, 8);
    if (!results.length) continue;

    let picked = null;

    // 1er passage strict
    for (const r of results) {
      const key = titleArtistKey(r.title, r.artist);
      const artistKey = norm(r.artist);

      if (!r.id) continue;
      if (nowId && r.id === nowId) continue;
      if (recentIds.has(r.id)) continue;
      if (recentKeys.has(key)) continue;
      if (usedIds.has(r.id)) continue;
      if (usedKeys.has(key)) continue;
      if (usedArtists.has(artistKey)) continue;
      if (artistKey === nowArtist) continue; // éviter même artiste que morceau courant si possible

      picked = r;
      break;
    }

    // 2e passage plus permissif (autorise même artiste courant)
    if (!picked) {
      for (const r of results) {
        const key = titleArtistKey(r.title, r.artist);
        const artistKey = norm(r.artist);

        if (!r.id) continue;
        if (nowId && r.id === nowId) continue;
        if (recentIds.has(r.id)) continue;
        if (recentKeys.has(key)) continue;
        if (usedIds.has(r.id)) continue;
        if (usedKeys.has(key)) continue;
        if (usedArtists.has(artistKey)) continue;

        picked = r;
        break;
      }
    }

    if (!picked) continue;

    const key = titleArtistKey(picked.title, picked.artist);
    usedIds.add(picked.id);
    usedKeys.add(key);
    usedArtists.add(norm(picked.artist));

    out.push({
      spotify_track_id: picked.id,
      title: picked.title,
      artist: picked.artist,
      image_url: picked.albumArt ?? null,
      uri: picked.uri ?? null,
      external_url: picked.id ? `https://open.spotify.com/track/${encodeURIComponent(picked.id)}` : null,
      reason: c.reason,
      role: c.role ?? null,
      estimated_tension: c.estimated_tension ?? null,
    });

    if (out.length === 3) break;
  }

  return out.slice(0, 3);
}

export function renderAutoDjSuggestions(container, suggestions) {
  if (!container) return;

  if (!suggestions?.length) {
    container.innerHTML = '<div class="empty-state">Aucune suggestion valide disponible.</div>';
    return;
  }

  const roleLabels = { safe: 'SAFE', build: 'BUILD', bold: 'BOLD' };

  container.innerHTML = '';
  suggestions.forEach((s, i) => {
    const item = document.createElement('article');
    item.className = 'auto-dj-suggestion';

    const roleBadge = s.role && roleLabels[s.role]
      ? `<span class="auto-dj-role-badge auto-dj-role-${escHtml(s.role)}">${roleLabels[s.role]}</span>`
      : `<span class="auto-dj-rank">${i + 1}</span>`;

    const tensionHtml = s.estimated_tension !== null
      ? `<small class="muted auto-dj-tension-hint">Tension estimée : ${escHtml(String(s.estimated_tension))} / 100</small>`
      : '';

    item.innerHTML = `
      ${roleBadge}
      ${
        s.image_url
          ? `<img class="auto-dj-cover" src="${escHtml(s.image_url)}" alt="pochette ${escHtml(s.title)}" width="56" height="56" loading="lazy">`
          : `<div class="auto-dj-cover-placeholder" aria-hidden="true"></div>`
      }
      <div class="auto-dj-info">
        <strong>${escHtml(s.title)}</strong>
        <span class="muted">${escHtml(s.artist)}</span>
        <small class="muted">${escHtml(s.reason)}</small>
        ${tensionHtml}
      </div>
      <a class="secondary auto-dj-open" href="${escHtml(s.external_url || '#')}" target="_blank" rel="noopener noreferrer">
        Ouvrir dans Spotify
      </a>
    `;

    container.appendChild(item);
  });
}
