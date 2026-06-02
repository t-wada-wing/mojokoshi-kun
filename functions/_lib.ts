export interface Env {
  DB: D1Database;
  AUDIO: R2Bucket;
  OPENAI_API_KEY: string;
  DOWNLOAD_PASSCODE: string;
  TRANSCRIBE_MODEL?: string;
}

export interface TranscriptRecord {
  id: number;
  school: string;
  grade: string;
  class: string;
  student_name: string;
  filename: string;
  transcript: string;
  audio_key: string | null;
  model: string | null;
  created_at: string;
  downloaded_at: string | null;
}

export async function ensureSchema(env: Env): Promise<void> {
  await env.DB.prepare(`
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
    )
  `).run();

  const columns = await env.DB.prepare(`PRAGMA table_info(transcripts)`).all<{ name: string }>();
  const hasDownloadedAt = (columns.results ?? []).some((column) => column.name === 'downloaded_at');
  if (!hasDownloadedAt) {
    await env.DB.prepare(`ALTER TABLE transcripts ADD COLUMN downloaded_at TEXT`).run();
  }

  await env.DB.batch([
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_transcripts_school ON transcripts(school)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_transcripts_downloaded_at ON transcripts(downloaded_at)`),
  ]);
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
  });
}

export function verifyPasscode(request: Request, env: Env): boolean {
  const passcode = request.headers.get('X-Passcode') ?? new URL(request.url).searchParams.get('passcode');
  return passcode === env.DOWNLOAD_PASSCODE;
}

export function unauthorized(): Response {
  return jsonResponse({ ok: false, error: 'パスコードが正しくありません' }, 401);
}

export function buildFilename(
  school: string,
  grade: string,
  className: string,
  studentName: string,
): string {
  const raw = `${school}_${grade}_${className}_${studentName}.txt`;
  return raw.replace(/[\\/:*?"<>|]/g, '_');
}

export function contentDisposition(filename: string): string {
  const encoded = encodeURIComponent(filename);
  return `attachment; filename*=UTF-8''${encoded}`;
}

export function getTranscribeModel(env: Env): string {
  return env.TRANSCRIBE_MODEL?.trim() || 'gpt-4o-mini-transcribe';
}

export async function transcribeAudio(
  env: Env,
  audio: Blob,
  filename: string,
): Promise<string> {
  const formData = new FormData();
  formData.append('file', audio, filename);
  formData.append('model', getTranscribeModel(env));
  formData.append('language', 'ja');
  formData.append('response_format', 'json');

  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as { text?: string };
  if (!data.text) {
    throw new Error('文字起こし結果が空でした');
  }

  return data.text;
}
