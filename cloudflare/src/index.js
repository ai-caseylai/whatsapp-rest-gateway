// ============================================================
//  WhatsApp Gateway Hub — Cloudflare Worker + Durable Object
//  中央 WebSocket 交換中心
// ============================================================

// 環境變數（wrangler secret / Cloudflare Dashboard 設定）：
//   CONNECTOR_SECRET — 本地 connector 認證
//   HUB_ACCOUNTS     — JSON: [{"username":"crm","password":"...","label":"CRM"}]
//   CLIENT_SECRET    — (可選) 舊版 token 認證

// ============================================================
//  Durable Object
// ============================================================
class HubDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();  // WebSocket → { role, id, username, label, connectedAt }
  }

  // 解析帳號清單
  getAccounts() {
    try {
      const raw = this.env.HUB_ACCOUNTS || "[]";
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  // 驗證帳號密碼
  validateLogin(username, password) {
    const accounts = this.getAccounts();
    return accounts.find(a => a.username === username && a.password === password) || null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") || "client";
    const token = url.searchParams.get("token") || "";

    // connector 認證
    if (role === "connector") {
      const expected = this.env.CONNECTOR_SECRET || "";
      if (expected && token !== expected) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    // 舊版 client token 認證（可選）
    if (role === "client" && this.env.CLIENT_SECRET && token === this.env.CLIENT_SECRET) {
      // token 有效，允許略過 login
    }

    // 升級到 WebSocket
    const pair = new WebSocketPair();
    const [clientWs, serverWs] = Object.values(pair);

    serverWs.accept();
    serverWs.role = role;
    serverWs.id = crypto.randomUUID();
    serverWs.authenticated = false;
    serverWs.username = null;
    serverWs.connectedAt = Date.now();

    // 舊版 token 認證過的直接標記
    if (role === "client" && this.env.CLIENT_SECRET && token === this.env.CLIENT_SECRET) {
      serverWs.authenticated = true;
      serverWs.username = "token-auth";
    }

    // connector 直接標記已驗證
    if (role === "connector") {
      serverWs.authenticated = true;
      serverWs.username = "connector";
    }

    this.sessions.set(serverWs, {
      role,
      id: serverWs.id,
      username: serverWs.username,
      authenticated: serverWs.authenticated,
      connectedAt: serverWs.connectedAt,
    });

    // 系統通知：只通知 connector 上下線，client 登入後才通知
    if (role === "connector") {
      this.broadcastSystem("connector.online", serverWs);
    }

    // ── 事件處理 ──
    serverWs.addEventListener("message", (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        msg._from = serverWs.id;
        msg._fromRole = serverWs.role;
        this.handleMessage(serverWs, msg);
      } catch (err) {
        serverWs.send(JSON.stringify({
          type: "error",
          error: "Invalid JSON: " + err.message,
        }));
      }
    });

    serverWs.addEventListener("close", () => {
      const info = this.sessions.get(serverWs);
      this.sessions.delete(serverWs);
      if (info?.role === "connector") {
        this.broadcastSystem("connector.offline", serverWs);
      } else if (info?.role === "client" && info?.authenticated) {
        this.broadcastSystem("client.leave", serverWs);
      }
    });

    serverWs.addEventListener("error", (err) => {
      console.error("WebSocket error:", err.message);
    });

    return new Response(null, { status: 101, webSocket: clientWs });
  }

  // ── 訊息路由 ──
  handleMessage(senderWs, msg) {
    const info = this.sessions.get(senderWs);

    // login 可在未認證狀態下執行
    if (msg.type === "login") {
      this.handleLogin(senderWs, msg);
      return;
    }

    // ping 和 status 不需要認證
    if (msg.type === "ping") {
      senderWs.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      return;
    }

    if (msg.type === "status") {
      senderWs.send(JSON.stringify({
        type: "status",
        clients: this.getClientList(),
        connectorOnline: this.hasConnector(),
        authenticated: info?.authenticated || false,
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // 所有其他訊息類型需要認證
    if (!info?.authenticated) {
      senderWs.send(JSON.stringify({
        type: "error",
        error: "請先登入。發送 {\"type\":\"login\",\"username\":\"...\",\"password\":\"...\"}",
      }));
      return;
    }

    switch (msg.type) {
      // ─ Client → Connector ─
      case "send-text":
      case "send-media":
      case "send-location":
      case "send-poll":
      case "send-contact":
      case "simulate":
      case "mark-read":
      case "get-chats":
      case "get-contacts":
      case "check-number":
      case "get-instances":
        if (info.role === "client") {
          this.forwardToConnector(msg);
        }
        break;

      // ─ Connector → All Clients ─
      case "inbound":
      case "whatsapp.inbound":
      case "whatsapp.media":
        if (info.role === "connector") {
          this.broadcastToClients(msg, senderWs);
        }
        break;

      case "send-result":
      case "query-result":
        if (info.role === "connector") {
          this.broadcastToClients(msg, senderWs);
        }
        break;

      default:
        if (info.role === "client" && this.hasConnector()) {
          this.forwardToConnector(msg);
        }
    }
  }

  // ── 登入 ──
  handleLogin(senderWs, msg) {
    const { username, password } = msg;

    if (!username || !password) {
      senderWs.send(JSON.stringify({
        type: "login-error",
        error: "請提供 username 和 password",
      }));
      return;
    }

    const account = this.validateLogin(username, password);
    if (!account) {
      senderWs.send(JSON.stringify({
        type: "login-error",
        error: "帳號或密碼錯誤",
      }));
      return;
    }

    senderWs.authenticated = true;
    senderWs.username = username;
    const info = this.sessions.get(senderWs);
    if (info) {
      info.authenticated = true;
      info.username = username;
      info.label = account.label || username;
    }

    senderWs.send(JSON.stringify({
      type: "login-ok",
      username,
      label: account.label || username,
      timestamp: new Date().toISOString(),
    }));

    // 通知其他客戶端有人上線
    this.broadcastSystem("client.join", senderWs);
  }

  // ── 轉發給 connector ──
  forwardToConnector(msg) {
    for (const [ws, info] of this.sessions) {
      if (info.role === "connector" && ws.readyState === 1) {
        ws.send(JSON.stringify(msg));
        return true;
      }
    }
    return false;
  }

  // ── 廣播給已認證客戶端 ──
  broadcastToClients(msg, excludeWs) {
    for (const [ws, info] of this.sessions) {
      if (ws === excludeWs) continue;
      if (info.role !== "client") continue;
      if (!info.authenticated) continue;
      if (ws.readyState !== 1) {
        this.sessions.delete(ws);
        continue;
      }
      ws.send(JSON.stringify(msg));
    }
  }

  // ── 系統廣播 ──
  broadcastSystem(event, senderWs) {
    const info = senderWs ? this.sessions.get(senderWs) : null;
    for (const [ws, i] of this.sessions) {
      if (ws === senderWs) continue;
      if (ws.readyState !== 1) { this.sessions.delete(ws); continue; }
      // 只發給已認證的 client 和 connector
      if (i.role === "connector" || i.authenticated) {
        ws.send(JSON.stringify({
          type: "system",
          event,
          clientId: info?.id,
          username: info?.username || null,
          role: info?.role,
          timestamp: new Date().toISOString(),
        }));
      }
    }
  }

  // ── 查詢 ──
  getClientList() {
    const clients = [];
    for (const [ws, info] of this.sessions) {
      clients.push({
        id: info.id,
        role: info.role,
        username: info.username || null,
        authenticated: info.authenticated,
        connectedAt: new Date(info.connectedAt).toISOString(),
      });
    }
    return clients;
  }

  hasConnector() {
    for (const [ws, info] of this.sessions) {
      if (info.role === "connector" && ws.readyState === 1) return true;
    }
    return false;
  }
}

// ============================================================
//  Worker 進入點
// ============================================================
export { HubDO };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // WebSocket 升級
    if (request.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const doId = env.HUB.idFromName("primary");
      const doStub = env.HUB.get(doId);
      return doStub.fetch(request);
    }

    // HTTP — 健康檢查
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        status: "ok",
        service: "WhatsApp Gateway Hub",
        authEnabled: true,
        timestamp: new Date().toISOString(),
      }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // HTTP — POST /api/send（需帶 Authorization 和帳號資訊）
    if (url.pathname === "/api/send" && request.method === "POST") {
      try {
        const body = await request.json();
        const doId = env.HUB.idFromName("primary");
        const doStub = env.HUB.get(doId);
        const result = await doStub.fetch(
          new Request(url.origin + "/__internal__/relay", {
            method: "POST",
            body: JSON.stringify({ ...body, _relay: true, _from: "http-api" }),
          })
        );
        const data = await result.json().catch(() => ({ ok: false }));
        return new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    return new Response("WhatsApp Gateway Hub", {
      headers: { "Content-Type": "text/plain" },
    });
  },
};
