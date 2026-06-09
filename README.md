# 文字起こしくん

電話録音をアップロードすると OpenAI で文字起こしし、Cloudflare D1 にテキスト、R2 に圧縮音声を保存する PWA です。

## 機能

- スクール / 学年 / クラス / 生徒氏名を入力して音声をアップロード
- ブラウザ内で mono 16kHz mp3 に圧縮してから送信
- 文字起こし結果を `スクール_学年_クラス_氏名.txt` 形式で保存
- ダウンロードページでスクール単位の一覧表示、個別 txt / zip 一括ダウンロード、削除
- 管理画面でアップロード履歴の時系列表示、未ダウンロードの絞り込み
- 文字起こし完了時に管理者メールへ通知（SendGrid）

## 技術スタック

- フロント: Vite + React + TypeScript + vite-plugin-pwa
- バックエンド: Cloudflare Pages Functions
- DB: Cloudflare D1
- 音声保存: Cloudflare R2
- 文字起こし: OpenAI `gpt-4o-mini-transcribe`

## セットアップ

### 1. 依存関係

```bash
npm install
```

### 2. 環境変数

`.dev.vars.example` を参考に `.dev.vars` を作成します。

```env
OPENAI_API_KEY=sk-...
DOWNLOAD_PASSCODE=taichi
TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
UPLOAD_MAX_PER_IP_HOUR=12
UPLOAD_MAX_PER_IP_DAY=40
UPLOAD_MAX_GLOBAL_DAY=150
UPLOAD_MAX_FILE_MB=25

# アップロード完了メール通知（任意）
MAIL_API_KEY=SG.xxx
MAIL_FROM="文字起こしくん <verified-sender@example.com>"
NOTIFY_EMAIL_TO="t-narazaki@rensei.co.jp,t-wada@rensei.co.jp"
APP_BASE_URL=https://your-app.pages.dev
```

アップロード監視は、上記の上限を超えると OpenAI API を呼ぶ前に遮断し、`/download`
の管理画面に異常検知として表示します。

メール通知は `MAIL_API_KEY` / `MAIL_FROM` / `NOTIFY_EMAIL_TO` がすべて設定されている場合のみ、
文字起こし完了後に SendGrid 経由で送信されます。未設定の場合は通知をスキップし、文字起こし処理自体は継続します。
メール本文にはパスコードや文字起こし本文は含めず、管理画面へのリンクは `${APP_BASE_URL}/download` のみを載せます。

### SendGrid 初期設定

1. Twilio SendGrid にログインし、`Settings > API Keys` で送信用 API キーを作成します。権限を絞る場合は `mail.send` を許可してください。
2. `Settings > Sender Authentication > Single Sender Verification` で、`MAIL_FROM` に使う送信元メールアドレスを登録し、届いた確認メールのリンクで認証を完了します。
3. ローカルでは `.dev.vars` に `MAIL_API_KEY` / `MAIL_FROM` / `NOTIFY_EMAIL_TO` / `APP_BASE_URL` を設定します。`MAIL_FROM` に表示名を含める場合は `"文字起こしくん <verified-sender@example.com>"` のように引用符で囲みます。
4. 本番では Cloudflare Pages Secret に同じ値を設定します。

```bash
npx wrangler pages secret put MAIL_API_KEY --project-name=mojiokoshi-kun
npx wrangler pages secret put MAIL_FROM --project-name=mojiokoshi-kun
npx wrangler pages secret put NOTIFY_EMAIL_TO --project-name=mojiokoshi-kun
npx wrangler pages secret put APP_BASE_URL --project-name=mojiokoshi-kun
```

`npm run ship:prod` は `.dev.vars` に値がある場合、`DOWNLOAD_PASSCODE` に加えて上記のメール関連 Secret も同期します。空欄の項目はスキップします。

テスト時は、まず `MAIL_API_KEY` を空にした状態で文字起こしが成功することを確認し、その後 SendGrid 設定済みの状態で短い音声を1件アップロードして管理者メールに通知が届くことを確認します。通知失敗時は `/download` のアップロード監視に `mail_failed` として記録されます。

