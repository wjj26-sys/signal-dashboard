import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();

app.use(
  cors({
    origin: "*",
  })
);

app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const SOURCE_CHAT_ID = process.env.SOURCE_CHAT_ID;
const SOURCE_CHAT_ID_2 = process.env.SOURCE_CHAT_ID_2;
const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;
const VANTAGE_TICK_TOKEN = process.env.VANTAGE_TICK_TOKEN || "";
const PORT = process.env.PORT || 4000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null;

const orderNames = [
  "첫번째",
  "두번째",
  "세번째",
  "네번째",
  "다섯번째",
  "여섯번째",
  "일곱번째",
  "여덟번째",
  "아홉번째",
  "열번째",
];

let botEnabled = true;
let signalRunning = false;
let testMode = false;
let activeSignal = null;
let tradeWatchCheckInProgress = false;

let sentSignals = [];
let blockedSignals = [];

function getKstNow() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Seoul" })
  );
}

function getTimeText() {
  const now = getKstNow();

  return `${String(now.getHours()).padStart(2, "0")}:${String(
    now.getMinutes()
  ).padStart(2, "0")}`;
}

function toDateText(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getTodayLogDate() {
  return toDateText(getKstNow());
}

function getWeekKey(dateText) {
  const date = new Date(`${dateText}T00:00:00`);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;

  date.setDate(date.getDate() + diff);

  return toDateText(date);
}

function getAutoScheduleState() {
  const now = getKstNow();
  const hour = now.getHours();
  const minute = now.getMinutes();

  const minutes = hour * 60 + minute;

  const openStart1 = 8 * 60;
  const openEnd1 = 10 * 60;

  const lockStart = 10 * 60;
  const lockEnd = 11 * 60;

  const openStart2 = 11 * 60;
  const lockStart2 = 1 * 60;

  const isFirstOpen = minutes >= openStart1 && minutes < openEnd1;
  const isSecondOpen = minutes >= openStart2 || minutes < lockStart2;
  const isLockTime = minutes >= lockStart && minutes < lockEnd;

  const isOpen = (isFirstOpen || isSecondOpen) && !isLockTime;

  if (isOpen) {
    return {
      isOpen: true,
      statusText: "자동 운영 시간",
      reason: "",
    };
  }

  return {
    isOpen: false,
    statusText: "자동 잠금 시간",
    reason: "자동 잠금 시간으로 미전송",
  };
}

function isOperatingTime() {
  return getAutoScheduleState().isOpen;
}

function getMessageText(message) {
  return message.text || message.caption || "";
}

function getSignalDirection(message) {
  const text = getMessageText(message).toUpperCase();

  if (text.includes("BUY") || text.includes("LONG") || text.includes("롱")) {
    return "BUY";
  }

  if (text.includes("SELL") || text.includes("SHORT") || text.includes("숏")) {
    return "SELL";
  }

  return "";
}

function hasSignalImage(message) {
  const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;

  const hasImageDocument =
    message.document?.mime_type &&
    String(message.document.mime_type).startsWith("image/");

  return Boolean(hasPhoto || hasImageDocument);
}

function isSignalMessage(message) {
  return hasSignalImage(message);
}

function getSourceRoom(sourceChatId) {
  const chatId = String(sourceChatId);

  if (SOURCE_CHAT_ID && chatId === String(SOURCE_CHAT_ID)) {
    return "1번방";
  }

  if (SOURCE_CHAT_ID_2 && chatId === String(SOURCE_CHAT_ID_2)) {
    return "2번방";
  }

  return null;
}

function requireSupabase() {
  if (!supabase) {
    throw new Error(
      "Supabase 연결값이 없습니다. Render 환경변수 SUPABASE_URL, SUPABASE_SERVICE_KEY를 확인해주세요."
    );
  }

  return supabase;
}

function mapSentLog(row) {
  return {
    id: row.id,
    sourceRoom: row.source_room || "",
    order: row.signal_order,
    orderText:
      row.order_text ||
      `${orderNames[(row.signal_order || 1) - 1] || `${row.signal_order}번째`} 시그널`,
    signal: row.signal || "",
    sourceMessageId: row.source_message_id,
    forwardedMessageId: row.forwarded_message_id,
    sourceChatId: row.source_chat_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    status: row.status || "진행중",
    text: row.message_text || "",
    positions: row.positions_json || null,
    resultSummary: row.result_summary || "",
    logDate: row.log_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBlockedLog(row) {
  return {
    id: row.id,
    sourceRoom: row.source_room || "",
    signal: row.signal || "",
    messageId: row.source_message_id,
    sourceChatId: row.source_chat_id,
    time: row.started_at,
    reason: row.reason || "미전송",
    text: row.message_text || "",
    logDate: row.log_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function syncSignalLogsFromDb() {
  if (!supabase) return;

  const today = getTodayLogDate();

  const { data, error } = await supabase
    .from("signal_logs")
    .select("*")
    .eq("log_date", today)
    .order("created_at", { ascending: true });

  if (error) throw error;

  const rows = data || [];

  sentSignals = rows
    .filter((row) => row.log_type === "sent")
    .map(mapSentLog);

  blockedSignals = rows
    .filter((row) => row.log_type === "blocked")
    .map(mapBlockedLog);

  activeSignal =
    [...sentSignals].reverse().find((item) => item.status === "진행중") ||
    null;

  signalRunning = Boolean(activeSignal);
}

async function releaseTodaySignalLock() {
  if (!supabase) return;

  const { error } = await supabase
    .from("signal_locks")
    .delete()
    .eq("lock_date", getTodayLogDate());

  if (error) throw error;
}

async function acquireTodaySignalLock(payload) {
  const today = getTodayLogDate();

  if (!supabase) {
    return {
      ok: !signalRunning,
      reason: signalRunning ? "진행중 유입으로 미전송" : "",
    };
  }

  const { data, error } = await supabase
    .from("signal_locks")
    .insert({
      lock_date: today,
      source_room: payload.sourceRoom || "",
      source_chat_id: payload.sourceChatId,
      source_message_id: payload.sourceMessageId,
    })
    .select()
    .single();

  if (error) {
    // 23505 = unique constraint violation
    // 오늘 날짜 lock_date가 이미 있으면 이미 다른 신호가 선점한 상태입니다.
    if (error.code === "23505") {
      return {
        ok: false,
        reason: "진행중 유입으로 미전송",
      };
    }

    throw error;
  }

  return {
    ok: true,
    lock: data,
  };
}

async function attachSignalLogToLock(signalLogId) {
  if (!supabase || !signalLogId) return;

  const { error } = await supabase
    .from("signal_locks")
    .update({
      signal_log_id: signalLogId,
    })
    .eq("lock_date", getTodayLogDate());

  if (error) throw error;
}

async function createSentSignalLog(payload) {
  const today = getTodayLogDate();

  if (!supabase) {
    sentSignals.push({ ...payload, logDate: today });
    activeSignal = payload;
    signalRunning = true;
    return payload;
  }

  const { data, error } = await supabase
    .from("signal_logs")
    .insert({
      log_date: today,
      log_type: "sent",
      source_room: payload.sourceRoom || "",
      signal_order: payload.order,
      order_text: payload.orderText,
      signal: payload.signal || "",
      source_message_id: payload.sourceMessageId,
      forwarded_message_id: payload.forwardedMessageId,
      source_chat_id: payload.sourceChatId,
      started_at: payload.startedAt,
      ended_at: payload.endedAt,
      status: payload.status,
      message_text: payload.text || "",
    })
    .select()
    .single();

  if (error) throw error;

  const mapped = mapSentLog(data);

  await syncSignalLogsFromDb();

  return mapped;
}

async function createBlockedSignalLog(payload) {
  const today = getTodayLogDate();

  if (!supabase) {
    blockedSignals.push({ ...payload, logDate: today });
    return payload;
  }

  const { data, error } = await supabase
    .from("signal_logs")
    .insert({
      log_date: today,
      log_type: "blocked",
      source_room: payload.sourceRoom || "",
      signal_order: null,
      order_text: null,
      signal: payload.signal || "",
      source_message_id: payload.messageId,
      forwarded_message_id: null,
      source_chat_id: payload.sourceChatId,
      started_at: payload.time,
      ended_at: null,
      status: "미전송",
      reason: payload.reason,
      message_text: payload.text || "",
    })
    .select()
    .single();

  if (error) throw error;

  const mapped = mapBlockedLog(data);

  await syncSignalLogsFromDb();

  return mapped;
}

async function finishActiveSignalLog() {
  const endedAt = getTimeText();

  await syncSignalLogsFromDb();

  if (!activeSignal) {
    signalRunning = false;
    await releaseTodaySignalLock();
    return null;
  }

  if (supabase) {
    const { error } = await supabase
      .from("signal_logs")
      .update({
        status: "종료",
        ended_at: endedAt,
      })
      .eq("id", activeSignal.id)
      .eq("log_date", getTodayLogDate());

    if (error) throw error;

    await releaseTodaySignalLock();

    await syncSignalLogsFromDb();
    return activeSignal;
  }

  activeSignal.status = "종료";
  activeSignal.endedAt = endedAt;

  sentSignals = sentSignals.map((item) =>
    String(item.id) === String(activeSignal.id)
      ? {
          ...item,
          status: "종료",
          endedAt,
        }
      : item
  );

  signalRunning = false;
  activeSignal = null;

  return null;
}

function enrichArchive(group) {
  const records = [...group.records].sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  const startDate = records[0]?.date || "";
  const endDate = records[records.length - 1]?.date || "";
  const updatedAt = records.reduce(
    (latest, record) => (record.updatedAt > latest ? record.updatedAt : latest),
    ""
  );

  return {
    ...group,
    records,
    startDate,
    endDate,
    updatedAt,
  };
}

function groupRecordsByWeek(records) {
  const archiveMap = new Map();

  records.forEach((record) => {
    const weekKey = record.week_key;

    if (!archiveMap.has(weekKey)) {
      archiveMap.set(weekKey, {
        weekKey,
        records: [],
      });
    }

    archiveMap.get(weekKey).records.push({
      id: record.id,
      date: record.record_date,
      symbol: record.symbol,
      text: record.content,
      updatedAt: record.updated_at,
      createdAt: record.created_at,
    });
  });

  return Array.from(archiveMap.values())
    .map(enrichArchive)
    .sort((a, b) => b.weekKey.localeCompare(a.weekKey))
    .slice(0, 2);
}

async function cleanupOldPositionWeeks() {
  const db = requireSupabase();

  const { data, error } = await db
    .from("position_records")
    .select("week_key")
    .order("week_key", { ascending: false });

  if (error) throw error;

  const weekKeys = [...new Set((data || []).map((item) => item.week_key))];
  const deleteWeeks = weekKeys.slice(2);

  if (deleteWeeks.length === 0) return;

  const { error: deleteError } = await db
    .from("position_records")
    .delete()
    .in("week_key", deleteWeeks);

  if (deleteError) throw deleteError;
}

async function telegramApi(method, body) {
  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN이 Render 환경변수 또는 .env에 없습니다.");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  const data = await response.json();

  if (!data.ok) {
    console.error("Telegram API Error:", data);
    throw new Error(data.description || "Telegram API Error");
  }

  return data.result;
}

async function sendCloseMarketMessage() {
  if (!TARGET_CHAT_ID) {
    throw new Error("TARGET_CHAT_ID가 없습니다.");
  }

  return telegramApi("sendMessage", {
    chat_id: TARGET_CHAT_ID,
    text: `✅✅ 시장가 매도 진행 ✅✅
✅✅ 시장가 매도 진행 ✅✅

모든 회차 정리 진행하겠습니다`,
  });
}

async function forwardMessageToTarget(message) {
  if (!TARGET_CHAT_ID) {
    throw new Error("TARGET_CHAT_ID가 Render 환경변수 또는 .env에 없습니다.");
  }

  return telegramApi("forwardMessage", {
    chat_id: TARGET_CHAT_ID,
    from_chat_id: message.chat.id,
    message_id: message.message_id,
  });
}

async function sendTextMessageToTarget(text) {
  if (!TARGET_CHAT_ID) {
    throw new Error("TARGET_CHAT_ID가 Render 환경변수 또는 .env에 없습니다.");
  }

  return telegramApi("sendMessage", {
    chat_id: TARGET_CHAT_ID,
    text,
  });
}

const PRICE_PROVIDER = process.env.PRICE_PROVIDER || "goldapi_net";
const GOLD_API_KEY = process.env.GOLD_API_KEY || "";
const PRICE_POLL_SECONDS = Math.max(
  1,
  Number(process.env.PRICE_POLL_SECONDS || 5)
);

const VANTAGE_MAX_STALE_SECONDS = Math.max(
  10,
  Number(process.env.VANTAGE_MAX_STALE_SECONDS || 60)
);

let isCheckingTradeWatch = false;

function formatTvValue(value) {
  if (value === undefined || value === null || value === "") return "-";
  return String(value).trim();
}

function makeTradingViewMessage(payload) {
  const event = String(payload.event || payload.type || "").toLowerCase();
  const direction = String(payload.direction || "").toUpperCase();

  const symbol = payload.symbolText || payload.symbol || "XAUUSD(금/GOLD)";
  const round = Number(payload.round || payload.step || payload.entryRound);
  const entry = formatTvValue(payload.entry);
  const tp = formatTvValue(payload.tp);
  const sl = formatTvValue(payload.sl);
  const lot = formatTvValue(payload.lot || "1랏");

  if (event === "tp") {
    return `✅✅TP(익절가) 도달 완료✅✅
✅✅TP(익절가) 도달 완료✅✅

모든 회차 정리 진행하겠습니다`;
  }

  if (event === "sl") {
    return `🟥🟥 SL(손절가) 도달 완료🟥🟥
🟥🟥 SL(손절가) 도달 완료🟥🟥

모든 회차 정리 진행하겠습니다`;
  }

  if (event !== "entry") {
    throw new Error("event 값은 entry, tp, sl 중 하나여야 합니다.");
  }

  if (![2, 3].includes(round)) {
    throw new Error("entry 알림은 round 값이 2 또는 3이어야 합니다.");
  }

  if (!["LONG", "SHORT"].includes(direction)) {
    throw new Error("direction 값은 LONG 또는 SHORT 이어야 합니다.");
  }

  const isLong = direction === "LONG";
  const header = isLong
    ? `🟢🟢🟢상승🟢🟢🟢
🟢🟢🟢상승🟢🟢🟢`
    : `🔴🔴🔴하락🔴🔴🔴
🔴🔴🔴하락🔴🔴🔴`;

  const roundLabel = `${round}회차`;
  const orderLabel =
    round === 2 ? "1회차 / 2회차" : "1회차 / 2회차 / 3회차";

  return `${header}
 
- ${roundLabel} 진입가 도달
- ${roundLabel} 예약매매 진행 안하신분들 매수 진행
- ${orderLabel} 주문 아래 TP로 수정 부탁드리겠습니다.

${symbol}

📍 ${roundLabel} 진입가 : ${entry}
📍 비중 : ${lot}

✅ TP(익절가) : ${tp} (수정값)
🛑 SL(손절가) : ${sl}

※본인 시드에 따라 다르게 적용
※투자 관련 책임 / 권리는 투자자 본인에게`;
}

async function addBlockedSignal(message, reason, sourceRoom) {
  const direction = getSignalDirection(message);

  const fallbackId = blockedSignals.length + 1;

  return createBlockedSignalLog({
    id: fallbackId,
    sourceRoom,
    signal: direction,
    messageId: message.message_id,
    sourceChatId: message.chat.id,
    time: getTimeText(),
    reason,
    text: getMessageText(message),
  });
}

async function handleSignalMessage(message) {
  const sourceChatId = String(message.chat.id);
  const sourceRoom = getSourceRoom(sourceChatId);

  if (!sourceRoom) {
    return;
  }

  if (!isSignalMessage(message)) {
    return;
  }

  await syncSignalLogsFromDb();

  if (!botEnabled) {
    await addBlockedSignal(message, "봇이 비활성 상태라 미전송", sourceRoom);
    return;
  }

  const scheduleState = getAutoScheduleState();

  if (!scheduleState.isOpen) {
    await addBlockedSignal(
      message,
      scheduleState.reason || "자동 잠금 시간으로 미전송",
      sourceRoom
    );
    return;
  }

  if (signalRunning) {
    await addBlockedSignal(message, "진행중 유입으로 미전송", sourceRoom);
    return;
  }

  const lockResult = await acquireTodaySignalLock({
    sourceRoom,
    sourceChatId: message.chat.id,
    sourceMessageId: message.message_id,
  });

  if (!lockResult.ok) {
    await addBlockedSignal(
      message,
      lockResult.reason || "진행중 유입으로 미전송",
      sourceRoom
    );
    return;
  }

  try {
    const maxOrder = sentSignals.reduce(
      (max, item) => Math.max(max, Number(item.order) || 0),
      0
    );

    const order = maxOrder + 1;
    const startedAt = getTimeText();
    const direction = getSignalDirection(message);

    const forwarded = await forwardMessageToTarget(message);

    const newSignal = {
      id: order,
      order,
      orderText: `${orderNames[order - 1] || `${order}번째`} 시그널`,
      sourceRoom,
      signal: direction,
      sourceMessageId: message.message_id,
      forwardedMessageId: forwarded.message_id,
      sourceChatId: message.chat.id,
      startedAt,
      endedAt: null,
      status: "진행중",
      text: getMessageText(message),
    };

    const savedSignal = await createSentSignalLog(newSignal);

    await attachSignalLogToLock(savedSignal.id);

    signalRunning = true;
    activeSignal = savedSignal;

    console.log("신호 전달 완료:", savedSignal);
  } catch (error) {
    await releaseTodaySignalLock();
    throw error;
  }
}

app.get("/", (req, res) => {
  res.send("Signal server is running.");
});

function mapTradeSetup(row) {
  return {
    id: row.id,
    tradeDate: row.trade_date || "",
    symbol: row.symbol || "XAUUSD",
    direction: row.direction || "LONG",
    baseEntry: row.base_entry ?? "",
    entry2: row.entry2 ?? "",
    entry3: row.entry3 ?? "",
    tpGap: row.tp_gap ?? "",
    firstTp: row.first_tp ?? null,
    secondAverage: row.second_average ?? null,
    secondTp: row.second_tp ?? null,
    thirdAverage: row.third_average ?? null,
    thirdTp: row.third_tp ?? null,
    slPrice: row.sl_price ?? "",
    updatedAt: row.updated_at,
  };
}

function toNullableNumber(value) {
  if (value === "" || value === undefined || value === null) return null;

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

app.get("/api/trade-setup", async (req, res) => {
  try {
    const db = requireSupabase();

    const { data, error } = await db
      .from("trade_setups")
      .select("*")
      .eq("setup_key", "current")
      .maybeSingle();

    if (error) throw error;

    res.json({
      ok: true,
      setup: data ? mapTradeSetup(data) : null,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/trade-setup", async (req, res) => {
  try {
    const db = requireSupabase();

    const payload = req.body || {};

    const { data, error } = await db
      .from("trade_setups")
      .upsert(
        {
          setup_key: "current",
          trade_date: payload.tradeDate || getTodayLogDate(),
          symbol: payload.symbol || "XAUUSD",
          direction: payload.direction || "LONG",
          base_entry: toNullableNumber(payload.baseEntry),
          entry2: toNullableNumber(payload.entry2),
          entry3: toNullableNumber(payload.entry3),
          tp_gap: toNullableNumber(payload.tpGap),
          first_tp: toNullableNumber(payload.firstTp),
          second_average: toNullableNumber(payload.secondAverage),
          second_tp: toNullableNumber(payload.secondTp),
          third_average: toNullableNumber(payload.thirdAverage),
          third_tp: toNullableNumber(payload.thirdTp),
          sl_price: toNullableNumber(payload.slPrice),
        },
        {
          onConflict: "setup_key",
        }
      )
      .select()
      .single();

    if (error) throw error;

    res.json({
      ok: true,
      message: "계산값을 저장했습니다.",
      setup: mapTradeSetup(data),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

function toWatchNumber(value) {
  if (value === "" || value === undefined || value === null) return null;

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function formatWatchPrice(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) return "-";

  return Math.round(number).toFixed(2);
}

function mapTradeWatch(row) {
  if (!row) return null;

  return {
    id: row.id,
    isActive: row.is_active,
    symbol: row.symbol || "XAUUSD",
    direction: row.direction || "LONG",
    entry2: row.entry2,
    entry3: row.entry3,
    firstTp: row.first_tp,
    secondTp: row.second_tp,
    thirdTp: row.third_tp,
    slPrice: row.sl_price,
    activeTp: row.active_tp,
    sentEntry2: row.sent_entry2,
    sentEntry3: row.sent_entry3,
    sentTp: row.sent_tp,
    sentSl: row.sent_sl,
    lastPrice: row.last_price,
    lastCheckedAt: row.last_checked_at,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
    updatedAt: row.updated_at,
  };
}

async function sendWatchTelegramMessage(text) {
  if (!TARGET_CHAT_ID) {
    throw new Error("TARGET_CHAT_ID가 없습니다.");
  }

  return telegramApi("sendMessage", {
    chat_id: TARGET_CHAT_ID,
    text,
  });
}

async function fetchXauUsdPrice() {
  if (PRICE_PROVIDER === "vantage_mt5") {
    const db = requireSupabase();

    const { data, error } = await db
      .from("xauusd_price_ticks")
      .select("*")
      .eq("symbol", "XAUUSD")
      .eq("provider", "vantage_mt5")
      .order("checked_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      throw new Error("Vantage MT5 가격 기록이 아직 없습니다.");
    }

    const checkedAtTime = new Date(data.checked_at).getTime();
    const ageSeconds = Math.floor((Date.now() - checkedAtTime) / 1000);

    if (!Number.isFinite(checkedAtTime) || ageSeconds > VANTAGE_MAX_STALE_SECONDS) {
      throw new Error(
        `Vantage MT5 가격 수신이 끊겼습니다. 마지막 수신: ${ageSeconds}초 전`
      );
    }

    return {
      price: Number(data.price),
      bid: data.bid,
      ask: data.ask,
      timestamp: data.checked_at,
      ageSeconds,
      raw: data,
      latestTick: mapPriceTick(data),
    };
  }

  if (PRICE_PROVIDER === "gold_api_free") {
    const url = "https://api.gold-api.com/price/XAU";

    const response = await fetch(url);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`가격 API 오류: ${response.status} ${body}`);
    }

    const data = await response.json();

    const price = Number(
      data.price ??
        data.rate ??
        data.value ??
        data.usd ??
        data?.data?.price
    );

    if (!Number.isFinite(price)) {
      throw new Error(
        `가격 API 응답에서 price 값을 찾지 못했습니다: ${JSON.stringify(data)}`
      );
    }

    return {
      price,
      bid: data.bid ?? null,
      ask: data.ask ?? null,
      timestamp: data.timestamp ?? data.updated_at ?? null,
      raw: data,
    };
  }

  if (PRICE_PROVIDER === "goldapi_net") {
    if (!GOLD_API_KEY || GOLD_API_KEY === "발급받은_API_KEY") {
      throw new Error("GOLD_API_KEY가 Render 환경변수에 없습니다.");
    }

    const url = `https://app.goldapi.net/price/XAU/USD?x-api-key=${encodeURIComponent(
      GOLD_API_KEY
    )}`;

    const response = await fetch(url);

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`가격 API 오류: ${response.status} ${body}`);
    }

    const data = await response.json();

    const price = Number(data.price ?? data.ask ?? data.bid);

    if (!Number.isFinite(price)) {
      throw new Error("가격 API 응답에서 price 값을 찾지 못했습니다.");
    }

    return {
      price,
      bid: data.bid ?? null,
      ask: data.ask ?? null,
      timestamp: data.timestamp ?? null,
      raw: data,
    };
  }

  throw new Error(`지원하지 않는 PRICE_PROVIDER입니다: ${PRICE_PROVIDER}`);
}

function mapPriceTick(row) {
  return {
    id: row.id,
    symbol: row.symbol || "XAUUSD",
    price: row.price,
    bid: row.bid,
    ask: row.ask,
    provider: row.provider,
    source: row.source,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
  };
}

async function saveXauUsdPriceTick(priceData, source = "manual") {
  try {
    const db = requireSupabase();

    const { data, error } = await db
      .from("xauusd_price_ticks")
      .insert({
        symbol: "XAUUSD",
        price: toNullableNumber(priceData.price),
        bid: toNullableNumber(priceData.bid),
        ask: toNullableNumber(priceData.ask),
        provider: PRICE_PROVIDER,
        source,
        checked_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;

    const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    await db
      .from("xauusd_price_ticks")
      .delete()
      .lt("created_at", cutoff);

    return data;
  } catch (error) {
    console.error("가격 기록 저장 실패:", error.message);
    return null;
  }
}

function makeEntryReachMessage({ direction, round, entry, tp, sl }) {
  const isLong = direction === "LONG";

  const header = isLong
    ? `🟢🟢🟢상승🟢🟢🟢
🟢🟢🟢상승🟢🟢🟢`
    : `🔴🔴🔴하락🔴🔴🔴
🔴🔴🔴하락🔴🔴🔴`;

  const roundLabel = `${round}회차`;
  const orderLabel =
    round === 2 ? "1회차 / 2회차" : "1회차 / 2회차 / 3회차";
  const lot = round === 3 ? "2랏" : "1랏";

  return `${header}
 
- ${roundLabel} 진입가 도달
- ${roundLabel} 예약매매 진행 안하신분들 매수 진행
- ${orderLabel} 주문 아래 TP로 수정 부탁드리겠습니다.

XAUUSD(금/GOLD)

📍 ${roundLabel} 진입가 : ${formatWatchPrice(entry)}
📍 비중 : ${lot}

✅ TP(익절가) : ${formatWatchPrice(tp)} (수정값)
🛑 SL(손절가) : ${formatWatchPrice(sl)}

※본인 시드에 따라 다르게 적용
※투자 관련 책임 / 권리는 투자자 본인에게`;
}

function makeTpReachMessage() {
  return `✅✅TP(익절가) 도달 완료✅✅
✅✅TP(익절가) 도달 완료✅✅

모든 회차 정리 진행하겠습니다`;
}

function makeSlReachMessage() {
  return `🟥🟥 SL(손절가) 도달 완료🟥🟥
🟥🟥 SL(손절가) 도달 완료🟥🟥

모든 회차 정리 진행하겠습니다`;
}

function hasTouchedEntry(direction, price, entry) {
  if (entry === null) return false;

  if (direction === "LONG") {
    return price <= entry;
  }

  return price >= entry;
}

function hasTouchedTp(direction, price, tp) {
  if (tp === null) return false;

  if (direction === "LONG") {
    return price >= tp;
  }

  return price <= tp;
}

function hasTouchedSl(direction, price, sl) {
  if (sl === null) return false;

  if (direction === "LONG") {
    return price <= sl;
  }

  return price >= sl;
}

async function getCurrentTradeSetup() {
  const db = requireSupabase();

  const { data, error } = await db
    .from("trade_setups")
    .select("*")
    .eq("setup_key", "current")
    .maybeSingle();

  if (error) throw error;

  return data;
}

async function stopTradeWatchState(reason = "stopped") {
  const db = requireSupabase();

  const { data, error } = await db
    .from("trade_watch_state")
    .update({
      is_active: false,
      stopped_at: new Date().toISOString(),
    })
    .eq("watch_key", "current")
    .select()
    .maybeSingle();

  if (error) throw error;

  return data;
}

async function getManualMarketExitPrice() {
  try {
    const priceData = await fetchXauUsdPrice();
    const price = toNullableNumber(priceData?.price);

    if (price !== null) return price;
  } catch (error) {
    console.error("시장가 종료 현재가 조회 실패:", error.message);
  }

  // 실시간 조회가 실패하면 자동 감시가 마지막으로 저장한 가격을 사용합니다.
  try {
    const db = requireSupabase();

    const { data, error } = await db
      .from("trade_watch_state")
      .select("last_price")
      .eq("watch_key", "current")
      .maybeSingle();

    if (error) throw error;

    return toNullableNumber(data?.last_price);
  } catch (error) {
    console.error("시장가 종료 마지막 가격 조회 실패:", error.message);
    return null;
  }
}

app.get("/api/xauusd-price", async (req, res) => {
  try {
    const priceData = await fetchXauUsdPrice();

    const savedTick =
      PRICE_PROVIDER === "vantage_mt5"
       ? priceData.latestTick || null
       : await saveXauUsdPriceTick(priceData, "manual");

    res.json({
      ok: true,
      provider: PRICE_PROVIDER,
      ...priceData,
      savedTick: savedTick ? mapPriceTick(savedTick) : null,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/vantage-tick", async (req, res) => {
  try {
    if (!VANTAGE_TICK_TOKEN) {
      return res.status(500).json({
        ok: false,
        error: "VANTAGE_TICK_TOKEN이 Render 환경변수에 없습니다.",
      });
    }

    const token = req.headers["x-vantage-token"] || req.body?.token || "";

    if (token !== VANTAGE_TICK_TOKEN) {
      return res.status(401).json({
        ok: false,
        error: "인증 토큰이 올바르지 않습니다.",
      });
    }

    const bid = toNullableNumber(req.body?.bid);
    const ask = toNullableNumber(req.body?.ask);
    const last = toNullableNumber(req.body?.last);
    const receivedPrice = toNullableNumber(req.body?.price);

    const price =
      receivedPrice ??
      last ??
      (bid !== null && ask !== null ? (bid + ask) / 2 : null) ??
      bid ??
      ask;

    if (price === null) {
      return res.status(400).json({
        ok: false,
        error: "price, bid, ask 중 최소 1개는 필요합니다.",
      });
    }

    const checkedAt = req.body?.time
      ? new Date(req.body.time).toISOString()
      : new Date().toISOString();

    const db = requireSupabase();

    const { data, error } = await db
      .from("xauusd_price_ticks")
      .insert({
        symbol: "XAUUSD",
        price,
        bid,
        ask,
        provider: "vantage_mt5",
        source: "mt5",
        checked_at: checkedAt,
      })
      .select()
      .single();

    if (error) throw error;

    const mappedTick = mapPriceTick(data);

    setImmediate(() => {
      checkTradeWatchOnce({
        trigger: "vantage_tick",
        priceData: {
          price,
          bid,
          ask,
          timestamp: checkedAt,
          raw: req.body,
          latestTick: mappedTick,
        },
      }).catch((watchError) => {
        console.error("Vantage tick 즉시 감시 실패:", watchError.message);
      });
    });

    return res.json({
      ok: true,
      tick: mappedTick,
      watchTriggered: true,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/api/xauusd-history", async (req, res) => {
  try {
    const db = requireSupabase();

    const limit = Math.min(Number(req.query.limit || 20000), 50000);

    let query = db
      .from("xauusd_price_ticks")
      .select("*")
      .eq("symbol", "XAUUSD");

    if (PRICE_PROVIDER) {
      query = query.eq("provider", PRICE_PROVIDER);
    }

    const { data, error } = await query
      .order("checked_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    res.json({
      ok: true,
      provider: PRICE_PROVIDER,
      history: (data || []).reverse().map(mapPriceTick),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/api/trade-watch", async (req, res) => {
  try {
    const db = requireSupabase();

    const { data, error } = await db
      .from("trade_watch_state")
      .select("*")
      .eq("watch_key", "current")
      .maybeSingle();

    if (error) throw error;

    res.json({
      ok: true,
      watch: mapTradeWatch(data),
      pricePollSeconds: PRICE_POLL_SECONDS,
      provider: PRICE_PROVIDER,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/trade-watch/start", async (req, res) => {
  try {
    const db = requireSupabase();
    const setup = await getCurrentTradeSetup();

    if (!setup) {
      return res.status(400).json({
        ok: false,
        error: "저장된 계산값이 없습니다. 먼저 계산값 저장을 눌러주세요.",
      });
    }

    const entry2 = toWatchNumber(setup.entry2);
    const entry3 = toWatchNumber(setup.entry3);
    const firstTp = toWatchNumber(setup.first_tp);
    const secondTp = toWatchNumber(setup.second_tp);
    const thirdTp = toWatchNumber(setup.third_tp);
    const slPrice = toWatchNumber(setup.sl_price);

    if (firstTp === null || slPrice === null) {
      return res.status(400).json({
        ok: false,
        error: "1차 TP와 SL 손절가가 필요합니다.",
      });
    }

    const { data, error } = await db
      .from("trade_watch_state")
      .upsert(
        {
          watch_key: "current",
          is_active: true,
          symbol: setup.symbol || "XAUUSD",
          direction: setup.direction || "LONG",
          entry2,
          entry3,
          first_tp: firstTp,
          second_tp: secondTp,
          third_tp: thirdTp,
          sl_price: slPrice,
          active_tp: firstTp,
          sent_entry2: false,
          sent_entry3: false,
          sent_tp: false,
          sent_sl: false,
          last_price: null,
          last_checked_at: null,
          started_at: new Date().toISOString(),
          stopped_at: null,
        },
        {
          onConflict: "watch_key",
        }
      )
      .select()
      .single();

    if (error) throw error;

    res.json({
      ok: true,
      message: "자동 감시를 시작했습니다.",
      watch: mapTradeWatch(data),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/trade-watch/stop", async (req, res) => {
  try {
    const data = await stopTradeWatchState("manual_stop");

    res.json({
      ok: true,
      message: "자동 감시를 중지했습니다.",
      watch: mapTradeWatch(data),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

async function updateTradeWatchHeartbeat(db, price) {
  const { error } = await db
    .from("trade_watch_state")
    .update({
      last_price: price,
      last_checked_at: new Date().toISOString(),
    })
    .eq("watch_key", "current")
    .eq("is_active", true);

  if (error) throw error;
}

async function claimTradeWatchEvent(
  db,
  {
    flagColumn,
    updates = {},
    requiredValues = {},
  }
) {
  let query = db
    .from("trade_watch_state")
    .update({
      [flagColumn]: true,
      ...updates,
    })
    .eq("watch_key", "current")
    .eq("is_active", true)
    .eq(flagColumn, false);

  Object.entries(requiredValues).forEach(([column, value]) => {
    query = query.eq(column, value);
  });

  const { data, error } = await query.select("*").maybeSingle();

  if (error) throw error;

  // 동시에 여러 요청이 들어와도 false → true 선점에 성공한 요청 1개만 data를 받습니다.
  return data || null;
}

function getConfirmedWatchStage(watch) {
  if (watch?.sent_entry3) return 3;
  if (watch?.sent_entry2) return 2;
  return 1;
}

function getTpForWatchStage({
  stage,
  firstTp,
  secondTp,
  thirdTp,
}) {
  if (stage === 3) {
    return thirdTp ?? secondTp ?? firstTp;
  }

  if (stage === 2) {
    return secondTp ?? firstTp;
  }

  return firstTp;
}

async function finishPositionAfterAutomaticExit(reason) {
  await finishActiveSignalLog();

  signalRunning = false;
  activeSignal = null;
  botEnabled = true;

  await syncSignalLogsFromDb();

  console.log(`${reason} 도달로 자동 감시 중지 및 포지션 종료 완료`);
}

async function checkTradeWatchOnce(options = {}) {
  // 한 서버 프로세스 안에서 겹치는 실행을 1차로 방지합니다.
  // 실제 중복 발송 방지는 아래 DB 조건부 선점이 담당합니다.
  if (tradeWatchCheckInProgress) return;

  tradeWatchCheckInProgress = true;

  try {
    const db = requireSupabase();

    const { data: watch, error } = await db
      .from("trade_watch_state")
      .select("*")
      .eq("watch_key", "current")
      .eq("is_active", true)
      .maybeSingle();

    if (error) throw error;
    if (!watch) return;
    if (!botEnabled) return;

    const scheduleState = getAutoScheduleState();

    if (!scheduleState.isOpen) {
      // 자동 잠금 시간에는 감시 상태를 삭제하지 않고 판단만 잠시 멈춥니다.
      // 운영 시간이 다시 시작되면 기존 감시가 그대로 재개됩니다.
      return;
    }

    const priceData = options.priceData || (await fetchXauUsdPrice());

    if (!options.priceData && PRICE_PROVIDER !== "vantage_mt5") {
      await saveXauUsdPriceTick(priceData, "watch");
    }

    const price = Number(priceData.price);

    if (!Number.isFinite(price)) {
      throw new Error("자동 감시에 사용할 현재 가격이 올바르지 않습니다.");
    }

    await updateTradeWatchHeartbeat(db, price);

    const direction = watch.direction || "LONG";

    const entry2 = toWatchNumber(watch.entry2);
    const entry3 = toWatchNumber(watch.entry3);
    const firstTp = toWatchNumber(watch.first_tp);
    const secondTp = toWatchNumber(watch.second_tp);
    const thirdTp = toWatchNumber(watch.third_tp);
    const slPrice = toWatchNumber(watch.sl_price);

    /*
      중요 처리 순서
      1. SL은 어떤 회차에서도 최우선으로 1회만 처리
      2. 1차 상태에서는 2차 진입만 처리하고 즉시 종료
      3. 2차 확인 상태에서만 3차 진입 처리
      4. TP는 DB에 확정된 마지막 진입 회차의 TP만 사용

      따라서:
      - 2차까지만 확정되면 2차 TP만 사용
      - 3차 진입이 DB에 확정된 뒤에만 3차 TP 사용
      - 한 번의 가격 틱에서 2차와 3차 메시지를 동시에 보내지 않음
    */

    if (
      !watch.sent_sl &&
      !watch.sent_tp &&
      hasTouchedSl(direction, price, slPrice)
    ) {
      const claimedSl = await claimTradeWatchEvent(db, {
        flagColumn: "sent_sl",
        updates: {
          is_active: false,
          stopped_at: new Date().toISOString(),
          last_price: price,
          last_checked_at: new Date().toISOString(),
        },
        requiredValues: {
          sent_tp: false,
        },
      });

      if (!claimedSl) return;

      let sendError = null;

      try {
        await sendWatchTelegramMessage(makeSlReachMessage());
      } catch (error) {
        sendError = error;
        console.error("SL 메시지 발송 실패:", error.message);
      }

      await finishPositionAfterAutomaticExit("SL");

      if (sendError) throw sendError;
      return;
    }

    const stage = getConfirmedWatchStage(watch);

    // 1차 상태에서는 2차 진입만 처리합니다.
    if (
      stage === 1 &&
      hasTouchedEntry(direction, price, entry2)
    ) {
      const nextTp = secondTp ?? firstTp;

      const claimedEntry2 = await claimTradeWatchEvent(db, {
        flagColumn: "sent_entry2",
        updates: {
          active_tp: nextTp,
          last_price: price,
          last_checked_at: new Date().toISOString(),
        },
        requiredValues: {
          sent_entry3: false,
          sent_tp: false,
          sent_sl: false,
        },
      });

      if (!claimedEntry2) return;

      try {
        await sendWatchTelegramMessage(
          makeEntryReachMessage({
            direction,
            round: 2,
            entry: entry2,
            tp: nextTp,
            sl: slPrice,
          })
        );
      } catch (error) {
        // 중복 방지를 위해 이미 선점한 플래그는 되돌리지 않습니다.
        console.error("2차 진입 메시지 발송 실패:", error.message);
        throw error;
      }

      return;
    }

    // 2차 진입이 DB에 확정된 상태에서만 3차 진입을 처리합니다.
    if (
      stage === 2 &&
      hasTouchedEntry(direction, price, entry3)
    ) {
      const nextTp = thirdTp ?? secondTp ?? firstTp;

      const claimedEntry3 = await claimTradeWatchEvent(db, {
        flagColumn: "sent_entry3",
        updates: {
          active_tp: nextTp,
          last_price: price,
          last_checked_at: new Date().toISOString(),
        },
        requiredValues: {
          sent_entry2: true,
          sent_tp: false,
          sent_sl: false,
        },
      });

      if (!claimedEntry3) return;

      try {
        await sendWatchTelegramMessage(
          makeEntryReachMessage({
            direction,
            round: 3,
            entry: entry3,
            tp: nextTp,
            sl: slPrice,
          })
        );
      } catch (error) {
        // 중복 방지를 위해 이미 선점한 플래그는 되돌리지 않습니다.
        console.error("3차 진입 메시지 발송 실패:", error.message);
        throw error;
      }

      return;
    }

    // TP는 active_tp 값을 맹신하지 않고, DB에 확정된 진입 회차로 다시 계산합니다.
    const confirmedTp = getTpForWatchStage({
      stage,
      firstTp,
      secondTp,
      thirdTp,
    });

    if (
      !watch.sent_tp &&
      !watch.sent_sl &&
      hasTouchedTp(direction, price, confirmedTp)
    ) {
      const stageRequirements =
        stage === 3
          ? {
              sent_entry2: true,
              sent_entry3: true,
              sent_sl: false,
            }
          : stage === 2
          ? {
              sent_entry2: true,
              sent_entry3: false,
              sent_sl: false,
            }
          : {
              sent_entry2: false,
              sent_entry3: false,
              sent_sl: false,
            };

      const claimedTp = await claimTradeWatchEvent(db, {
        flagColumn: "sent_tp",
        updates: {
          active_tp: confirmedTp,
          is_active: false,
          stopped_at: new Date().toISOString(),
          last_price: price,
          last_checked_at: new Date().toISOString(),
        },
        requiredValues: stageRequirements,
      });

      if (!claimedTp) return;

      let sendError = null;

      try {
        await sendWatchTelegramMessage(makeTpReachMessage());
      } catch (error) {
        sendError = error;
        console.error("TP 메시지 발송 실패:", error.message);
      }

      await finishPositionAfterAutomaticExit("TP");

      if (sendError) throw sendError;
      return;
    }
  } catch (error) {
    console.error("Trade watch check error:", error.message);

    if (
      PRICE_PROVIDER === "vantage_mt5" &&
      String(error.message || "").includes("Vantage MT5 가격 수신이 끊겼습니다")
    ) {
      try {
        await stopTradeWatchState("vantage_price_stale");
        console.log("Vantage MT5 가격 수신 끊김으로 자동 감시를 중지했습니다.");
      } catch (stopError) {
        console.error("자동 감시 중지 실패:", stopError.message);
      }
    }
  } finally {
    tradeWatchCheckInProgress = false;
  }
}

app.get("/api/status", async (req, res) => {
  try {
    await syncSignalLogsFromDb();

    const scheduleState = getAutoScheduleState();

    res.json({
      botEnabled,
      operatingTime: scheduleState.isOpen,
      scheduleOpen: scheduleState.isOpen,
      scheduleStatus: scheduleState.statusText,
      scheduleReason: scheduleState.reason,
      signalRunning,
      canReceiveSignal: botEnabled && scheduleState.isOpen && !signalRunning,
      testMode,
      activeSignal,
      sentSignals,
      blockedSignals,
      supabaseConnected: Boolean(supabase),
      logDate: getTodayLogDate(),
      sourceRooms: {
        room1: SOURCE_CHAT_ID ? "설정됨" : "미설정",
        room2: SOURCE_CHAT_ID_2 ? "설정됨" : "미설정",
      },
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/manual-on", async (req, res) => {
  try {
    await syncSignalLogsFromDb();

    if (activeSignal) {
      await finishActiveSignalLog();
    } else {
      await releaseTodaySignalLock();
    }

    botEnabled = true;
    signalRunning = false;
    activeSignal = null;

    await syncSignalLogsFromDb();

    res.json({
      ok: true,
      message: "전달 가능 상태입니다. 다음 이미지 신호를 받을 수 있습니다.",
      botEnabled,
      signalRunning,
      canReceiveSignal: true,
      sentSignals,
      blockedSignals,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/manual-off", async (req, res) => {
  try {
    await syncSignalLogsFromDb();

    botEnabled = false;

    res.json({
      ok: true,
      message: "관리자 잠금 상태입니다. 봇이 OFF되었습니다.",
      botEnabled,
      signalRunning,
      canReceiveSignal: false,
      activeSignal,
      sentSignals,
      blockedSignals,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/finish-signal", async (req, res) => {
  try {
    await syncSignalLogsFromDb();

    const closedSignalId = activeSignal?.id || null;
    const marketExitAt = new Date().toISOString();
    const marketExitPrice = await getManualMarketExitPrice();

    // 종료 버튼을 누른 순간 가격을 감시 상태의 마지막 가격으로 남겨둡니다.
    if (marketExitPrice !== null) {
      const db = requireSupabase();

      const { error: priceUpdateError } = await db
        .from("trade_watch_state")
        .update({
          last_price: marketExitPrice,
          last_checked_at: marketExitAt,
        })
        .eq("watch_key", "current");

      if (priceUpdateError) throw priceUpdateError;
    }

    if (activeSignal && activeSignal.status === "진행중") {
      await sendCloseMarketMessage();
    }

    await finishActiveSignalLog();
    await stopTradeWatchState("finish_signal");

    signalRunning = false;
    activeSignal = null;
    botEnabled = true;

    await syncSignalLogsFromDb();

    res.json({
      ok: true,
      message: "포지션이 종료되었습니다. 다음 신호를 받을 수 있습니다.",
      closedSignalId,
      marketExitPrice,
      marketExitAt,
      botEnabled,
      signalRunning,
      canReceiveSignal: true,
      sentSignals,
      blockedSignals,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/lock-position", async (req, res) => {
  try {
    await syncSignalLogsFromDb();

    botEnabled = true;
    signalRunning = true;

    if (!activeSignal) {
      const maxOrder = sentSignals.reduce(
        (max, item) => Math.max(max, Number(item.order) || 0),
        0
      );

      const order = maxOrder + 1;

      activeSignal = await createSentSignalLog({
        id: order,
        order,
        orderText: `${orderNames[order - 1] || `${order}번째`} 시그널`,
        sourceRoom: "수동",
        signal: "",
        sourceMessageId: null,
        forwardedMessageId: null,
        sourceChatId: null,
        startedAt: getTimeText(),
        endedAt: null,
        status: "진행중",
        text: "관리자가 수동으로 포지션 진행중 상태로 변경했습니다.",
      });
    }

    res.json({
      ok: true,
      message: "포지션 진행중 상태로 잠금 처리되었습니다.",
      botEnabled,
      signalRunning,
      activeSignal,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.patch("/api/sent-signals/:id/result", async (req, res) => {
  try {
    const id = req.params.id;
    const positions = req.body.positions || [];
    const resultSummary = req.body.resultSummary || "확인중";

    if (!Array.isArray(positions)) {
      return res.status(400).json({
        ok: false,
        error: "positions 값은 배열이어야 합니다.",
      });
    }

    if (supabase) {
      const { error } = await supabase
        .from("signal_logs")
        .update({
          positions_json: positions,
          result_summary: resultSummary,
        })
        .eq("id", id)
        .eq("log_type", "sent");

      if (error) throw error;

      await syncSignalLogsFromDb();
    } else {
      sentSignals = sentSignals.map((item) =>
        String(item.id) === String(id)
          ? {
              ...item,
              positions,
              resultSummary,
            }
          : item
      );
    }

    res.json({
      ok: true,
      message: "시그널 결과를 저장했습니다.",
      sentSignals,
      activeSignal,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.delete("/api/sent-signals/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (supabase) {
      const deletingActiveSignal =
        activeSignal && String(activeSignal.id) === String(id);

      const { error } = await supabase
        .from("signal_logs")
        .delete()
        .eq("id", id)
        .eq("log_type", "sent");

      if (error) throw error;

      const { error: lockDeleteByLogError } = await supabase
        .from("signal_locks")
        .delete()
        .eq("signal_log_id", id);

      if (lockDeleteByLogError) throw lockDeleteByLogError;

      if (deletingActiveSignal) {
        await releaseTodaySignalLock();
      }

      await syncSignalLogsFromDb();
    } else {
      sentSignals = sentSignals.filter((item) => String(item.id) !== String(id));

      if (String(activeSignal?.id) === String(id)) {
        activeSignal = null;
        signalRunning = false;
      }
    }

    res.json({
      ok: true,
      message: "전송된 시그널 1개를 삭제했습니다.",
      sentSignals,
      activeSignal,
      signalRunning,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.delete("/api/blocked-signals/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (supabase) {
      const { error } = await supabase
        .from("signal_logs")
        .delete()
        .eq("id", id)
        .eq("log_type", "blocked");

      if (error) throw error;

      await syncSignalLogsFromDb();
    } else {
      blockedSignals = blockedSignals.filter(
        (item) => String(item.id) !== String(id)
      );
    }

    res.json({
      ok: true,
      message: "미전송 기록 1개를 삭제했습니다.",
      blockedSignals,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/api/position-records", async (req, res) => {
  try {
    const db = requireSupabase();

    const { data, error } = await db
      .from("position_records")
      .select("*")
      .order("record_date", { ascending: false })
      .order("updated_at", { ascending: false });

    if (error) throw error;

    const archives = groupRecordsByWeek(data || []);

    res.json({
      ok: true,
      records: data || [],
      archives,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/position-records", async (req, res) => {
  try {
    const db = requireSupabase();

    const recordDate = req.body.record_date || req.body.date;
    const symbol = req.body.symbol || "XAUUSD";
    const content = req.body.content || req.body.text;

    if (!recordDate) {
      return res.status(400).json({
        ok: false,
        error: "record_date 또는 date 값이 필요합니다.",
      });
    }

    if (!content) {
      return res.status(400).json({
        ok: false,
        error: "content 또는 text 값이 필요합니다.",
      });
    }

    const weekKey = getWeekKey(recordDate);

    const { data, error } = await db
      .from("position_records")
      .upsert(
        {
          record_date: recordDate,
          symbol,
          week_key: weekKey,
          content,
        },
        {
          onConflict: "record_date,symbol",
        }
      )
      .select()
      .single();

    if (error) throw error;

    await cleanupOldPositionWeeks();

    const { data: allRecords, error: listError } = await db
      .from("position_records")
      .select("*")
      .order("record_date", { ascending: false })
      .order("updated_at", { ascending: false });

    if (listError) throw listError;

    res.json({
      ok: true,
      message: "포지션 기록을 DB에 저장했습니다.",
      record: data,
      archives: groupRecordsByWeek(allRecords || []),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.delete("/api/position-records/:id", async (req, res) => {
  try {
    const db = requireSupabase();
    const id = req.params.id;

    const { error } = await db.from("position_records").delete().eq("id", id);

    if (error) throw error;

    const { data: allRecords, error: listError } = await db
      .from("position_records")
      .select("*")
      .order("record_date", { ascending: false })
      .order("updated_at", { ascending: false });

    if (listError) throw listError;

    res.json({
      ok: true,
      message: "포지션 기록 1개를 삭제했습니다.",
      archives: groupRecordsByWeek(allRecords || []),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.delete("/api/position-records/week/:weekKey", async (req, res) => {
  try {
    const db = requireSupabase();
    const weekKey = req.params.weekKey;

    const { error } = await db
      .from("position_records")
      .delete()
      .eq("week_key", weekKey);

    if (error) throw error;

    const { data: allRecords, error: listError } = await db
      .from("position_records")
      .select("*")
      .order("record_date", { ascending: false })
      .order("updated_at", { ascending: false });

    if (listError) throw listError;

    res.json({
      ok: true,
      message: "선택한 주간 정리본을 삭제했습니다.",
      archives: groupRecordsByWeek(allRecords || []),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/api/test-mode-on", (req, res) => {
  testMode = true;
  botEnabled = true;

  res.json({
    ok: true,
    botEnabled,
    testMode,
    message: "테스트 모드 ON입니다. 현재는 운영시간 제한 없이 항상 작동합니다.",
  });
});

app.get("/api/test-mode-off", (req, res) => {
  testMode = false;
  botEnabled = true;

  res.json({
    ok: true,
    botEnabled,
    testMode,
    message: "테스트 모드 OFF입니다. 현재는 운영시간 제한 없이 항상 작동합니다.",
  });
});

app.get("/api/telegram-updates", async (req, res) => {
  try {
    const updates = await telegramApi("getUpdates", {});

    const simplified = updates.map((update) => {
      const message = update.message || update.channel_post;

      if (!message) {
        return {
          updateId: update.update_id,
          type: "unknown",
        };
      }

      return {
        updateId: update.update_id,
        chatId: message.chat.id,
        sourceRoom: getSourceRoom(message.chat.id),
        chatTitle:
          message.chat.title || message.chat.username || message.chat.first_name,
        chatType: message.chat.type,
        text: message.text || message.caption || "",
        hasPhoto: Boolean(message.photo?.length),
        hasImageDocument: Boolean(
          message.document?.mime_type &&
            String(message.document.mime_type).startsWith("image/")
        ),
        signalDirection: getSignalDirection(message),
        messageId: message.message_id,
      };
    });

    res.json(simplified);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/api/test-forward-latest", async (req, res) => {
  try {
    const updates = await telegramApi("getUpdates", {
      limit: 50,
    });

    const messages = updates
      .map((update) => update.message || update.channel_post)
      .filter(Boolean)
      .filter((message) => Boolean(getSourceRoom(message.chat.id)))
      .filter((message) => isSignalMessage(message));

    const latestMessage = messages[messages.length - 1];

    if (!latestMessage) {
      return res.status(404).json({
        ok: false,
        message:
          "원본방에서 찾은 이미지 신호가 없습니다. 원본방에 BUY/SELL 이미지 포함 메시지를 보내주세요.",
      });
    }

    const forwarded = await forwardMessageToTarget(latestMessage);

    res.json({
      ok: true,
      message: "최신 이미지 신호를 전달방으로 전달했습니다.",
      sourceRoom: getSourceRoom(latestMessage.chat.id),
      sourceChatId: latestMessage.chat.id,
      sourceMessageId: latestMessage.message_id,
      forwardedMessageId: forwarded.message_id,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/api/set-webhook", async (req, res) => {
  try {
    const publicUrl = req.query.url;

    if (!publicUrl) {
      return res.status(400).json({
        ok: false,
        error:
          "url 파라미터가 필요합니다. 예: /api/set-webhook?url=https://xxxx.onrender.com",
      });
    }

    const webhookUrl = `${publicUrl.replace(/\/$/, "")}/telegram/webhook`;

    const result = await telegramApi("setWebhook", {
      url: webhookUrl,
      allowed_updates: ["message", "channel_post"],
    });

    res.json({
      ok: true,
      webhookUrl,
      result,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/tradingview-webhook", async (req, res) => {
  try {
    const payload = req.body || {};

    const expectedSecret = process.env.TRADINGVIEW_WEBHOOK_SECRET;

    if (expectedSecret && payload.secret !== expectedSecret) {
      return res.status(401).json({
        ok: false,
        error: "인증값이 맞지 않습니다.",
      });
    }

    await syncSignalLogsFromDb();

    if (!botEnabled) {
      return res.json({
        ok: true,
        ignored: true,
        reason: "봇 잠금 상태라 트레이딩뷰 알림을 무시했습니다.",
      });
    }

    if (!activeSignal || activeSignal.status !== "진행중") {
      return res.json({
        ok: true,
        ignored: true,
        reason: "진행중 포지션이 없어 트레이딩뷰 알림을 무시했습니다.",
      });
    }

    const message = makeTradingViewMessage(payload);

    await sendTextMessageToTarget(message);

    res.json({
      ok: true,
      message: "트레이딩뷰 알림을 텔레그램으로 전송했습니다.",
      sentText: message,
    });
  } catch (error) {
    console.error("TradingView Webhook Error:", error.message);

    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get("/api/webhook-info", async (req, res) => {
  try {
    const result = await telegramApi("getWebhookInfo", {});

    res.json({
      ok: true,
      result,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/telegram/webhook", async (req, res) => {
  try {
    const update = req.body;

    if (update.message) {
      await handleSignalMessage(update.message);
    }

    if (update.channel_post) {
      await handleSignalMessage(update.channel_post);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error("Webhook Error:", error.message);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Price watch interval: ${PRICE_POLL_SECONDS}s`);
});

setInterval(() => {
  checkTradeWatchOnce();
}, PRICE_POLL_SECONDS * 1000);