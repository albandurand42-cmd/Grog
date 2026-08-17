-- Migration: Auto-DJ mémoire longue V2 — non destructive
-- Ajoute source à play_history ; étend suggestion_history avec raison, tension, direction, context_style.
-- Supprime la limite 24h dans les fonctions helper pour garantir la persistance totale.

-- ── play_history ──────────────────────────────────────────────────────────────
-- Crée la table si elle n'existe pas (safety net pour environnements vierges)
CREATE TABLE IF NOT EXISTS play_history (
  id BIGSERIAL PRIMARY KEY,
  spotify_track_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  artist TEXT NOT NULL DEFAULT '',
  played_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Ajout de la colonne source (non destructif)
ALTER TABLE play_history ADD COLUMN IF NOT EXISTS source TEXT;

-- Index sur played_at pour les requêtes chronologiques
CREATE INDEX IF NOT EXISTS idx_play_history_played_at
  ON play_history(played_at DESC);

CREATE INDEX IF NOT EXISTS idx_play_history_spotify_track_id
  ON play_history(spotify_track_id);

-- RLS
ALTER TABLE play_history ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'play_history' AND policyname = 'Public read play_history'
  ) THEN
    EXECUTE 'CREATE POLICY "Public read play_history" ON play_history FOR SELECT USING (true)';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'play_history' AND policyname = 'DJ admin insert play_history'
  ) THEN
    EXECUTE 'CREATE POLICY "DJ admin insert play_history" ON play_history FOR INSERT WITH CHECK (true)';
  END IF;
END $$;

-- ── suggestion_history ────────────────────────────────────────────────────────
-- Colonnes supplémentaires pour la mémoire longue (non destructif)
ALTER TABLE suggestion_history ADD COLUMN IF NOT EXISTS reason TEXT;
ALTER TABLE suggestion_history ADD COLUMN IF NOT EXISTS estimated_tension INTEGER;
ALTER TABLE suggestion_history ADD COLUMN IF NOT EXISTS direction TEXT;
ALTER TABLE suggestion_history ADD COLUMN IF NOT EXISTS context_style TEXT;

-- Index supplémentaires
CREATE INDEX IF NOT EXISTS idx_suggestion_history_direction
  ON suggestion_history(direction);

CREATE INDEX IF NOT EXISTS idx_suggestion_history_context_style
  ON suggestion_history(context_style);

-- ── Fonctions helper — sans limite 24h ────────────────────────────────────────

-- Marquer un morceau comme joué (aucune limite temporelle, tous les non-joués)
CREATE OR REPLACE FUNCTION mark_suggestion_as_played(
  p_spotify_track_id TEXT,
  p_limit INT DEFAULT 1
)
RETURNS INT AS $$
DECLARE
  v_updated INT;
BEGIN
  UPDATE suggestion_history
  SET was_played = TRUE
  WHERE spotify_track_id = p_spotify_track_id
    AND was_played = FALSE
  ORDER BY suggested_at DESC
  LIMIT p_limit;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$ LANGUAGE plpgsql;

-- Stats globales sur les suggestions (pas de filtre 24h par défaut)
CREATE OR REPLACE FUNCTION get_suggestion_stats(
  p_days INT DEFAULT 0
)
RETURNS TABLE(
  spotify_track_id TEXT,
  title TEXT,
  artist TEXT,
  total_suggestions INT,
  times_played INT,
  play_rate NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    sh.spotify_track_id,
    sh.title,
    sh.artist,
    COUNT(*)::INT AS total_suggestions,
    COUNT(*) FILTER (WHERE sh.was_played)::INT AS times_played,
    ROUND(COUNT(*) FILTER (WHERE sh.was_played)::NUMERIC / NULLIF(COUNT(*)::NUMERIC, 0), 3) AS play_rate
  FROM suggestion_history sh
  WHERE (p_days = 0 OR sh.suggested_at > NOW() - (p_days || ' days')::INTERVAL)
  GROUP BY sh.spotify_track_id, sh.title, sh.artist
  ORDER BY total_suggestions DESC;
END;
$$ LANGUAGE plpgsql;
