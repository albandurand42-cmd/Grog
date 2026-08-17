import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type TrackLike = {
  spotify_track_id?: string | null;
  title?: string | null;
  artist?: string | null;
  played_at?: string | null;
};

type RequestLike = {
  title?: string | null;
  artist?: string | null;
  votes?: number | null;
};

type Suggestion = {
  title: string;
  artist: string;
  reason: string;
  role: 'safe' | 'build' | 'bold';
  estimated_tension: number | null;
};

type DJProfile = {
  top_artists?: { artist: string; count: number }[];
  top_tracks?: { title: string; artist: string; count: number }[];
  ignored_artists?: { artist: string; ignored: number }[];
  total_suggestions?: number;
  total_played?: number;
  play_ratio_pct?: number | null;
};

function asText(value: unknown, fallback = '') {
  return typeof value === 'string' ? value.trim() : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function normalizeDirection(value: unknown) {
  return value === 'down' ? 'down' : 'up';
}

function clampTension(value: unknown) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.max(0, Math.min(100, Math.round(numeric)));
}

function normalizeRole(value: unknown, index: number): Suggestion['role'] {
  const role = asText(value).toLowerCase();
  if (role === 'safe' || role === 'build' || role === 'bold') return role;
  return ['safe', 'build', 'bold'][index] as Suggestion['role'];
}

function toChronologicalTracks(value: unknown): TrackLike[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const row = asRecord(item);
      return {
        spotify_track_id: asText(row.spotify_track_id ?? ''),
        title: asText(row.title ?? ''),
        artist: asText(row.artist ?? ''),
        played_at: asText(row.played_at ?? ''),
      };
    })
    .filter((item) => item.title || item.artist)
    .slice(-10);
}

function toRequests(value: unknown): RequestLike[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const row = asRecord(item);
      return {
        title: asText(row.title ?? ''),
        artist: asText(row.artist ?? ''),
        votes: Number.isFinite(Number(row.votes)) ? Number(row.votes) : null,
      };
    })
    .filter((item) => item.title || item.artist)
    .slice(0, 25);
}

function buildUserPrompt(payload: {
  now_playing: TrackLike | null;
  recent_tracks: TrackLike[];
  requests: RequestLike[];
  dj_context: { direction: 'up' | 'down' };
  dj_profile?: DJProfile | null;
}) {
  const directionSentence = payload.dj_context.direction === 'down'
    ? 'Le DJ veut actuellement DESCENDRE la tension.'
    : 'Le DJ veut actuellement MONTER la tension.';

  const recentTracksText = payload.recent_tracks.length
    ? payload.recent_tracks
      .map((track, index, array) => {
        const position = index === array.length - 1 ? '← le plus récent' : '';
        return `${index + 1}. ${track.title || 'Titre inconnu'} — ${track.artist || 'Artiste inconnu'}${track.played_at ? ` (${track.played_at})` : ''} ${position}`.trim();
      })
      .join('\n')
    : 'Aucun historique récent.';

  const requestsText = payload.requests.length
    ? payload.requests
      .map((request) => `- ${request.title || 'Titre inconnu'} — ${request.artist || 'Artiste inconnu'}${request.votes ? ` (${request.votes} votes)` : ''}`)
      .join('\n')
    : 'Aucune demande en attente.';

  const djProfileText = buildDjProfileSection(payload.dj_profile);

  return [
    directionSentence,
    '',
    'Analyse la liste recent_tracks comme une trajectoire musicale chronologique du plus ancien au plus récent.',
    'Le dernier morceau et les 3 à 5 derniers titres ont plus de poids que les plus anciens.',
    'Reste cohérent avec le style actuel, évite les ruptures brutales et prends en compte les demandes seulement si elles collent au style, à la direction et à la trajectoire.',
    '',
    'Règles directionnelles :',
    payload.dj_context.direction === 'down'
      ? '- SAFE: transition douce, énergie descendante.\n- BUILD: transition structurée mais orientée vers une baisse d'intensité.\n- BOLD: choix plus audacieux pour redescendre ou changer doucement de registre.'
      : '- SAFE: continuité très naturelle.\n- BUILD: monte légèrement l'énergie.\n- BOLD: monte davantage ou fait évoluer le style tout en restant cohérent.',
    '',
    `Now playing: ${payload.now_playing?.title || 'Inconnu'} — ${payload.now_playing?.artist || 'Inconnu'}`,
    '',
    'Recent tracks (ordre chronologique, le dernier est le plus récent) :',
    recentTracksText,
    '',
    'Demandes en attente :',
    requestsText,
    ...(djProfileText ? ['', djProfileText] : []),
    '',
    'Réponds uniquement en JSON avec ce format exact :',
    '{"suggestions":[{"title":"...","artist":"...","reason":"...","role":"safe|build|bold","estimated_tension":0}]}',
    'Il faut exactement 3 suggestions: SAFE, BUILD, BOLD.',
    'Ne mets aucun texte hors JSON.',
  ].join('\n');
}

