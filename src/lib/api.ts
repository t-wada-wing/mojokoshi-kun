export interface UploadProgress {
  stage: 'idle' | 'compressing' | 'uploading' | 'transcribing' | 'done' | 'error';
  percent: number;
  message: string;
}

export interface UploadResult {
  ok: boolean;
  filename?: string;
  error?: string;
}

export interface UploadParams {
  school: string;
  grade: string;
  className: string;
  studentName: string;
  audio: Blob;
  audioFilename: string;
  onProgress: (progress: UploadProgress) => void;
}

export function uploadTranscription(params: UploadParams): Promise<UploadResult> {
  const { school, grade, className, studentName, audio, audioFilename, onProgress } = params;

  return new Promise((resolve) => {
    const formData = new FormData();
    formData.append('school', school);
    formData.append('grade', grade);
    formData.append('className', className);
    formData.append('studentName', studentName);
    formData.append('audio', audio, audioFilename);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/transcribe');
    xhr.responseType = 'json';

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
      onProgress({
        stage: 'transcribing',
        percent: 75,
        message: '文字起こしを実行しています...',
      });
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

export async function verifyPasscode(passcode: string): Promise<boolean> {
  const response = await fetch('/api/records?school=', {
    headers: {
      'X-Passcode': passcode,
    },
  });

  if (response.status === 401) return false;
  return response.ok;
}
