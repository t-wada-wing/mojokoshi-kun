import { strToU8, zipSync } from 'fflate';

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
  ANALYSIS_MODEL?: string;
  ANALYZE_MAX_GLOBAL_DAY?: string;
  ANALYZE_MAX_PER_IP_HOUR?: string;
  ANALYZE_MAX_INPUT_CHARS?: string;
  USD_JPY_RATE?: string;
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
  analysis?: string | null;
  analyzed_at?: string | null;
  analysis_model?: string | null;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface TranscriptionResult {
  text: string;
  usage: TokenUsage;
}

export interface AnalysisLimitConfig {
  maxPerIpHour: number;
  maxGlobalDay: number;
  maxInputChars: number;
}

export interface AnalysisLimitResult {
  allowed: boolean;
  reason?: string;
  message?: string;
  perIpHourCount: number;
  globalDayCount: number;
  config: AnalysisLimitConfig;
}

export interface AnalysisEventInput {
  ipHash: string;
  transcriptId: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  status: 'completed' | 'failed';
}

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export interface MonthlyUsageRow {
  month: string;
  transcribeUsd: number;
  analyzeUsd: number;
  totalUsd: number;
  totalJpy: number;
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

async function addColumnIfMissing(
  env: Env,
  table: 'transcripts' | 'upload_events',
  column: string,
  definition: string,
): Promise<void> {
  const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  if ((columns.results ?? []).some((item) => item.name === column)) {
    return;
  }

  try {
    await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('duplicate column name')) {
      return;
    }
    throw error;
  }
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

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS analysis_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip_hash TEXT NOT NULL,
      transcript_id INTEGER NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `).run();

  await addColumnIfMissing(env, 'transcripts', 'downloaded_at', 'TEXT');
  await addColumnIfMissing(env, 'transcripts', 'analysis', 'TEXT');
  await addColumnIfMissing(env, 'transcripts', 'analyzed_at', 'TEXT');
  await addColumnIfMissing(env, 'transcripts', 'analysis_model', 'TEXT');
  await addColumnIfMissing(env, 'upload_events', 'input_tokens', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing(env, 'upload_events', 'output_tokens', 'INTEGER NOT NULL DEFAULT 0');

  await env.DB.batch([
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_transcripts_school ON transcripts(school)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_transcripts_downloaded_at ON transcripts(downloaded_at)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_upload_events_ip_created ON upload_events(ip_hash, created_at)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_upload_events_created ON upload_events(created_at)`),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_upload_alerts_created ON upload_alerts(created_at)`),
    env.DB.prepare(
      `CREATE INDEX IF NOT EXISTS idx_analysis_events_ip_created ON analysis_events(ip_hash, created_at)`,
    ),
    env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_analysis_events_created ON analysis_events(created_at)`),
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

export function uniqueZipEntryName(filename: string, used: Map<string, number>): string {
  const count = used.get(filename) ?? 0;
  used.set(filename, count + 1);
  if (count === 0) return filename;

  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1) return `${filename}_${count + 1}`;
  const base = filename.slice(0, dotIndex);
  const ext = filename.slice(dotIndex);
  return `${base}_${count + 1}${ext}`;
}

export function analysisZipFilename(filename: string): string {
  return filename.replace(/\.txt$/i, '_分析.txt');
}

export interface ZipTextEntry {
  entryName: string;
  content: string;
}

export function buildZipResponse(entries: ZipTextEntry[], zipFilename: string): Response {
  const usedNames = new Map<string, number>();
  const zipEntries: Record<string, Uint8Array> = {};

  for (const entry of entries) {
    const zipName = uniqueZipEntryName(entry.entryName, usedNames);
    zipEntries[zipName] = strToU8(entry.content);
  }

  return new Response(zipSync(zipEntries), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(zipFilename),
    },
  });
}

export function buildTranscriptZipResponse(
  records: Array<Pick<TranscriptRecord, 'filename' | 'transcript'>>,
  zipFilename: string,
): Response {
  return buildZipResponse(
    records.map((record) => ({ entryName: record.filename, content: record.transcript })),
    zipFilename,
  );
}

