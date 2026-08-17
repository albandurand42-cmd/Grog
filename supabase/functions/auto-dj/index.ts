import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

type Direction = 'up' | 'down';

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

type RecentSuggestionLike = {
  title?: string | null;
  artist?: string | null;
  was_played?: boolean | null;
};

type DJProfile = Record<string, unknown>;

type AutoDJPayload = {
  now_playing: TrackLike | null;
  recent_tracks: TrackLike[];
  recent_suggestions: RecentSuggestionLike[];
  requests: RequestLike[];
  dj_context: { direction: Direction; instruction: string };
  dj_profile: DJProfile | null;
};

type Analysis = {
  current_style: string;
  trajectory: string;
  energy_estimate: number;
  direction: Direction;
  confidence: number;
};

type Candidate = {
  title: string;
  artist: string;
  reason: string;
  estimated_tension: number;
};

type AutoDJV3Response = {
  analysis: Analysis;
  candidates: Candidate[];
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function asIntInRange(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function asNumberInRange(value: unknown, min: number, max: number): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function normalizeDirection(value: unknown): Direction {
  return value === 'down' ? 'down' : 'up';
}

function parsePayload(body: unknown): AutoDJPayload {
  const root = asRecord(body);
  const now = asRecord(root.now_playing);

  const now_playing: TrackLike | null = root.now_playing
    ? {
      spotify_track_id: asText(now.spotify_track_id ?? ''),
      title: asText(now.title ?? ''),
      artist: asText(now.artist ?? ''),
      played_at: asText(now.played_at ?? ''),
    }
    : null;

  const recent_tracks = Array.isArray(root.recent_tracks)
    ? root.recent_tracks
      .map((row) => {
        const item = asRecord(row);
        return {
          spotify_track_id: asText(item.spotify_track_id ?? ''),
          title: asText(item.title ?? ''),
          artist: asText(item.artist ?? ''),
          played_at: asText(item.played_at ?? ''),
        };
      })
      .filter((t) => t.title || t.artist)
      .slice(-25)
    : [];

  const recent_suggestions = Array.isArray(root.recent_suggestions)
    ? root.recent_suggestions
      .map((row) => {
        const item = asRecord(row);
        return {
          title: asText(item.title ?? ''),
          artist: asText(item.artist ?? ''),
          was_played: Boolean(item.was_played),
        };
      })
      .filter((s) => s.title || s.artist)
      .slice(-40)
    : [];

  const requests = Array.isArray(root.requests)
    ? root.requests
      .map((row) => {
        const item = asRecord(row);
        return {
          title: asText(item.title ?? ''),
          artist: asText(item.artist ?? ''),
          votes: Number.isFinite(Number(item.votes)) ? Number(item.votes) : 0,
        };
      })
      .filter((r) => r.title || r.artist)
      .slice(0, 25)
    : [];

  return {
    now_playing,
    recent_tracks,
    recent_suggestions,
    requests,
    dj_context: {
      direction: normalizeDirection(asRecord(root.dj_context).direction),
      instruction: asText(asRecord(root.dj_context).instruction ?? ''),
    },
    dj_profile: root.dj_profile && typeof root.dj_profile === 'object'
      ? (root.dj_profile as DJProfile)
      : null,
  };
}

function buildDjProfileSection(profile: DJProfile | null): string {
  if (!profile) return 'Aucun profil DJ disponible';
  const src = asRecord(profile);
  const lines: string[] = [];

  const topArtists = Array.isArray(src.top_artists) ? src.top_artists : [];
  if (topArtists.length > 0) {
    const artists = topArtists
      .slice(0, 5)
      .map((row) => {
        const item = asRecord(row);
        const name = asText(item.artist, 'Artiste inconnu');
        const count = Number.isFinite(Number(item.count)) ? Number(item.count) : 0;
        return `${name} (${count}x)`;
      })
      .join(', ');
    lines.push(`Top artistes joués: ${artists}`);
  }

  const ignoredArtists = Array.isArray(src.ignored_artists) ? src.ignored_artists : [];
  if (ignoredArtists.length > 0) {
    const artists = ignoredArtists
      .slice(0, 5)
      .map((row) => asText(asRecord(row).artist, 'Artiste inconnu'))
      .join(', ');
    lines.push(`Artistes souvent ignorés: ${artists}`);
  }

  if (Number.isFinite(Number(src.play_ratio_pct))) {
    lines.push(`Taux de suggestions jouées: ${Number(src.play_ratio_pct)}%`);
  }

  return lines.length ? lines.join('\n') : 'Profil DJ présent mais sans données utiles';
}

function buildPrompt(payload: AutoDJPayload): string {
  const directionText = payload.dj_context.direction === 'down'
    ? 'DESCENDRE la tension'
    : 'MONTER la tension';

  const nowPlayingText = payload.now_playing
    ? `${payload.now_playing.title || 'Titre inconnu'} — ${payload.now_playing.artist || 'Artiste inconnu'}`
    : 'Aucun morceau en cours';

  const recentTracksText = payload.recent_tracks.length
    ? payload.recent_tracks
      .map((track, idx) => `${idx + 1}. ${track.title || 'Titre inconnu'} — ${track.artist || 'Artiste inconnu'}${track.played_at ? ` (${track.played_at})` : ''}`)
      .join('\n')
    : 'Aucun historique récent';

  const recentSuggestionsText = payload.recent_suggestions.length
    ? payload.recent_suggestions
      .map((s) => `${s.title || 'Titre inconnu'} — ${s.artist || 'Artiste inconnu'} | played=${s.was_played ? 'yes' : 'no'}`)
      .join('\n')
    : 'Aucune suggestion récente';

  const requestsText = payload.requests.length
    ? payload.requests
      .map((r) => `${r.title || 'Titre inconnu'} — ${r.artist || 'Artiste inconnu'} (${r.votes ?? 0} votes)`)
      .join('\n')
    : 'Aucune demande publique';

  const djProfileText = buildDjProfileSection(payload.dj_profile);

  const instructionText = payload.dj_context.instruction
    ? `Consigne DJ manuelle : "${payload.dj_context.instruction}"`
    : 'Aucune consigne DJ manuelle';

  return [
    'Tu es Auto-DJ V3. Réponds uniquement en JSON valide.',
    '',
    `Direction DJ: ${payload.dj_context.direction} (${directionText}).`,
    '',
    `${instructionText}`,
    '',
    'Objectif (par ordre de priorité):',
    '1. Respecter les morceaux réellement joués récemment comme trajectoire principale.',
    '2. Respecter la direction up/down demandée.',
    '3. Appliquer la consigne DJ manuelle en construisant une transition cohérente (ne pas ignorer le contexte réel).',
    '4. Prendre en compte les demandes publiques si cohérentes avec style/trajectoire/direction.',
    '5. Utiliser le profil historique du DJ.',
    '6. Pénaliser les suggestions déjà ignorées récemment.',
    '- Éviter les morceaux récemment joués.',
    '- Varier les artistes (éviter les doublons artiste).',
    '- Générer environ 15 candidats diversifiés.',
    '',
    `Now playing: ${nowPlayingText}`,
    '',
    'Recent tracks (ordre chronologique ancien -> récent):',
    recentTracksText,
    '',
    'Recent suggestions (incluant ignorées):',
    recentSuggestionsText,
    '',
    'Public requests:',
    requestsText,
    '',
    `DJ profile: ${djProfileText}`,
    '',
    'Format de sortie OBLIGATOIRE:',
    '{',
    '  "analysis": {',
    '    "current_style": "string",',
    '    "trajectory": "string",',
    '    "energy_estimate": 0-100 integer,',
    `    "direction": "${payload.dj_context.direction}",`,
    '    "confidence": 0-1 number',
    '  },',
    '  "candidates": [',
    '    {',
    '      "title": "string non vide",',
    '      "artist": "string non vide",',
    '      "reason": "string non vide",',
    '      "estimated_tension": 0-100 integer',
    '    }',
    '  ]',
    '}',
    '',
    'Contraintes finales:',
    '- candidates doit contenir entre 12 et 20 éléments (vise ~15).',
    '- Aucun texte hors JSON.',
    '- Ne retourne JAMAIS de clé "suggestions".',
    '- Ne retourne JAMAIS de clé "role_hint".',
  ].join('\n');
}

function stripJsonFences(text: string): string {
  return text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
}

function parseAnalysis(raw: unknown, expectedDirection: Direction): Analysis | null {
  const src = asRecord(raw);
  const current_style = asText(src.current_style);
  const trajectory = asText(src.trajectory);
  const energy_estimate = asIntInRange(src.energy_estimate, 0, 100);
  const direction = src.direction === 'up' || src.direction === 'down' ? src.direction : null;
  const confidence = asNumberInRange(src.confidence, 0, 1);

  if (!current_style || !trajectory || energy_estimate === null || !direction || confidence === null) return null;
  if (direction !== expectedDirection) return null;

  return {
    current_style,
    trajectory,
    energy_estimate,
    direction,
    confidence,
  };
}

function parseCandidate(raw: unknown): Candidate | null {
  const src = asRecord(raw);
  const title = asText(src.title);
  const artist = asText(src.artist);
  const reason = asText(src.reason);
  const estimated_tension = asIntInRange(src.estimated_tension, 0, 100);

  if (!title || !artist || !reason || estimated_tension === null) return null;

  return {
    title,
    artist,
    reason,
    estimated_tension,
  };
}

function validateV3Response(raw: unknown, expectedDirection: Direction): AutoDJV3Response {
  const src = asRecord(raw);
  const analysis = parseAnalysis(src.analysis, expectedDirection);
  if (!analysis) {
    throw new Error('Invalid auto-dj response: missing or invalid analysis');
  }

  if (!Array.isArray(src.candidates)) {
    throw new Error('Invalid auto-dj response: missing candidates');
  }

  const rawCandidates = src.candidates;
  if (rawCandidates.length < 12 || rawCandidates.length > 20) {
    throw new Error(
      `Invalid auto-dj response: raw candidates count out of range (12-20), raw=${rawCandidates.length}`,
    );
  }

  const candidates: Candidate[] = [];
  for (let i = 0; i < rawCandidates.length; i += 1) {
    const parsed = parseCandidate(rawCandidates[i]);
    if (!parsed) {
      throw new Error(`Invalid auto-dj response: invalid candidate at index ${i}`);
    }
    candidates.push(parsed);
  }

  return { analysis, candidates };
}

async function fetchAutoDJV3(payload: AutoDJPayload): Promise<AutoDJV3Response> {
  const apiKey = Deno.env.get('OPENAI_API_KEY');
  if (!apiKey) throw new Error('OPENAI_API_KEY manquant');

  const model = Deno.env.get('OPENAI_MODEL') || DEFAULT_OPENAI_MODEL;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: ['Bearer', apiKey].join(' '),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'Tu es un assistant Auto-DJ expert. Tu dois toujours répondre un JSON strict au format demandé.',
        },
        {
          role: 'user',
          content: buildPrompt(payload),
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
    throw new Error('OpenAI: empty content');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(content));
  } catch {
    throw new Error('OpenAI: invalid JSON');
  }

  return validateV3Response(parsed, payload.dj_context.direction);
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
    });
  }

  try {
    const payload = parsePayload(await req.json());

    if (!payload.now_playing || (!payload.now_playing.title && !payload.now_playing.artist)) {
      return new Response(JSON.stringify({ error: 'Missing now_playing' }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      });
    }

    if (payload.recent_tracks.length === 0) {
      return new Response(JSON.stringify({ error: 'recent_tracks must not be empty' }), {
        status: 400,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      });
    }

    const v3 = await fetchAutoDJV3(payload);

    return new Response(JSON.stringify(v3), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
      },
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Erreur inconnue' }),
      {
        status: 500,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      },
    );
  }
});