### 3. Cloudflare リソース

```bash
# D1 作成
npx wrangler d1 create transcribe-db

# 出力された database_id を wrangler.toml の database_id に設定

# スキーマ適用
npx wrangler d1 execute transcribe-db --local --file=./schema.sql
npx wrangler d1 execute transcribe-db --remote --file=./schema.sql

# R2 作成
npx wrangler r2 bucket create transcribe-audio
```

### 4. ローカル開発

```bash
npm run build
npm run pages:dev
```

別ターミナルでフロント開発する場合:

```bash
npm run dev
```

`vite.config.ts` の proxy により `/api` は `http://127.0.0.1:8788` に転送されます。

### 5. 本番デプロイ

#### 方法A: GitHub Actions（推奨）

1. Cloudflare ダッシュボードで API トークンを作成（Permissions: Account / Cloudflare Pages Edit, D1 Edit, R2 Edit）
2. GitHub リポジトリ `Settings > Secrets > Actions` に `CLOUDFLARE_API_TOKEN` を登録
3. `main` へ push すると自動デプロイ

#### 方法B: 手動デプロイ

```bash
npm run deploy
```

#### 方法C: コミット + push + 本番デプロイ（一括）

`main` ブランチで実行します。ビルド後にコミット・push・`wrangler pages deploy` まで行い、`.dev.vars` の `DOWNLOAD_PASSCODE` とメール関連設定があれば Pages シークレットも同期します。

```bash
npm run ship:prod -- "chore: update download passcode"
```

#### Cloudflare リソース（初回のみ）

```bash
# R2（OAuth 権限不足の場合はダッシュボードからバケット transcribe-audio を作成）
npx wrangler login
npx wrangler r2 bucket create transcribe-audio

# D1（作成済みの場合は database_id を wrangler.toml に設定）
npx wrangler d1 create transcribe-db
npx wrangler d1 execute transcribe-db --remote --file=./schema.sql
```

本番シークレット（未設定の場合）:

```bash
npx wrangler pages secret put OPENAI_API_KEY --project-name=mojiokoshi-kun
npx wrangler pages secret put DOWNLOAD_PASSCODE --project-name=mojiokoshi-kun
npx wrangler pages secret put MAIL_API_KEY --project-name=mojiokoshi-kun
npx wrangler pages secret put MAIL_FROM --project-name=mojiokoshi-kun
npx wrangler pages secret put NOTIFY_EMAIL_TO --project-name=mojiokoshi-kun
npx wrangler pages secret put APP_BASE_URL --project-name=mojiokoshi-kun
```

#### Cloudflare Pages と GitHub の連携（ダッシュボード）

CLI だけでは Git 連携の OAuth 認可が必要なため、以下はダッシュボードで行います。

1. [Cloudflare Pages](https://dash.cloudflare.com/) > `mojiokoshi-kun` > Settings > Builds & deployments
2. Connect to Git > GitHub > `t-wada-wing/mojiokoshi-kun` を選択
3. Build command: `npm run build` / Build output: `dist`

※ GitHub Actions デプロイと併用する場合は、どちらか一方に統一してください。

## ページ

- `/` : アップロード
- `/download` : ダウンロード / 管理 (パスコード: `taichi`)

## 注意

- `.amr` / `.3gp` 形式は非対応です
- **25分を超える音声**はブラウザ内で自動分割され、サーバー側で文字起こし結果を1件のテキストに結合して保存します（完了まで時間がかかる場合があります）
- OpenAI `gpt-4o-mini-transcribe` は1リクエストあたり約25分（1500秒）・25MBが上限のため、内部分割（20分単位）で対応しています
- OpenAI の文字起こし API は課金設定が必要です
- API キーは `.dev.vars` または Cloudflare Secrets にのみ保存し、リポジトリへコミットしないでください
