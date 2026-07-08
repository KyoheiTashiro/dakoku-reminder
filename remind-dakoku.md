# 打刻リマインド（remind-dakoku）構築手順

## 目的

- **打刻漏れ防止**。始業・就業時の打刻忘れを Slack リマインドで解消
- 平日の始業帯（朝）・就業帯（夜）に Slack チャンネルへ定期投稿 → 打刻を促す
- 打刻完了後は指定スタンプで当日の時間帯分を停止 → 通知疲れ回避

## 概要

- 平日（土日・日本の祝日を除く）10:00-11:00 / 20:00-21:00、5分おきに指定チャンネル自動投稿
- 投稿に指定スタンプ押下 → その時間帯の当日分停止
- 数字のみ投稿（例 `10`）→ 投稿時刻からN分リマインド一時停止（スヌーズ）
- GAS + Slack API で実現

## システム構成

**[1] GAS 時間トリガー**

- 実行間隔: 5分おき
- 稼働時間帯: 平日 10-11時 / 19-22時（土日・祝日は内部判定でスキップ）

**[2] GAS: `tick()`** — メインロジック

トリガー起動のたび、以下の順で判定し、条件を満たさないステップで即終了。

1. **稼働日時判定** (`isOutOfActiveHours`): 土日・日本の祝日・稼働時間外（10時台/19-21時台以外）のいずれかなら終了。
2. **停止フラグ確認** (`hasStoppedFlag`): 当日・当該時間帯のフラグがすでに立っていれば終了。
3. **終日停止検知** (`hasAllDayStopSignal`): 当日0時以降のチャンネル履歴を取得し、いずれかのメッセージに `DAY_OFF_EMOJI`（部分一致、例 `heart`）を含むリアクションが付いていないか確認。ついていれば朝・夜 両時間帯のフラグを立てて終了し、当日終日リマインドを停止する。色違いのハート（`yellow_heart`等）も全捕捉。
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

`コード.gs`:

```javascript
const PROPS = PropertiesService.getScriptProperties();
const TOKEN = PROPS.getProperty('SLACK_TOKEN');
const CHANNEL = PROPS.getProperty('CHANNEL_ID');
const STOP_EMOJI = PROPS.getProperty('STOP_EMOJI');
const DAY_OFF_EMOJI = PROPS.getProperty('DAY_OFF_EMOJI');

const TIME_SLOT = {
  MORNING: 'morning',
  EVENING: 'evening',
};

const ACTIVE_HOURS = {
  [TIME_SLOT.MORNING]: { startHour: 10, endHour: 11 },
  [TIME_SLOT.EVENING]: { startHour: 19, endHour: 22 },
};

const FLAG_PREFIX = 'stopped_';

const NUMBER_ONLY_PATTERN = /^\d+$/;

/**
 * トリガーから5分おきに実行されるメインロジック。
 * 平日かつ打刻対象の時間帯で、当日の当該時間帯が未打刻と判定される場合、リマインドを投稿する。
 *
 * @returns {void}
 */
function tick() {
  const now = new Date();

  if (isOutOfActiveHours(now) || hasStoppedFlag(now)) return;

  if (hasAllDayStopSignal(now)) {
    setStopFlag(now, TIME_SLOT.MORNING);
    setStopFlag(now, TIME_SLOT.EVENING);
    return;
  }

  const timeSlot = getTimeSlot(now);

  if (hasReactionOnRecent(timeSlot) || hasUserCompletionPost(now, timeSlot)) {
    setStopFlag(now, timeSlot);
    return;
  }

  if (isSnoozed(timeSlot)) return;

  const message = buildMessage(timeSlot);

  postMessage(message);
}

/**
 * 当日・当該時間帯の停止フラグを Script Properties に立てる。
 *
 * @param {Date} date - 対象日
 * @param {'morning'|'evening'} timeSlot - 対象の時間帯
 * @returns {void}
 */
function setStopFlag(date, timeSlot) {
  const dateString = Utilities.formatDate(date, 'Asia/Tokyo', 'yyyyMMdd');
  const flagKey = `${FLAG_PREFIX}${dateString}_${timeSlot}`;

  PROPS.setProperty(flagKey, '1');
}

/**
 * 当日0時以降の履歴に終日停止シグナル（ハート系リアクション）が存在するかを判定する。
 * リアクション名に DAY_OFF_EMOJI を含むものがあれば true。
 * 検知時は朝・夜 両時間帯のフラグを立て、当日終日リマインドを停止させる用途。
 * API失敗時は false を返し投稿継続させる。
 *
 * @param {Date} date - 判定基準日
 * @returns {boolean} ハート系リアクション存在時、trueを返却
 */
function hasAllDayStopSignal(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const oldest = Math.floor(start.getTime() / 1000);

  const messages = fetchChannelHistory(oldest, 200);
  if (!messages) return false;

  return messages
    .flatMap((message) => message.reactions ?? [])
    .some((reaction) => reaction.name.includes(DAY_OFF_EMOJI));
}

/**
 * チャンネル履歴を取得しメッセージ配列を返却。
 * API失敗時は null を返す（呼出側で投稿継続判定に利用）。
 *
 * @param {number} oldest - 取得開始のUNIX秒
 * @param {number} limit - 取得件数上限
 * @returns {Array|null} メッセージ配列 or 失敗時null
 */
function fetchChannelHistory(oldest, limit) {
  const url = `https://slack.com/api/conversations.history?channel=${CHANNEL}&oldest=${oldest}&limit=${limit}`;
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    muteHttpExceptions: true,
  });
  const body = JSON.parse(res.getContentText());

  if (!body.ok) {
    console.error('failed to fetch history: ', body);
    return null;
  }

  return body.messages;
}

