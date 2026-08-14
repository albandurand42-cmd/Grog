// Abstraction pour les paroles synchronisées via LRCLIB.

const LRCLIB_BASE = 'https://lrclib.net/api';
const CLIENT_HEADER = 'GROG/1.0 (https://albandurand42-cmd.github.io/Grog/)';
const memoryCache = new Map();

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function hasNoise(text) {
  return /\b(live|remix|instrumental|karaoke)\b/i.test(text || '');
}

function parseLrc(syncedLyrics) {
  const lines = [];
  for (const rawLine of String(syncedLyrics || '').split(/\r?\n/)) {
    const tags = [...rawLine.matchAll(/\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    const text = rawLine.replace(/\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g, '').trim();
    if (!tags.length || !text) continue;
    const last = tags[tags.length - 1];
    const minutes = Number(last[1]);
    const seconds = Number(last[2]);
    const ms = Number((last[3] || '0').padEnd(3, '0'));
    lines.push({ time: minutes * 60000 + seconds * 1000 + ms, text });
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

function scoreResult(item, track) {
  let score = 0;
  const tn = normalize(item.trackName || item.name || '');
  const an = normalize(item.artistName || item.artist || '');
  const al = normalize(item.albumName || item.album || '');
  const qTrack = normalize(track.track_name);
  const qArtist = normalize(track.artist_name);
  const qAlbum = normalize(track.album_name);

  if (tn === qTrack) score += 100; else if (tn.includes(qTrack)) score += 70;
  if (an === qArtist) score += 100; else if (an.includes(qArtist)) score += 60;
  if (qAlbum && al && al.includes(qAlbum)) score += 15;
  if (typeof item.duration === 'number') {
    const diff = Math.abs(item.duration - track.duration);
    if (diff <= 1) score += 80;
    else if (diff <= 3) score += 60;
    else if (diff <= 6) score += 30;
    else score -= Math.min(50, diff * 5);
  }
  if (hasNoise(`${tn} ${an} ${al}`) && !hasNoise(`${qTrack} ${qArtist} ${qAlbum}`)) score -= 70;
  return score;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'Lrclib-Client': CLIENT_HEADER,
    },
  });
  return res;
}

async function exactSearch(track) {
  // Ne pas appeler /api/get si duration est absent ou <= 0, ou si album est absent
  if (!track.album_name || typeof track.duration_ms !== 'number' || track.duration_ms <= 0) {
    console.log('[LYRICS] Recherche exacte ignorée: album absent ou duration invalide');
    return null;
  }

  const params = new URLSearchParams({
    track_name: track.track_name,
    artist_name: track.artist_name,
    album_name: track.album_name || '',
    duration: String(Math.round(track.duration_ms / 1000)),
  });
  const url = `${LRCLIB_BASE}/get?${params.toString()}`;
  console.log('[LYRICS] URL /get: ' + url);
  
  try {
    const res = await fetchJson(url);
    if (res.status === 404) {
      console.log('[LYRICS] Aucun résultat exact (404)');
      return null;
    }
    if (!res.ok) {
      console.warn(`[LYRICS] /get HTTP ${res.status}`);
      return null;
    }
    const result = await res.json();
    console.log('[LYRICS] Réponse /get:', result);
    return result?.syncedLyrics ? result : null;
  } catch (err) {
    console.warn('[LYRICS] exactSearch erreur, fallback à search:', err.message);
    return null;
  }
}

async function fallbackSearch(track) {
  const params = new URLSearchParams({
    track_name: track.track_name,
    artist_name: track.artist_name,
  });
  const url = `${LRCLIB_BASE}/search?${params.toString()}`;
  console.log('[LYRICS] URL /search: ' + url);
  
  try {
    const res = await fetchJson(url);
    if (res.status === 404) {
      console.log('[LYRICS] Aucun résultat /search (404)');
      return [];
    }
    if (!res.ok) {
      console.warn(`[LYRICS] /search HTTP ${res.status}`);
      return [];
    }
    const results = await res.json();
    console.log('[LYRICS] Réponse /search:', results);
    return Array.isArray(results) ? results : (results ? [results] : []);
  } catch (err) {
    console.warn('[LYRICS] fallbackSearch erreur:', err.message);
    return [];
  }
}

function chooseBest(results, track) {
  const candidates = results.filter((r) => r && r.syncedLyrics);
  const pool = (candidates.length ? candidates : results).filter((r) => r && !hasNoise(`${r.trackName || ''} ${r.artistName || ''} ${r.albumName || ''}`));
  pool.sort((a, b) => scoreResult(b, track) - scoreResult(a, track));
  return pool[0] || null;
}

export async function getSyncedLyrics(track) {
  const key = `${track.spotify_track_id || ''}::${track.track_name || ''}::${track.artist_name || ''}::${track.duration_ms || ''}`;
  if (memoryCache.has(key)) {
    console.log('[LYRICS] Cache hit:', track.track_name, track.artist_name);
    return memoryCache.get(key);
  }

  console.log('[LYRICS] Recherche nouvelle:', {
    track_name: track.track_name,
    artist_name: track.artist_name,
    album_name: track.album_name,
    duration_ms: track.duration_ms,
  });

  try {
    const exact = await exactSearch(track);
    if (exact?.syncedLyrics) {
      const lines = parseLrc(exact.syncedLyrics);
      console.log('[LYRICS] ' + lines.length + ' lignes synchronisées (exact)');
      if (lines.length) {
        const payload = { type: 'synced', lines, plainLyrics: exact.plainLyrics || null };
        memoryCache.set(key, payload);
        return payload;
      }
    }

    console.log('[LYRICS] Recherche fallback');
    const results = await fallbackSearch(track);
    console.log('[LYRICS] ' + results.length + ' résultats /search');
    const best = chooseBest(results, track);
    if (best) {
      console.log('[LYRICS] Meilleur résultat trouvé:', best.trackName, '-', best.artistName);
    }
    
    if (!best) {
      console.log('[LYRICS] Aucun résultat');
      memoryCache.set(key, null);
      return null;
    }

    if (best.syncedLyrics) {
      const lines = parseLrc(best.syncedLyrics);
      console.log('[LYRICS] ' + lines.length + ' lignes synchronisées');
      if (lines.length) {
        const payload = { type: 'synced', lines, plainLyrics: best.plainLyrics || null };
        memoryCache.set(key, payload);
        return payload;
      }
    }

    if (best.plainLyrics) {
      console.log('[LYRICS] Paroles non-synchronisées');
      const payload = { type: 'plain', text: best.plainLyrics };
      memoryCache.set(key, payload);
      return payload;
    }

    console.log('[LYRICS] Aucune parole trouvée');
    memoryCache.set(key, null);
    return null;
  } catch (error) {
    console.error('[LYRICS] Erreur:', error);
    memoryCache.set(key, null);
    return null;
  }
}
