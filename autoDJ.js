import { searchTracks } from './spotify.js';
import { escHtml } from './utils.js';
import { supabase } from './supabase.js';
import { AUTO_DJ_FUNCTION_URL } from './config.js';

function norm(s) {
  return String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function titleArtistKey(title, artist) {
  return `${norm(title)}::${norm(artist)}`;
}

/**
 * Request AI suggestions from Edge Function V3
 * Returns { analysis, candidates }
 */
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

  const data = await res.json();
  console.log('[AUTO-DJ] edge response', data);

  if (!data || !data.analysis || !Array.isArray(data.candidates)) {
    throw new Error('Invalid auto-dj response: missing analysis or candidates');
  }

  // Validate candidates
  const candidates = data.candidates.map((c) => ({
    title: String(c?.title ?? '').trim(),
    artist: String(c?.artist ?? '').trim(),
    reason: String(c?.reason ?? '').trim(),
    estimated_tension: Number.isFinite(Number(c?.estimated_tension))
      ? Number(c.estimated_tension)
      : 50,
  }));

  return {
    analysis: data.analysis,
    candidates,
  };
}

/**
 * Verify and filter candidates on Spotify with anti-repetition logic
 */
export async function verifySuggestionsOnSpotify(
  aiResponse,
  context
) {
  const { analysis, candidates } = aiResponse;
  const now = context?.nowPlaying ?? null;
  const recentTracks = context?.recentTracks ?? [];
  const requests = context?.requests ?? [];
  const recentSuggestions = context?.recentSuggestions ?? [];

  const nowId = now?.spotify_track_id ?? null;
  const nowArtist = norm(now?.artist ?? '');

  // Build sets of tracks to avoid
  const recentIds = new Set(recentTracks.map((t) => t.spotify_track_id).filter(Boolean));
  const recentKeys = new Set(recentTracks.map((t) => titleArtistKey(t.title, t.artist)));

  // Penalize artists suggested but never played recently
  const ignoredArtists = new Map();
  const ignoredTracks = new Map();
  for (const s of recentSuggestions) {
    if (!s.was_played) {
      const artistKey = norm(s.artist);
      ignoredArtists.set(artistKey, (ignoredArtists.get(artistKey) || 0) + 1);
      ignoredTracks.set(titleArtistKey(s.title, s.artist), (ignoredTracks.get(titleArtistKey(s.title, s.artist)) || 0) + 1);
    }
  }

  // Public requests sorted by votes
  const pendingHighVotes = requests
    .filter((r) => r?.title && r?.artist)
    .sort((a, b) => (b.votes ?? 0) - (a.votes ?? 0));

  // Build candidate pool: AI suggestions first, then high-voted requests
  const candidatePool = [
    ...candidates.map((x) => ({ ...x, source: 'ai' })),
    ...pendingHighVotes.map((r) => ({
      title: r.title,
      artist: r.artist,
      reason: r.votes > 1 ? `Demande très votée (${r.votes} votes)` : 'Demande invitée',
      estimated_tension: 50,
      source: 'request',
    })),
  ];

  const usedIds = new Set();
  const usedKeys = new Set();
  const usedArtists = new Set();

  const verified = [];

  for (const c of candidatePool) {
    const q = `${c.title} ${c.artist}`.trim();
    const results = await searchTracks(q, 8);
    if (!results.length) continue;

    let picked = null;

    // First pass: strict filtering
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
      if (artistKey === nowArtist) continue;

      // Anti-repetition: penalize ignored suggestions
      const timesIgnored = ignoredTracks.get(key) || 0;
      if (timesIgnored > 2) continue;

      picked = r;
      break;
    }

    // Second pass: more permissive (allow same artist as current)
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

        const timesIgnored = ignoredTracks.get(key) || 0;
        if (timesIgnored > 3) continue;

        picked = r;
        break;
      }
    }

    if (!picked) continue;

    const key = titleArtistKey(picked.title, picked.artist);
    const artistKey = norm(picked.artist);

    usedIds.add(picked.id);
    usedKeys.add(key);
    usedArtists.add(artistKey);

    verified.push({
      spotify_track_id: picked.id,
      title: picked.title,
      artist: picked.artist,
      image_url: picked.albumArt ?? null,
      uri: picked.uri ?? null,
      external_url: picked.id ? `https://open.spotify.com/track/${encodeURIComponent(picked.id)}` : null,
      reason: c.reason,
      estimated_tension: c.estimated_tension ?? 50,
    });

    // Stop at 3 final suggestions
    if (verified.length === 3) break;
  }

  return {
    analysis,
    suggestions: verified.slice(0, 3),
  };
}