export function buildAnalysisZipResponse(
  records: Array<Pick<TranscriptRecord, 'filename'> & { analysis: string }>,
  zipFilename: string,
): Response {
  return buildZipResponse(
    records.map((record) => ({
      entryName: analysisZipFilename(record.filename),
      content: record.analysis,
    })),
    zipFilename,
  );
}

export function parseDownloadIds(value: string | null): number[] {
  if (!value) return [];

  const ids = value
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);

  return Array.from(new Set(ids));
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

export async function updateUploadEventUsage(
  env: Env,
  id: number | undefined,
  usage: TokenUsage,
): Promise<void> {
  if (!id) return;

  await env.DB.prepare(
    `UPDATE upload_events SET input_tokens = ?, output_tokens = ? WHERE id = ?`,
  )
    .bind(usage.inputTokens, usage.outputTokens, id)
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

function parseTranscriptionUsage(data: unknown): TokenUsage {
  if (!data || typeof data !== 'object') {
    return { inputTokens: 0, outputTokens: 0 };
  }

  const usage = (data as { usage?: { input_tokens?: number; output_tokens?: number } }).usage;
  return {
    inputTokens: Math.max(0, usage?.input_tokens ?? 0),
    outputTokens: Math.max(0, usage?.output_tokens ?? 0),
  };
}

export async function transcribeAudio(
  env: Env,
  audio: Blob,
  filename: string,
): Promise<TranscriptionResult> {
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

  return {
    text: data.text,
    usage: parseTranscriptionUsage(data),
  };
}

export interface TranscriptionChunkInput {
  blob: Blob;
  filename: string;
}

export async function transcribeAudioInChunks(
  env: Env,
  chunks: TranscriptionChunkInput[],
): Promise<TranscriptionResult> {
  const parts: string[] = [];
  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  for (const chunk of chunks) {
    const result = await transcribeAudio(env, chunk.blob, chunk.filename);
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    const trimmed = result.text.trim();
    if (trimmed) parts.push(trimmed);
  }

  return {
    text: parts.join('\n'),
    usage,
  };
}

export function getAnalysisModel(env: Env): string {
  return env.ANALYSIS_MODEL?.trim() || 'gpt-4o-mini';
}

export function getAnalysisLimitConfig(env: Env): AnalysisLimitConfig {
  return {
    maxPerIpHour: positiveNumber(env.ANALYZE_MAX_PER_IP_HOUR, 30),
    maxGlobalDay: positiveNumber(env.ANALYZE_MAX_GLOBAL_DAY, 100),
    maxInputChars: positiveNumber(env.ANALYZE_MAX_INPUT_CHARS, 80000),
  };
}

export function getUsdJpyRate(env: Env): number {
  return positiveNumber(env.USD_JPY_RATE, 150);
}

const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-4o-mini-transcribe': { inputPer1M: 1.25, outputPer1M: 5.0 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
};

export function getModelPricing(model: string): ModelPricing {
  return DEFAULT_MODEL_PRICING[model] ?? DEFAULT_MODEL_PRICING['gpt-4o-mini'];
}

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = getModelPricing(model);
  return (
    (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M
  );
}

export function estimateCostJpy(usd: number, env: Env): number {
  return Math.round(usd * getUsdJpyRate(env) * 100) / 100;
}

export async function checkAnalysisLimit(
  env: Env,
  ipHash: string,
): Promise<AnalysisLimitResult> {
  const config = getAnalysisLimitConfig(env);
  const [perIpHour, globalDay] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM analysis_events
       WHERE ip_hash = ? AND status = 'completed' AND created_at >= datetime('now', '-1 hour')`,
    )
      .bind(ipHash)
      .first<{ count: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM analysis_events
       WHERE status = 'completed' AND created_at >= datetime('now', '-1 day')`,
    ).first<{ count: number }>(),
  ]);

  const result: AnalysisLimitResult = {
    allowed: true,
    perIpHourCount: perIpHour?.count ?? 0,
    globalDayCount: globalDay?.count ?? 0,
    config,
  };

  if (result.perIpHourCount >= config.maxPerIpHour) {
    return {
      ...result,
      allowed: false,
      reason: 'ip_hour',
      message: '短時間のAI分析が集中しています。しばらく時間をおいてから再度お試しください。',
    };
  }

  if (result.globalDayCount >= config.maxGlobalDay) {
    return {
      ...result,
      allowed: false,
      reason: 'global_day',
      message: '本日のAI分析数が上限に達しました。管理者に確認してください。',
    };
  }

  return result;
}

