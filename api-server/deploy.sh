#!/bin/bash
# ============================================
# MSMate API 重建部署脚本（版本动态校验，发版无需改本脚本）
# 用法（宝塔文件管理器上传 server.js + deploy.sh 到 /www/msmate-api/ 后）：
#   cd /www/msmate-api && sed -i 's/\r$//' deploy.sh && bash deploy.sh
# 数据安全：/www/wwwroot/msmate-api/data 挂载进容器（users/orders/rsa-key 等全保留）
# ============================================
set -e
cd /www/msmate-api

echo "== 1/4 校验文件（动态版本，防传错文件但不锁版本号）=="
CLIV=$(grep -oE "version: '2\.[0-9]+\.[0-9]+'" server.js | head -1 | grep -oE "2\.[0-9]+\.[0-9]+")
SVCI=$(grep -oE "version: '0\.[0-9]+\.[0-9]+'" server.js | head -1 | grep -oE "0\.[0-9]+\.[0-9]+")
if [ -z "$CLIV" ] || [ -z "$SVCI" ]; then
  echo "server.js 里提取不到版本号（应有 LATEST 2.x.x 和 /ping 0.x.x），文件可能传错或损坏，拒绝部署"
  exit 1
fi
echo "server.js 校验通过：服务端 v$SVCI / 客户端 LATEST $CLIV"
IMG="msmate-api:v$SVCI"

echo "== 2/4 构建镜像 $IMG =="
docker build -t "$IMG" .

echo "== 3/4 停旧容器 + 启新容器 =="
docker stop msmate-api 2>/dev/null || true
docker rm msmate-api 2>/dev/null || true
docker run -d --name msmate-api --restart=always -p 3210:3210 -v /www/wwwroot/msmate-api/data:/app/data -e MSMATE_MAIL=on -e SF_API_KEY=sk-xmvygdzmvinctnnopqzryqqaelxspgaswuzlwcmlvicqohqg -e SMTP_HOST=smtp.qq.com -e SMTP_PORT=465 -e SMTP_USER=1425696076@qq.com -e SMTP_PASS=lqjfeskjgcwcjjja -e SMTP_FROM=1425696076@qq.com -e ADMIN_PASS=777888 -e NTFY_TOPIC=msmate-pay-tx47kw92qvhe "$IMG"

echo "== 4/4 验证 =="
sleep 2
echo "-- /ping（期望 version $SVCI）--"
curl -s http://127.0.0.1:3210/ping; echo
echo "-- /v1/latest（期望 $CLIV）--"
curl -s http://127.0.0.1:3210/v1/latest; echo
echo "-- 容器状态 --"
docker ps --filter name=msmate-api --format "{{.Names}} {{.Status}} {{.Image}}"
echo "== 完成：把上面三段验证输出发给 AI =="
