const express = require("express");
const { OpenClawClient } = require("openclaw-node");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// ── 載入 .env ──
function loadEnv(filepath) {
  if (!fs.existsSync(filepath)) return;
  const lines = fs.readFileSync(filepath, "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv(path.join(__dirname, ".env"));

// ── 設定 ──
const CONFIG = {
  apiKey: process.env.API_KEY || "",
  gatewayUrl: process.env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789",
  gatewayToken: process.env.OPENCLAW_GATEWAY_TOKEN || "",
  restPort: parseInt(process.env.REST_PORT, 10) || 3090,
  restHost: process.env.REST_HOST || "127.0.0.1",
  webhookSecret: process.env.WEBHOOK_SECRET || "",
  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60000,
  rateLimitMaxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS, 10) || 60,
};

// ── 4 個 WhatsApp 實例定義 ──
const INSTANCES = {};
for (let i = 1; i <= 4; i++) {
  const url = process.env[`WA_INSTANCE_${i}`];
  if (url) {
    INSTANCES[i] = {
      id: i,
      url: url.replace(/\/$/, ""),
      label: process.env[`WA_LABEL_${i}`] || `Instance ${i}`,
    };
  }
}

// ── 日誌工具 ──
const LOG_LEVELS = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };
const LOG_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

function log(level, msg, data) {
  if (LOG_LEVELS[level] < LOG_LEVEL) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  if (data !== undefined) {
    const m = level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log";
    console[m](line, data);
  } else {
    const m = level === "ERROR" ? "error" : level === "WARN" ? "warn" : "log";
    console[m](line);
  }
}

// ── 工具函數 ──
function generateId() {
  return crypto.randomUUID();
}

// ── 對 whatsapp-web-api-rest 發請求 ──
async function waRequest(instanceId, method, endpoint, body) {
  const instance = INSTANCES[instanceId];
  if (!instance) {
    throw new Error(`實例 ${instanceId} 不存在，可用實例: ${Object.keys(INSTANCES).join(", ")}`);
  }

  const url = `${instance.url}${endpoint}`;
  const opts = { method };
  if (body) {
    opts.headers = { "Content-Type": "application/json" };
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`WA 實例 ${instanceId} 回傳 ${res.status}: ${text}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

// ── Webhook 訂閱者管理 ──
const subscribers = new Set();

function notifySubscribers(event, payload) {
  if (subscribers.size === 0) return;

  const body = JSON.stringify({
    event,
    timestamp: new Date().toISOString(),
    data: payload,
  });

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "WhatsApp-REST-Gateway/2.0",
  };

  if (CONFIG.webhookSecret) {
    const sig = crypto.createHmac("sha256", CONFIG.webhookSecret).update(body).digest("hex");
    headers["X-Webhook-Signature"] = `sha256=${sig}`;
  }

  for (const entry of subscribers) {
    // 若訂閱者有指定 events 過濾
    if (entry.events && entry.events.length > 0 && !entry.events.includes(event)) {
      continue;
    }
    fetch(entry.url, { method: "POST", headers, body })
      .then((r) => { if (!r.ok) log("WARN", `Webhook ${entry.url} 回應 ${r.status}`); })
      .catch((err) => log("WARN", `Webhook ${entry.url} 發送失敗: ${err.message}`));
  }
}

// ── 建立 Express 應用 ──
const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "16mb" }));

// ── 請求日誌中介層 ──
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    log("INFO", `${req.method} ${req.originalUrl} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// ── API Key 認證中介層 ──
function apiKeyAuth(req, res, next) {
  // 若未設定 API_KEY 則跳過認證
  if (!CONFIG.apiKey) return next();

  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;

  if (token !== CONFIG.apiKey) {
    return res.status(401).json({ error: "API Key 無效" });
  }
  next();
}

// 靜態檔案 — 管理頁面
app.use("/admin", express.static(path.join(__dirname, "admin")));

// 除了 /health、/admin、/webhook/inbound 之外，全部需要認證
app.use((req, res, next) => {
  if (req.path === "/health" || req.path.startsWith("/admin") || req.path.startsWith("/webhook/inbound")) {
    return next();
  }
  apiKeyAuth(req, res, next);
});

// ── 簡易速率限制 ──
const rateMap = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateMap) {
    if (now - v.windowStart > CONFIG.rateLimitWindowMs) rateMap.delete(k);
  }
}, CONFIG.rateLimitWindowMs);