/**
 * 打刻対象外の時間帯であることを判定。
 *
 * @param {Date} date - 判定対象の日時
 * @returns {boolean} 打刻対象外である場合、trueを返却
 */
function isOutOfActiveHours(date) {
  const day = date.getDay();

  const isWeekend = day === 0 || day === 6;
  const isHoliday = isNationalHoliday(date);
  const timeSlot = getTimeSlot(date);

  return isWeekend || isHoliday || !timeSlot;
}

/**
 * 日本の祝日であることを判定。
 * 判定結果は CacheService に 6時間（21600秒、GAS上限）保持し、同一日付内のAPI再呼出を抑止。
 * 失敗時はfalseを返却。
 *
 * @param {Date} date - 判定対象の日付
 * @returns {boolean} 祝日の場合、trueを返却
 */
function isNationalHoliday(date) {
  const cache = CacheService.getScriptCache();
  const key = `holiday_${Utilities.formatDate(date, 'Asia/Tokyo', 'yyyyMMdd')}`;
  const cached = cache.get(key);

  if (cached !== null) {
    return cached === '1'
  };


  try {
    const calendar = CalendarApp.getCalendarById('ja.japanese.official#holiday@group.v.calendar.google.com');
    const isHoliday = calendar.getEventsForDay(date).length > 0;

    cache.put(key, isHoliday ? '1' : '0', 21600);
    return isHoliday;
  } catch (e) {
    console.error('failed to verify national holiday: ', e);
    return false;
  }
}

/**
 * 日時から該当する時間帯名を返却する。
 *
 * @param {Date} date - 判定対象の日時
 * @returns {'morning'|'evening'|null} 該当する時間帯名 or 範囲外の場合はnull
 */
