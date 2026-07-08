const PROPS = PropertiesService.getScriptProperties();
const TOKEN = PROPS.getProperty('SLACK_TOKEN');
const CHANNEL = PROPS.getProperty('CHANNEL_ID');
const STOP_EMOJI = PROPS.getProperty('STOP_EMOJI');
const DAY_OFF_EMOJI = PROPS.getProperty('DAY_OFF_EMOJI');

const TIME_SLOT = {
  MORNING: 'morning',
  EVENING: 'evening',
};

const NUMBER_ONLY_PATTERN = /^\d+$/;

const HOLIDAY_CALENDAR_ID = 'ja.japanese.official#holiday@group.v.calendar.google.com';

/**
 * 時間帯ごとの稼働時間設定を Script Properties から構築して返す。
 *
 * @returns {{morning: {startHour: number, endHour: number}, evening: {startHour: number, endHour: number}}} 時間帯ごとの稼働時間設定
 */
function getActiveHours() {
  return {
    [TIME_SLOT.MORNING]: buildActiveHours('MORNING_START_HOUR', 'MORNING_END_HOUR'),
    [TIME_SLOT.EVENING]: buildActiveHours('EVENING_START_HOUR', 'EVENING_END_HOUR'),
  };
}

/**
 * Script Properties の開始時・終了時キーから時間帯設定を組み立てる。
 * 開始 >= 終了となる組み合わせの場合は例外を投げる。
 *
 * @param {string} startKey - 開始時の Script Properties キー名
 * @param {string} endKey - 終了時の Script Properties キー名
 * @returns {{startHour: number, endHour: number}} 時間帯設定
 */
function buildActiveHours(startKey, endKey) {
  const startHour = parseHourProperty(startKey);
  const endHour = parseHourProperty(endKey);

  if (startHour >= endHour) {
    throw new Error(`invalid hours: ${startKey}=${startHour}, ${endKey}=${endHour}`);
  }

  return { startHour, endHour };
}

/**
 * Script Properties から時（0-24）を読み取る。
 * 未設定・不正な値（数字以外、24超え）の場合は例外を投げる。
 *
 * @param {string} key - Script Properties のキー名
 * @returns {number} 時
 */
function parseHourProperty(key) {
  const raw = PROPS.getProperty(key);

  if (!raw) {
    throw new Error(`missing script property: ${key}`);
  }

  const text = raw.trim();

  if (!NUMBER_ONLY_PATTERN.test(text) || Number(text) > 24) {
    throw new Error(`invalid ${key}: ${raw}`);
  }

  return Number(text);
}

const FLAG_PREFIX = 'stopped_';

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

  const response = requestSlackApi('chat.postMessage', { channel: CHANNEL, text: buildMessage(timeSlot) });

  if (!response.ok) console.error('post failed', response);
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
 * 当日0時以降の履歴に終日停止シグナル（ハート系絵文字）が存在するかを判定する。
 * リアクション名に DAY_OFF_EMOJI を含むもの、またはユーザー（Bot以外）の投稿本文に
 * DAY_OFF_EMOJI を含むもの（例 `:heart:`）があれば true。
 * 検知時は朝・夜 両時間帯のフラグを立て、当日終日リマインドを停止させる用途。
 * API失敗時は false を返し投稿継続させる。
 *
 * @param {Date} date - 判定基準日
 * @returns {boolean} ハート系絵文字の存在時、trueを返却
 */
function hasAllDayStopSignal(date) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const oldest = Math.floor(start.getTime() / 1000);

  const messages = fetchChannelHistory(oldest, 200);
  if (!messages) return false;

  return messages.some((message) =>
    (message.reactions ?? []).some((reaction) => reaction.name.includes(DAY_OFF_EMOJI)) ||
    (!message.bot_id && message.subtype !== 'bot_message' &&
      (message.text ?? '').includes(DAY_OFF_EMOJI))
  );
}

/**
 * Slack Web API を呼び出し、レスポンスの JSON を返す。
 * HTTPエラー時も例外を投げず、Slack のエラーレスポンス（ok: false）をそのまま返す。
 * ok 判定・エラー処理は呼出側の責務（verifySetup が失敗レスポンス本体を必要とするため）。
 *
 * @param {string} endpoint - APIメソッド名（例 'chat.postMessage'）
 * @param {Object} [params] - パラメータ。値は文字列化して form-encoded で送信
 * @returns {Object} Slack APIレスポンス
 */
