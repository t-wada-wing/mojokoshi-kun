#!/usr/bin/env bash
# npm run ship:prod [-- "コミットメッセージ"]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PROJECT_NAME="${PROJECT_NAME:-mojiokoshi-kun}"
PRODUCTION_BRANCH="${PRODUCTION_BRANCH:-main}"
BUILD_DIR="${BUILD_DIR:-dist}"

COMMIT_MESSAGE="${*:-chore: ship prod}"

log() {
  printf '\n[ship:prod] %s\n' "$*"
}

fail() {
  printf '\n[ship:prod] Error: %s\n' "$*" >&2
  exit 1
}

CURRENT_BRANCH="$(git branch --show-current)"
[[ -n "$CURRENT_BRANCH" ]] || fail "Detached HEAD はサポートしていません。"
[[ "$CURRENT_BRANCH" == "$PRODUCTION_BRANCH" ]] || fail "${PRODUCTION_BRANCH} ブランチで実行してください（現在: ${CURRENT_BRANCH}）。"

git remote get-url origin >/dev/null 2>&1 || fail "git remote origin がありません。"

if git diff --name-only --diff-filter=U | grep -q .; then
  fail "マージコンフリクトを解消してから実行してください。"
fi

log "npm run build"
npm run build

log "git add -A"
git add -A

if git diff --cached --quiet; then
  log "コミットする変更がありません（コミットをスキップ）"
else
  log "git commit: ${COMMIT_MESSAGE}"
  git commit -m "$COMMIT_MESSAGE"
fi

log "git push origin ${PRODUCTION_BRANCH}"
git push origin "$PRODUCTION_BRANCH"

COMMIT_HASH="$(git rev-parse HEAD)"
COMMIT_SUBJECT="$(git log -1 --pretty=%s)"

log "Cloudflare Pages へデプロイ"
npx wrangler pages deploy "$BUILD_DIR" \
  --project-name="$PROJECT_NAME" \
  --branch="$PRODUCTION_BRANCH" \
  --commit-hash="$COMMIT_HASH" \
  --commit-message="$COMMIT_SUBJECT"

read_dev_var() {
  local key="$1"
  local line value

  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" .dev.vars | tail -1 || true)"
  [[ -n "$line" ]] || return 1

  value="${line#*=}"
  value="${value%$'\r'}"

  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi

  [[ -n "$value" ]] || return 1
  printf '%s' "$value"
}

sync_pages_secret() {
  local key="$1"
  local value

  [[ -f .dev.vars ]] || return 0
  if [[ "$key" == "DOWNLOAD_PASSCODE" && "${SKIP_SYNC_DOWNLOAD_PASSCODE:-0}" == "1" ]]; then
    return 0
  fi

  value="$(read_dev_var "$key" || true)"
  [[ -n "$value" ]] || return 0

  log "Pages シークレット ${key} を .dev.vars と同期"
  printf '%s' "$value" | npx wrangler pages secret put "$key" --project-name="$PROJECT_NAME"
}

for secret_name in DOWNLOAD_PASSCODE MAIL_API_KEY MAIL_FROM NOTIFY_EMAIL_TO APP_BASE_URL; do
  sync_pages_secret "$secret_name"
done

log "完了: https://${PROJECT_NAME}.pages.dev"