function buildDjProfileSection(profile?: DJProfile | null): string {
  if (!profile) return '';
  const lines: string[] = ['Profil DJ (mémoire longue soirée) :'];

  if (profile.top_artists && profile.top_artists.length > 0) {
    lines.push('Top artistes joués : ' + profile.top_artists.slice(0, 5).map((a) => `${a.artist} (${a.count}×)`).join(', '));
  }
  if (profile.ignored_artists && profile.ignored_artists.length > 0) {
    lines.push('Artistes souvent ignorés (éviter) : ' + profile.ignored_artists.slice(0, 5).map((a) => a.artist).join(', '));
  }
  if (profile.play_ratio_pct !== null && profile.play_ratio_pct !== undefined) {
    lines.push(`Taux de play sur suggestions : ${profile.play_ratio_pct}%`);
  }

  return lines.join('\n');
}

async function fetchSuggestions(payload: {
  now_playing: TrackLike | null;
  recent_tracks: TrackLike[];
  requests: RequestLike[];
  dj_context: { direction: 'up' | 'down' };
  dj_profile?: DJProfile | null;
}) {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY manquant');

  const model = Deno.env.get('OPENAI_MODEL') || 'gpt-4.1-mini';
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: ['Bearer', apiKey].join(' '),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.8,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: [
            'Tu es un assistant Auto-DJ expert en trajectoires de soirée.',
            'Tu proposes uniquement le prochain morceau, jamais de faux titre, jamais de doublon récent, jamais de texte hors JSON.',
            'Tu utilises impérativement dj_context.direction pour décider s’il faut monter ou descendre.',
          ].join(' '),
        },
        {
          role: 'user',
          content: buildUserPrompt(payload),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`OpenAI HTTP ${response.status} ${errorText}`);
  }

  const completion = await response.json();
  const content = completion?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('Réponse OpenAI vide');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new Error('Réponse OpenAI JSON invalide');
  }
  if (!Array.isArray(parsed?.suggestions) || parsed.suggestions.length !== 3) {
    throw new Error('Réponse suggestions invalide');
  }

  return parsed.suggestions.map((item: Record<string, unknown>, index: number) => ({
    title: asText(item?.title),
    artist: asText(item?.artist),
    reason: asText(item?.reason),
    role: normalizeRole(item?.role, index),
    estimated_tension: clampTension(item?.estimated_tension),
  })) as Suggestion[];
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = asRecord(await req.json());
    const nowPlaying = asRecord(body.now_playing);
    const payload = {
      now_playing: body.now_playing
        ? {
          spotify_track_id: asText(nowPlaying.spotify_track_id ?? ''),
          title: asText(nowPlaying.title ?? ''),
          artist: asText(nowPlaying.artist ?? ''),
          played_at: null,
        }
        : null,
      recent_tracks: toChronologicalTracks(body.recent_tracks),
      requests: toRequests(body.requests),
      dj_context: {
        direction: normalizeDirection(asRecord(body.dj_context).direction),
      },
      dj_profile: body.dj_profile ? (body.dj_profile as DJProfile) : null,
    };

    const suggestions = await fetchSuggestions(payload);

    // Build a lightweight analysis for client-side rendering
    const recentTracks = payload.recent_tracks;
    const lastTrack = recentTracks[recentTracks.length - 1] ?? payload.now_playing;
    const analysis = {
      current_style: lastTrack?.artist ? `Style autour de ${lastTrack.artist}` : 'Mixte',
      trajectory: recentTracks.length >= 2
        ? `${recentTracks[0]?.artist ?? '?'} → ${recentTracks[recentTracks.length - 1]?.artist ?? '?'}`
        : (lastTrack?.artist ?? 'Inconnu'),
      energy_estimate: 60,
      direction: payload.dj_context.direction,
      confidence: Math.min(0.9, 0.4 + recentTracks.length * 0.05),
    };

    // Convert suggestions to candidates format (role → role_hint)
    const candidates = suggestions.map((s) => ({
      title: s.title,
      artist: s.artist,
      reason: s.reason,
      role_hint: s.role as 'safe' | 'build' | 'bold',
      estimated_tension: s.estimated_tension ?? 50,
    }));

    return new Response(JSON.stringify({ analysis, candidates }), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: error instanceof Error ? error.message : 'Erreur inconnue',
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
    });
  }
});
