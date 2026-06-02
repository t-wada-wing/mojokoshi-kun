import { ensureSchema, jsonResponse, unauthorized, verifyPasscode, type Env } from '../_lib';

interface PagesContext {
  request: Request;
  env: Env;
}

export const onRequestGet: PagesFunction<Env> = async (context: PagesContext) => {
  const { request, env } = context;

  if (!verifyPasscode(request, env)) {
    return unauthorized();
  }

  const school = new URL(request.url).searchParams.get('school')?.trim() ?? '';

  try {
    await ensureSchema(env);
    if (!school) {
      return jsonResponse({ ok: true, records: [] });
    }

    const result = await env.DB.prepare(
      `SELECT id, school, grade, class, student_name, filename, created_at, downloaded_at
       FROM transcripts
       WHERE school = ?
       ORDER BY created_at DESC, id DESC`,
    )
      .bind(school)
      .all<{
        id: number;
        school: string;
        grade: string;
        class: string;
        student_name: string;
        filename: string;
        created_at: string;
        downloaded_at: string | null;
      }>();

    return jsonResponse({
      ok: true,
      records: result.results ?? [],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '一覧の取得に失敗しました';
    return jsonResponse({ ok: false, error: message }, 500);
  }
};
