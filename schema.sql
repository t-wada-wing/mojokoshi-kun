CREATE TABLE IF NOT EXISTS transcripts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  school TEXT NOT NULL,
  grade TEXT NOT NULL,
  class TEXT NOT NULL,
  student_name TEXT NOT NULL,
  filename TEXT NOT NULL,
  transcript TEXT NOT NULL,
  audio_key TEXT,
  model TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  downloaded_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_transcripts_school ON transcripts(school);
CREATE INDEX IF NOT EXISTS idx_transcripts_downloaded_at ON transcripts(downloaded_at);

CREATE TABLE IF NOT EXISTS upload_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT NOT NULL,
  school TEXT,
  grade TEXT,
  class TEXT,
  student_name TEXT,
  filename TEXT,
  file_size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS upload_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  ip_hash TEXT,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_upload_events_ip_created ON upload_events(ip_hash, created_at);
CREATE INDEX IF NOT EXISTS idx_upload_events_created ON upload_events(created_at);
CREATE INDEX IF NOT EXISTS idx_upload_alerts_created ON upload_alerts(created_at);