function rateLimiter(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  let entry = rateMap.get(key);
  if (!entry || now - entry.windowStart > CONFIG.rateLimitWindowMs) {
    entry = { windowStart: now, count: 0 };
    rateMap.set(key, entry);
  }
  entry.count++;
  res.setHeader("X-RateLimit-Limit", CONFIG.rateLimitMaxRequests);
  res.setHeader("X-RateLimit-Remaining", Math.max(0, CONFIG.rateLimitMaxRequests - entry.count));
  if (entry.count > CONFIG.rateLimitMaxRequests) {
    return res.status(429).json({ error: "請求過多，請稍後再試" });
  }
  next();
}
app.use(rateLimiter);

// ── 建立 OpenClaw 客戶端 ──
const client = new OpenClawClient({
  url: CONFIG.gatewayUrl,
  token: CONFIG.gatewayToken || undefined,
  autoReconnect: true,
  maxReconnectAttempts: 20,
});

let gatewayConnected = false;

// ── 常用端點包裝函數 ──

// 取得可用實例清單
function getInstancesStatus() {
  const result = {};
  for (const [id, inst] of Object.entries(INSTANCES)) {
    result[id] = { id: inst.id, label: inst.label, url: inst.url };
  }
  return result;
}

// 取得實例的 QR 碼頁面 URL
function getQrUrl(instanceId) {
  const inst = INSTANCES[instanceId];
  if (!inst) return null;
  return `${inst.url}/`;
}

// 前端回應格式
function fail(res, code, msg) {
  return res.status(code).json({ ok: false, error: msg });
}

function ok(res, data) {
  return res.json({ ok: true, ...data });
}

// ====================================================================
//  REST 端點
// ====================================================================

// ── GET /health ──
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    gateway: {
      connected: gatewayConnected,
      url: CONFIG.gatewayUrl,
    },
    instances: getInstancesStatus(),
    subscribers: subscribers.size,
    authEnabled: !!CONFIG.apiKey,
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + " MB",
  });
});

// ── GET /api/instances ── 列出所有 WhatsApp 實例
app.get("/api/instances", (req, res) => {
  ok(res, { instances: getInstancesStatus() });
});

// ── GET /api/instances/:id/qr ── 取得 QR 碼配對頁面 URL
app.get("/api/instances/:id/qr", (req, res) => {
  const id = parseInt(req.params.id, 10);
  const qrUrl = getQrUrl(id);
  if (!qrUrl) return fail(res, 404, `實例 ${id} 不存在`);
  ok(res, { instanceId: id, qrUrl });
});

// ── POST /api/instances/:id/logout ── 登出
app.post("/api/instances/:id/logout", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const result = await waRequest(id, "GET", "/logout");
    ok(res, { instanceId: id, message: "已登出", detail: result });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// ====================================================================
//  訊息發送端點
// ====================================================================

// ── POST /api/send-text ── 發送文字
app.post("/api/send-text", async (req, res) => {
  try {
    const { instance, target, text } = req.body;
    if (!instance) return fail(res, 400, "instance 為必填 (1-4)");
    if (!target) return fail(res, 400, "target 為必填（如 +85212345678）");
    if (!text) return fail(res, 400, "text 為必填");

    const chatId = target.includes("@") ? target : `${target.replace(/^\+/, "")}@c.us`;

    const result = await waRequest(instance, "POST", "/message", { chatId, text });
    log("INFO", `[實例${instance}] 文字已發送 → ${chatId}`);
    ok(res, { instance, chatId, result });
  } catch (err) {
    log("ERROR", `/api/send-text: ${err.message}`);
    fail(res, 500, err.message);
  }
});

// ── POST /api/send-media ── 發送圖片/影片/檔案/貼圖/語音
app.post("/api/send-media", async (req, res) => {
  try {
    const { instance, target, mediaType, mimetype, filename, caption, data, url, ptt } = req.body;
    if (!instance) return fail(res, 400, "instance 為必填 (1-4)");
    if (!target) return fail(res, 400, "target 為必填");
    if (!mediaType) return fail(res, 400, "mediaType 為必填 (image|video|audio|document|sticker)");

    const chatId = target.includes("@") ? target : `${target.replace(/^\+/, "")}@c.us`;

    const payload = { chatId, media: { type: mediaType } };

    if (data) {
      payload.media.data = data;
    } else if (url) {
      // 從 URL 下載並轉換為 base64
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`下載媒體失敗: ${resp.status}`);
      const buffer = Buffer.from(await resp.arrayBuffer());
      payload.media.data = buffer.toString("base64");
    } else {
      return fail(res, 400, "data (base64) 或 url 至少需要一個");
    }

    if (mimetype) payload.media.mimetype = mimetype;
    if (filename) payload.media.filename = filename;
    if (caption) payload.media.caption = caption;
    if (mediaType === "audio" && ptt !== undefined) payload.media.ptt = ptt;

    const result = await waRequest(instance, "POST", "/message", payload);
    log("INFO", `[實例${instance}] 媒體已發送 → ${chatId} (${mediaType})`);
    ok(res, { instance, chatId, mediaType, result });
  } catch (err) {
    log("ERROR", `/api/send-media: ${err.message}`);
    fail(res, 500, err.message);
  }
});