/**
 * Record suggestions to suggestion_history table
 * @param {Array} suggestions - verified suggestion objects
 * @param {string} generationId - unique id for this batch
 * @param {{ direction?: string, context_style?: string }} [context]
 */
export async function recordSuggestionsToHistory(suggestions, generationId, context = {}) {
  if (!suggestions || suggestions.length === 0) return;

  try {
    const rows = suggestions.map((s) => ({
      spotify_track_id: s.spotify_track_id,
      title: s.title,
      artist: s.artist,
      suggested_at: new Date().toISOString(),
      was_played: false,
      generation_id: generationId,
      reason: s.reason ?? null,
      estimated_tension: Number.isFinite(s.estimated_tension) ? Math.round(s.estimated_tension) : null,
      direction: context.direction ?? null,
      context_style: context.context_style ?? null,
    }));

    const { error } = await supabase.from('suggestion_history').insert(rows);
    if (error) {
      console.warn('[AUTO-DJ] suggestion_history insert warning:', error.message);
    } else {
      console.log('[AUTO-DJ] recorded', rows.length, 'suggestions to history');
    }
  } catch (err) {
    console.warn('[AUTO-DJ] suggestion_history insert exception:', err?.message ?? String(err));
  }
}

/**
 * Mark a track as played in suggestion_history
 */
export async function markSuggestionAsPlayed(spotifyTrackId) {
  if (!spotifyTrackId) return;

  try {
    // Find recent unplayed suggestion with this track
    const { data, error: selectErr } = await supabase
      .from('suggestion_history')
      .select('id')
      .eq('spotify_track_id', spotifyTrackId)
      .eq('was_played', false)
      .order('suggested_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (selectErr) {
      console.warn('[AUTO-DJ] mark as played select error:', selectErr.message);
      return;
    }

    if (!data) return;

    const { error: updateErr } = await supabase
      .from('suggestion_history')
      .update({ was_played: true })
      .eq('id', data.id);

    if (updateErr) {
      console.warn('[AUTO-DJ] mark as played update error:', updateErr.message);
    } else {
      console.log('[AUTO-DJ] marked suggestion as played:', spotifyTrackId);
    }
  } catch (err) {
    console.warn('[AUTO-DJ] mark as played exception:', err?.message ?? String(err));
  }
}

/**
 * Render suggestions
 */
export function renderAutoDjSuggestions(container, response) {
  if (!container) return;

  const { suggestions } = response;

  if (!suggestions || suggestions.length === 0) {
    container.innerHTML = '<div class="empty-state">Aucune suggestion valide disponible.</div>';
    return;
  }

  container.innerHTML = '';

  // Render suggestions
  const suggestionsHtml = document.createElement('div');
  suggestionsHtml.className = 'auto-dj-suggestions-grid';

  suggestions.forEach((s) => {
    const item = document.createElement('article');
    item.className = 'auto-dj-suggestion';

    const tensionHtml =
      s.estimated_tension !== null
        ? `<small class="muted auto-dj-tension-hint">Tension : ${Math.round(s.estimated_tension)}</small>`
        : '';

    item.innerHTML = `
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
        Spotify
      </a>
    `;

    suggestionsHtml.appendChild(item);
  });

  container.appendChild(suggestionsHtml);
}
