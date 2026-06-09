export interface UploadProgress {
  stage: 'idle' | 'compressing' | 'uploading' | 'transcribing' | 'done' | 'error';
  percent: number;
  message: string;
}

export interface UploadResult {
  ok: boolean;
  filename?: string;
  error?: string;
  cancelled?: boolean;
}

export interface AudioUploadPart {
  blob: Blob;
  filename: string;
}

export interface UploadParams {
  school: string;
  grade: string;
  className: string;
  studentName: string;
  audioParts: AudioUploadPart[];
  isLongAudio: boolean;
  onProgress: (progress: UploadProgress) => void;
  signal?: AbortSignal;
}

export function uploadTranscription(params: UploadParams): Promise<UploadResult> {
  const {
    school,
    grade,
    className,
    studentName,
    audioParts,
    isLongAudio,
    onProgress,
    signal,
  } = params;

  return new Promise((resolve) => {
    const formData = new FormData();
    formData.append('school', school);
    formData.append('grade', grade);
    formData.append('className', className);
    formData.append('studentName', studentName);
    formData.append('audioChunkCount', String(audioParts.length));

    if (audioParts.length === 1) {
      formData.append('audio', audioParts[0].blob, audioParts[0].filename);
    } else {
      audioParts.forEach((part, index) => {
        formData.append(`audio_${index}`, part.blob, part.filename);
      });
    }

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/transcribe');
    xhr.responseType = 'json';

    const abortUpload = () => xhr.abort();
    if (signal) {
      if (signal.aborted) {
        resolve({ ok: false, cancelled: true });
        return;
      }
      signal.addEventListener('abort', abortUpload, { once: true });
    }

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) {
        onProgress({
          stage: 'uploading',
          percent: 40,
          message: '音声をアップロードしています...',
        });
        return;
      }

      const uploadPercent = Math.round((event.loaded / event.total) * 50);
      onProgress({
        stage: 'uploading',
        percent: 10 + uploadPercent,
        message: '音声をアップロードしています...',
      });
    };

    xhr.upload.onload = () => {
      const transcribingMessage =
        audioParts.length > 1 && isLongAudio
          ? `文字起こし中です（1/${audioParts.length}）… 25分を超える録音は時間がかかります`
          : '文字起こしを実行しています...';
      onProgress({
        stage: 'transcribing',
        percent: 75,
        message: transcribingMessage,
      });
    };

    xhr.onabort = () => {
      resolve({ ok: false, cancelled: true });
    };

    xhr.onerror = () => {
      onProgress({
        stage: 'error',
        percent: 100,
        message: '通信エラーが発生しました',
      });
      resolve({ ok: false, error: '通信エラーが発生しました' });
    };

    xhr.onload = () => {
      const response = xhr.response as UploadResult | null;
      if (xhr.status >= 200 && xhr.status < 300 && response?.ok) {
        onProgress({
          stage: 'done',
          percent: 100,
          message: '完了しました',
        });
        resolve(response);
        return;
      }

      const errorMessage =
        response?.error ?? `アップロードに失敗しました (${xhr.status})`;
      onProgress({
        stage: 'error',
        percent: 100,
        message: errorMessage,
      });
      resolve({ ok: false, error: errorMessage });
    };

    xhr.send(formData);
  });
}

export interface RecordItem {
  id: number;
  school: string;
  grade: string;
  class: string;
  student_name: string;
  filename: string;
  created_at: string;
  downloaded_at: string | null;
}

export interface UploadMonitorAlert {
  id: number;
  kind: string;
  detail: {
    school?: string;
    filename?: string;
    fileSize?: number;
    perIpHourCount?: number;
    perIpDayCount?: number;
    globalDayCount?: number;
  };
  created_at: string;
}

export interface UploadMonitorData {
  summary: {
    totalCount: number;
    completedCount: number;
    rejectedCount: number;
    failedCount: number;
  };
  alerts: UploadMonitorAlert[];
  limits: {
    maxPerIpHour: number;
    maxPerIpDay: number;
    maxGlobalDay: number;
    maxFileBytes: number;
  };
}

