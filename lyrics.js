// Abstraction pour les paroles synchronisées via LRCLIB.

const LRCLIB_BASE = 'https://lrclib.net/api';
const memoryCache = new Map();

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function hasVersionNoise(text) {
  return /\b(live|remix|instrumental|karaoke|acoustic|cover|edit|version)\b/i.test(text || '');
}

function scoreCandidate(track, query) {
  let score = 0;
  const trackName = normalize(track.trackName || track.name || '');
  const artistName = normalize(track.artistName || track.artist || '');
  const albumName = normalize(track.albumName || track.album || '');

  if (trackName === normalize(query.track_name)) score += 100;
  else if (trackName.includes(normalize(query.track_name))) score += 60;

  if (artistName === normalize(query.artist_name)) score += 100;
  else if (artistName.includes(normalize(query.artist_name))) score += 50;

  if (query.album_name && albumName && albumName.includes(normalize(query.album_name))) score += 20;

  if (typeof track.duration === 'number' && typeof query.duration === 'number') {
    const diff = Math.abs(track.duration - query.duration);
    if (diff <= 2) score += 80;
    else if (diff <= 5) score += 50;
    else if (diff <= 10) score += 20;
    else score -= Math.min(40, diff * 2);
  }

  const text = `${trackName} ${artistName} ${albumName}`;
  if (hasVersionNoise(text)) score -= 70;

  return score;
}

function parseLrc(syncedLyrics) {
  const lines = [];
  if (!syncedLyrics) return lines;

  for (const rawLine of String(syncedLyrics).split(/\r?\n/)) {
    const matches = [...rawLine.matchAll(/\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g)];
    const text = rawLine.replace(/\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g, '').trim();
    if (!matches.length || !text) continue;

    const time = matches[matches.length - 1];
    const minutes = Number(time[1]);
    const seconds = Number(time[2]);
    const centiseconds = Number((time[3] || '0').padEnd(3, '0'));
    lines.push({ time: minutes * 60000 + seconds * 1000 + centiseconds, text });
  }

  lines.sort((a, b) => a.time - b.time);
  return lines;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`LRCLIB HTTP ${res.status}`);
  return res.json();
}

async function searchLrclib(track) {
  const params = new URLSearchParams();
  params.set('track_name', track.track_name);
  params.set('artist_name', track.artist_name);
  params.set('duration', String(Math.round(track.duration_ms / 1000)));
  if (track.album_name) params.set('album_name', track.album_name);

  const query = params.toString();
  const data = await fetchJson(`${LRCLIB_BASE}/search?${query}`);
  const candidates = Array.isArray(data) ? data : (data ? [data] : []);
  if (!candidates.length) return null;

  candidates.sort((a, b) => scoreCandidate(b, track) - scoreCandidate(a, track));
  return candidates[0] || null;
}

export async function getSyncedLyrics(track) {
  const key = `${track.spotify_track_id || ''}::${track.track_name || ''}::${track.artist_name || ''}::${track.duration_ms || ''}`;
  if (memoryCache.has(key)) return memoryCache.get(key);

  console.log('[Lyrics] Recherche :', track.track_name, track.artist_name);

  try {
    const result = await searchLrclib(track);
    if (!result) {
      memoryCache.set(key, null);
      return null;
    }

    console.log('[Lyrics] Résultat LRCLIB trouvé');

    if (result.syncedLyrics) {
      const lines = parseLrc(result.syncedLyrics);
      if (lines.length) {
        console.log('[Lyrics] Paroles synchronisées :', lines.length);
        memoryCache.set(key, { type: 'synced', lines, title: result.trackName, artist: result.artistName });
        return memoryCache.get(key);
      }
    }

    if (result.plainLyrics) {
      memoryCache.set(key, { type: 'plain', text: result.plainLyrics, title: result.trackName, artist: result.artistName });
      return memoryCache.get(key);
    }

    memoryCache.set(key, null);
    return null;
  } catch (error) {
    console.error('[Lyrics] erreur LRCLIB:', error);
    memoryCache.set(key, null);
    return null;
  }
}

export function clearLyricsCache() {
  memoryCache.clear();
}

export function parseSyncedLyricsText(syncedLyrics) {
  return parseLrc(syncedLyrics);
}
