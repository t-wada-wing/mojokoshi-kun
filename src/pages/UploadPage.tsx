import { useMemo, useRef, useState } from 'react';
import {
  CLASSES,
  GRADES,
  SCHOOLS,
  buildFilename,
  isUnsupportedAudioFile,
  isValidStudentName,
} from '../constants';
import UploadOverlay from '../components/UploadOverlay';
import ResultModal from '../components/ResultModal';
import { prepareAudioForUpload } from '../lib/audio';
import { uploadTranscription, type UploadProgress } from '../lib/api';

const initialProgress: UploadProgress = {
  stage: 'idle',
  percent: 0,
  message: '',
};

export default function UploadPage() {
  const [school, setSchool] = useState('');
  const [grade, setGrade] = useState('');
  const [className, setClassName] = useState('');
  const [studentName, setStudentName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const [nameError, setNameError] = useState('');
  const [progress, setProgress] = useState<UploadProgress>(initialProgress);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState('');
  const [modalMessage, setModalMessage] = useState('');
  const [modalVariant, setModalVariant] = useState<'success' | 'error'>('success');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const previewFilename = useMemo(() => {
    if (!school || !grade || !className || !studentName) return '';
    return buildFilename(school, grade, className, studentName);
  }, [school, grade, className, studentName]);

  const canUpload =
    Boolean(school && grade && className && studentName && file) &&
    isValidStudentName(studentName) &&
    !fileError &&
    !isSubmitting;

  const handleStudentNameChange = (value: string) => {
    setStudentName(value);
    if (!value) {
      setNameError('');
      return;
    }
    setNameError(isValidStudentName(value) ? '' : '苗字と名前の間に半角スペースを入れてください');
  };

  const handleFileChange = (selected: File | null) => {
    setFile(selected);
    if (!selected) {
      setFileError('');
      return;
    }

    if (isUnsupportedAudioFile(selected.name)) {
      setFileError(
        'この音声形式(.amr/.3gp等)は対応していません。別の録音アプリでm4a/mp3形式で保存してください。',
      );
      return;
    }

    setFileError('');
  };

  const resetForm = () => {
    setSchool('');
    setGrade('');
    setClassName('');
    setStudentName('');
    setFile(null);
    setFileError('');
    setNameError('');
  };

  const handleCancel = () => {
    abortControllerRef.current?.abort();
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canUpload || !file) return;

    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    setIsSubmitting(true);
    setProgress({
      stage: 'compressing',
      percent: 5,
      message: '音声を圧縮しています...',
    });

    try {
      const prepared = await prepareAudioForUpload(file, abortController.signal);
      setProgress({
        stage: 'uploading',
        percent: 10,
        message: '音声をアップロードしています...',
      });

      const result = await uploadTranscription({
        school,
        grade,
        className,
        studentName,
        audio: prepared.blob,
        audioFilename: prepared.filename,
        onProgress: setProgress,
        signal: abortController.signal,
      });

      if (result.cancelled || abortController.signal.aborted) {
        return;
      }

      if (result.ok) {
        setModalVariant('success');
        setModalTitle('完了しました');
        setModalMessage(`保存ファイル名: ${result.filename ?? previewFilename}`);
        setModalOpen(true);
        resetForm();
      } else {
        setModalVariant('error');
        setModalTitle('エラー');
        setModalMessage(result.error ?? 'アップロードに失敗しました');
        setModalOpen(true);
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        return;
      }

      const message = error instanceof Error ? error.message : 'アップロードに失敗しました';
      setProgress({
        stage: 'error',
        percent: 100,
        message,
      });
      setModalVariant('error');
      setModalTitle('エラー');
      setModalMessage(message);
      setModalOpen(true);
    } finally {
      abortControllerRef.current = null;
      setIsSubmitting(false);
      setProgress(initialProgress);
    }
  };

  return (
    <>
      <section className="card">
        <h2>音声アップロード</h2>
        <p className="lead">
          スクール・学年・クラス・生徒氏名を入力し、電話録音ファイルをアップロードしてください。
        </p>

        <form className="form-grid" onSubmit={handleSubmit}>
          <label>
            スクール
            <select value={school} onChange={(e) => setSchool(e.target.value)} disabled={isSubmitting}>
              <option value="">選択してください</option>
              {SCHOOLS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>

          <label>
            学年
            <select value={grade} onChange={(e) => setGrade(e.target.value)} disabled={isSubmitting}>
              <option value="">選択してください</option>
              {GRADES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>

          <label>
            クラス
            <select
              value={className}
              onChange={(e) => setClassName(e.target.value)}
              disabled={isSubmitting}
            >
              <option value="">選択してください</option>
              {CLASSES.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>

          <label>
            生徒氏名
            <input
              type="text"
              value={studentName}
              onChange={(e) => handleStudentNameChange(e.target.value)}
              placeholder="例: 山田 太郎"
              disabled={isSubmitting}
            />
            {nameError ? <span className="field-error">{nameError}</span> : null}
          </label>

          <label>
            音声ファイル
            <input
              type="file"
              accept="audio/*,.mp3,.m4a,.wav,.aac,.ogg,.webm,.mp4"
              onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
              disabled={isSubmitting}
            />
            {file ? <span className="field-hint">{file.name}</span> : null}
            {fileError ? <span className="field-error">{fileError}</span> : null}
          </label>

          {previewFilename ? (
            <p className="filename-preview">保存ファイル名: {previewFilename}</p>
          ) : null}

          <button type="submit" className="primary-button" disabled={!canUpload}>
            アップロード
          </button>
        </form>
      </section>

      <UploadOverlay progress={progress} onCancel={handleCancel} />
      <ResultModal
        open={modalOpen}
        title={modalTitle}
        message={modalMessage}
        variant={modalVariant}
        onClose={() => setModalOpen(false)}
      />
    </>
  );
}
