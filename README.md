# WhatsApp REST Gateway

將 OpenClaw 內建 WhatsApp（Baileys）通道包裝成 REST API + Cloudflare WebSocket Hub，支援 4 個 WhatsApp 門號。

## 架構

```
CRM/App/Bot ──→ wss://e-plus-mh.techforliving.net (Cloudflare WebSocket Hub)
                              │
                        Connector (本機)
                              │
                        REST Gateway (:3090)
                              │
              ┌──────┬────────┼────────┬──────┐
          實例1    實例2     實例3    實例4
          :8085    :8086     :8087    :8088
```

## 快速啟動

```bash
# 1. 設定環境變數
cp .env.example .env
# 編輯 .env，填入 API_KEY

# 2. 啟動全部服務
docker-compose up -d

# 3. 掃描 QR 碼配對（每個門號一次）
open http://localhost:8085/  # 實例1
open http://localhost:8086/  # 實例2
open http://localhost:8087/  # 實例3
open http://localhost:8088/  # 實例4

# 4. 打開管理後台
open http://localhost:3090/admin
```

## 部署服務

| 服務 | 位址 |
|------|------|
| Cloudflare WebSocket Hub | `wss://e-plus-mh.techforliving.net` |
| Hub 備用 | `wss://whatsapp-gateway-hub.ai-caseylai.workers.dev` |
| 管理後台 | `https://whatsapp-rest-gateway.ai-caseylai.workers.dev` |

## REST API

所有端點（`/health` 除外）需帶 Header：`Authorization: Bearer <API_KEY>`

### 發送

```bash
# 文字
curl -X POST http://localhost:3090/api/send-text \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"instance":1, "target":"+85212345678", "text":"Hello"}'

# 圖片
curl -X POST http://localhost:3090/api/send-media \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"instance":1, "target":"+852...", "mediaType":"image", "url":"https://...", "caption":"描述"}'

# 位置 / 投票 / 聯絡人 / 模擬輸入狀態
# 詳見完整 API 文件
```

### 查詢

```bash
GET /api/instances                        # 實例清單
GET /api/chats?instance=1                 # 聊天列表
GET /api/contacts?instance=1              # 聯絡人
GET /api/check-number/1/85212345678       # 檢查號碼
```

### AI 聊天（OpenClaw）

```bash
POST /api/chat-sync  # 同步回覆
POST /api/chat       # SSE 串流
GET  /api/sessions   # 對話列表
```

### Webhook

```bash
POST   /api/webhooks/subscribe    # 訂閱
DELETE /api/webhooks/unsubscribe  # 取消
GET    /api/webhooks              # 列表
```

入站 webhook payload：
```json
{
  "event": "whatsapp.inbound",
  "data": {
    "instance": 1,
    "from": "85212345678@c.us",
    "body": "我想查詢訂單",
    "timestamp": "2026-05-13T..."
  }
}
```

## WebSocket Hub（需帳號密碼）

### 連線 + 登入流程

```javascript
const ws = new WebSocket('wss://e-plus-mh.techforliving.net?role=client');

ws.onopen = () => {
  // 先登入
  ws.send(JSON.stringify({
    type: 'login',
    username: 'crm',
    password: 'crm123'
  }));
};

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);

  switch (msg.type) {
    case 'login-ok':
      // 登入成功，開始收發
      ws.send(JSON.stringify({ type: 'status' }));
      break;
    case 'login-error':
      console.error('登入失敗:', msg.error);
      break;
    case 'whatsapp.inbound':
      console.log(`[實例${msg.instance}] ${msg.from}: ${msg.body}`);
      break;
    case 'send-result':
      console.log('發送', msg.ok ? '成功' : '失敗');
      break;
  }
};

// 發送訊息
ws.send(JSON.stringify({
  type: 'send-text',
  instance: 1,
  target: '+85212345678',
  text: '您好'
}));
```

### 內建帳號

| 帳號 | 密碼 | 用途 |
|------|------|------|
| `crm` | `crm123` | CRM 主系統 |
| `admin` | `admin123` | 管理員 |
| `bot` | `bot123` | 自動機器人 |

修改帳號密碼：
```bash
echo '[{"username":"新帳號","password":"新密碼","label":"標籤"}]' | \
  CLOUDFLARE_API_TOKEN=xxx npx wrangler secret put HUB_ACCOUNTS
```

## 專案結構

```
├── server.js              # REST Gateway 主程式
├── connector.js           # Cloudflare Hub 橋接器
├── Dockerfile             # Docker 映像
├── docker-compose.yml     # 一鍵啟動全部服務
├── admin/index.html       # 管理後台
├── cloudflare/            # Cloudflare Worker + Durable Object
│   ├── wrangler.toml
│   └── src/index.js
├── setup-cloudflare.sh    # Cloudflare Tunnel 設定
└── .env.example           # 環境變數範本
```

## OpenClaw Skill

Skill 檔案：`~/.openclaw/skills/whatsapp-gateway/SKILL.md`

設定環境變數後，可直接對 OpenClaw 說「發送 WhatsApp 給 +852...」來使用。
