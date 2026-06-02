import { useEffect, useMemo, useState } from 'react';
import AnalysisModal from '../components/AnalysisModal';
import { MAX_BULK_ANALYZE, SCHOOLS } from '../constants';
import {
  analyzeRecord,
  deleteRecord,
  downloadAnalysisSelectedZipUrl,
  downloadAnalysisZipUrl,
  downloadSelectedZipUrl,
  downloadUrl,
  downloadZipUrl,
  fetchMonthlyUsage,
  fetchRecords,
  fetchUploadMonitor,
  verifyPasscode,
  type MonthlyUsageResponse,
  type RecordItem,
  type UploadMonitorData,
} from '../lib/api';

const PASSCODE_STORAGE_KEY = 'transcribe-passcode';

type DownloadTab = 'ai' | 'admin';

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
  const [monthlyUsage, setMonthlyUsage] = useState<MonthlyUsageResponse | null>(null);
  const [usageError, setUsageError] = useState('');
  const [bulkAnalyzing, setBulkAnalyzing] = useState(false);
  const [activeTab, setActiveTab] = useState<DownloadTab>('ai');
  const [adminLoaded, setAdminLoaded] = useState(false);
  const [adminLoading, setAdminLoading] = useState(false);
  const [analysisModal, setAnalysisModal] = useState<{
    open: boolean;
    title: string;
    content: string;
    loading: boolean;
    cached: boolean;
    recordId: number | null;
    downloadName: string;
  }>({
    open: false,
    title: '',
    content: '',
    loading: false,
    cached: false,
    recordId: null,
    downloadName: '',
  });

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
  const unanalyzedRecords = useMemo(
    () => records.filter((record) => !record.analyzed_at),
    [records],
  );
  const selectedUnanalyzedRecords = useMemo(
    () => selectedRecords.filter((record) => !record.analyzed_at),
    [selectedRecords],
  );
  const analyzedRecords = useMemo(
    () => records.filter((record) => record.analyzed_at),
    [records],
  );
  const selectedAnalyzedRecords = useMemo(
    () => selectedRecords.filter((record) => record.analyzed_at),
    [selectedRecords],
  );

  useEffect(() => {
    const saved = sessionStorage.getItem(PASSCODE_STORAGE_KEY);
    if (saved) {
      setPasscode(saved);
      setAuthenticated(true);
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

  const loadMonthlyUsage = async (targetPasscode = passcode) => {
    try {
      const usage = await fetchMonthlyUsage(targetPasscode);
      setMonthlyUsage(usage);
      setUsageError('');
    } catch (error) {
      setMonthlyUsage(null);
      setUsageError(error instanceof Error ? error.message : '利用料金の取得に失敗しました');
    }
  };

  const refreshAdminPanels = async (targetPasscode = passcode) => {
    await Promise.all([loadUploadMonitor(targetPasscode), loadMonthlyUsage(targetPasscode)]);
  };

  const loadAdminPanels = async (targetPasscode = passcode) => {
    setAdminLoading(true);
    try {
      await refreshAdminPanels(targetPasscode);
      setAdminLoaded(true);
    } finally {
      setAdminLoading(false);
    }
  };

  const handleTabChange = (tab: DownloadTab) => {
    setActiveTab(tab);
    if (tab === 'admin' && !adminLoaded && !adminLoading) {
      void loadAdminPanels(passcode);
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
    setActiveTab('ai');
    setAdminLoaded(false);
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

  const handleDownloadAnalysisSchool = async () => {
    if (!school) return;
    await runDownload(
      downloadAnalysisZipUrl(passcode, school),
      `${school}_AI分析.zip`,
      '分析結果をダウンロードしました',
    );
  };

  const handleDownloadAnalysisSelected = async () => {
    if (selectedAnalyzedRecords.length === 0) {
      setActionMessage('ダウンロードする分析結果を選択してください');
      return;
    }

    await runDownload(
      downloadAnalysisSelectedZipUrl(
        passcode,
        selectedAnalyzedRecords.map((record) => record.id),
      ),
      school ? `${school}_選択AI分析.zip` : '選択AI分析.zip',
      `${selectedAnalyzedRecords.length}件の分析結果をダウンロードしました`,
    );
  };

  const handleDownloadRecord = async (record: RecordItem) => {
    await runDownload(
      downloadUrl(passcode, record.id),
      record.filename,
      '最新のダウンロード履歴を更新しました',
    );
  };

  const analysisFilename = (filename: string) => filename.replace(/\.txt$/i, '_分析.txt');

  const openAnalysisModal = (record: RecordItem, loading: boolean, content = '', cached = false) => {
    setAnalysisModal({
      open: true,
      title: `AI分析: ${record.student_name}`,
      content,
      loading,
      cached,
      recordId: record.id,
      downloadName: analysisFilename(record.filename),
    });
  };

  const handleAnalyzeRecord = async (record: RecordItem, force = false) => {
    openAnalysisModal(record, true);
    try {
      const result = await analyzeRecord(passcode, record.id, { force });
      setAnalysisModal((current) => ({
        ...current,
        content: result.analysis,
        loading: false,
        cached: result.cached,
      }));
      if (school) {
        await loadRecords(school);
      }
      if (adminLoaded) {
        void refreshAdminPanels(passcode);
      }
    } catch (error) {
      setAnalysisModal((current) => ({ ...current, open: false, loading: false }));
      setActionMessage(error instanceof Error ? error.message : '分析に失敗しました');
    }
  };

  const runBulkAnalyze = async (targets: RecordItem[], scopeLabel: string) => {
    setBulkAnalyzing(true);
    let success = 0;
    let failed = 0;

    for (let index = 0; index < targets.length; index += 1) {
      const record = targets[index];
      setActionMessage(
        `AI一括分析中（${scopeLabel}）... ${index + 1}/${targets.length} (${record.student_name})`,
      );
      try {
        await analyzeRecord(passcode, record.id);
        success += 1;
      } catch {
        failed += 1;
      }
    }

    setBulkAnalyzing(false);
    await loadRecords(school);
    if (adminLoaded) {
      void refreshAdminPanels(passcode);
    }
    setActionMessage(
      `一括分析が完了しました（成功 ${success}件 / 失敗 ${failed}件）。1回最大 ${MAX_BULK_ANALYZE} 件まで実行できます。`,
    );
  };

  const handleBulkAnalyzeSchool = async () => {
    if (!school || bulkAnalyzing) return;

    const targets = unanalyzedRecords.slice(0, MAX_BULK_ANALYZE);
    if (targets.length === 0) {
      setActionMessage('未分析の記録がありません');
      return;
    }

    if (unanalyzedRecords.length > MAX_BULK_ANALYZE) {
      const proceed = window.confirm(
        `未分析が ${unanalyzedRecords.length} 件あります。1回の一括分析は最大 ${MAX_BULK_ANALYZE} 件までです。\n今回 ${targets.length} 件を分析します。続行しますか？`,
      );
      if (!proceed) return;
    }

    await runBulkAnalyze(targets, 'スクール一括');
  };

  const handleBulkAnalyzeSelected = async () => {
    if (!school || bulkAnalyzing) return;

    if (selectedRecords.length === 0) {
      setActionMessage('分析するファイルを選択してください');
      return;
    }

    const targets = selectedUnanalyzedRecords.slice(0, MAX_BULK_ANALYZE);
    if (targets.length === 0) {
      setActionMessage('選択した記録はすべて分析済みです');
      return;
    }

    if (selectedUnanalyzedRecords.length > MAX_BULK_ANALYZE) {
      const proceed = window.confirm(
        `選択した未分析が ${selectedUnanalyzedRecords.length} 件あります。1回の一括分析は最大 ${MAX_BULK_ANALYZE} 件までです。\n今回 ${targets.length} 件を分析します。続行しますか？`,
      );
      if (!proceed) return;
    }

    await runBulkAnalyze(targets, '選択分');
  };

  const handleCopyAnalysis = async () => {
    if (!analysisModal.content) return;
    try {
      await navigator.clipboard.writeText(analysisModal.content);
      setActionMessage('分析結果をコピーしました');
    } catch {
      setActionMessage('コピーに失敗しました');
    }
  };

  const handleDownloadAnalysis = () => {
    if (!analysisModal.content) return;
    const blob = new Blob([analysisModal.content], { type: 'text/plain;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = analysisModal.downloadName || '分析.txt';
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
    setActionMessage('分析結果をダウンロードしました');
  };

  const formatMonthLabel = (month: string) => {
    const [year, mon] = month.split('-');
    return `${year}年${Number(mon)}月`;
  };

  const formatYen = (value: number) =>
    new Intl.NumberFormat('ja-JP', { style: 'currency', currency: 'JPY' }).format(value);

  const formatUsd = (value: number) => `$${value.toFixed(4)}`;

  if (!authenticated) {
    return (
      <section className="card narrow">
        <h2>分析</h2>
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
          <h2>分析</h2>
          <p className="lead">
            {activeTab === 'ai'
              ? 'スクールを選び、面談録音のAI分析と文字起こしの取得ができます。'
              : '利用料金の目安とアップロード監視を確認できます。'}
          </p>
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
            setMonthlyUsage(null);
            setUsageError('');
            setActiveTab('ai');
            setAdminLoaded(false);
            setAdminLoading(false);
          }}
        >
          ログアウト
        </button>
      </div>

      <div className="download-tabs" role="tablist" aria-label="分析メニュー">
        <button
          type="button"
          role="tab"
          id="download-tab-ai"
          aria-selected={activeTab === 'ai'}
          aria-controls="download-panel-ai"
          className={`download-tab${activeTab === 'ai' ? ' active' : ''}`}
          onClick={() => handleTabChange('ai')}
        >
          AI分析
        </button>
        <button
          type="button"
          role="tab"
          id="download-tab-admin"
          aria-selected={activeTab === 'admin'}
          aria-controls="download-panel-admin"
          className={`download-tab${activeTab === 'admin' ? ' active' : ''}`}
          onClick={() => handleTabChange('admin')}
        >
          管理
        </button>
      </div>

      {activeTab === 'ai' ? (
        <div id="download-panel-ai" role="tabpanel" aria-labelledby="download-tab-ai">
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
          <button
            type="button"
            className="secondary-button"
            onClick={() => void handleDownloadAnalysisSchool()}
            disabled={analyzedRecords.length === 0}
          >
            このスクールの分析結果をダウンロード (zip)
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void handleDownloadAnalysisSelected()}
            disabled={selectedAnalyzedRecords.length === 0}
          >
            選択した分析結果をダウンロード (zip)
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => void handleBulkAnalyzeSelected()}
            disabled={bulkAnalyzing || selectedUnanalyzedRecords.length === 0}
          >
            {bulkAnalyzing ? 'AI一括分析中...' : '選択したファイルをAI分析'}
          </button>
          <button
            type="button"
            className="secondary-button"
            onClick={() => void handleBulkAnalyzeSchool()}
            disabled={bulkAnalyzing || unanalyzedRecords.length === 0}
          >
            {bulkAnalyzing ? 'AI一括分析中...' : 'このスクールをまとめてAI分析'}
          </button>
        </div>
      ) : null}

      {school ? (
        <p className="field-hint">
          1回の一括AI分析は最大 {MAX_BULK_ANALYZE} 件までです（未分析 {unanalyzedRecords.length} 件
          {selectedRecords.length > 0 ? ` / 選択中の未分析 ${selectedUnanalyzedRecords.length} 件` : ''}）。
          分析済みの選択はスキップされます。分析結果は zip（*_分析.txt）または各件の「AI分析」から txt で保存できます。未分析は zip に含まれません。
        </p>
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
                  {record.analyzed_at ? (
                    <p className="analysis-status analyzed">
                      分析済: {formatDateTime(record.analyzed_at)}
                    </p>
                  ) : (
                    <p className="analysis-status">未分析</p>
                  )}
                </div>
                <div className="record-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void handleAnalyzeRecord(record)}
                    disabled={bulkAnalyzing}
                  >
                    AI分析
                  </button>
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
        </div>
      ) : null}

      {activeTab === 'admin' ? (
        <div id="download-panel-admin" role="tabpanel" aria-labelledby="download-tab-admin">
      {adminLoading ? <p className="field-hint">管理データを読み込み中...</p> : null}

      <section className="usage-panel" aria-live="polite">
        <div className="history-header">
          <h3>月別 推定利用料金（目安）</h3>
          {monthlyUsage ? <span>為替目安: 1USD = {monthlyUsage.usdJpyRate}円</span> : null}
        </div>
        {monthlyUsage ? (
          <>
            <p className="field-hint">{monthlyUsage.disclaimer}</p>
            {monthlyUsage.months.length > 0 ? (
              <table className="usage-table">
                <thead>
                  <tr>
                    <th>月</th>
                    <th>文字起こし</th>
                    <th>AI分析</th>
                    <th>合計(円)</th>
                    <th>合計(USD)</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyUsage.months.map((row) => (
                    <tr key={row.month}>
                      <td>{formatMonthLabel(row.month)}</td>
                      <td>{formatYen(row.transcribeUsd * monthlyUsage.usdJpyRate)}</td>
                      <td>{formatYen(row.analyzeUsd * monthlyUsage.usdJpyRate)}</td>
                      <td>{formatYen(row.totalJpy)}</td>
                      <td>{formatUsd(row.totalUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="field-hint">まだ集計データがありません。</p>
            )}
          </>
        ) : (
          <p className="field-hint">利用料金を読み込み中...</p>
        )}
        {usageError ? <p className="field-error">{usageError}</p> : null}
      </section>

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
            {uploadMonitor.analysisToday ? (
              <p>
                <strong>{uploadMonitor.analysisToday.count}</strong>
                <span>
                  本日の分析（約{formatYen(uploadMonitor.analysisToday.estimatedJpy)}）
                </span>
              </p>
            ) : null}
          </div>
          {uploadMonitor.analysisLimits ? (
            <p className="field-hint">
              AI分析の上限: 1時間あたり {uploadMonitor.analysisLimits.maxPerIpHour}件 / 1日全体{' '}
              {uploadMonitor.analysisLimits.maxGlobalDay}件
            </p>
          ) : null}
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
        </div>
      ) : null}

      <AnalysisModal
        open={analysisModal.open}
        title={analysisModal.title}
        content={analysisModal.content}
        loading={analysisModal.loading}
        cached={analysisModal.cached}
        onClose={() =>
          setAnalysisModal((current) => ({
            ...current,
            open: false,
            loading: false,
          }))
        }
        onCopy={() => void handleCopyAnalysis()}
        onDownload={handleDownloadAnalysis}
        onReanalyze={
          analysisModal.recordId
            ? () => {
                const record = records.find((item) => item.id === analysisModal.recordId);
                if (record) void handleAnalyzeRecord(record, true);
              }
            : undefined
        }
      />
    </section>
  );
}
