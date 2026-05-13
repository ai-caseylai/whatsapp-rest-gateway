#!/bin/bash
set -e

echo "============ Cloudflare Tunnel 設定 ============"
echo ""

# 檢查 cloudflared
if ! command -v cloudflared &>/dev/null; then
  echo "請先安裝 cloudflared: brew install cloudflared"
  exit 1
fi

# 1. 登入 (若尚未)
if [ ! -f ~/.cloudflared/cert.pem ]; then
  echo "步驟 1: 請在瀏覽器中登入 Cloudflare..."
  echo "執行中..."
  cloudflared tunnel login
  echo ""
fi

# 2. 建立 tunnel
echo "步驟 2: 建立 tunnel..."
TUNNEL_NAME="whatsapp-gateway-$(hostname -s)"
echo "Tunnel 名稱: $TUNNEL_NAME"

# 檢查 tunnel 是否已存在
if cloudflared tunnel list 2>/dev/null | grep -q "$TUNNEL_NAME"; then
  echo "Tunnel 已存在，使用現有的"
else
  cloudflared tunnel create "$TUNNEL_NAME"
  echo "Tunnel 已建立"
fi

# 3. 取得 tunnel ID
TUNNEL_ID=$(cloudflared tunnel list 2>/dev/null | grep "$TUNNEL_NAME" | awk '{print $1}')
echo "Tunnel ID: $TUNNEL_ID"

# 4. 建立 config.yml
CONFIG_DIR="$HOME/.cloudflared"
mkdir -p "$CONFIG_DIR"

cat > "$CONFIG_DIR/config.yml" <<YAML
tunnel: $TUNNEL_ID
credentials-file: $HOME/.cloudflared/${TUNNEL_ID}.json

ingress:
  - hostname: CHANGE-ME.yourdomain.com
    service: http://localhost:3090

  - service: http_status:404
YAML

echo ""
echo "步驟 3: 請編輯 $CONFIG_DIR/config.yml"
echo "  把 'CHANGE-ME.yourdomain.com' 換成你的實際網域，例如 gw.crm.com"
echo ""
echo "步驟 4: 在 Cloudflare DNS 中新增一筆 CNAME 記錄："
echo "  CNAME  gw  →  ${TUNNEL_ID}.cfargotunnel.com"
echo ""
echo "步驟 5: 啟動 tunnel"
echo "  cloudflared tunnel run $TUNNEL_NAME"
echo ""
echo "============ 完成 ============"
