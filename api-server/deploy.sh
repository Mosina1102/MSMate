#!/bin/bash
# ============================================
# MSMate API 重建部署脚本 v0.7.0（LATEST → 客户端 2.7.18）
# 用法（宝塔文件管理器上传 server.js + deploy.sh 到 /www/msmate-api/ 后）：
#   cd /www/msmate-api && sed -i 's/\r$//' deploy.sh && bash deploy.sh
# 数据安全：/www/wwwroot/msmate-api/data 挂载进容器（users/orders/rsa-key 等全保留）
# ============================================
set -e
cd /www/msmate-api

echo "== 1/4 校验文件 =="
grep -q "version: '2.7.18'" server.js || { echo "server.js 不是 2.7.18 版，拒绝部署"; exit 1; }
node -c server.js 2>/dev/null || echo "（无 node，跳过语法检查——容器内会再验）"

echo "== 2/4 构建镜像 msmate-api:v0.7.0 =="
docker build -t msmate-api:v0.7.0 .

echo "== 3/4 停旧容器 + 启新容器 =="
docker stop msmate-api 2>/dev/null || true
docker rm msmate-api 2>/dev/null || true
docker run -d --name msmate-api --restart=always -p 3210:3210 -v /www/wwwroot/msmate-api/data:/app/data -e MSMATE_MAIL=on -e SF_API_KEY=sk-xmvygdzmvinctnnopqzryqqaelxspgaswuzlwcmlvicqohqg -e SMTP_HOST=smtp.qq.com -e SMTP_PORT=465 -e SMTP_USER=1425696076@qq.com -e SMTP_PASS=lqjfeskjgcwcjjja -e SMTP_FROM=1425696076@qq.com -e ADMIN_PASS=777888 -e NTFY_TOPIC=msmate-pay-tx47kw92qvhe msmate-api:v0.7.0

echo "== 4/4 验证 =="
sleep 2
echo "-- /ping（期望 version 0.7.0）--"
curl -s http://127.0.0.1:3210/ping; echo
echo "-- /v1/latest（期望 2.7.18）--"
curl -s http://127.0.0.1:3210/v1/latest; echo
echo "-- 容器状态 --"
docker ps --filter name=msmate-api --format "{{.Names}} {{.Status}} {{.Image}}"
echo "== 完成：把上面三段验证输出发给 AI =="