export interface UploadEventItem {
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

export interface DownloadEventItem {
  id: number;
  school: string;
  grade: string;
  class: string;
  student_name: string;
  filename: string;
  created_at: string;
  downloaded_at: string;
}

export async function fetchRecords(
  passcode: string,
  school: string,
): Promise<RecordItem[]> {
  const response = await fetch(
    `/api/records?school=${encodeURIComponent(school)}`,
    {
      headers: {
        'X-Passcode': passcode,
      },
    },
  );

  const data = (await response.json()) as { ok: boolean; records?: RecordItem[]; error?: string };
  if (!response.ok || !data.ok || !data.records) {
    throw new Error(data.error ?? '一覧の取得に失敗しました');
  }

  return data.records;
}

export async function fetchUploadEvents(
  passcode: string,
  options?: { school?: string; status?: string; limit?: number },
): Promise<UploadEventItem[]> {
  const params = new URLSearchParams();
  if (options?.school) {
    params.set('school', options.school);
  }
  if (options?.status) {
    params.set('status', options.status);
  }
  if (options?.limit) {
    params.set('limit', String(options.limit));
  }

  const query = params.toString();
  const response = await fetch(`/api/upload-events${query ? `?${query}` : ''}`, {
    headers: {
      'X-Passcode': passcode,
    },
  });

  const data = (await response.json()) as {
    ok: boolean;
    events?: UploadEventItem[];
    error?: string;
  };

  if (!response.ok || !data.ok || !data.events) {
    throw new Error(data.error ?? 'アップロード履歴の取得に失敗しました');
  }

  return data.events;
}

export async function fetchDownloadEvents(
  passcode: string,
  options?: { school?: string; limit?: number },
): Promise<DownloadEventItem[]> {
  const params = new URLSearchParams();
  if (options?.school) {
    params.set('school', options.school);
  }
  if (options?.limit) {
    params.set('limit', String(options.limit));
  }

  const query = params.toString();
  const response = await fetch(`/api/download-events${query ? `?${query}` : ''}`, {
    headers: {
      'X-Passcode': passcode,
    },
  });

  const data = (await response.json()) as {
    ok: boolean;
    events?: DownloadEventItem[];
    error?: string;
  };

  if (!response.ok || !data.ok || !data.events) {
    throw new Error(data.error ?? 'ダウンロード実行履歴の取得に失敗しました');
  }

  return data.events;
}

export async function fetchUploadMonitor(passcode: string): Promise<UploadMonitorData> {
  const response = await fetch('/api/upload-monitor', {
    headers: {
      'X-Passcode': passcode,
    },
  });

  const data = (await response.json()) as {
    ok: boolean;
    summary?: UploadMonitorData['summary'];
    alerts?: UploadMonitorAlert[];
    limits?: UploadMonitorData['limits'];
    error?: string;
  };

  if (!response.ok || !data.ok || !data.summary || !data.alerts || !data.limits) {
    throw new Error(data.error ?? 'アップロード監視の取得に失敗しました');
  }

  return {
    summary: data.summary,
    alerts: data.alerts,
    limits: data.limits,
  };
}

export async function deleteRecord(passcode: string, id: number): Promise<void> {
  const response = await fetch(`/api/delete?id=${id}`, {
    method: 'DELETE',
    headers: {
      'X-Passcode': passcode,
    },
  });

  const data = (await response.json()) as { ok: boolean; error?: string };
  if (!response.ok || !data.ok) {
    throw new Error(data.error ?? '削除に失敗しました');
  }
}

export function downloadUrl(passcode: string, id: number): string {
  return `/api/download?id=${id}&passcode=${encodeURIComponent(passcode)}`;
}

export function downloadZipUrl(passcode: string, school: string): string {
  return `/api/download?school=${encodeURIComponent(school)}&passcode=${encodeURIComponent(passcode)}`;
}

export function downloadSelectedZipUrl(passcode: string, ids: number[]): string {
  return `/api/download?ids=${encodeURIComponent(ids.join(','))}&passcode=${encodeURIComponent(passcode)}`;
}

export function downloadAllZipUrl(passcode: string): string {
  return `/api/download?all=1&passcode=${encodeURIComponent(passcode)}`;
}

export async function verifyPasscode(passcode: string): Promise<boolean> {
  const response = await fetch('/api/records?school=', {
    headers: {
      'X-Passcode': passcode,
    },
  });

  if (response.status === 401) return false;
  return response.ok;
}
