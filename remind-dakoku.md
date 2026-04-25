# 打刻リマインド（remind-dakoku）構築手順

## 目的

- **打刻漏れ防止**。始業・就業時の打刻忘れを Slack リマインドで解消
- 平日の始業帯（朝）・就業帯（夜）に Slack チャンネルへ定期投稿 → 打刻を促す
- 打刻完了後は指定スタンプで当日の時間帯分を停止 → 通知疲れ回避

## 概要

- 平日 10:00-11:00 / 20:00-21:00、5分おきに指定チャンネル自動投稿
- 投稿に指定スタンプ押下 → その時間帯の当日分停止
- GAS + Slack API で実現

## システム構成

**[1] GAS 時間トリガー**

- 実行間隔: 5分おき
- 稼働時間帯: 平日 10-11時 / 20-21時

**[2] GAS: `tick()`** — メインロジック

トリガー起動のたび、以下の順で判定し、条件を満たさないステップで即終了。

1. **曜日判定**: 土日なら何もせず終了。リマインドは平日のみ稼働
2. **時間帯判定**: 現在時刻が 10時台なら朝枠、20時台なら夜枠、いずれでもなければ終了。これで稼働時間外の実行を弾く
3. **停止フラグ確認**: 当日・当該時間帯のフラグがすでに立っていれば終了。打刻済なのに再投稿する二重通知を防ぐ
4. **スタンプ検知**: Slackから当該時間帯開始以降のチャンネル履歴を取得し、いずれかのBot投稿に設定絵文字のリアクションが付いていないか確認。ついていれば「打刻済」とみなしフラグを立てて終了。実質ここが打刻完了検知の要
5. **投稿**: 上記すべてをすり抜けた場合のみ、時刻つきリマインド文を投稿。朝枠は始業向け、夜枠は就業向けで文言を切替

**補助的な役割**

- **履歴取得関数**: 時間帯開始時刻以降のメッセージだけを対象にし、過去の別時間帯のリアクションを誤検知しない。API失敗時は「未検知」として扱い、投稿は通常どおり続行
- **投稿関数**: Slack APIが失敗しても例外で止めず、ログだけ残して次回トリガーに任せる。再送処理なし
- **週次クリーンアップ**: 停止フラグは日付入りのキーで保存されるため、日付が変われば自動で新規扱いになる。ただし古いキーが溜まり続けるため、週1回まとめて過去日付のキーを削除

**[3] Slack Workspace**

- `#打刻リマインドチャンネル`
- Bot投稿に ✅ リアクション付与で時間帯の投稿停止

**[4] GAS: `cleanupFlags()`**

- 実行間隔: 週次
- 古いフラグ削除

データフロー:

- **投稿**: GAS → `chat.postMessage` → Slackチャンネル
- **検知**: GAS → `conversations.history` → メッセージ＋リアクション取得
- **状態保持**: Script Properties に `stopped_YYYYMMDD_{morning|evening}` フラグ
- **リセット**: 日付キー変化で自動復活 + `cleanupFlags` 週次掃除

## フラグ管理

「当日・当該時間帯のリマインドを停止するか」の状態を、GASの **Script Properties** に Key-Value で保存。外部DB不要で、GASプロジェクトに紐づく永続ストア。

**キー設計**

形式: `stopped_YYYYMMDD_{morning|evening}`

日付と時間帯を1つのキーに埋め込む方式。例: `stopped_20260424_morning`。値は `"1"` 固定（存在チェックのみで使うため中身は何でもよい）。朝枠と夜枠は独立キーなので、朝だけ停止・夜はまだ稼働という状態が自然に表現できる。

**ライフサイクル**

1. **作成**: `tick()` がスタンプ検知したタイミングでキーを書き込む。この瞬間以降、同日・同時間帯の投稿はスキップ
2. **参照**: `tick()` 冒頭でキー存在を確認。あれば即終了で、Slack APIを叩かない
3. **自動失効**: キーに日付が含まれるため、翌日の `tick()` は別キーを見にいく。前日のフラグは参照されず、実質的に日付境界で自動リセット
4. **物理削除**: 失効後もキー自体はProperties領域に残留するため、週次の `cleanupFlags()` で当日より古い日付キーを一括削除。領域の上限（500KB）圧迫を予防

