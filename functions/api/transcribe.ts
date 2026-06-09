import {
  buildFilename,
  checkUploadLimit,
  collectAudioFilesFromFormData,
  ensureSchema,
  getTranscribeModel,
  hashClientIp,
  jsonResponse,
  recordUploadAlert,
  recordUploadEvent,
  sendUploadNotification,
  transcribeAudioInChunks,
  updateUploadEventStatus,
  type Env,
} from '../_lib';

interface PagesContext {
  request: Request;
  env: Env;
  waitUntil: (promise: Promise<unknown>) => void;
}

export const onRequestPost: PagesFunction<Env> = async (context: PagesContext) => {
  const { request, env, waitUntil } = context;

  if (!env.OPENAI_API_KEY) {
    return jsonResponse({ ok: false, error: 'OPENAI_API_KEY が設定されていません' }, 500);
  }

  try {
    await ensureSchema(env);
    const formData = await request.formData();
    const school = String(formData.get('school') ?? '').trim();
    const grade = String(formData.get('grade') ?? '').trim();
    const className = String(formData.get('className') ?? '').trim();
    const studentName = String(formData.get('studentName') ?? '').trim();

    if (!school || !grade || !className || !studentName) {
      return jsonResponse({ ok: false, error: '入力項目が不足しています' }, 400);
    }

    if (!/^\S+ \S+$/.test(studentName) || studentName.includes('\u3000')) {
      return jsonResponse(
        { ok: false, error: '生徒氏名は苗字と名前の間に半角スペースを入れてください' },
        400,
      );
    }

    let audioFiles: File[];
    try {
      audioFiles = collectAudioFilesFromFormData(formData);
    } catch (error) {
      const message = error instanceof Error ? error.message : '音声ファイルがありません';
      return jsonResponse({ ok: false, error: message }, 400);
    }

    if (audioFiles.length === 0) {
      return jsonResponse({ ok: false, error: '音声ファイルがありません' }, 400);
    }

    const filename = buildFilename(school, grade, className, studentName);
    const ipHash = await hashClientIp(request);
    const totalFileSize = audioFiles.reduce((sum, file) => sum + file.size, 0);
    const uploadLimit = await checkUploadLimit(env, ipHash, totalFileSize);

    if (!uploadLimit.allowed) {
      await recordUploadEvent(env, {
        ipHash,
        school,
        grade,
        className,
        studentName,
        filename,
        fileSize: totalFileSize,
        status: 'rejected',
      });
      await recordUploadAlert(env, uploadLimit.reason ?? 'upload_limit', ipHash, {
        school,
        grade,
        className,
        studentName,
        filename,
        fileSize: totalFileSize,
        perIpHourCount: uploadLimit.perIpHourCount,
        perIpDayCount: uploadLimit.perIpDayCount,
        globalDayCount: uploadLimit.globalDayCount,
        limit: uploadLimit.config,
      });
      return jsonResponse(
        { ok: false, error: uploadLimit.message ?? 'アップロード数が多すぎます' },
        429,
      );
    }

    const uploadEventId = await recordUploadEvent(env, {
      ipHash,
      school,
      grade,
      className,
      studentName,
      filename,
      fileSize: totalFileSize,
      status: 'accepted',
    });
    const model = getTranscribeModel(env);
    const audioKey = crypto.randomUUID() + '.mp3';

    const audioBuffers = await Promise.all(audioFiles.map((file) => file.arrayBuffer()));
    const firstAudio = audioFiles[0];

    await env.AUDIO.put(audioKey, audioBuffers[0], {
      httpMetadata: {
        contentType: firstAudio.type || 'audio/mpeg',
      },
    });

    const transcriptionInputs = audioFiles.map((file, index) => ({
      blob: new Blob([audioBuffers[index]], { type: file.type || 'audio/mpeg' }),
      filename: file.name || `audio_part${index + 1}.mp3`,
    }));

    let transcript: string;
    try {
      transcript = await transcribeAudioInChunks(env, transcriptionInputs);
    } catch (error) {
      await env.AUDIO.delete(audioKey);
      await updateUploadEventStatus(env, uploadEventId, 'failed');
      throw error;
    }

    const result = await env.DB.prepare(
      `INSERT INTO transcripts (school, grade, class, student_name, filename, transcript, audio_key, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
      .bind(school, grade, className, studentName, filename, transcript, audioKey, model)
      .first<{ id: number }>();

    await updateUploadEventStatus(env, uploadEventId, 'completed');

    waitUntil(
      sendUploadNotification(env, {
        transcriptId: result?.id,
        school,
        grade,
        className,
        studentName,
        filename,
      }).catch((error) => {
        console.error('Upload notification error:', error);
      }),
    );

    return jsonResponse({
      ok: true,
      id: result?.id,
      filename,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '文字起こしに失敗しました';
    return jsonResponse({ ok: false, error: message }, 500);
  }
};
