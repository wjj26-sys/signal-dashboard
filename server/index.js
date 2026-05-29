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

// 봇은 계속 ON 상태로 유지합니다.
// signalRunning이 true면 "포지션 진행중 / 새 신호 잠금" 상태입니다.
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

  return "이미지 신호";
}

function hasSignalImage(message) {
  const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;

  const hasImageDocument =
    message.document?.mime_type &&
    String(message.document.mime_type).startsWith("image/");

  return Boolean(hasPhoto || hasImageDocument);
}

function isSignalMessage(message) {
  // 현재 기준: 사진이 포함된 메시지만 신호로 판단합니다.
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
  const keepWeeks = weekKeys.slice(0, 2);
  const deleteWeeks = weekKeys.slice(2);

  if (deleteWeeks.length === 0) {
    return;
  }

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

function addBlockedSignal(message, reason) {
  const direction = getSignalDirection(message);

  blockedSignals.push({
    id: blockedSignals.length + 1,
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

  // 사진 없는 일반 텍스트/잡담은 신호로 보지 않습니다.
  if (!isSignalMessage(message)) {
    return;
  }

  if (!botEnabled) {
    addBlockedSignal(message, "봇이 비활성 상태라 미전송");
    return;
  }

  // 포지션 진행중이면 새 신호는 전달하지 않고 기록만 남깁니다.
  if (signalRunning) {
    addBlockedSignal(message, "진행중 유입으로 미전송");
    return;
  }

  const order = sentSignals.length + 1;
  const startedAt = getTimeText();
  const direction = getSignalDirection(message);

  const forwarded = await forwardMessageToTarget(message);

  signalRunning = true;

  activeSignal = {
    id: order,
    order,
    orderText: `${orderNames[order - 1] || `${order}번째`} 시그널`,
    signal: direction,
    sourceMessageId: message.message_id,
    forwardedMessageId: forwarded.message_id,
    startedAt,
    endedAt: null,
    status: "진행중",
    text: getMessageText(message),
  };

  sentSignals.push(activeSignal);

  console.log("신호 전달 완료:", activeSignal);
}

app.get("/", (req, res) => {
  res.send("Signal server is running.");
});

app.get("/api/status", (req, res) => {
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
  });
});

// 기존 프론트 호환용.
// 이제 manual-on은 봇 ON이 아니라 "포지션 잠금 해제 / 다음 신호 받을 수 있음" 의미입니다.
app.post("/api/manual-on", (req, res) => {
  botEnabled = true;
  signalRunning = false;
  activeSignal = null;

  res.json({
    ok: true,
    message: "전달 가능 상태입니다. 다음 이미지 신호를 받을 수 있습니다.",
    botEnabled,
    signalRunning,
    canReceiveSignal: true,
  });
});

// 기존 프론트 호환용.
// 봇을 실제로 끄지 않습니다. 봇은 계속 ON 상태를 유지합니다.
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

// 포지션 종료 버튼.
// 포지션을 종료하고 다음 신호를 받을 수 있게 잠금을 해제합니다.
app.post("/api/finish-signal", (req, res) => {
  const endedAt = getTimeText();

  if (activeSignal) {
    activeSignal.status = "종료";
    activeSignal.endedAt = endedAt;

    sentSignals = sentSignals.map((item) =>
      item.id === activeSignal.id
        ? {
            ...item,
            status: "종료",
            endedAt,
          }
        : item
    );
  }

  signalRunning = false;
  activeSignal = null;
  botEnabled = true;

  res.json({
    ok: true,
    message: "포지션이 종료되었습니다. 다음 신호를 받을 수 있습니다.",
    botEnabled,
    signalRunning,
    canReceiveSignal: true,
    sentSignals,
    blockedSignals,
  });
});

// 필요할 때 수동으로 포지션 잠금 상태를 만들 수 있는 API입니다.
app.post("/api/lock-position", (req, res) => {
  botEnabled = true;
  signalRunning = true;

  activeSignal = activeSignal || {
    id: sentSignals.length + 1,
    order: sentSignals.length + 1,
    orderText: `${
      orderNames[sentSignals.length] || `${sentSignals.length + 1}번째`
    } 시그널`,
    signal: "수동 잠금",
    sourceMessageId: null,
    forwardedMessageId: null,
    startedAt: getTimeText(),
    endedAt: null,
    status: "진행중",
    text: "관리자가 수동으로 포지션 진행중 상태로 변경했습니다.",
  };

  res.json({
    ok: true,
    message: "포지션 진행중 상태로 잠금 처리되었습니다.",
    botEnabled,
    signalRunning,
    activeSignal,
  });
});

app.delete("/api/sent-signals/:id", (req, res) => {
  const id = Number(req.params.id);

  sentSignals = sentSignals.filter((item) => item.id !== id);

  if (activeSignal?.id === id) {
    activeSignal = null;
    signalRunning = false;
  }

  res.json({
    ok: true,
    message: "전송된 시그널 1개를 삭제했습니다.",
    sentSignals,
    activeSignal,
    signalRunning,
  });
});

app.delete("/api/blocked-signals/:id", (req, res) => {
  const id = Number(req.params.id);

  blockedSignals = blockedSignals.filter((item) => item.id !== id);

  res.json({
    ok: true,
    message: "미전송 기록 1개를 삭제했습니다.",
    blockedSignals,
  });
});

// ===============================
// Supabase 포지션 기록 API
// ===============================

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