**この設計で得られる挙動**

- 打刻済後の静粛: 同時間帯の再投稿ゼロ
- 翌日の自動再開: リセット処理を明示的に走らせる必要なし
- 朝・夜の独立性: 朝の打刻が夜のリマインドに影響しない
- 障害復旧の単純さ: おかしな停止状態になったら該当キーを手動削除するだけで復帰

## 1. Slack App作成

### 1-1. アプリ新規作成

- https://api.slack.com/apps アクセス
- `Create New App` → `From scratch`
- App Name: 任意（例 `RemindDakoku`）
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

- 対象チャンネルで `/invite @RemindDakoku`
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
| `STOP_EMOJI` | `white_check_mark`（コロン不要） |

### 2-4. コード貼付

`コード.gs`:

```javascript
const PROPS = PropertiesService.getScriptProperties();
const TOKEN = PROPS.getProperty('SLACK_TOKEN');
const CHANNEL = PROPS.getProperty('CHANNEL_ID');
const STOP_EMOJI = PROPS.getProperty('STOP_EMOJI');

const TIME_SLOT = {
  MORNING: 'morning',
  EVENING: 'evening',
};

const ACTIVE_HOURS = {
  [TIME_SLOT.MORNING]: { startHour: 10, endHour: 11 },
  [TIME_SLOT.EVENING]: { startHour: 20, endHour: 21 },
};

const FLAG_PREFIX = 'stopped_';

/**
 * 日時から該当する時間帯名を返却する。
 *
 * @param {Date} now - 判定対象の日時
 * @returns {'morning'|'evening'|null} 該当する時間帯名 or 範囲外の場合はnull
 */
function getTimeSlot(now) {
  const hours = now.getHours();
  const morning = ACTIVE_HOURS[TIME_SLOT.MORNING];
  const evening = ACTIVE_HOURS[TIME_SLOT.EVENING];

  switch (true) {
    case hours >= morning.startHour && hours < morning.endHour:
      return TIME_SLOT.MORNING;
    case hours >= evening.startHour && hours < evening.endHour:
      return TIME_SLOT.EVENING;
    default:
      return null;
  }
}

/**
 * 打刻対象外の時間帯であることを判定。
 *
 * @param {Date} now - 判定対象の日時
 * @returns {boolean} 打刻対象外である場合、trueを返却
 */
function isOutOfActiveHours(now) {
  const day = now.getDay();
  const isWeekend = day === 0 || day === 6;

  const timeSlot = getTimeSlot(now);

  return isWeekend || timeSlot === null;
}

/**
 * 当日・当該時間帯の停止フラグが立っているかを判定。
 * 稼働時間帯(getTimeSlot が non-null を返す)の呼出を前提とする。
 *
 * @param {Date} now - 判定対象の日時
 * @returns {boolean} フラグが立っている場合、trueを返却
 */
function hasStoppedFlag(now) {
  const timeSlot = getTimeSlot(now);
  const dateString = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd');
  const flagKey = `${FLAG_PREFIX}${dateString}_${timeSlot}`;

  return Boolean(PROPS.getProperty(flagKey));
}

/**
 * トリガーから5分おきに実行されるメインロジック。
 * 平日かつ打刻対象の時間帯で、当日の当該時間帯が未打刻と判定される場合、リマインドを投稿する。
 *
 * @returns {void}
 */
function tick() {
  const now = new Date();
  if (isOutOfActiveHours(now) || hasStoppedFlag(now)) return;

  const timeSlot = getTimeSlot(now);

  if (hasReactionOnRecent(timeSlot)) {
    const dateString = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd');
    PROPS.setProperty(`${FLAG_PREFIX}${dateString}_${timeSlot}`, '1');
    return;
  }

  const message = timeSlot === TIME_SLOT.MORNING
      ? '始業打刻したら✅を押してね！'
      : '終業打刻したら✅を押してね！';
  postMessage(message);
}

/**
 * Slackチャンネルへテキスト投稿。
 * 失敗時は例外を投げずconsole.errorに記録のみ。
 *
 * @param {string} text - 投稿本文
 * @returns {void}
 */
function postMessage(message) {
  const res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    headers: { Authorization: `Bearer ${TOKEN}` },
    contentType: 'application/json; charset=utf-8',
    payload: JSON.stringify({ channel: CHANNEL, message }),
    muteHttpExceptions: true,
  });
  const body = JSON.parse(res.getContentText());

  if (!body.ok) console.error('post failed', body);
}

/**
 * 当該時間帯の開始以降のチャンネル履歴を取得し、STOP_EMOJI リアクションの有無を判定する。
 * API失敗時はfalseを返し投稿継続させる。
 *
 * @param {'morning'|'evening'} timeSlot - 検査対象の時間帯
 * @returns {boolean} 対象の投稿のリアクションに STOP_EMOJI が含まれる場合、trueを返却
 */
function hasReactionOnRecent(timeSlot) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(ACTIVE_HOURS[timeSlot].startHour, 0, 0, 0);
  const oldest = Math.floor(start.getTime() / 1000);

  const url = `https://slack.com/api/conversations.history?channel=${CHANNEL}&oldest=${oldest}&limit=50`;
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    muteHttpExceptions: true,
  });
  const body = JSON.parse(res.getContentText());

  if (!body.ok) {
    console.error('failed to fetch history: ', body);
    return false;
  }

  return body.messages.some((message) =>
    message.reactions?.some((reaction) => reaction.name === STOP_EMOJI)
  );
}

