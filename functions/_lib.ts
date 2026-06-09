export interface Env {
  DB: D1Database;
  AUDIO: R2Bucket;
  OPENAI_API_KEY: string;
  DOWNLOAD_PASSCODE: string;
  TRANSCRIBE_MODEL?: string;
  UPLOAD_MAX_PER_IP_HOUR?: string;
  UPLOAD_MAX_PER_IP_DAY?: string;
  UPLOAD_MAX_GLOBAL_DAY?: string;
  UPLOAD_MAX_FILE_MB?: string;
  MAIL_API_KEY?: string;
  MAIL_FROM?: string;
  NOTIFY_EMAIL_TO?: string;
  APP_BASE_URL?: string;
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

export interface UploadLimitConfig {
  maxPerIpHour: number;
  maxPerIpDay: number;
  maxGlobalDay: number;
  maxFileBytes: number;
}

export interface UploadLimitResult {
  allowed: boolean;
  reason?: string;
  message?: string;
  perIpHourCount: number;
  perIpDayCount: number;
  globalDayCount: number;
  config: UploadLimitConfig;
}

export interface UploadEventInput {
  ipHash: string;
  school: string;
  grade: string;
  className: string;
  studentName: string;
  filename: string;
  fileSize: number;
  status: 'accepted' | 'completed' | 'rejected' | 'failed';
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

  await env.DB.prepare(`
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
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS upload_alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      ip_hash TEXT,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_upload_events_ip_created ON upload_events(ip_hash, created_at)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_upload_events_created ON upload_events(created_at)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_upload_alerts_created ON upload_alerts(created_at)`),
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

function positiveNumber(value: string | undefined, fallback: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue <= 0) return fallback;
  return numberValue;
}

export function getUploadLimitConfig(env: Env): UploadLimitConfig {
  const maxFileMb = positiveNumber(env.UPLOAD_MAX_FILE_MB, 25);
  return {
    maxPerIpHour: positiveNumber(env.UPLOAD_MAX_PER_IP_HOUR, 12),
    maxPerIpDay: positiveNumber(env.UPLOAD_MAX_PER_IP_DAY, 40),
    maxGlobalDay: positiveNumber(env.UPLOAD_MAX_GLOBAL_DAY, 150),
    maxFileBytes: Math.floor(maxFileMb * 1024 * 1024),
  };
}

export async function hashClientIp(request: Request): Promise<string> {
  const rawIp =
    request.headers.get('CF-Connecting-IP') ??
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ??
    'unknown';
  const data = new TextEncoder().encode(rawIp);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function checkUploadLimit(
  env: Env,
  ipHash: string,
  fileSize: number,
): Promise<UploadLimitResult> {
  const config = getUploadLimitConfig(env);
  const [perIpHour, perIpDay, globalDay] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM upload_events
       WHERE ip_hash = ? AND created_at >= datetime('now', '-1 hour')`,
    )
      .bind(ipHash)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM upload_events
       WHERE ip_hash = ? AND created_at >= datetime('now', '-1 day')`,
    )
      .bind(ipHash)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM upload_events
       WHERE created_at >= datetime('now', '-1 day')`,
    ).first<{ count: number }>(),
  ]);

  const result: UploadLimitResult = {
    allowed: true,
    perIpHourCount: perIpHour?.count ?? 0,
    perIpDayCount: perIpDay?.count ?? 0,
    globalDayCount: globalDay?.count ?? 0,
    config,
  };

  if (fileSize > config.maxFileBytes) {
    return {
      ...result,
      allowed: false,
      reason: 'file_size',
      message: `音声ファイルが大きすぎます。${Math.floor(config.maxFileBytes / 1024 / 1024)}MB以下にしてください。`,
    };
  }

  if (result.perIpHourCount >= config.maxPerIpHour) {
    return {
      ...result,
      allowed: false,
      reason: 'ip_hour',
      message: '短時間にアップロードが集中しています。しばらく時間をおいてから再度お試しください。',
    };
  }

  if (result.perIpDayCount >= config.maxPerIpDay) {
    return {
      ...result,
      allowed: false,
      reason: 'ip_day',
      message: '本日のアップロード数が多くなっています。管理者に確認してください。',
    };
  }

  if (result.globalDayCount >= config.maxGlobalDay) {
    return {
      ...result,
      allowed: false,
      reason: 'global_day',
      message: '本日の全体アップロード数が上限に達しました。管理者に確認してください。',
    };
  }

  return result;
}

export async function recordUploadEvent(env: Env, input: UploadEventInput): Promise<number | undefined> {
  const result = await env.DB.prepare(
    `INSERT INTO upload_events (ip_hash, school, grade, class, student_name, filename, file_size, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.ipHash,
      input.school,
      input.grade,
      input.className,
      input.studentName,
      input.filename,
      input.fileSize,
      input.status,
    )
    .run();

  return result.meta.last_row_id;
}

export async function updateUploadEventStatus(
  env: Env,
  id: number | undefined,
  status: UploadEventInput['status'],
): Promise<void> {
  if (!id) return;

  await env.DB.prepare(`UPDATE upload_events SET status = ? WHERE id = ?`)
    .bind(status, id)
    .run();
}

export async function recordUploadAlert(
  env: Env,
  kind: string,
  ipHash: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO upload_alerts (kind, ip_hash, detail)
     VALUES (?, ?, ?)`,
  )
    .bind(kind, ipHash, JSON.stringify(detail))
    .run();
}

export function formatTranscriptionError(status: number, errorText: string): string {
  if (status === 400) {
    if (errorText.includes('1500 seconds') || errorText.includes('longer than')) {
      return '音声が長すぎるため文字起こしできませんでした。しばらくしてから再度お試しください。';
    }
    if (errorText.includes('25') && errorText.toLowerCase().includes('mb')) {
      return '音声ファイルが大きすぎます。短い録音をお試しください。';
    }
  }

  return `OpenAI API error (${status}): ${errorText}`;
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
    throw new Error(formatTranscriptionError(response.status, errorText));
  }

  const data = (await response.json()) as { text?: string };
  if (!data.text) {
    throw new Error('文字起こし結果が空でした');
  }

  return data.text;
}

export interface TranscriptionChunkInput {
  blob: Blob;
  filename: string;
}

export async function transcribeAudioInChunks(
  env: Env,
  chunks: TranscriptionChunkInput[],
): Promise<string> {
  const parts: string[] = [];

  for (const chunk of chunks) {
    const text = await transcribeAudio(env, chunk.blob, chunk.filename);
    const trimmed = text.trim();
    if (trimmed) parts.push(trimmed);
  }

  return parts.join('\n');
}

export interface UploadNotificationInput {
  transcriptId?: number;
  school: string;
  grade: string;
  className: string;
  studentName: string;
  filename: string;
}

export function getNotifyRecipients(env: Env): string[] {
  const raw = env.NOTIFY_EMAIL_TO?.trim();
  if (!raw) return [];

  return raw
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
}

export function isMailConfigured(env: Env): boolean {
  return Boolean(
    env.MAIL_API_KEY?.trim() && env.MAIL_FROM?.trim() && getNotifyRecipients(env).length > 0,
  );
}

function parseMailFrom(from: string): { email: string; name?: string } {
  const match = from.match(/^(.+?)\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].trim(), email: match[2].trim() };
  }

  return { email: from };
}

export async function sendUploadNotification(
  env: Env,
  input: UploadNotificationInput,
): Promise<void> {
  if (!isMailConfigured(env)) return;

  const recipients = getNotifyRecipients(env);
  const adminUrl = env.APP_BASE_URL?.trim()
    ? `${env.APP_BASE_URL.replace(/\/$/, '')}/download`
    : undefined;

  const lines = [
    '新しい音声アップロードが完了しました。',
    '',
    `学校: ${input.school}`,
    `学年: ${input.grade}`,
    `クラス: ${input.className}`,
    `生徒: ${input.studentName}`,
    `ファイル: ${input.filename}`,
  ];

  if (input.transcriptId) {
    lines.push(`記録ID: ${input.transcriptId}`);
  }

  if (adminUrl) {
    lines.push('', `管理画面: ${adminUrl}`);
  }

  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.MAIL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: recipients.map((email) => ({ email })) }],
      from: parseMailFrom(env.MAIL_FROM!.trim()),
      subject: `[文字起こしくん] ${input.school} / ${input.studentName}`,
      content: [{ type: 'text/plain', value: lines.join('\n') }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Upload notification failed:', response.status, errorText);
  }
}

export function collectAudioFilesFromFormData(formData: FormData): File[] {
  const countRaw = formData.get('audioChunkCount');
  const parsedCount = Number(countRaw);
  const chunkCount =
    Number.isFinite(parsedCount) && parsedCount >= 1 ? Math.floor(parsedCount) : 0;

  if (chunkCount > 1) {
    const files: File[] = [];
    for (let i = 0; i < chunkCount; i += 1) {
      const entry = formData.get(`audio_${i}`);
      if (!(entry instanceof File) || entry.size === 0) {
        throw new Error(`音声チャンク ${i + 1} が不正です`);
      }
      files.push(entry);
    }
    return files;
  }

  const single = formData.get('audio');
  if (single instanceof File && single.size > 0) {
    return [single];
  }

  return [];
}
