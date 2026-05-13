// ============================================================
//  WhatsApp Gateway Connector
//  本機 WebSocket 橋接器 — 連接 Cloudflare Hub 和本機 REST API
// ============================================================

const crypto = require("crypto");

// ── 載入 .env ──
const fs = require("fs");
const path = require("path");
function loadEnv(filepath) {
  if (!fs.existsSync(filepath)) return;
  for (const line of fs.readFileSync(filepath, "utf-8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv(path.join(__dirname, ".env"));

const CONFIG = {
  hubUrl: process.env.HUB_WS_URL || "wss://whatsapp-gateway-hub.ai-caseylai.workers.dev",
  connectorSecret: process.env.CONNECTOR_SECRET || "connector-secret-713ff6d70045de9da73c58c6",
  gatewayUrl: process.env.GATEWAY_LOCAL_URL || "http://127.0.0.1:3090",
  apiKey: process.env.API_KEY || "",
  reconnectDelayMs: 3000,
  maxReconnectDelayMs: 60000,
  pingIntervalMs: 30000,
};

let ws = null;
let reconnectTimeout = null;
let currentDelay = CONFIG.reconnectDelayMs;
let isRunning = true;

// ── 日誌 ──
function log(level, msg, data) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [connector] [${level}] ${msg}`;
  if (data) console[level === "ERROR" ? "error" : "log"](line, data);
  else console[level === "ERROR" ? "error" : "log"](line);
}

// ── 連接 Hub ──
function connect() {
  const url = `${CONFIG.hubUrl}?role=connector&token=${encodeURIComponent(CONFIG.connectorSecret)}`;

  log("INFO", `正在連接 Hub: ${CONFIG.hubUrl}`);

  try {
    ws = new WebSocket(url);

    ws.on("open", () => {
      log("INFO", "已連接 Cloudflare Hub");
      currentDelay = CONFIG.reconnectDelayMs;
      // 發送上線狀態
      sendToHub({ type: "status", clients: "syn", timestamp: new Date().toISOString() });
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleHubMessage(msg);
      } catch (err) {
        log("WARN", `無法解析 Hub 訊息: ${err.message}`);
      }
    });

    ws.on("close", (code) => {
      log("WARN", `Hub 連線已關閉 (code=${code})`);
      ws = null;
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      log("ERROR", `WebSocket 錯誤: ${err.message}`);
    });
  } catch (err) {
    log("ERROR", `連接失敗: ${err.message}`);
    scheduleReconnect();
  }
}

// ── 重連 ──
function scheduleReconnect() {
  if (!isRunning) return;
  if (reconnectTimeout) clearTimeout(reconnectTimeout);

  log("INFO", `將在 ${currentDelay / 1000}s 後重新連接`);
  reconnectTimeout = setTimeout(() => {
    currentDelay = Math.min(currentDelay * 2, CONFIG.maxReconnectDelayMs);
    connect();
  }, currentDelay);
}

// ── 處理來自 Hub 的訊息 ──
async function handleHubMessage(msg) {
  log("DEBUG", `收到 Hub 訊息: ${msg.type}`, msg);

  // 跳過系統訊息
  if (msg.type === "system" || msg.type === "pong" || msg.type === "status") return;

  // 來自 CRM 的請求 → 轉發到本機 REST Gateway
  if (msg.type === "send-text" || msg.type === "send-media" || msg.type === "send-location" ||
      msg.type === "send-poll" || msg.type === "send-contact" || msg.type === "simulate" ||
      msg.type === "mark-read") {
    await handleClientRequest(msg);
    return;
  }

  // 查詢類
  if (msg.type === "get-chats" || msg.type === "get-contacts" || msg.type === "check-number" ||
      msg.type === "get-instances") {
    await handleClientQuery(msg);
    return;
  }

  // 未知訊息
  log("DEBUG", `未處理的訊息類型: ${msg.type}`);
}

// ── 處理來自 CRM 的請求（轉發到本機 REST API）──
async function handleClientRequest(msg) {
  const typeMap = {
    "send-text": { endpoint: "/api/send-text", bodyKeys: ["instance", "target", "text"] },
    "send-media": { endpoint: "/api/send-media", bodyKeys: ["instance", "target", "mediaType", "mimetype", "filename", "caption", "url", "data", "ptt"] },
    "send-location": { endpoint: "/api/send-location", bodyKeys: ["instance", "target", "name", "address", "latitude", "longitude", "url"] },
    "send-poll": { endpoint: "/api/send-poll", bodyKeys: ["instance", "target", "name", "options", "allowMultipleAnswers"] },
    "send-contact": { endpoint: "/api/send-contact", bodyKeys: ["instance", "target", "firstname", "lastname", "email", "phone"] },
    "simulate": { endpoint: "/api/simulate", bodyKeys: ["instance", "target", "action"] },
    "mark-read": { endpoint: "/api/mark-read", bodyKeys: ["instance", "target"] },
  };

  const mapping = typeMap[msg.type];
  if (!mapping) return;

  try {
    const body = {};
    for (const key of mapping.bodyKeys) {
      if (msg[key] !== undefined) body[key] = msg[key];
    }

    const headers = { "Content-Type": "application/json" };
    if (CONFIG.apiKey) headers["Authorization"] = `Bearer ${CONFIG.apiKey}`;

    const res = await fetch(`${CONFIG.gatewayUrl}${mapping.endpoint}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const result = await res.json().catch(() => ({ raw: true, status: res.status }));

    // 回傳結果給 Hub
    sendToHub({
      type: "send-result",
      requestType: msg.type,
      requestId: msg._requestId || null,
      ok: result.ok !== false,
      result,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    log("ERROR", `轉發請求失敗: ${err.message}`);
    sendToHub({
      type: "send-result",
      requestType: msg.type,
      requestId: msg._requestId || null,
      ok: false,
      error: err.message,
      timestamp: new Date().toISOString(),
    });
  }
}

// ── 查詢處理 ──
async function handleClientQuery(msg) {
  const queryMap = {
    "get-chats": (m) => `/api/chats?instance=${m.instance || 1}`,
    "get-contacts": (m) => `/api/contacts?instance=${m.instance || 1}`,
    "check-number": (m) => `/api/check-number/${m.instance || 1}/${m.number}`,
    "get-instances": () => `/api/instances`,
  };

  const pathFn = queryMap[msg.type];
  if (!pathFn) return;

  try {
    const headers = {};
    if (CONFIG.apiKey) headers["Authorization"] = `Bearer ${CONFIG.apiKey}`;

    const res = await fetch(`${CONFIG.gatewayUrl}${pathFn(msg)}`, { headers });
    const result = await res.json().catch(() => ({ raw: true }));

    sendToHub({
      type: "query-result",
      queryType: msg.type,
      requestId: msg._requestId || null,
      ok: true,
      result,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    sendToHub({
      type: "query-result",
      queryType: msg.type,
      requestId: msg._requestId || null,
      ok: false,
      error: err.message,
    });
  }
}

// ── 發送訊息到 Hub ──
function sendToHub(msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
}

// ── 心跳 ──
setInterval(() => {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "ping", timestamp: Date.now() }));
  }
}, CONFIG.pingIntervalMs);

// ── 啟動 ──
log("INFO", "WhatsApp Gateway Connector 啟動中...");
log("INFO", `Hub: ${CONFIG.hubUrl}`);
log("INFO", `Gateway: ${CONFIG.gatewayUrl}`);

connect();

// ── 優雅關閉 ──
process.on("SIGINT", () => {
  log("INFO", "關閉中...");
  isRunning = false;
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  if (ws) {
    ws.close(1000, "shutdown");
    ws = null;
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  isRunning = false;
  if (reconnectTimeout) clearTimeout(reconnectTimeout);
  if (ws) ws.close(1000, "shutdown");
  process.exit(0);
});
