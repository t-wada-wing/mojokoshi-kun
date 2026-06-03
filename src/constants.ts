export const SCHOOLS = [
  'RPLUS北門',
  '滝川本校',
  'RPLUS深川',
  'RPLUS東光環状通り',
  'RPLUS北本校',
  'RPLUS本校',
  'ひじり野',
  '永山中央',
  '永山',
  '緑が丘',
  '北本校',
  '豊岡',
  '東光南',
  '本校中3',
  '本校中2',
  '本校中1',
  '本校小6',
  '本校小5',
  '本校小4',
] as const;

export const GRADES = ['小4', '小5', '小6', '中1', '中2', '中3'] as const;

export const CLASSES = ['特選', '選抜', '練成', '個別'] as const;

export type School = (typeof SCHOOLS)[number];
export type Grade = (typeof GRADES)[number];
export type ClassName = (typeof CLASSES)[number];

export const UNSUPPORTED_EXTENSIONS = ['.amr', '.3gp', '.3gpp', '.awb'] as const;

/** OpenAI 文字起こし用の内部分割（秒）。API 上限 25 分より短く取る */
export const MAX_TRANSCRIBE_CHUNK_SECONDS = 20 * 60;

/** 画面案内・長時間ヒント表示の閾値（秒） */
export const LONG_AUDIO_HINT_SECONDS = 25 * 60;

export const LONG_AUDIO_STATIC_HINT =
  '25分を超える音声は、圧縮と文字起こしに通常より時間がかかります。完了まで画面を閉じないでください。';

export function formatDurationMinutes(seconds: number): number {
  return Math.max(1, Math.ceil(seconds / 60));
}

export const STUDENT_NAME_PATTERN = /^\S+ \S+$/;

export function isValidStudentName(name: string): boolean {
  if (!STUDENT_NAME_PATTERN.test(name)) return false;
  if (name.includes('\u3000')) return false;
  return true;
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

export function isUnsupportedAudioFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return UNSUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
