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
const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;
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

function isOperatingTime() {
  return true;
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
    logDate: row.log_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapBlockedLog(row) {
  return {
    id: row.id,
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

async function addBlockedSignal(message, reason) {
  const direction = getSignalDirection(message);

  const fallbackId = blockedSignals.length + 1;

  return createBlockedSignalLog({
    id: fallbackId,
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

  if (SOURCE_CHAT_ID && sourceChatId !== String(SOURCE_CHAT_ID)) {
    return;
  }

  if (!isSignalMessage(message)) {
    return;
  }

  await syncSignalLogsFromDb();

  if (!botEnabled) {
    await addBlockedSignal(message, "봇이 비활성 상태라 미전송");
    return;
  }

  if (signalRunning) {
    await addBlockedSignal(message, "진행중 유입으로 미전송");
    return;
  }

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

  signalRunning = true;
  activeSignal = savedSignal;

  console.log("신호 전달 완료:", savedSignal);
}

app.get("/", (req, res) => {
  res.send("Signal server is running.");
});

app.get("/api/status", async (req, res) => {
  try {
    await syncSignalLogsFromDb();

    res.json({
      botEnabled,
      operatingTime: isOperatingTime(),
      signalRunning,
      canReceiveSignal: botEnabled && !signalRunning,
      testMode,
      activeSignal,
      sentSignals,
      blockedSignals,
      supabaseConnected: Boolean(supabase),
      logDate: getTodayLogDate(),
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

app.post("/api/manual-off", (req, res) => {
  botEnabled = true;

  res.json({
    ok: true,
    message: "봇은 계속 ON 상태입니다. 포지션 종료는 /api/finish-signal에서 처리됩니다.",
    botEnabled,
    signalRunning,
    canReceiveSignal: botEnabled && !signalRunning,
  });
});

app.post("/api/finish-signal", async (req, res) => {
  try {
    await syncSignalLogsFromDb();
    await finishActiveSignalLog();

    signalRunning = false;
    activeSignal = null;
    botEnabled = true;

    await syncSignalLogsFromDb();

    res.json({
      ok: true,
      message: "포지션이 종료되었습니다. 다음 신호를 받을 수 있습니다.",
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

app.delete("/api/sent-signals/:id", async (req, res) => {
  try {
    const id = req.params.id;

    if (supabase) {
      const { error } = await supabase
        .from("signal_logs")
        .delete()
        .eq("id", id)
        .eq("log_type", "sent");

      if (error) throw error;

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
      .filter((message) => String(message.chat.id) === String(SOURCE_CHAT_ID))
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
  console.log(`Server running on http://localhost:${PORT}`);
});