# 打刻リマインド（remind-dakoku）構築手順

概要・使い方は [README.md](README.md)、仕組み・設計の解説は [docs/architecture.md](docs/architecture.md) を参照。

## 1. Slack App作成

### 1-1. アプリ新規作成（manifest貼付）

- https://api.slack.com/apps アクセス
- `Create New App` → `From a manifest`
- Workspace選択 → 次画面で `JSON` タブを選び [manifest.json](manifest.json) の内容を貼付 → `Create`
- scope（`chat:write` / `reactions:read` / `channels:history` / `channels:read` / `groups:history` / `groups:read`）は manifest に含まれるため追加不要

### 1-2. インストール

- 同ページ上部 `Install to Workspace` → 承認
- `Bot User OAuth Token` (`xoxb-...`) コピー保管

### 1-3. Botをチャンネル招待

- 対象チャンネルで `/invite @リマインド犬`
- チャンネルID取得: チャンネル名右クリック → `リンクをコピー` → URL末尾 `/archives/CXXXXX` の `CXXXXX`

## 2. GASプロジェクト作成

### 2-1. 新規プロジェクト

- https://script.google.com/ → `新しいプロジェクト`
- プロジェクト名: `RemindDakoku`

### 2-2. タイムゾーン設定

- 左下歯車 `プロジェクトの設定`
- `タイムゾーン` → `(GMT+09:00) 東京`
- **必須**。抜けると判定が9時間ずれる

### 2-3. Script Properties登録

`プロジェクトの設定` → `スクリプト プロパティ` → `スクリプト プロパティを追加`:

| キー | 値 |
|------|-----|
| `SLACK_TOKEN` | `xoxb-...` |
| `CHANNEL_ID` | `CXXXXX` |
| `STOP_EMOJI` | `white_check_mark` |
| `DAY_OFF_EMOJI` | `heart` |
| `MORNING_START_HOUR` | `10` |
| `MORNING_END_HOUR` | `11` |
| `EVENING_START_HOUR` | `19` |
| `EVENING_END_HOUR` | `22` |
| `MORNING_MESSAGE` | `【始業】打刻したことを確認したら、✅を押してね！` |
| `EVENING_MESSAGE` | `【終業】打刻したことを確認したら、✅を押してね！` |

`*_HOUR` は時（0-24）のみ指定。全キー必須で、未設定・不正な値・開始 >= 終了の場合は実行時エラーになる。

### 2-4. コード貼付

[src/code.gs](src/code.gs) の内容を `コード.gs` に貼付。

## 3. トリガー設定

エディタで `setup` を選択して実行。

- 初回実行時にOAuth承認（Slack 外部URL + Calendar 読取スコープ）を求められるので承認
- `tick`（5分おき）と `cleanupFlags`（毎週日曜3時）の2トリガーが自動作成される
- 既存の同名トリガーは実行前に削除されるため、再実行しても重複登録されない

## 4. 動作テスト

### 4-0. 設定チェック

エディタで `verifySetup` を選択して実行 → 実行ログで全項目 `✅` を確認。`❌` があれば表示内容に従い該当箇所を修正して再実行。

### 4-1. 手動投稿テスト

`testPost` を選択して実行 → チャンネル確認

### 4-2. `tick`単体実行

時間帯外でも動作確認したい場合、一時的に `  if (isOutOfActiveHours(now) || hasStoppedFlag(now)) return;` コメントアウト → 実行 → 復元

### 4-3. リアクション停止テスト

- 10時台投稿に `:white_check_mark:` 押下
- 次5分トリガー時、`stopped_YYYYMMDD_morning` フラグ立ち → 以降投稿停止確認
- `プロジェクトの設定` → `スクリプト プロパティ` でフラグ存在確認

## 注意点（構築時）

- **タイムゾーン**: プロジェクト設定 `Asia/Tokyo` 必須（手順 2-2）、抜けると9時間ずれる
- **プライベートチャンネル**: `groups:history` / `groups:read` は manifest に含まれるためスコープ追加不要。Bot のチャンネル招待のみ必要

動作仕様に関する注意点（5分刻み精度・レート制限・祝日カレンダー・スヌーズ仕様等）は [docs/architecture.md](docs/architecture.md) の「設計上の注意点」を参照。

## トラブルシュート

| 症状 | 原因 / 対処 |
|------|-------------|
| 投稿されない | `実行ログ`で`post failed`確認。`not_in_channel` → Bot未招待。`invalid_auth` → トークン誤り |
| リアクション検知しない | `STOP_EMOJI`のコロン混入確認。カスタム絵文字は正式名使用 |
| 二重投稿 | 複数トリガー残存が原因 → `setup()` 再実行で解消（既存トリガーを削除してから作り直すため重複しない） |
| 祝日に投稿される | `failed to verify national holiday` ログ確認 → Calendar スコープ未承認 or カレンダーID誤り。承認やり直し or `isNationalHoliday` のID確認 |
