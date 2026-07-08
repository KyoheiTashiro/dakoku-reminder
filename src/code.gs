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
