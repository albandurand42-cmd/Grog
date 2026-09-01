-- ============================================================
-- GROG — Nettoyage automatique des commentaires > 24 h
-- À exécuter via un cron job Supabase (pg_cron) ou manuellement.
-- Ne touche pas aux tables play_history / suggestion_history.
--
-- Stratégie :
--   - pending/rejected après 24 h : supprimés (jamais diffusés)
--   - approved après 7 jours : supprimés (affichés, plus utiles)
-- ============================================================

-- Commentaires non diffusés (pending ou rejected) après 24 h
delete from public.comments
where status in ('pending', 'rejected')
  and created_at < now() - interval '24 hours';

-- Commentaires approuvés après 7 jours
delete from public.comments
where status = 'approved'
  and created_at < now() - interval '7 days';

