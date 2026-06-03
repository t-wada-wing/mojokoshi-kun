-- AI分析機能削除後の D1 掃除（本番・ローカル共通）
DROP INDEX IF EXISTS idx_analysis_events_ip_created;
DROP INDEX IF EXISTS idx_analysis_events_created;
DROP TABLE IF EXISTS analysis_events;

ALTER TABLE transcripts DROP COLUMN analysis;
ALTER TABLE transcripts DROP COLUMN analyzed_at;
ALTER TABLE transcripts DROP COLUMN analysis_model;
