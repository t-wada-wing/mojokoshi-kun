import {
  buildAnalysisZipResponse,
  ensureSchema,
  jsonResponse,
  parseDownloadIds,
  unauthorized,
  verifyPasscode,
  type Env,
  type TranscriptRecord,
} from '../_lib';

interface PagesContext {
  request: Request;
  env: Env;
}

const ANALYSIS_WHERE = `analysis IS NOT NULL AND trim(analysis) != ''`;

type AnalysisRecord = Pick<TranscriptRecord, 'id' | 'school' | 'filename'> & { analysis: string };

function hasAnalysis(record: {
  analysis?: string | null;
}): record is AnalysisRecord {
  return Boolean(record.analysis?.trim());
}

export const onRequestGet: PagesFunction<Env> = async (context: PagesContext) => {
  const { request, env } = context;

  if (!verifyPasscode(request, env)) {
    return unauthorized();
  }

  const url = new URL(request.url);
  const ids = parseDownloadIds(url.searchParams.get('ids'));
  const school = url.searchParams.get('school')?.trim();

  try {
    await ensureSchema(env);

    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(', ');
      const result = await env.DB.prepare(
        `SELECT id, school, filename, analysis
         FROM transcripts
         WHERE id IN (${placeholders})
         ORDER BY created_at ASC, id ASC`,
      )
        .bind(...ids)
        .all<Pick<TranscriptRecord, 'id' | 'school' | 'filename' | 'analysis'>>();

      const records = result.results ?? [];
      if (records.length === 0) {
        return jsonResponse({ ok: false, error: '選択した記録が見つかりません' }, 404);
      }

      if (records.length !== ids.length) {
        return jsonResponse({ ok: false, error: '選択した記録の一部が見つかりません' }, 404);
      }

      const analyzed = records.filter(hasAnalysis);
      if (analyzed.length === 0) {
        return jsonResponse({ ok: false, error: '分析済みの記録がありません' }, 400);
      }

      const schools = Array.from(new Set(analyzed.map((record) => record.school)));
      const zipFilename =
        schools.length === 1 ? `${schools[0]}_選択AI分析.zip` : '選択AI分析.zip';

      return buildAnalysisZipResponse(analyzed, zipFilename);
    }

    if (school) {
      const result = await env.DB.prepare(
        `SELECT id, school, filename, analysis
         FROM transcripts
         WHERE school = ? AND ${ANALYSIS_WHERE}
         ORDER BY created_at ASC, id ASC`,
      )
        .bind(school)
        .all<Pick<TranscriptRecord, 'id' | 'school' | 'filename' | 'analysis'>>();

      const records = (result.results ?? []).filter(hasAnalysis);
      if (records.length === 0) {
        return jsonResponse({ ok: false, error: '分析済みの記録がありません' }, 400);
      }

      return buildAnalysisZipResponse(records, `${school}_AI分析.zip`);
    }

    return jsonResponse({ ok: false, error: 'ids または school を指定してください' }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : '分析結果のダウンロードに失敗しました';
    return jsonResponse({ ok: false, error: message }, 500);
  }
};
