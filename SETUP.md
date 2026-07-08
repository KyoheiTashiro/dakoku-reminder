# 打刻リマインド（remind-dakoku）構築手順

概要・使い方は [README.md](README.md) を参照。

## システム構成

**[1] GAS 時間トリガー**

- 実行間隔: 5分おき
- 稼働時間帯: 平日 10-11時 / 19-22時（土日・祝日は内部判定でスキップ）

**[2] GAS: `tick()`** — メインロジック

トリガー起動のたび、以下の順で判定し、条件を満たさないステップで即終了。

1. **稼働日時判定** (`isOutOfActiveHours`): 土日・日本の祝日・稼働時間外（10時台/19-21時台以外）のいずれかなら終了。
2. **停止フラグ確認** (`hasStoppedFlag`): 当日・当該時間帯のフラグがすでに立っていれば終了。
3. **終日停止検知** (`hasAllDayStopSignal`): 当日0時以降のチャンネル履歴を取得し、いずれかのメッセージに `DAY_OFF_EMOJI`（部分一致、例 `heart`）を含むリアクションが付いていないか、またはユーザー（bot以外）の投稿本文に `DAY_OFF_EMOJI` を含む絵文字（例 `:heart:`）がないか確認。あれば朝・夜 両時間帯のフラグを立てて終了し、当日終日リマインドを停止する。色違いのハート（`yellow_heart`等）も全捕捉。
4. **スタンプ検知** (`hasReactionOnRecent`): Slackから当該時間帯開始以降のチャンネル履歴を取得し、いずれかのメッセージに設定絵文字のリアクションが付いていないか確認。ついていれば「打刻済」とみなしフラグを立てて終了。
5. **ユーザー自己申告検知** (`hasUserCompletionPost`): 当該時間帯のスキャン開始時刻（MORNING:当日0時 / EVENING:朝枠終了時刻）以降のチャンネル履歴を取得し、ユーザー（bot以外）の投稿本文に `✅` 文字が含まれていれば「打刻済」とみなしフラグを立てて終了。ACTIVE_HOURS開始より早く打刻したユーザーが先回りで申告した場合の抑止用。朝の申告は夜の枠まで抑止しない。
6. **スヌーズ判定** (`isSnoozed`): 当該時間帯開始以降のチャンネル履歴を取得し、ユーザー（bot以外）の数字のみ投稿（例 `10`）を探す。「投稿時刻 + N分」が現在時刻を超えていれば、まだスヌーズ期限内とみなして終了。完了申告と異なり**フラグは立てず**、期限が過ぎれば次のtickで自動再開する。
7. **投稿** (`buildMessage` + `postMessage`): 上記すべてをすり抜けた場合のみリマインド文を投稿。

**[3] Slack Workspace**

- 任意のチャンネル（例 `#打刻リマインド`）。`CHANNEL_ID` で指定したチャンネルが投稿先
- Bot投稿に ✅ リアクション付与で時間帯の投稿停止

**[4] GAS: `cleanupFlags()`**

- 実行間隔: 週次(推奨)
- 古いフラグ削除

データフロー:

- **投稿**: GAS → `chat.postMessage` → Slackチャンネル
- **検知**: GAS → `conversations.history` → メッセージ＋リアクション取得
- **状態保持**: Script Properties に `stopped_YYYYMMDD_{morning|evening}` フラグ
- **リセット**: 日付キー変化で自動復活 + `cleanupFlags` 週次掃除

## フラグ管理

「当日・当該時間帯のリマインドを停止するか」の状態を、GASの **Script Properties** に Key-Value で保存。

**キー設計**

形式: `stopped_YYYYMMDD_{morning|evening}`

日付と時間帯を1つのキーに埋め込む方式。例: `stopped_20260424_morning`。値は `"1"` 固定

## 1. Slack App作成

### 1-1. アプリ新規作成

- https://api.slack.com/apps アクセス
- `Create New App` → `From scratch`
- App Name: 任意（例 `リマインド犬`）
- Workspace選択 → `Create App`

### 1-2. OAuth Scopes設定

左メニュー `OAuth & Permissions` → `Scopes` → `Bot Token Scopes` に追加:

- `chat:write` — 投稿
- `reactions:read` — スタンプ読取
- `channels:history` — パブリックチャンネル履歴
- `groups:history` — プライベートチャンネル履歴（必要時）

### 1-3. インストール

- 同ページ上部 `Install to Workspace` → 承認
- `Bot User OAuth Token` (`xoxb-...`) コピー保管

### 1-4. Botをチャンネル招待

