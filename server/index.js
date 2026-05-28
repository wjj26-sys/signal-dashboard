import express from "express";
import dotenv from "dotenv";
import cron from "node-cron";

dotenv.config();

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const SOURCE_CHAT_ID = process.env.SOURCE_CHAT_ID;
const TARGET_CHAT_ID = process.env.TARGET_CHAT_ID;
const PORT = process.env.PORT || 4000;

let botEnabled = false;
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

function isOperatingTime() {
  const now = getKstNow();

  const hour = now.getHours();
  const minute = now.getMinutes();
  const currentMinutes = hour * 60 + minute;

  const startMinutes = 9 * 60;
  const endMinutes = 10 * 60;

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

async function telegramApi(method, body) {
  if (!BOT_TOKEN) {
    throw new Error("BOT_TOKEN이 .env에 없습니다.");
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
    throw new Error("TARGET_CHAT_ID가 .env에 없습니다.");
  }

  return telegramApi("forwardMessage", {
    chat_id: TARGET_CHAT_ID,
    from_chat_id: message.chat.id,
    message_id: message.message_id,
  });
}

function addBlockedSignal(message, reason) {
  blockedSignals.push({
    id: blockedSignals.length + 1,
    messageId: message.message_id,
    sourceChatId: message.chat.id,
    time: getTimeText(),
    reason,
  });
}

async function handleSignalMessage(message) {
  const sourceChatId = String(message.chat.id);

  if (SOURCE_CHAT_ID && sourceChatId !== String(SOURCE_CHAT_ID)) {
    return;
  }

  if (!botEnabled) {
    addBlockedSignal(message, "봇이 OFF 상태라 미전송");
    return;
  }

  if (!testMode && !isOperatingTime()) {
    addBlockedSignal(message, "운영 시간이 아니어서 미전송");
    return;
  }

  if (signalRunning) {
    addBlockedSignal(message, "진행중 유입으로 미전송");
    return;
  }

  const order = sentSignals.length + 1;
  const startedAt = getTimeText();

  const forwarded = await forwardMessageToTarget(message);

  signalRunning = true;

  activeSignal = {
    id: order,
    order,
    sourceMessageId: message.message_id,
    forwardedMessageId: forwarded.message_id,
    startedAt,
    status: "진행중",
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
    activeSignal,
    sentSignals,
    blockedSignals,
  });
});

app.post("/api/manual-on", (req, res) => {
  botEnabled = true;

  res.json({
    ok: true,
    botEnabled,
  });
});

app.post("/api/manual-off", (req, res) => {
  botEnabled = false;

  res.json({
    ok: true,
    botEnabled,
  });
});

app.post("/api/finish-signal", (req, res) => {
  signalRunning = false;

  if (activeSignal) {
    activeSignal.status = "종료";
    activeSignal.endedAt = getTimeText();
  }

  activeSignal = null;

  res.json({
    ok: true,
    signalRunning,
  });
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
    console.error(error.message);
    res.sendStatus(500);
  }
});

// 매일 09:00 KST 자동 ON
cron.schedule(
  "0 9 * * *",
  () => {
    botEnabled = true;
    console.log("09:00 KST 자동 ON");
  },
  {
    timezone: "Asia/Seoul",
  }
);

// 매일 10:00 KST 자동 OFF
cron.schedule(
  "0 10 * * *",
  () => {
    botEnabled = false;
    signalRunning = false;
    activeSignal = null;
    console.log("10:00 KST 자동 OFF");
  },
  {
    timezone: "Asia/Seoul",
  }
);

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
        chatTitle: message.chat.title || message.chat.username || message.chat.first_name,
        chatType: message.chat.type,
        text: message.text || message.caption || "",
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
      .filter((message) => String(message.chat.id) === String(SOURCE_CHAT_ID));

    const latestMessage = messages[messages.length - 1];

    if (!latestMessage) {
      return res.status(404).json({
        ok: false,
        message: "원본방에서 찾은 최신 메시지가 없습니다. 원본방에 테스트 메시지를 하나 보내주세요.",
      });
    }

    const forwarded = await forwardMessageToTarget(latestMessage);

    res.json({
      ok: true,
      message: "최신 메시지를 전달방으로 전달했습니다.",
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

app.get("/api/test-mode-on", (req, res) => {
  botEnabled = true;
  testMode = true;

  res.json({
    ok: true,
    botEnabled,
    testMode,
    message: "테스트 모드 ON: 운영 시간과 상관없이 신호를 받을 수 있습니다.",
  });
});

app.get("/api/test-mode-off", (req, res) => {
  testMode = false;

  res.json({
    ok: true,
    botEnabled,
    testMode,
    message: "테스트 모드 OFF: 09:00~10:00 운영 시간만 적용됩니다.",
  });
});

app.get("/api/set-webhook", async (req, res) => {
  try {
    const publicUrl = req.query.url;

    if (!publicUrl) {
      return res.status(400).json({
        ok: false,
        error: "url 파라미터가 필요합니다. 예: /api/set-webhook?url=https://xxxx.ngrok-free.app",
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

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});