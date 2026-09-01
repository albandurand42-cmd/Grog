-- ============================================================
-- GROG — Nettoyage automatique des commentaires > 24 h
-- À exécuter via un cron job Supabase (pg_cron) ou manuellement.
-- Ne touche pas aux tables play_history / suggestion_history.
-- ============================================================

delete from public.comments
where created_at < now() - interval '24 hours';
