# MSMate API 镜像 —— 5 行，没有更多了
# 构建：docker build -t msmate-api .
# 运行：docker run -d --name msmate-api --restart=always -p 3210:3210 msmate-api
FROM node:20-alpine
WORKDIR /app
COPY server.js .
EXPOSE 3210
CMD ["node", "server.js"]