/**
 * Script Properties から本日より古い `stopped_YYYYMMDD_*` キーを一括削除する。
 * トリガーから1週間おきなどで定期的に実行される想定。
 *
 * @returns {void}
 */
function cleanupFlags() {
  const properties = PROPS.getProperties();
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');

  Object.keys(properties)
    .filter((property) => property.startsWith(FLAG_PREFIX))
    .filter((property) => property.split('_')[1] < today)
    .forEach((property) => PROPS.deleteProperty(property));
}
```

### 2-5. 保存

`Ctrl+S`

## 3. トリガー設定

### 3-1. `tick`を5分おき実行

- 左メニュー 時計アイコン `トリガー` → `トリガーを追加`
- 実行する関数: `tick`
- イベントソース: `時間主導型`
- 時間ベース: `分ベースのタイマー`
- 間隔: `5分おき`
- 保存 → 初回OAuth承認

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

時間帯外でも動作確認したい場合、一時的に ` if (isOutOfActiveTimeZones(now)) return;` コメントアウト → 実行 → 復元

### 4-3. スタンプ停止テスト

- 10時台投稿に `:white_check_mark:` 押下
- 次5分トリガー時、`stopped_YYYYMMDD_morning` フラグ立ち → 以降投稿停止確認
- `プロジェクトの設定` → `スクリプト プロパティ` でフラグ存在確認

## 5. 挙動仕様

| 時刻 | 動作 |
|------|------|
| 平日 10:00-10:55（5分刻み） | `morning`投稿、スタンプ検知で以降停止 |
| 平日 20:00-20:55（5分刻み） | `evening`投稿、`morning`停止と独立 |
| 土日 | 全スキップ |
| 日付変わる | フラグキー変わる → 翌日自動再開 |

## 注意点

- **5分刻み精度**: GAS `5分おき`トリガーは厳密に `:00,:05,...` でなく±数分ずれる → 投稿時刻揺れる。厳密にしたい場合 `特定時刻トリガー` 12個登録
- **レート制限**: `conversations.history` は Tier 3（50+/分） → 5分おきなら余裕
- **プライベートチャンネル**: `groups:history` スコープ追加 + Bot再インストール必要
- **`limit=50`**: 該当時間帯に50件超投稿ある場合ページング必要（通常用途では不要）
- **タイムゾーン**: プロジェクト設定 `Asia/Tokyo` 必須、抜けると9時間ずれる

## トラブルシュート

| 症状 | 原因 / 対処 |
|------|-------------|
| 投稿されない | `実行ログ`で`post failed`確認。`not_in_channel` → Bot未招待。`invalid_auth` → トークン誤り |
| スタンプ検知しない | `STOP_EMOJI`のコロン混入確認。カスタム絵文字は正式名使用 |
| 二重投稿 | 複数トリガー残存確認 → 古いの削除 |