function getTimeSlot(date) {
  const hours = date.getHours();
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
 * 当日・当該時間帯の停止フラグが立っているかを判定。
 *
 * @param {Date} date - 判定対象の日時
 * @returns {boolean} フラグが立っている場合、trueを返却
 */
function hasStoppedFlag(date) {
  const timeSlot = getTimeSlot(date);
  if (!timeSlot) return false;

  const dateString = Utilities.formatDate(date, 'Asia/Tokyo', 'yyyyMMdd');
  const flagKey = `${FLAG_PREFIX}${dateString}_${timeSlot}`;

  return Boolean(PROPS.getProperty(flagKey));
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

  const messages = fetchChannelHistory(oldest, 50);
  if (!messages) return false;

  return messages
    .flatMap((message) => message.reactions ?? [])
    .some((reaction) => reaction.name === STOP_EMOJI);
}

/**
 * 当該時間帯のスキャン開始時刻以降のチャンネル履歴を取得し、ユーザー（bot以外）の
 * 投稿本文に `✅` 文字が含まれていないかを判定する。
 * ACTIVE_HOURS開始前にユーザーが先回りで打刻完了を申告した場合の抑止用。
 * MORNINGは当日0時以降、EVENINGは朝枠終了時刻(MORNING.endHour)以降をスキャン対象とし、
 * 朝の打刻申告が夜の枠まで抑止しないようにする。
 * API失敗時はfalseを返し投稿継続させる。
 *
 * @param {Date} date - 判定基準日
 * @param {'morning'|'evening'} timeSlot - 検査対象の時間帯
 * @returns {boolean} ✅含むユーザー投稿が範囲内に存在する場合、trueを返却
 */
function hasUserCompletionPost(date, timeSlot) {
  const start = new Date(date);

  if (timeSlot === TIME_SLOT.EVENING) {
    start.setHours(ACTIVE_HOURS[TIME_SLOT.MORNING].endHour, 0, 0, 0);
  } else {
    start.setHours(0, 0, 0, 0);
  }

  const oldest = Math.floor(start.getTime() / 1000);

  const messages = fetchChannelHistory(oldest, 200);
  if (!messages) return false;

  return messages
    .filter((message) => !message.bot_id && message.subtype !== 'bot_message')
    .some((message) => (message.text ?? '').includes(STOP_EMOJI));
}

/**
 * 当該時間帯開始以降の履歴から、ユーザー（bot以外）の数字のみ投稿を探し、
 * スヌーズ期限内のものが存在するかを判定する。
 * 「投稿時刻 + N分」が現在時刻を超える間はスヌーズ中とみなす。
 * 「まだ打刻していないが N分待ってほしい」用途。完了申告（✅）と異なりフラグは立てず、
 * 期限が過ぎれば次のtickでリマインドが自動再開する。
 * API失敗時はfalseを返し投稿継続させる。
 *
 * @param {'morning'|'evening'} timeSlot - 検査対象の時間帯
 * @returns {boolean} スヌーズ期限内の数字投稿が存在する場合、trueを返却
 */
function isSnoozed(timeSlot) {
  const now = new Date();
  const start = new Date(now);
  start.setHours(ACTIVE_HOURS[timeSlot].startHour, 0, 0, 0);
  const oldest = Math.floor(start.getTime() / 1000);

  const messages = fetchChannelHistory(oldest, 50);
  if (!messages) return false;

  const nowSec = now.getTime() / 1000;

  return messages
    .filter((message) => !message.bot_id && message.subtype !== 'bot_message')
    .some((message) => {
      const text = (message.text ?? '').trim();
      if (!NUMBER_ONLY_PATTERN.test(text)) return false;

      const minutes = Number(text);
      const snoozeExpiresAtSec = Number(message.ts) + minutes * 60;
      return snoozeExpiresAtSec > nowSec;
    });
}

/**
 * 時間帯に応じたリマインド文を生成。
 *
 * @param {'morning'|'evening'} timeSlot - 対象の時間帯
 * @returns {string} 投稿本文
 */
function buildMessage(timeSlot) {
  if (Math.random() < 0.001) return 'ワン！';

  return timeSlot === TIME_SLOT.MORNING
    ? '【始業】打刻したことを確認したら、✅を押してね！'
    : '【終業】打刻したことを確認したら、✅を押してね！';
}

/**
 * Slackチャンネルへテキスト投稿。
 * 失敗時は例外を投げずconsole.errorに記録のみ。
 *
 * @param {string} text - 投稿本文
 * @returns {void}
 */
function postMessage(text) {
  const res = UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    headers: { Authorization: `Bearer ${TOKEN}` },
    contentType: 'application/json; charset=utf-8',
    payload: JSON.stringify({ channel: CHANNEL, text }),
    muteHttpExceptions: true,
  });

  const body = JSON.parse(res.getContentText());

  if (!body.ok) console.error('post failed', body);
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

## 5. 挙動仕様

| 時刻 | 動作 |
|------|------|
| 平日 10:00-10:55（5分刻み） | `morning`投稿、スタンプ検知で以降停止 |
| 平日 20:00-20:55（5分刻み） | `evening`投稿、`morning`停止と独立 |
| 土日 | 全スキップ |
| 祝日 | 全スキップ |
| 日付変わる | フラグキー変わる → 翌日自動再開 |
| 当日の投稿にハート系リアクション（`DAY_OFF_EMOJI` 部分一致） | 朝・夜 両フラグを立て当日終日リマインド停止 |
| 当日0時以降のユーザー投稿に `✅` 文字 | 当該時間帯のリマインド抑止 → ACTIVE_HOURS開始前の先回り打刻に対応 |
| ユーザーが数字のみ投稿（例 `10`） | 投稿時刻からN分当該時間帯のリマインドを一時停止（スヌーズ）。フラグ立てず期限切れで自動再開 |

**時間帯のカスタマイズ**

朝枠・夜枠の稼働時間は、コード冒頭の `ACTIVE_HOURS` を書き換えて任意に設定可。`startHour`（開始時、含む）と `endHour`（終了時、含まず）を変更し、`tick` トリガーの稼働時間と整合させればよい。

```javascript
const ACTIVE_HOURS = {
  [TIME_SLOT.MORNING]: { startHour: 9, endHour: 10 },   // 朝の枠を9-10時に
  [TIME_SLOT.EVENING]: { startHour: 18, endHour: 19 },  // 夜の枠を18-19時に
};
```

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
