import {
  ensureSchema,
  getUploadLimitConfig,
  jsonResponse,
  unauthorized,
  verifyPasscode,
  type Env,
} from '../_lib';

interface PagesContext {
  request: Request;
  env: Env;
}

interface UploadSummaryRow {
  total_count: number;
  completed_count: number;
  rejected_count: number;
  failed_count: number;
}

interface UploadAlertRow {
  id: number;
  kind: string;
  detail: string;
  created_at: string;
}

export const onRequestGet: PagesFunction<Env> = async (context: PagesContext) => {
  const { request, env } = context;

  if (!verifyPasscode(request, env)) {
    return unauthorized();
  }

  try {
    await ensureSchema(env);
    const summary = await env.DB.prepare(
      `SELECT
         COUNT(*) AS total_count,
         SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
         SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected_count,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count
       FROM upload_events
       WHERE created_at >= datetime('now', '-1 day')`,
    ).first<UploadSummaryRow>();

    const alertResult = await env.DB.prepare(
      `SELECT id, kind, detail, created_at
       FROM upload_alerts
       ORDER BY created_at DESC, id DESC
       LIMIT 10`,
    ).all<UploadAlertRow>();

    const alerts = (alertResult.results ?? []).map((alert) => {
      let detail: unknown = {};
      try {
        detail = JSON.parse(alert.detail);
      } catch {
        detail = { raw: alert.detail };
      }

      return {
        id: alert.id,
        kind: alert.kind,
        detail,
        created_at: alert.created_at,
      };
    });

    return jsonResponse({
      ok: true,
      summary: {
        totalCount: summary?.total_count ?? 0,
        completedCount: summary?.completed_count ?? 0,
        rejectedCount: summary?.rejected_count ?? 0,
        failedCount: summary?.failed_count ?? 0,
      },
      alerts,
      limits: getUploadLimitConfig(env),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'アップロード監視の取得に失敗しました';
    return jsonResponse({ ok: false, error: message }, 500);
  }
};
