// Auto-DJ V3 Edge Function
// Analyzes music trajectory and generates intelligent suggestions with diversification
// Deployed to Supabase Edge Functions

import Anthropic from "@anthropic-ai/sdk";

interface Track {
  spotify_track_id: string;
  title: string;
  artist: string;
  played_at?: string;
}

interface Request {
  title: string;
  artist: string;
  votes: number;
}

interface RecentSuggestion {
  title: string;
  artist: string;
  was_played: boolean;
}

interface DJContext {
  direction: "up" | "down";
  instruction: string;
}

interface Payload {
  now_playing: {
    spotify_track_id: string;
    title: string;
    artist: string;
  };
  recent_tracks: Track[];
  recent_suggestions: RecentSuggestion[];
  requests: Request[];
  dj_context: DJContext;
}

interface Analysis {
  current_style: string;
  trajectory: string;
  energy_estimate: number;
  direction: string;
  confidence: number;
}

interface Candidate {
  title: string;
  artist: string;
  reason: string;
  estimated_tension: number;
}

interface ResponsePayload {
  analysis: Analysis;
  candidates: Candidate[];
}

const client = new Anthropic();

function analyzeTrajectory(tracks: Track[]): Analysis {
  if (!tracks.length) {
    return {
      current_style: "Unknown",
      trajectory: "No history",
      energy_estimate: 50,
      direction: "neutral",
      confidence: 0.3,
    };
  }

  const stylePatterns = analyzeStylePatterns(tracks);
  const energyTrend = estimateEnergyTrend(tracks);

  return {
    current_style: stylePatterns.style,
    trajectory: stylePatterns.trajectory,
    energy_estimate: energyTrend.current,
    direction: energyTrend.trend,
    confidence: Math.min(0.95, 0.5 + tracks.length * 0.08),
  };
}

function analyzeStylePatterns(tracks: Track[]): {
  style: string;
  trajectory: string;
} {
  const styleKeywords: Record<string, string[]> = {
    disco: ["disco", "bee gees", "donna summer", "earth wind", "chic"],
    "french touch": [
      "daft punk",
      "modjo",
      "stardust",
      "cassius",
      "justice",
      "sebastian",
    ],
    electro: ["justice", "daft punk", "deadmau5", "tiësto"],
    house: ["house", "david guetta", "calvin harris"],
    techno: ["techno", "richie hawtin", "carl cox"],
    funk: ["funk", "earth wind", "james brown"],
    soul: ["soul", "marvin gaye", "al green"],
    jazz: ["jazz", "miles davis", "coltrane"],
  };

  let detectedStyles = new Map<string, number>();

  for (const track of tracks) {
    const combined = (track.title + " " + track.artist).toLowerCase();
    for (const [style, keywords] of Object.entries(styleKeywords)) {
      for (const keyword of keywords) {
        if (combined.includes(keyword)) {
          detectedStyles.set(style, (detectedStyles.get(style) || 0) + 1);
        }
      }
    }
  }

  let mainStyle = "Mixed";
  let maxCount = 0;
  for (const [style, count] of detectedStyles) {
    if (count > maxCount) {
      maxCount = count;
      mainStyle = style;
    }
  }

  const styles = Array.from(detectedStyles.keys()).slice(0, 3);
  const trajectory =
    styles.length > 1
      ? `${styles[0].charAt(0).toUpperCase() + styles[0].slice(1)} → ${styles.slice(1).join(" → ")}`
      : mainStyle;

  return {
    style: mainStyle.charAt(0).toUpperCase() + mainStyle.slice(1),
    trajectory,
  };
}

function estimateEnergyTrend(tracks: Track[]): {
  current: number;
  trend: string;
} {
  const energyMap: Record<string, number> = {
    electro: 85,
    techno: 80,
    house: 75,
    "french touch": 72,
    funk: 78,
    disco: 80,
    soul: 55,
    jazz: 50,
  };

  let totalEnergy = 0;
  for (const track of tracks) {
    const combined = (track.title + " " + track.artist).toLowerCase();
    for (const [genre, energy] of Object.entries(energyMap)) {
      if (combined.includes(genre)) {
        totalEnergy += energy;
        break;
      }
    }
  }

  const current =
    tracks.length > 0 ? Math.round(totalEnergy / tracks.length) : 50;

  let trend = "stable";
  if (tracks.length >= 2) {
    const recent = tracks.slice(0, 2);
    const older = tracks.slice(2, 4);
    if (recent.length > 0 && older.length > 0) {
      const recentEnergy = estimateTrackEnergy(recent[0]);
      const olderEnergy = estimateTrackEnergy(older[0]);
      if (recentEnergy > olderEnergy + 10) trend = "up";
      else if (recentEnergy < olderEnergy - 10) trend = "down";
    }
  }

  return { current, trend };
}

