import { ensureSchema, jsonResponse, unauthorized, verifyPasscode, type Env } from '../_lib';

interface PagesContext {
  request: Request;
  env: Env;
}

interface DownloadEventRow {
  id: number;
  school: string;
  grade: string;
  class: string;
  student_name: string;
  filename: string;
  created_at: string;
  downloaded_at: string;
}

export const onRequestGet: PagesFunction<Env> = async (context: PagesContext) => {
  const { request, env } = context;

  if (!verifyPasscode(request, env)) {
    return unauthorized();
  }

  const url = new URL(request.url);
  const school = url.searchParams.get('school')?.trim() ?? '';
  const limitRaw = Number(url.searchParams.get('limit') ?? '50');
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 200) : 50;

  try {
    await ensureSchema(env);

    const query = school
      ? env.DB.prepare(
          `SELECT id, school, grade, class, student_name, filename, created_at, downloaded_at
           FROM transcripts
           WHERE downloaded_at IS NOT NULL AND school = ?
           ORDER BY downloaded_at DESC, id DESC
           LIMIT ?`,
        ).bind(school, limit)
      : env.DB.prepare(
          `SELECT id, school, grade, class, student_name, filename, created_at, downloaded_at
           FROM transcripts
           WHERE downloaded_at IS NOT NULL
           ORDER BY downloaded_at DESC, id DESC
           LIMIT ?`,
        ).bind(limit);

    const result = await query.all<DownloadEventRow>();

    return jsonResponse({
      ok: true,
      events: result.results ?? [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ダウンロード実行履歴の取得に失敗しました';
    return jsonResponse({ ok: false, error: message }, 500);
  }
};