// ── POST /api/send-location ── 發送位置
app.post("/api/send-location", async (req, res) => {
  try {
    const { instance, target, name, address, latitude, longitude, url: locUrl } = req.body;
    if (!instance) return fail(res, 400, "instance 為必填 (1-4)");
    if (!target || latitude == null || longitude == null) return fail(res, 400, "target/latitude/longitude 為必填");

    const chatId = target.includes("@") ? target : `${target.replace(/^\+/, "")}@c.us`;

    const payload = { chatId, location: { latitude, longitude } };
    if (name) payload.location.name = name;
    if (address) payload.location.address = address;
    if (locUrl) payload.location.url = locUrl;

    const result = await waRequest(instance, "POST", "/message", payload);
    ok(res, { instance, chatId, result });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// ── POST /api/send-poll ── 發送投票
app.post("/api/send-poll", async (req, res) => {
  try {
    const { instance, target, name, options, allowMultipleAnswers } = req.body;
    if (!instance) return fail(res, 400, "instance 為必填 (1-4)");
    if (!target || !name || !options || !options.length) return fail(res, 400, "target/name/options 為必填");

    const chatId = target.includes("@") ? target : `${target.replace(/^\+/, "")}@c.us`;

    const payload = { chatId, poll: { name, options, allowMultipleAnswers: !!allowMultipleAnswers } };

    const result = await waRequest(instance, "POST", "/message", payload);
    ok(res, { instance, chatId, result });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// ── POST /api/send-contact ── 發送聯絡人
app.post("/api/send-contact", async (req, res) => {
  try {
    const { instance, target, firstname, lastname, email, phone } = req.body;
    if (!instance) return fail(res, 400, "instance 為必填 (1-4)");
    if (!target || !firstname || !phone) return fail(res, 400, "target/firstname/phone 為必填");

    const chatId = target.includes("@") ? target : `${target.replace(/^\+/, "")}@c.us`;

    const payload = { chatId, contact: { firstname, phone } };
    if (lastname) payload.contact.lastname = lastname;
    if (email) payload.contact.email = email;

    const result = await waRequest(instance, "POST", "/message", payload);
    ok(res, { instance, chatId, result });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// ── POST /api/simulate ── 模擬狀態（輸入中、錄音中...）
app.post("/api/simulate", async (req, res) => {
  try {
    const { instance, target, action } = req.body;
    if (!instance) return fail(res, 400, "instance 為必填 (1-4)");
    if (!target || !action) return fail(res, 400, "target/action 為必填");

    const validActions = ["composing", "recording", "available", "unavailable", "paused"];
    if (!validActions.includes(action)) {
      return fail(res, 400, `action 必須是: ${validActions.join(", ")}`);
    }

    const chatId = target.includes("@") ? target : `${target.replace(/^\+/, "")}@c.us`;

    const result = await waRequest(instance, "POST", "/simulate", { chatId, action });
    ok(res, { instance, chatId, action, result });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// ── POST /api/mark-read ── 標記已讀
app.post("/api/mark-read", async (req, res) => {
  try {
    const { instance, target } = req.body;
    if (!instance) return fail(res, 400, "instance 為必填 (1-4)");
    if (!target) return fail(res, 400, "target 為必填");

    const chatId = target.includes("@") ? target : `${target.replace(/^\+/, "")}@c.us`;

    const result = await waRequest(instance, "POST", "/messages/read", { chatId });
    ok(res, { instance, chatId, result });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// ====================================================================
//  查詢端點
// ====================================================================

// ── GET /api/chats ── 取得聊天列表
app.get("/api/chats", async (req, res) => {
  try {
    const instance = parseInt(req.query.instance, 10);
    if (!instance) return fail(res, 400, "請帶 ?instance=1-4");

    const result = await waRequest(instance, "GET", "/chats");
    ok(res, { instance, chats: result });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// ── GET /api/contacts ── 取得聯絡人
app.get("/api/contacts", async (req, res) => {
  try {
    const instance = parseInt(req.query.instance, 10);
    if (!instance) return fail(res, 400, "請帶 ?instance=1-4");

    const result = await waRequest(instance, "GET", "/contacts");
    ok(res, { instance, contacts: result });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// ── GET /api/check-number/:instance/:number ── 檢查號碼是否註冊 WhatsApp
app.get("/api/check-number/:instance/:number", async (req, res) => {
  try {
    const instanceId = parseInt(req.params.instance, 10);
    const number = req.params.number;
    const result = await waRequest(instanceId, "GET", `/number/${number}`);
    ok(res, { instance: instanceId, number, result });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// ── GET /api/profile/:instance/:target/status ── 取得狀態
app.get("/api/profile/:instance/:target/status", async (req, res) => {
  try {
    const instanceId = parseInt(req.params.instance, 10);
    const target = req.params.target;
    const chatId = target.includes("@") ? target : `${target.replace(/^\+/, "")}@c.us`;
    const result = await waRequest(instanceId, "GET", `/profile/status/${chatId}`);
    ok(res, { instance: instanceId, target: chatId, result });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// ── GET /api/profile/:instance/:target/picture ── 取得大頭照
app.get("/api/profile/:instance/:target/picture", async (req, res) => {
  try {
    const instanceId = parseInt(req.params.instance, 10);
    const target = req.params.target;
    const chatId = target.includes("@") ? target : `${target.replace(/^\+/, "")}@c.us`;
    const result = await waRequest(instanceId, "GET", `/profile/picture/${chatId}`);
    ok(res, { instance: instanceId, target: chatId, result });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// ====================================================================
//  AI 聊天端點 (OpenClaw Gateway)
// ====================================================================

// ── POST /api/chat ── AI 聊天（串流 SSE）
app.post("/api/chat", async (req, res) => {
  try {
    const { message, sessionKey } = req.body;
    if (!message) return fail(res, 400, "message 為必填");
    if (!gatewayConnected) return fail(res, 503, "AI Gateway 未連接");

    const opts = {};
    if (sessionKey) opts.sessionKey = sessionKey;

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const stream = client.chat(message, opts);
    try {
      for await (const chunk of stream) {
        if (chunk.type === "text") {
          res.write(`data: ${JSON.stringify({ type: "text", content: chunk.text })}\n\n`);
        } else if (chunk.type === "tool_use") {
          res.write(`data: ${JSON.stringify({ type: "tool_use", name: chunk.name, input: chunk.input })}\n\n`);
        } else if (chunk.type === "tool_result") {
          res.write(`data: ${JSON.stringify({ type: "tool_result", content: chunk.content })}\n\n`);
        } else if (chunk.type === "done") {
          res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        }
      }
    } catch (streamErr) {
      res.write(`data: ${JSON.stringify({ type: "error", error: streamErr.message })}\n\n`);
    }
    res.end();
  } catch (err) {
    log("ERROR", `/api/chat: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/chat-sync ── AI 聊天（同步）
app.post("/api/chat-sync", async (req, res) => {
  try {
    const { message, sessionKey } = req.body;
    if (!message) return fail(res, 400, "message 為必填");
    if (!gatewayConnected) return fail(res, 503, "AI Gateway 未連接");

    const opts = {};
    if (sessionKey) opts.sessionKey = sessionKey;

    const reply = await client.chatSync(message, opts);
    ok(res, { reply, sessionKey: opts.sessionKey });
  } catch (err) {
    log("ERROR", `/api/chat-sync: ${err.message}`);
    fail(res, 500, err.message);
  }
});

// ── GET /api/sessions ── 取得對話列表
app.get("/api/sessions", async (req, res) => {
  try {
    if (!gatewayConnected) return fail(res, 503, "AI Gateway 未連接");
    const limit = parseInt(req.query.limit, 10) || 50;
    const sessions = await client.sessions.list({ limit });
    ok(res, { sessions });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// ── GET /api/sessions/:key/history ── 取得對話歷史
app.get("/api/sessions/:key/history", async (req, res) => {
  try {
    if (!gatewayConnected) return fail(res, 503, "AI Gateway 未連接");
    const limit = parseInt(req.query.limit, 10) || 50;
    const history = await client.sessions.history(req.params.key, { limit });
    ok(res, { history });
  } catch (err) {
    fail(res, 500, err.message);
  }
});

// ====================================================================
//  Webhook 管理
// ====================================================================

// ── POST /api/webhooks/subscribe ── 訂閱
app.post("/api/webhooks/subscribe", (req, res) => {
  const { url, events } = req.body;
  if (!url) return fail(res, 400, "url 為必填");

  try {
    new URL(url);
  } catch {
    return fail(res, 400, "url 格式無效");
  }

  const entry = {
    url,
    events: events || [],
    subscribedAt: new Date().toISOString(),
  };
  subscribers.add(entry);

  log("INFO", `Webhook 已訂閱: ${url} (events: ${entry.events.join(",") || "all"})`);
  ok(res, { subscribed: entry, total: subscribers.size });
});

// ── DELETE /api/webhooks/unsubscribe ── 取消訂閱
app.delete("/api/webhooks/unsubscribe", (req, res) => {
  const { url } = req.body;
  if (!url) return fail(res, 400, "url 為必填");

  let removed = false;
  for (const entry of subscribers) {
    if (entry.url === url) {
      subscribers.delete(entry);
      removed = true;
      break;
    }
  }
  if (!removed) return fail(res, 404, "找不到該訂閱");
  log("INFO", `Webhook 已取消: ${url}`);
  ok(res, { unsubscribed: url, total: subscribers.size });
});

// ── GET /api/webhooks ── 列出訂閱
app.get("/api/webhooks", (req, res) => {
  ok(res, { subscribers: [...subscribers], total: subscribers.size });
});

// ── POST /api/webhooks/test ── 測試事件
app.post("/api/webhooks/test", (req, res) => {
  if (subscribers.size === 0) {
    return ok(res, { sent: false, reason: "沒有訂閱者" });
  }
  notifySubscribers("webhook.test", {
    message: "測試事件",
    timestamp: new Date().toISOString(),
  });
  ok(res, { sent: true, recipients: subscribers.size });
});

// ====================================================================
//  入站 Webhook 接收端點 — 各 whatsapp-web-api-rest 實例的回調
// ====================================================================

// POST /webhook/inbound/:instance — 接收來自 whatsapp-web-api-rest 的 webhook
app.post("/webhook/inbound/:instance", (req, res) => {
  const instanceId = parseInt(req.params.instance, 10);
  const body = req.body;

  log("DEBUG", `[實例${instanceId}] 收到入站 webhook`, body);

  const message = body?.message;
  if (message) {
    notifySubscribers("whatsapp.inbound", {
      instance: instanceId,
      instanceLabel: INSTANCES[instanceId]?.label || "",
      from: message.from,
      body: message.body || message,
      timestamp: new Date().toISOString(),
      raw: body,
    });
  }

  if (body?.media) {
    notifySubscribers("whatsapp.media", {
      instance: instanceId,
      instanceLabel: INSTANCES[instanceId]?.label || "",
      from: body.message?.from,
      media: body.media,
      timestamp: new Date().toISOString(),
      raw: body,
    });
  }

  res.json({ received: true });
});

// ====================================================================
//  404 + 錯誤處理
// ====================================================================

app.use((req, res) => {
  res.status(404).json({ ok: false, error: `找不到路徑: ${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, _next) => {
  log("ERROR", `未處理錯誤: ${err.message}`, err.stack);
  res.status(500).json({ ok: false, error: "伺服器內部錯誤" });
});

// ====================================================================
//  啟動
// ====================================================================

async function start() {
  log("INFO", `正在連接 AI Gateway: ${CONFIG.gatewayUrl}`);

  try {
    await client.connect();
    gatewayConnected = true;
    log("INFO", "已連接 OpenClaw AI Gateway");

    // 監聽 Gateway 底層事件
    if (typeof client.on === "function") {
      client.on("event", (evt) => {
        if (evt?.event === "agent.message" || evt?.event === "agent.response") {
          const p = evt.payload || {};
          if (p.channel === "whatsapp") {
            notifySubscribers(p.inbound ? "whatsapp.inbound" : "whatsapp.outbound", p);
          }
        }
      });
      client.on("disconnected", () => { gatewayConnected = false; });
      client.on("connected", () => { gatewayConnected = true; });
    }
  } catch (err) {
    log("WARN", `AI Gateway 連接失敗: ${err.message}（WhatsApp 收發仍正常）`);
  }

  return new Promise((resolve) => {
    app.listen(CONFIG.restPort, CONFIG.restHost, () => {
      log("INFO", `WhatsApp REST Gateway v2 已啟動 → http://${CONFIG.restHost}:${CONFIG.restPort}`);
      log("INFO", `已配置 ${Object.keys(INSTANCES).length} 個 WhatsApp 實例`);
      log("INFO", `API Key 認證: ${CONFIG.apiKey ? "已啟用" : "未啟用"}`);
      log("INFO", `AI Gateway: ${gatewayConnected ? "已連接" : "未連接"}`);

      console.log(`
  ┌──────────────────────────────────────────────────┐
  │          WhatsApp REST Gateway v2                │
  ├──────────────────────────────────────────────────┤
  │  實例端點 (需 API Key):                          │
  │    POST /api/send-text    發送文字               │
  │    POST /api/send-media   發送媒體               │
  │    POST /api/send-location 發送位置              │
  │    POST /api/send-poll    發送投票               │
  │    POST /api/send-contact 發送聯絡人             │
  │    POST /api/simulate     模擬狀態               │
  │    POST /api/mark-read    標記已讀               │
  │    GET  /api/chats        聊天列表               │
  │    GET  /api/contacts     聯絡人                 │
  │    GET  /api/instances    實例清單               │
  ├──────────────────────────────────────────────────┤
  │  AI 端點 (需 API Key):                           │
  │    POST /api/chat         AI 聊天(串流)          │
  │    POST /api/chat-sync    AI 聊天(同步)          │
  │    GET  /api/sessions     對話列表               │
  ├──────────────────────────────────────────────────┤
  │  Webhook 端點 (需 API Key):                      │
  │    POST   /api/webhooks/subscribe   訂閱         │
  │    DELETE /api/webhooks/unsubscribe 取消         │
  │    GET    /api/webhooks             列表         │
  ├──────────────────────────────────────────────────┤
  │  公開端點:                                       │
  │    GET /health              健康檢查             │
  │    POST /webhook/inbound/:id 入站回調            │
  └──────────────────────────────────────────────────┘
        ${Object.entries(INSTANCES).map(([id, inst]) => `  ${id}: ${inst.label} → ${inst.url}`).join("\n        ")}
        `);
      resolve();
    });
  });
}

// ── 優雅關閉 ──
async function shutdown(signal) {
  log("INFO", `收到 ${signal}，關閉中...`);
  if (gatewayConnected) {
    try { await client.disconnect(); } catch {}
  }
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (err) => log("ERROR", `未捕獲例外: ${err.message}`, err.stack));
process.on("unhandledRejection", (r) => log("ERROR", `未處理拒絕: ${r}`));

start().catch((err) => {
  log("ERROR", `啟動失敗: ${err.message}`, err.stack);
  process.exit(1);
});