export async function recordAnalysisEvent(env: Env, input: AnalysisEventInput): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO analysis_events (ip_hash, transcript_id, model, input_tokens, output_tokens, status)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.ipHash,
      input.transcriptId,
      input.model,
      input.inputTokens,
      input.outputTokens,
      input.status,
    )
    .run();
}

export const ANALYSIS_SYSTEM_PROMPT = `あなたは学習塾の面談録音を整理するアシスタントです。
文字起こしテキストのみが与えられます。声のトーンや間のニュアンスは判断できないため、推測は「（推測）」と明記し、聞き取れない事項は③に回してください。

必ず次の構成で日本語のレポートを出力してください（見出し番号を含める）:

面談録音内容整理（{学年} {生徒氏名}さん）
① 本人の悩み
② 保護者不安
③ まだ聞けていないこと
④ 必要性形成できている場面
⑤ 本人・保護者の温度感変化
⑥ 次回行動形成状況

録音を聞き返しながら人で確認した方が良い論点
（テキストだけでは判断できない点を3〜5項目。各項目に確認すべき観点を書く）

--- 出力例（形式の参考） ---
面談録音内容整理（中3 榎本大雅さん）
① 本人の悩み
英語を「しゃべれるようになりたい」という希望がある。
春の時点から「できれば錬成会に（通いたい）」という本人の意向があったものの、現在通っている塾の曜日が土曜日に変更になったため、すぐの通塾は難しくなっている状況。

② 保護者不安
実践的な英会話を学ぶには、錬成会ではなく専門の英会話教室に行く必要があるのではないかという懸念。
特選クラスが平日（水・金）開催であるのに対し、下の子の野球の試合等で土日も忙しく、現状は平日の通塾に難しさを感じている。

③ まだ聞けていないこと
現在通塾している塾での具体的な学習状況や、成績・学習に対する課題感。
中体連終了後における、大雅くん本人の具体的な学習・通塾に関する意思。
受験生としての具体的な志望校（※次回の面談で確認予定）。

④ 必要性形成できている場面
夏期講習会（特選クラス）への申し込みが完了し、受講の合意が取れている。
保護者自身から「私としては、土曜日一緒に（友人の）結翔くんと通ってほしいとずっと言っている」と、錬成会へ通わせることへの明確な希望が語られている。

⑤ 本人・保護者の温度感変化
英語の授業（オンライン英会話）に関心を示していたが、特選クラスの実施が平日であると知った際、「あ、そっかそっか、平日なんですもんね」とトーンダウンしている場面がある。
その後、夏期講習前に入塾を確定させた場合のキャンペーン（7月分授業料無料）を案内された際、「特典があるんですね」「本人と相談して決めたい」と、入塾検討に向けて前向きな反応へと変化している。

⑥ 次回行動形成状況
6月25日（木）14:30より、お母様とのご面談（志望校に向けた状況確認など）を実施することで日時が確定した。
先生から大雅くんへ、中体連と月末の定期試験に向けた応援メッセージを託し、お母様がそれを伝えることで合意した。

録音を聞き返しながら人で確認した方が良い論点
「平日が難しい」という発言のニュアンス: どの程度絶対的な制約なのか（送迎の問題か、部活等の時間的な問題か）、調整の余地が含まれている声色かどうかを確認する。
入塾特典（7月分無料）を提示された際の反応の温度感: 「特典があるんですね」という反応が、単なる相槌か、早期入塾への強い動機付けとして響いているか、声のトーンから見極める。
「結翔くんと一緒に通ってほしい（土曜日）」という保護者の意向の強さ: 「特選クラス（平日）」の受講と、「結翔くんと同じクラス・曜日（土曜）」のどちらを保護者が最終的に優先したいと考えているか、発言時の感情の乗り方から確認する。`;

export interface AnalyzeTranscriptResult {
  analysis: string;
  usage: TokenUsage;
  model: string;
}

