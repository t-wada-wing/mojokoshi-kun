import { useEffect, useMemo, useState } from 'react';
import { SCHOOLS } from '../constants';
import {
  deleteRecord,
  downloadSelectedZipUrl,
  downloadUrl,
  downloadZipUrl,
  fetchRecords,
  fetchUploadMonitor,
  verifyPasscode,
  type RecordItem,
  type UploadMonitorData,
} from '../lib/api';

const PASSCODE_STORAGE_KEY = 'transcribe-passcode';

function parseServerDate(value: string | null | undefined): Date | null {
  if (!value) return null;

  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function formatDateTime(value: string | null | undefined): string {
  const date = parseServerDate(value);
  if (!date) return value ?? '';

  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Tokyo',
  }).format(date);
}

function dateTimeValue(value: string | null | undefined): number {
  return parseServerDate(value)?.getTime() ?? 0;
}

function formatBytes(value: number): string {
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)}KB`;
  return `${Math.floor(value / 1024 / 1024)}MB`;
}

function filenameFromDisposition(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;

  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      return fallback;
    }
  }

  const plain = disposition.match(/filename="?([^";]+)"?/);
  return plain?.[1] ?? fallback;
}

async function errorFromDownloadResponse(response: Response): Promise<string> {
  const contentType = response.headers.get('Content-Type') ?? '';
  if (contentType.includes('application/json')) {
    const data = (await response.json()) as { error?: string };
    return data.error ?? `ダウンロードに失敗しました (${response.status})`;
  }

  const text = await response.text();
  return text || `ダウンロードに失敗しました (${response.status})`;
}

async function startDownload(href: string, fallbackFilename: string): Promise<void> {
  const response = await fetch(href);
  if (!response.ok) {
    throw new Error(await errorFromDownloadResponse(response));
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filenameFromDisposition(response.headers.get('Content-Disposition'), fallbackFilename);
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
}

export default function DownloadPage() {
  const [passcode, setPasscode] = useState('');
  const [authenticated, setAuthenticated] = useState(false);
  const [authError, setAuthError] = useState('');
  const [school, setSchool] = useState('');
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [listError, setListError] = useState('');
  const [actionMessage, setActionMessage] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [uploadMonitor, setUploadMonitor] = useState<UploadMonitorData | null>(null);
  const [monitorError, setMonitorError] = useState('');

  const selectedRecords = useMemo(
    () => records.filter((record) => selectedIds.has(record.id)),
    [records, selectedIds],
  );

  const latestDownloads = useMemo(
    () =>
      [...records]
        .filter((record) => record.downloaded_at)
        .sort((a, b) => dateTimeValue(b.downloaded_at) - dateTimeValue(a.downloaded_at))
        .slice(0, 5),
    [records],
  );

  const allSelected = records.length > 0 && records.every((record) => selectedIds.has(record.id));
  const undownloadedCount = records.filter((record) => !record.downloaded_at).length;

  useEffect(() => {
    const saved = sessionStorage.getItem(PASSCODE_STORAGE_KEY);
    if (saved) {
      setPasscode(saved);
      setAuthenticated(true);
      void loadUploadMonitor(saved);
    }
  }, []);

  const loadUploadMonitor = async (targetPasscode = passcode) => {
    try {
      const monitor = await fetchUploadMonitor(targetPasscode);
      setUploadMonitor(monitor);
      setMonitorError('');
    } catch (error) {
      setUploadMonitor(null);
      setMonitorError(error instanceof Error ? error.message : 'アップロード監視の取得に失敗しました');
    }
  };

  const handleAuth = async (event: React.FormEvent) => {
    event.preventDefault();
    setAuthError('');
    const ok = await verifyPasscode(passcode);
    if (!ok) {
      setAuthError('パスコードが正しくありません');
      setAuthenticated(false);
      return;
    }
    sessionStorage.setItem(PASSCODE_STORAGE_KEY, passcode);
    setAuthenticated(true);
    void loadUploadMonitor(passcode);
  };

  const loadRecords = async (selectedSchool: string) => {
    setSchool(selectedSchool);
    setLoading(true);
    setListError('');
    setActionMessage('');
    try {
      const items = await fetchRecords(passcode, selectedSchool);
      setRecords(items);
      setSelectedIds(new Set());
      void loadUploadMonitor(passcode);
    } catch (error) {
      setRecords([]);
      setSelectedIds(new Set());
      setListError(error instanceof Error ? error.message : '一覧の取得に失敗しました');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm('この記録を削除しますか？')) return;
    try {
      await deleteRecord(passcode, id);
      setActionMessage('削除しました');
      if (school) {
        await loadRecords(school);
      }
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : '削除に失敗しました');
    }
  };

  const refreshAfterDownload = async (message: string) => {
    if (!school) return;
    await loadRecords(school);
    setActionMessage(message);
  };

  const runDownload = async (href: string, fallbackFilename: string, message: string) => {
    setActionMessage('ダウンロードを準備しています...');
    try {
      await startDownload(href, fallbackFilename);
      await refreshAfterDownload(message);
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : 'ダウンロードに失敗しました');
    }
  };

  const toggleRecord = (id: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const selectAll = () => {
    setSelectedIds(new Set(records.map((record) => record.id)));
  };

  const selectUndownloaded = () => {
    setSelectedIds(new Set(records.filter((record) => !record.downloaded_at).map((record) => record.id)));
  };

  const clearSelection = () => {
    setSelectedIds(new Set());
  };

  const handleDownloadSchool = async () => {
    if (!school) return;
    await runDownload(
      downloadZipUrl(passcode, school),
      `${school}_文字起こし.zip`,
      'スクール一括ダウンロードの履歴を更新しました',
    );
  };

  const handleDownloadSelected = async () => {
    if (selectedRecords.length === 0) {
      setActionMessage('ダウンロードするファイルを選択してください');
      return;
    }

    await runDownload(
      downloadSelectedZipUrl(
        passcode,
        selectedRecords.map((record) => record.id),
      ),
      school ? `${school}_選択文字起こし.zip` : '選択文字起こし.zip',
      `${selectedRecords.length}件のダウンロード履歴を更新しました`,
    );
  };

  const handleDownloadRecord = async (record: RecordItem) => {
    await runDownload(
      downloadUrl(passcode, record.id),
      record.filename,
      '最新のダウンロード履歴を更新しました',
    );
  };

  if (!authenticated) {
    return (
      <section className="card narrow">
        <h2>ダウンロード / 管理</h2>
        <p className="lead">パスコードを入力してください。</p>
        <form className="form-grid" onSubmit={handleAuth}>
          <label>
            パスコード
            <input
              type="password"
              value={passcode}
              onChange={(e) => setPasscode(e.target.value)}
              autoComplete="current-password"
            />
          </label>
          {authError ? <p className="field-error">{authError}</p> : null}
          <button type="submit" className="primary-button">
            ログイン
          </button>
        </form>
      </section>
    );
  }

  return (
    <section className="card">
      <div className="section-header">
        <div>
          <h2>ダウンロード / 管理</h2>
          <p className="lead">スクールを選択して文字起こし結果を確認・ダウンロードできます。</p>
        </div>
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            sessionStorage.removeItem(PASSCODE_STORAGE_KEY);
            setAuthenticated(false);
            setPasscode('');
            setSchool('');
            setRecords([]);
            setSelectedIds(new Set());
            setUploadMonitor(null);
            setMonitorError('');
          }}
        >
          ログアウト
        </button>
      </div>

      {uploadMonitor ? (
        <section className="upload-monitor" aria-live="polite">
          <div className="history-header">
            <h3>アップロード監視</h3>
            <span>{uploadMonitor.alerts.length > 0 ? '異常検知あり' : '正常'}</span>
          </div>
          <div className="monitor-grid">
            <p>
              <strong>{uploadMonitor.summary.totalCount}</strong>
              <span>24時間の総数</span>
            </p>
            <p>
              <strong>{uploadMonitor.summary.rejectedCount}</strong>
              <span>遮断</span>
            </p>
            <p>
              <strong>{formatBytes(uploadMonitor.limits.maxFileBytes)}</strong>
              <span>ファイル上限</span>
            </p>
          </div>
          {uploadMonitor.alerts.length > 0 ? (
            <ol className="monitor-alerts">
              {uploadMonitor.alerts.slice(0, 3).map((alert) => (
                <li key={alert.id}>
                  <span>{formatDateTime(alert.created_at)}</span>
                  {alert.detail.school ? `${alert.detail.school} / ` : ''}
                  {alert.detail.filename ?? alert.kind}
                </li>
              ))}
            </ol>
          ) : (
            <p className="field-hint">直近の異常アップロードはありません。</p>
          )}
        </section>
      ) : null}
      {monitorError ? <p className="field-error">{monitorError}</p> : null}

      <label>
        スクール
        <select value={school} onChange={(e) => loadRecords(e.target.value)}>
          <option value="">選択してください</option>
          {SCHOOLS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>

      {school ? (
        <div className="toolbar download-toolbar">
          <button
            type="button"
            className="secondary-button"
            onClick={() => void handleDownloadSchool()}
          >
            このスクールを一括ダウンロード (zip)
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => void handleDownloadSelected()}
            disabled={selectedRecords.length === 0}
          >
            選択したファイルをダウンロード (zip)
          </button>
        </div>
      ) : null}

      {school ? (
        <div className="download-history" aria-live="polite">
          <div className="history-header">
            <h3>最新のダウンロード履歴</h3>
            <span>{latestDownloads.length > 0 ? `${latestDownloads.length}件表示` : '履歴なし'}</span>
          </div>
          {latestDownloads.length > 0 ? (
            <ol>
              {latestDownloads.map((record) => (
                <li key={record.id}>
                  <span>
                    {record.student_name} / {record.filename}
                  </span>
                  <time>{formatDateTime(record.downloaded_at)}</time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="field-hint">このスクールのダウンロード履歴はまだありません。</p>
          )}
        </div>
      ) : null}

      {loading ? <p>読み込み中...</p> : null}
      {listError ? <p className="field-error">{listError}</p> : null}
      {actionMessage ? <p className="field-hint">{actionMessage}</p> : null}

      {records.length > 0 ? (
        <>
          <div className="selection-toolbar">
            <p>
              {selectedRecords.length}件選択中 / {records.length}件
              {undownloadedCount > 0 ? `（未ダウンロード ${undownloadedCount}件）` : ''}
            </p>
            <div>
              <button type="button" className="secondary-button" onClick={selectAll} disabled={allSelected}>
                一括チェック
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={selectUndownloaded}
                disabled={undownloadedCount === 0}
              >
                未ダウンロードを選択
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={clearSelection}
                disabled={selectedRecords.length === 0}
              >
                一括解除
              </button>
            </div>
          </div>

          <div className="record-list">
            {records.map((record) => (
              <article
                key={record.id}
                className={`record-item${selectedIds.has(record.id) ? ' selected' : ''}`}
              >
                <label className="record-select">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(record.id)}
                    onChange={() => toggleRecord(record.id)}
                    aria-label={`${record.filename}を選択`}
                  />
                  <span>選択</span>
                </label>
                <div className="record-content">
                  <strong>{record.student_name}</strong>
                  <p>
                    {record.grade} / {record.class} / {record.filename}
                  </p>
                  <p className="record-date">登録: {formatDateTime(record.created_at)}</p>
                  <p className={`download-status${record.downloaded_at ? ' downloaded' : ''}`}>
                    {record.downloaded_at
                      ? `最終DL: ${formatDateTime(record.downloaded_at)}`
                      : '未ダウンロード'}
                  </p>
                </div>
                <div className="record-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void handleDownloadRecord(record)}
                  >
                    txt
                  </button>
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => handleDelete(record.id)}
                  >
                    削除
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      ) : null}

      {school && !loading && records.length === 0 && !listError ? (
        <p className="field-hint">このスクールの記録はまだありません。</p>
      ) : null}
    </section>
  );
}
