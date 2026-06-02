import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import type { UploadProgress } from '../lib/api';

interface Props {
  progress: UploadProgress;
  onCancel: () => void;
}

const CANCELLABLE_STAGES: UploadProgress['stage'][] = [
  'compressing',
  'uploading',
  'transcribing',
];

export default function UploadOverlay({ progress, onCancel }: Props) {
  const isOpen = progress.stage !== 'idle';
  const canCancel = CANCELLABLE_STAGES.includes(progress.stage);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const blockTouchMove = (event: TouchEvent) => {
      event.preventDefault();
    };

    document.addEventListener('touchmove', blockTouchMove, { passive: false });

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('touchmove', blockTouchMove);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="overlay overlay-blocking"
      role="dialog"
      aria-modal="true"
      aria-label="アップロード中"
      onWheel={(event) => event.preventDefault()}
    >
      <div className="overlay-card">
        <p className="overlay-title">{progress.message}</p>
        <div className="progress-track" aria-hidden="true">
          <div className="progress-bar" style={{ width: `${progress.percent}%` }} />
        </div>
        <p className="overlay-percent">{progress.percent}%</p>
        <p className="overlay-note">アップロード完了まで画面を閉じないでください</p>
        {canCancel ? (
          <div className="overlay-actions">
            <button type="button" className="secondary-button" onClick={onCancel}>
              キャンセル
            </button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