function estimateTrackEnergy(track: Track): number {
  const combined = (track.title + " " + track.artist).toLowerCase();
  const energyMap: Record<string, number> = {
    electro: 85,
    techno: 80,
    house: 75,
    funk: 78,
    disco: 80,
  };

  for (const [genre, energy] of Object.entries(energyMap)) {
    if (combined.includes(genre)) return energy;
  }
  return 50;
}

async function generateCandidatesWithAI(
  payload: Payload,
  analysis: Analysis
): Promise<Candidate[]> {
  const recentTracksInfo = payload.recent_tracks
    .slice(0, 15)
    .map((t) => `${t.title} - ${t.artist}`)
    .join("\n");

  const recentSuggestionsInfo =
    payload.recent_suggestions && payload.recent_suggestions.length > 0
      ? payload.recent_suggestions
          .slice(0, 20)
          .map(
            (s) =>
              `${s.title} - ${s.artist} [played: ${s.was_played}]`
          )
          .join("\n")
      : "None";

  const requestsInfo =
    payload.requests && payload.requests.length > 0
      ? payload.requests
          .slice(0, 10)
          .map((r) => `${r.title} - ${r.artist} (${r.votes} votes)`)
          .join("\n")
      : "None";

  const instructionText = payload.dj_context.instruction
    ? `DJ MANUAL INSTRUCTION: "${payload.dj_context.instruction}" (build a coherent transition, don't ignore the real context)`
    : "";

  const prompt = `You are an expert DJ AI assistant analyzing music trends for Auto-DJ V3.

CURRENT ANALYSIS:
- Current style: ${analysis.current_style}
- Trajectory: ${analysis.trajectory}
- Energy level: ${analysis.energy_estimate}/100
- Detected direction: ${analysis.direction}
- Confidence: ${analysis.confidence * 100}%

CURRENT PLAYING:
${payload.now_playing.title} - ${payload.now_playing.artist}

LAST 15 TRACKS PLAYED (recent to oldest):
${recentTracksInfo}

LAST 20 SUGGESTIONS (including ignored):
${recentSuggestionsInfo}

PUBLIC REQUESTS (pending):
${requestsInfo}

DJ DIRECTION PREFERENCE: ${payload.dj_context.direction === "up" ? "ASCENDING (increase energy/intensity)" : "DESCENDING (reduce energy/intensity)"}
${instructionText}

YOUR TASK:
Generate exactly 15 candidate tracks that would work well as the next suggestion.

Priority order:
1. Recent tracks played (real context)
2. DJ direction up/down
3. DJ manual instruction (coherent transition)
4. Public requests (if consistent)

For each candidate, provide:
1. title: exact track title
2. artist: artist name
3. reason: brief explanation why this works (max 2 sentences)
4. estimated_tension: 0-100 scale (0=calm, 100=intense)

CONSTRAINTS:
- Avoid the currently playing track
- Avoid tracks from the last 15 played
- Never repeat suggestions that were ignored multiple times
- Ensure diversity: don't suggest the same artist twice
- Respect the DJ's direction preference
- Consider public requests but evaluate them critically
- Tracks must exist on Spotify and be findable

Return ONLY valid JSON array with exactly 15 candidates. No markdown, no explanation.

Format:
[
  {
    "title": "...",
    "artist": "...",
    "reason": "...",
    "estimated_tension": 75
  },
  ...
]`;

  const message = await client.messages.create({
    model: "claude-3-5-sonnet-20241022",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: prompt,
      },
    ],
  });

  const responseText =
    message.content[0].type === "text" ? message.content[0].text : "[]";

  let candidates: Candidate[] = [];
  try {
    const cleaned = responseText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    candidates = JSON.parse(cleaned);

    if (!Array.isArray(candidates)) candidates = [];
    candidates = candidates.slice(0, 15);
  } catch (err) {
    console.error("JSON parse error:", err);
    candidates = [];
  }

  return candidates;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const payload: Payload = await req.json();

    if (!payload.now_playing || !Array.isArray(payload.recent_tracks)) {
      return new Response(JSON.stringify({ error: "Invalid payload" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const analysis = analyzeTrajectory(payload.recent_tracks);
    const candidates = await generateCandidatesWithAI(payload, analysis);

    const response: ResponsePayload = {
      analysis,
      candidates,
    };

    return new Response(JSON.stringify(response), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    console.error("Error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