export async function analyzeTranscript(
  env: Env,
  record: Pick<TranscriptRecord, 'school' | 'grade' | 'class' | 'student_name' | 'transcript'>,
): Promise<AnalyzeTranscriptResult> {
  const model = getAnalysisModel(env);
  const userContent = [
    `スクール: ${record.school}`,
    `学年: ${record.grade}`,
    `クラス: ${record.class}`,
    `生徒氏名: ${record.student_name}`,
    '',
    '--- 文字起こし ---',
    record.transcript,
  ].join('\n');

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0.3,
      max_tokens: 4000,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const analysis = data.choices?.[0]?.message?.content?.trim();
  if (!analysis) {
    throw new Error('分析結果が空でした');
  }

  return {
    analysis,
    model,
    usage: {
      inputTokens: Math.max(0, data.usage?.prompt_tokens ?? 0),
      outputTokens: Math.max(0, data.usage?.completion_tokens ?? 0),
    },
  };
}

interface UsageAggregateRow {
  month: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export async function getMonthlyUsage(env: Env, months = 6): Promise<MonthlyUsageRow[]> {
  const transcribeModel = getTranscribeModel(env);
  const uploadRows = await env.DB.prepare(
    `SELECT strftime('%Y-%m', created_at) AS month,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens
     FROM upload_events
     WHERE status = 'completed'
       AND created_at >= datetime('now', 'start of month', '-' || ? || ' months')
     GROUP BY month`,
  )
    .bind(months - 1)
    .all<{ month: string; input_tokens: number; output_tokens: number }>();

  const analysisRows = await env.DB.prepare(
    `SELECT strftime('%Y-%m', created_at) AS month,
            model,
            SUM(input_tokens) AS input_tokens,
            SUM(output_tokens) AS output_tokens
     FROM analysis_events
     WHERE status = 'completed'
       AND created_at >= datetime('now', 'start of month', '-' || ? || ' months')
     GROUP BY month, model`,
  )
    .bind(months - 1)
    .all<UsageAggregateRow>();

  const monthMap = new Map<string, { transcribeUsd: number; analyzeUsd: number }>();

  const ensureMonth = (month: string) => {
    if (!monthMap.has(month)) {
      monthMap.set(month, { transcribeUsd: 0, analyzeUsd: 0 });
    }
    return monthMap.get(month)!;
  };

  for (const row of uploadRows.results ?? []) {
    const entry = ensureMonth(row.month);
    entry.transcribeUsd += estimateCostUsd(
      transcribeModel,
      row.input_tokens,
      row.output_tokens,
    );
  }

  for (const row of analysisRows.results ?? []) {
    const entry = ensureMonth(row.month);
    entry.analyzeUsd += estimateCostUsd(row.model, row.input_tokens, row.output_tokens);
  }

  const sortedMonths = [...monthMap.keys()].sort((a, b) => b.localeCompare(a));

  return sortedMonths.map((month) => {
    const costs = monthMap.get(month)!;
    const totalUsd = costs.transcribeUsd + costs.analyzeUsd;
    return {
      month,
      transcribeUsd: Math.round(costs.transcribeUsd * 10000) / 10000,
      analyzeUsd: Math.round(costs.analyzeUsd * 10000) / 10000,
      totalUsd: Math.round(totalUsd * 10000) / 10000,
      totalJpy: estimateCostJpy(totalUsd, env),
    };
  });
}

export async function getTodayAnalysisStats(env: Env): Promise<{
  count: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  estimatedJpy: number;
}> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(input_tokens), 0) AS input_tokens,
            COALESCE(SUM(output_tokens), 0) AS output_tokens,
            model
     FROM analysis_events
     WHERE status = 'completed' AND created_at >= datetime('now', '-1 day')
     GROUP BY model`,
  ).all<{ count: number; input_tokens: number; output_tokens: number; model: string }>();

  let count = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let estimatedUsd = 0;

  for (const item of row.results ?? []) {
    count += item.count;
    inputTokens += item.input_tokens;
    outputTokens += item.output_tokens;
    estimatedUsd += estimateCostUsd(item.model, item.input_tokens, item.output_tokens);
  }

  return {
    count,
    inputTokens,
    outputTokens,
    estimatedUsd: Math.round(estimatedUsd * 10000) / 10000,
    estimatedJpy: estimateCostJpy(estimatedUsd, env),
  };
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
