// ============================================================
//  WhatsApp Gateway Hub — Cloudflare Worker + Durable Object
//  中央 WebSocket 交換中心
// ============================================================

// 環境變數：在 wrangler.toml 或 Cloudflare Dashboard 設定
// CONNECTOR_SECRET — 本地 connector 的認證密鑰
// CLIENT_SECRET    — CRM 客戶端的認證密鑰（可選）

// ============================================================
//  Durable Object — 每個 DO 實例維護一群 WebSocket 連線
// ============================================================
class HubDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // sessions: Map<WebSocket, { role, id, connectedAt }>
    this.sessions = new Map();
    // 用 state.storage 跨請求持久化連線 ID（非必要但可追蹤）
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role") || "client";
    const token = url.searchParams.get("token") || "";
    const instanceId = url.searchParams.get("instance") || "";

    // 認證 connector
    if (role === "connector") {
      const expected = this.env.CONNECTOR_SECRET || "";
      if (expected && token !== expected) {
        return new Response("Unauthorized", { status: 401 });
      }
    }

    // 若 client 有設定密鑰，也驗證
    if (role === "client" && this.env.CLIENT_SECRET && token !== this.env.CLIENT_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }

    // 升級到 WebSocket
    const pair = new WebSocketPair();
    const [clientWs, serverWs] = Object.values(pair);

    serverWs.accept();
    serverWs.role = role;
    serverWs.id = crypto.randomUUID();
    serverWs.instanceId = instanceId || null;
    serverWs.connectedAt = Date.now();

    this.sessions.set(serverWs, {
      role,
      id: serverWs.id,
      instanceId: serverWs.instanceId,
      connectedAt: serverWs.connectedAt,
    });

    // 廣播上線通知
    this.broadcast({
      type: "system",
      event: role === "connector" ? "connector.online" : "client.join",
      clientId: serverWs.id,
      role,
      timestamp: new Date().toISOString(),
    }, null);

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
      this.broadcast({
        type: "system",
        event: info?.role === "connector" ? "connector.offline" : "client.leave",
        clientId: serverWs.id,
        role: info?.role,
        timestamp: new Date().toISOString(),
      }, null);
    });

    serverWs.addEventListener("error", (err) => {
      console.error("WebSocket error:", err.message);
    });

    return new Response(null, { status: 101, webSocket: clientWs });
  }

  // ── 訊息路由 ──
  handleMessage(senderWs, msg) {
    const senderInfo = this.sessions.get(senderWs);
    const senderRole = senderInfo?.role;

    switch (msg.type) {
      // 客戶端 → Connector（轉發到本機）
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
        if (senderRole === "client") {
          this.forwardToConnector(msg);
        }
        break;

      // Connector → 所有客戶端（入站訊息廣播）
      case "inbound":
      case "whatsapp.inbound":
      case "whatsapp.media":
        if (senderRole === "connector") {
          this.broadcast(msg, senderWs);
        }
        break;

      // Connector → 所有客戶端（發送結果回傳）
      case "send-result":
        if (senderRole === "connector") {
          this.broadcast(msg, senderWs);
        }
        break;

      // 查詢在線狀態
      case "status":
        senderWs.send(JSON.stringify({
          type: "status",
          clients: this.getClientList(),
          connectorOnline: this.hasConnector(),
          timestamp: new Date().toISOString(),
        }));
        break;

      // 心跳
      case "ping":
        senderWs.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
        break;

      default:
        // 未知訊息類型，如果是 client 發的轉給 connector
        if (senderRole === "client" && this.hasConnector()) {
          this.forwardToConnector(msg);
        }
    }
  }

  // ── 轉發給 connector ──
  forwardToConnector(msg) {
    let sent = false;
    for (const [ws, info] of this.sessions) {
      if (info.role === "connector" && ws.readyState === 1) {
        ws.send(JSON.stringify(msg));
        sent = true;
        break; // 只有一個 connector，轉給它即可
      }
    }
    return sent;
  }

  // ── 廣播給所有客戶端 ──
  broadcast(msg, excludeWs) {
    for (const [ws, info] of this.sessions) {
      if (ws === excludeWs) continue;
      if (ws.readyState !== 1) {
        this.sessions.delete(ws);
        continue;
      }
      ws.send(JSON.stringify(msg));
    }
  }

  // ── 查詢狀態 ──
  getClientList() {
    const clients = [];
    for (const [ws, info] of this.sessions) {
      clients.push({
        id: info.id,
        role: info.role,
        instanceId: info.instanceId,
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
      // 使用固定的 DO ID，確保所有客戶端都在同一個 DO 實例
      const doId = env.HUB.idFromName("primary");
      const doStub = env.HUB.get(doId);
      return doStub.fetch(request);
    }

    // HTTP API — 健康檢查
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({
        status: "ok",
        service: "WhatsApp Gateway Hub",
        timestamp: new Date().toISOString(),
      }), {
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      });
    }

    // HTTP API — 用 POST 發送訊息（方便 CRM 不必維護 WebSocket）
    if (url.pathname === "/api/send" && request.method === "POST") {
      try {
        const body = await request.json();
        const doId = env.HUB.idFromName("primary");
        const doStub = env.HUB.get(doId);

        // 透過 DO 內部的 HTTP 端點轉發
        // 這裡用一個內部請求把訊息送進 DO
        const msgUrl = new URL(request.url);
        msgUrl.pathname = "/__internal__/relay";

        // 把訊息直接透過 DO 的 fetch 發送
        const doResponse = await doStub.fetch(
          new Request(msgUrl.toString(), {
            method: "POST",
            body: JSON.stringify({ ...body, _relay: true, _from: "http-api" }),
          })
        );

        const result = await doResponse.json().catch(() => ({ ok: false }));
        return new Response(JSON.stringify(result), {
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    return new Response("WhatsApp Gateway Hub", {
      headers: { "Content-Type": "text/plain" },
    });
  },
};