- 対象チャンネルで `/invite @リマインド犬`
- チャンネルID取得: チャンネル名右クリック → `リンクをコピー` → URL末尾 `/archives/CXXXXX` の `CXXXXX`

## 2. GASプロジェクト作成

### 2-1. 新規プロジェクト

- https://script.google.com/ → `新しいプロジェクト`
- プロジェクト名: `RemindDakoku`

### 2-2. タイムゾーン設定

- 左下歯車 `プロジェクトの設定`
- `タイムゾーン` → `(GMT+09:00) 東京`

### 2-3. Script Properties登録

`プロジェクトの設定` → `スクリプト プロパティ` → `スクリプト プロパティを追加`:

| キー | 値 |
|------|-----|
| `SLACK_TOKEN` | `xoxb-...` |
| `CHANNEL_ID` | `CXXXXX` |
| `STOP_EMOJI` | `white_check_mark` |
| `DAY_OFF_EMOJI` | `heart` |

### 2-4. コード貼付

[src/code.gs](src/code.gs) の内容を `コード.gs` に貼付。

## 3. トリガー設定

### 3-1. `tick`を5分おき実行

- 左メニュー 時計アイコン `トリガー` → `トリガーを追加`
- 実行する関数: `tick`
- イベントソース: `時間主導型`
- 時間ベース: `分ベースのタイマー`
- 間隔: `5分おき`
- 保存 → 初回OAuth承認（Slack 外部URL + Calendar 読取スコープを承認）

### 3-2. `cleanupFlags`を週次実行

- トリガー追加
- 関数: `cleanupFlags`
- 時間主導型 → 週ベース → 日曜深夜など

## 4. 動作テスト

### 4-1. 手動投稿テスト

テスト関数追加:

```javascript
function testPost() { postMessage('テスト投稿'); }
```

`testPost`選択 → 実行 → チャンネル確認

### 4-2. `tick`単体実行

時間帯外でも動作確認したい場合、一時的に `  if (isOutOfActiveHours(now) || hasStoppedFlag(now)) return;` コメントアウト → 実行 → 復元

### 4-3. スタンプ停止テスト

- 10時台投稿に `:white_check_mark:` 押下
- 次5分トリガー時、`stopped_YYYYMMDD_morning` フラグ立ち → 以降投稿停止確認
- `プロジェクトの設定` → `スクリプト プロパティ` でフラグ存在確認

## 注意点

- **5分刻み精度**: GAS `5分おき`トリガーは厳密に `:00,:05,...` でなく±数分ずれる → 投稿時刻揺れる。厳密にしたい場合 `特定時刻トリガー` 12個登録
- **レート制限**: `conversations.history` は Tier 3（50+/分） → 5分おきなら余裕
- **プライベートチャンネル**: `groups:history` スコープ追加 + Bot再インストール必要
- **`limit=50`**: 該当時間帯に50件超投稿ある場合ページング必要（通常用途では不要）
- **タイムゾーン**: プロジェクト設定 `Asia/Tokyo` 必須、抜けると9時間ずれる
- **祝日カレンダー依存**: Google 公開祝日カレンダー (`ja.japanese.official#holiday@group.v.calendar.google.com`、法定祝日のみ版) 参照。`ja.japanese#holiday@...`（`.official` なし）は「祝日およびその他の休日」版で、七夕・クリスマス・大晦日等の行事も含むため使用しない。配信遅延・廃止リスクあり。実運用ではキャッシュ TTL 6時間 → 当日反映遅延の可能性
- **祝日キャッシュ**: `CacheService` 6時間保持。手動で祝日判定変更したい場合 `CacheService.getScriptCache().remove('holiday_YYYYMMDD')` でキー削除
- **スヌーズ対象**: 本文が数字のみ（`/^\d+$/`）の投稿のみ反応。雑談中の数字は誤検知しない。`0` 投稿は即再開で無害
- **API呼出回数**: tick毎に最大3回 `conversations.history` を叩く（reaction/completion/snooze）。Tier 3 のため5分おきなら問題ないが、気になれば履歴取得を1回に統合し3判定で共有可

## トラブルシュート

| 症状 | 原因 / 対処 |
|------|-------------|
| 投稿されない | `実行ログ`で`post failed`確認。`not_in_channel` → Bot未招待。`invalid_auth` → トークン誤り |
| スタンプ検知しない | `STOP_EMOJI`のコロン混入確認。カスタム絵文字は正式名使用 |
| 二重投稿 | 複数トリガー残存確認 → 古いの削除 |
| 祝日に投稿される | `failed to verify national holiday` ログ確認 → Calendar スコープ未承認 or カレンダーID誤り。承認やり直し or `isNationalHoliday` のID確認 |