function requestSlackApi(endpoint, params = {}) {
  const payload = Object.fromEntries(
    Object.entries(params).map(([key, value]) => [key, String(value)])
  );

  return JSON.parse(UrlFetchApp.fetch(`https://slack.com/api/${endpoint}`, {
    method: 'post',
    headers: { Authorization: `Bearer ${TOKEN}` },
    payload,
    muteHttpExceptions: true,
  }).getContentText());
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
  const response = requestSlackApi('conversations.history', { channel: CHANNEL, oldest, limit });

  if (!response.ok) {
    console.error('failed to fetch history: ', response);
    return null;
  }

  return response.messages;
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
    const calendar = CalendarApp.getCalendarById(HOLIDAY_CALENDAR_ID);
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
  const activeHours = getActiveHours();
  const morning = activeHours[TIME_SLOT.MORNING];
  const evening = activeHours[TIME_SLOT.EVENING];

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
  start.setHours(getActiveHours()[timeSlot].startHour, 0, 0, 0);
  const oldest = Math.floor(start.getTime() / 1000);

  const messages = fetchChannelHistory(oldest, 50);
  if (!messages) return false;

  return messages
    .flatMap((message) => message.reactions ?? [])
    .some((reaction) => reaction.name === STOP_EMOJI);
}

/**
 * 当該時間帯のスキャン開始時刻以降のチャンネル履歴を取得し、ユーザー（Bot以外）の
 * 投稿本文に `✅` 文字が含まれていないかを判定する。
 * ACTIVE_HOURS開始前にユーザーが先回りで打刻完了を申告した場合の停止用。
 * MORNINGは当日0時以降、EVENINGは朝の時間帯の終了時刻(MORNING.endHour)以降をスキャン対象とし、
 * 朝の打刻申告が夜の時間帯まで停止しないようにする。
 * API失敗時はfalseを返し投稿継続させる。
 *
 * @param {Date} date - 判定基準日
 * @param {'morning'|'evening'} timeSlot - 検査対象の時間帯
 * @returns {boolean} ✅含むユーザー投稿が範囲内に存在する場合、trueを返却
 */
