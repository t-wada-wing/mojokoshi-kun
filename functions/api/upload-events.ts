import { ensureSchema, jsonResponse, unauthorized, verifyPasscode, type Env } from '../_lib';

interface PagesContext {
  request: Request;
  env: Env;
}

interface UploadEventRow {
  id: number;
  school: string | null;
  grade: string | null;
  class: string | null;
  student_name: string | null;
  filename: string | null;
  file_size: number;
  status: string;
  created_at: string;
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
          `SELECT id, school, grade, class, student_name, filename, file_size, status, created_at
           FROM upload_events
           WHERE school = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        ).bind(school, limit)
      : env.DB.prepare(
          `SELECT id, school, grade, class, student_name, filename, file_size, status, created_at
           FROM upload_events
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        ).bind(limit);

    const result = await query.all<UploadEventRow>();

    return jsonResponse({
      ok: true,
      events: result.results ?? [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'アップロード履歴の取得に失敗しました';
    return jsonResponse({ ok: false, error: message }, 500);
  }
};
