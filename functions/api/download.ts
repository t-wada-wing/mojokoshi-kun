import { zipSync, strToU8 } from 'fflate';
import {
  contentDisposition,
  ensureSchema,
  jsonResponse,
  unauthorized,
  verifyPasscode,
  type Env,
  type TranscriptRecord,
} from '../_lib';

interface PagesContext {
  request: Request;
  env: Env;
}

function uniqueZipName(filename: string, used: Map<string, number>): string {
  const count = used.get(filename) ?? 0;
  used.set(filename, count + 1);
  if (count === 0) return filename;

  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1) return `${filename}_${count + 1}`;
  const base = filename.slice(0, dotIndex);
  const ext = filename.slice(dotIndex);
  return `${base}_${count + 1}${ext}`;
}

function parseIds(value: string | null): number[] {
  if (!value) return [];

  const ids = value
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((id) => Number.isInteger(id) && id > 0);

  return Array.from(new Set(ids));
}

async function markDownloaded(env: Env, ids: number[]): Promise<void> {
  if (ids.length === 0) return;

  const placeholders = ids.map(() => '?').join(', ');
  await env.DB.prepare(
    `UPDATE transcripts
     SET downloaded_at = datetime('now')
     WHERE id IN (${placeholders})`,
  )
    .bind(...ids)
    .run();
}

function buildZipResponse(
  records: Array<Pick<TranscriptRecord, 'id' | 'filename' | 'school' | 'transcript'>>,
  zipFilename: string,
): Response {
  const usedNames = new Map<string, number>();
  const zipEntries: Record<string, Uint8Array> = {};

  for (const record of records) {
    const zipName = uniqueZipName(record.filename, usedNames);
    zipEntries[zipName] = strToU8(record.transcript);
  }

  return new Response(zipSync(zipEntries), {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(zipFilename),
    },
  });
}

export const onRequestGet: PagesFunction<Env> = async (context: PagesContext) => {
  const { request, env } = context;

  if (!verifyPasscode(request, env)) {
    return unauthorized();
  }

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const ids = parseIds(url.searchParams.get('ids'));
  const school = url.searchParams.get('school')?.trim();

  try {
    await ensureSchema(env);
    if (id) {
      const record = await env.DB.prepare(
        `SELECT id, filename, transcript FROM transcripts WHERE id = ?`,
      )
        .bind(Number(id))
        .first<Pick<TranscriptRecord, 'id' | 'filename' | 'transcript'>>();

      if (!record) {
        return jsonResponse({ ok: false, error: '記録が見つかりません' }, 404);
      }

      await markDownloaded(env, [record.id]);

      return new Response(record.transcript, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': contentDisposition(record.filename),
        },
      });
    }

    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(', ');
      const result = await env.DB.prepare(
        `SELECT id, school, filename, transcript
         FROM transcripts
         WHERE id IN (${placeholders})
         ORDER BY created_at ASC, id ASC`,
      )
        .bind(...ids)
        .all<Pick<TranscriptRecord, 'id' | 'school' | 'filename' | 'transcript'>>();

      const records = result.results ?? [];
      if (records.length === 0) {
        return jsonResponse({ ok: false, error: '選択した記録が見つかりません' }, 404);
      }

      if (records.length !== ids.length) {
        return jsonResponse({ ok: false, error: '選択した記録の一部が見つかりません' }, 404);
      }

      const schools = Array.from(new Set(records.map((record) => record.school)));
      const zipFilename =
        schools.length === 1 ? `${schools[0]}_選択文字起こし.zip` : '選択文字起こし.zip';

      const response = buildZipResponse(records, zipFilename);
      await markDownloaded(
        env,
        records.map((record) => record.id),
      );
      return response;
    }

    if (school) {
      const result = await env.DB.prepare(
        `SELECT id, school, filename, transcript
         FROM transcripts
         WHERE school = ?
         ORDER BY created_at ASC, id ASC`,
      )
        .bind(school)
        .all<Pick<TranscriptRecord, 'id' | 'school' | 'filename' | 'transcript'>>();

      const records = result.results ?? [];
      if (records.length === 0) {
        return jsonResponse({ ok: false, error: 'このスクールの記録はありません' }, 404);
      }

      const response = buildZipResponse(records, `${school}_文字起こし.zip`);
      await markDownloaded(
        env,
        records.map((record) => record.id),
      );
      return response;
    }

    return jsonResponse({ ok: false, error: 'id または school を指定してください' }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ダウンロードに失敗しました';
    return jsonResponse({ ok: false, error: message }, 500);
  }
};