function hasUserCompletionPost(date, timeSlot) {
  const start = new Date(date);

  if (timeSlot === TIME_SLOT.EVENING) {
    start.setHours(getActiveHours()[TIME_SLOT.MORNING].endHour, 0, 0, 0);
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
 * 当該時間帯開始以降の履歴から、ユーザー（Bot以外）の数字のみ投稿を探し、
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
  start.setHours(getActiveHours()[timeSlot].startHour, 0, 0, 0);
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
 * 文言は Script Properties の MORNING_MESSAGE / EVENING_MESSAGE で設定（必須）。
 * 未設定の場合は例外を投げる。
 *
 * @param {'morning'|'evening'} timeSlot - 対象の時間帯
 * @returns {string} 投稿本文
 */
function buildMessage(timeSlot) {
  if (Math.random() < 0.001) return 'ワン！';

  const key = timeSlot === TIME_SLOT.MORNING ? 'MORNING_MESSAGE' : 'EVENING_MESSAGE';
  const message = PROPS.getProperty(key);

  if (!message) {
    throw new Error(`missing script property: ${key}`);
  }

  return message;
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

/**
 * トリガーの初期設定を行う。
 * 既存の `tick` / `cleanupFlags` 向けトリガーを削除してから作成し直すため、
 * 再実行しても重複登録されない（冪等）。
 *
 * @returns {void}
 */
function setup() {
  const handlersToReset = [tick, cleanupFlags].map((handler) => handler.name);
  const triggersToDelete = ScriptApp.getProjectTriggers().filter((trigger) =>
    handlersToReset.includes(trigger.getHandlerFunction())
  );
  triggersToDelete.forEach((trigger) => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger(tick.name).timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger(cleanupFlags.name).timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(3).create();

  console.log(`既存トリガーを${triggersToDelete.length}件削除しました`);
  console.log(`${tick.name}（5分おき）トリガーを作成しました`);
  console.log(`${cleanupFlags.name}（毎週日曜日AM3時）トリガーを作成しました`);
}

/**
 * 導入時の設定ミスを一括検出する。
 * 最初の失敗で止めず全項目を検査し、項目ごとに ✅ / ❌ 付きで console.log に列挙、
 * 最後に総括行を出力する。
 *
 * @returns {void}
 */
function verifySetup() {
  let failureCount = 0;

  const report = (passed, message) => {
    console.log(`${passed ? '✅' : '❌'} ${message}`);
    if (!passed) failureCount++;
  };

  // 必須 Script Properties がすべて設定されていること
  const requiredKeys = ['SLACK_TOKEN', 'CHANNEL_ID', 'STOP_EMOJI', 'DAY_OFF_EMOJI', 'MORNING_START_HOUR', 'MORNING_END_HOUR', 'EVENING_START_HOUR', 'EVENING_END_HOUR', 'MORNING_MESSAGE', 'EVENING_MESSAGE'];
  requiredKeys.forEach((key) => {
    if (PROPS.getProperty(key)) {
      report(true, `${key}: 設定済み`);
    } else {
      report(false, `${key}: 未設定です。スクリプトプロパティに設定してください`);
    }
  });

  // 稼働時間が有効であること（0-24 の数字、開始 < 終了）
  ['MORNING', 'EVENING'].forEach((slot) => {
    const label = `${slot}_START_HOUR/${slot}_END_HOUR`;
    try {
      buildActiveHours(`${slot}_START_HOUR`, `${slot}_END_HOUR`);
      report(true, `${label}: 有効`);
    } catch (e) {
      report(false, `${label}: ${e.message}`);
    }
  });

  // 絵文字名にコロン(:)が含まれていないこと
  ['STOP_EMOJI', 'DAY_OFF_EMOJI'].forEach((key) => {
    const value = PROPS.getProperty(key);
    if (value && value.includes(':')) {
      report(false, `${key}: コロン(:)が含まれています。絵文字名のみ指定してください。`);
    } else {
      report(true, `${key}: コロン混入なし`);
    }
  });

  // タイムゾーンが Asia/Tokyo であること
  const timeZone = Session.getScriptTimeZone();
  if (timeZone === 'Asia/Tokyo') {
    report(true, `タイムゾーン: ${timeZone}`);
  } else {
    report(false, `タイムゾーン: ${timeZone}（プロジェクトの設定で Asia/Tokyo に変更してください。）`);
  }

  // SLACK_TOKEN が有効であること（auth.test）
  if (!TOKEN) {
    report(false, 'トークン有効性: SLACK_TOKEN未設定のためスキップ');
  } else {
    try {
      const response = requestSlackApi('auth.test');
      if (!response.ok) {
        report(false, `トークン有効性: 無効です（${response.error}）。SLACK_TOKENを確認してください`);
      } else {
        report(true, 'トークン有効性: 有効');
      }
    } catch (e) {
      report(false, `トークン有効性: 確認に失敗しました（${e.message}）`);
    }
  }

  // チャンネルが存在し Bot が招待済みであること（conversations.info）
  if (!TOKEN || !CHANNEL) {
    report(false, 'CHANNEL_ID: SLACK_TOKENまたはCHANNEL_ID未設定のためスキップ');
  } else {
    try {
      const response = requestSlackApi('conversations.info', { channel: CHANNEL });
      if (response.error === 'missing_scope') {
        report(false, `CHANNEL_ID: Botのスコープ不足です（不足: ${response.needed}）。OAuth & Permissions で追加して再インストールしてください`);
      } else if (!response.ok) {
        report(false, `CHANNEL_ID: チャンネルを確認できません（${response.error}）CHANNEL_IDを確認してください`);
      } else if (!response.channel.is_member) {
        report(false, 'CHANNEL_ID: Botがチャンネルに未招待です。/invite で招待してください');
      } else {
        report(true, 'CHANNEL_ID: チャンネル確認OK（Bot招待済み）');
      }
    } catch (e) {
      report(false, `CHANNEL_ID: 確認に失敗しました（${e.message}）`);
    }
  }

  // 祝日カレンダーが参照可能であること（Calendar スコープ承認済み）
  try {
    if (CalendarApp.getCalendarById(HOLIDAY_CALENDAR_ID)) {
      report(true, '祝日カレンダー: 参照可能');
    } else {
      report(false, '祝日カレンダー: 参照できません。Calendarスコープの承認状況を確認してください');
    }
  } catch (e) {
    report(false, `祝日カレンダー: 参照に失敗しました（${e.message}）。Calendarスコープが未承認の可能性があります`);
  }

  console.log(failureCount === 0 ? '✅ すべてOK' : `❌ ${failureCount}件の問題あり`);
}

/**
 * 動作テスト用にSlackチャンネルへ固定文言を投稿する。
 *
 * @returns {void}
 */
function testPost() {
  const response = requestSlackApi('chat.postMessage', { channel: CHANNEL, text: 'テスト投稿' });

  if (!response.ok) console.error('post failed', response);
}
