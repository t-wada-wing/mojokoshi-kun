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
