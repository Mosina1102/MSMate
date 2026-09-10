# MSMate 项目说明（全面摸底文档）

> 生成时间：2026-09-10 ｜ 基于源码实读 + 项目记忆整理
> 包名 `ms-interconnect`，当前版本 **v2.7.14**，Electron 22（Chromium 108 / Node 16 运行时），Windows 桌面应用

## 一、项目定位

MSMate = **局域网/互联网文件互传 + 内置 AI 电脑助手** 一体的桌面应用。

- **互联**：局域网设备发现与文件互传（双面板文件管理器）、配对/好友体系、互联网模式（中转桥接）、IPv6 直连、对讲机（PTT）
- **Work**：AI 助手（多会话、工具调用、深度思考、生图/看图）、工作台（文件/网页页签）、Word/Excel 所见即所得编辑、Office 生成引擎
- **账号体系**：邮箱注册登录、积分/充值/签到、云同步、自动更新

## 二、目录结构总览

```
f:\局域网互传2.6\
├── main.js            主进程入口（3032 行）
├── preload.js         渲染层 API 桥（339 行，asarUnpack）
├── server/            主进程内嵌网络服务模块（7 个文件）
├── ai/                AI 引擎（主进程侧，10 个文件）
├── src/               渲染层（index.html + js/ 8 文件 + styles/）
├── api-server/        云服务端（零依赖 Node http + Dockerfile）
├── relay/             互联网中转服务器（TLS 桥接撮合）
├── tools/             发版脚本 release.ps1 等
├── test/              冒烟/探针/E2E 测试（60+ 脚本）
├── assets/            图标、安装器资源、logo
├── release_build_v2*  各版本打包产物目录
├── NOTES.md           任务状态/发版日志（持续追加）
└── PROJECT.md         本文档
```

## 三、主进程（main.js，3032 行）

| 区块 | 大致位置 | 职责 |
|---|---|---|
| 窗口创建 | L142-170 | 主窗口、contextIsolation、webviewTag |
| 托盘 | L252-304 | 关闭最小化到托盘、托盘菜单 |
| 互联网限额 | L306-344 | 每日 2GB 传输计数与持久化（netQuotaHooks） |
| 服务初始化 | L346-439 | AuthManager / TCPAgent / WorkAgent / SessionStore / UDPDiscovery |
| 事件转发中枢 | L466-590 | TCP/UDP 事件 → `webContents.send` 推给渲染层 |
| IPC 集中区 | L805 起 | 120+ 个 ipcMain.handle/on |

**IPC channel 分组**（代表性）：
- 配对/设备：`app:get-pair-code`、`app:accept-pair`、`app:verify-pair-code`、`device:refresh`、`device:set-name`、`device:set-remark`
- 连接：`connection:connect`、`connection:connect-by-ip`、`connection:disconnect`、`connection:get-connected`
- 好友：`friends:get` / `friends:add` / `friends:remove`（好友制远程连接）
- 中转：`relay:get-state`、`relay:save`、`relay:connect`、`relay:reset-pin`
- IPv6：`ipv6:get-invite`、`ipv6:connect-invite`、`ipv6:connect-peer`、`ipv6:get-peers`
- 文件：`file:list-local/remote`、`file:upload/download`、`file:*-folder`、`file:batch-*`、`file:delete/rename/move-remote(-local)`、`file:watch-dir`
- 工作台/文档：`wb:get/set`、`fs:render-office`、`fs:xlsx-*`、`fs:word-rich-save`、`docx:embed*`（WPS/Word 窗口嵌入）
- 账号/积分：`auth:*`（register/login/me/logout/profile/send-code/reset/avatar）、`credits:*`（order-create/order-voucher/orders-my/order-cancel/balance/signin）
- 同步/其他：`sync:run-now`、`settings:get/set`、`history:get/clear`、`ptt:*`（对讲机）、`ai:send`、`ai:export/import-data`、`dialog:*`、`shell:*`

**preload.js**：把上述 IPC 封装成 `window._api.*` 桥暴露给渲染层（配对、连接、文件传输、目录列表、远程文件操作、AI、积分等）。

## 四、server/ 目录（主进程网络模块）

| 文件 | 行数 | 职责与关键点 |
|---|---|---|
| tcpAgent.js | 1741 | 传输核心。TCP 端口 `45679`（MSC_TCP_PORT）；文件/文件夹传输协议、断点、批量、远程文件操作、限速、每日 2GB 限额挂钩 |
| udpDiscovery.js | 210 | 局域网发现。UDP `45678` 广播，3 秒/次，设备 15 秒超时 |
| ipv6Invite.js | 80 | 收集本机全局 IPv6（2xxx/3xxx 段）、生成/解析邀请串；hello 消息带 ipv6 字段，对 1.0 向后兼容 |
| netRelay.js | 265 | 互联网模式客户端：TLS 外连中转服务器注册在线、拉设备列表、桥接撮合（主动/被动），产出可注入 tcpAgent 的原始双端流。ping 15s、重连 2s→30s、桥接超时 10s |
| authManager.js | 91 | 设备信任列表（trust-list.json）、本机 deviceId、配对码生命周期 |
| diskSpace.js | 30 | 磁盘空间查询，不支持 statfsSync 时用 wmic 降级 |
| hotkeyListener.js | 120 | PTT 全局热键：PowerShell 轮询 GetAsyncKeyState（Win7 兼容、零依赖），上报 DOWN/UP |

## 五、渲染层（src/）

**script 加载顺序**（index.html 尾部，非 ES module，靠全局词法环境共享）：

```
icons.js → webchat.js → app.js → word-embed.js → word-rich.js → work.js → auth.js → credits.js
```

| 文件 | 行数 | 职责 |
|---|---|---|
| icons.js | 95 | Lucide 内联 SVG 图标库（`iconSvg()`），所有图标赋值必须 `innerHTML` |
| webchat.js | 725 | 网页聊天/浏览器页签相关 |
| app.js | 838 | 互传核心：全局状态（本地/远程目录、设备、传输、互联网模式、IPv6、好友）、启动流程、事件绑定 |
| word-embed.js | 525 | WPS/Word 内嵌 + 工作台通用网页页签、页签管理 |
| word-rich.js | 4330 | Word 所见即所得引擎（contentEditable，与 office.js 配合读写 docx/xlsx） |
| work.js | 3133 | Work AI 助手：多会话、AI 设置、消息渲染、markdown、生成模式、工具调用 UI、积分展示 |
| auth.js | 399 | 邮箱注册/登录/重置/头像（走 preload 的 auth:* 桥） |
| credits.js | 275 | 积分、充值订单（固定档位）、签到、余额展示 |

**布局骨架**（index.html）：左侧栏（互联/Work 模式切换、设备发现、桥接、互联网模式、IPv6、传输中心）→ 中部双面板（我的电脑 / 远程设备文件列表）→ Work 模式下右侧工作台（页签、预览/编辑、资源面板）。

**主题体系**：三主题（执事风-默认 / 经典白 / 深色）共用布局，靠 CSS token 覆盖实现（main.css `:root` → `theme-light` → `theme-light.theme-butler`）。index.html 头部脚本预读 `msmate_theme` 防闪烁。硬约束：UI 文案零 emoji、主操作按钮品牌紫、绿色仅限"成功/在线"语义、Electron 22 不支持 `color-mix`。

## 六、AI 引擎（ai/，主进程侧）

| 文件 | 行数 | 职责 |
|---|---|---|
| tools.js | 3059 | AI 工具层：本地/远程文件操作封装为工具，文本协议 ` ```tool {...}``` `；改动型操作返回 undo 记录；生图/看图模型路由（内置主模型→内置代理扣积分，自定义配置→用户服务商） |
| agent.js | 1676 | 会话循环 + 工具调用调度 + 审批控制 + 检查点回滚；积分信息随回复入史 |
| office.js | 2923 | Office 引擎 v2：docx（标题/图片/页眉页脚/目录）+ exceljs（多 sheet/公式/样式） |
| prompt.js | 301 | 系统提示词唯一维护入口（P0 铁律 / P1 操作规范 分区），默认人设 v0.4 |
| siliconflow.js | 87 | 硅基流动 API 客户端（OpenAI 兼容 SSE 流式，http/https 模块实现）；注意 `[DONE]` 后扣费帧不能丢 |
| sessions.js | 98 | 会话存储：`sessions/<id>/mswork_chat.json` + 索引 |
| snapshots.js | 168 | 快照缓存槽：删除/覆盖/移动前自动备份，一键还原 |
| data-sync.js | 81 | 跨设备数据迁移（settings + 会话 + 工作台），导入前自动备份 |
| anticrawl.js | 172 | 反反爬：UA 池轮换 + 特征识别 + 无头渲染兜底 |
| winembed.js | 297 | Win32 文档窗口嵌入（SetParent 进工作台，PowerShell 常驻帮手，stdin 行协议） |

## 七、服务端

### api-server/server.js（1394 行，v0.5.0，零依赖 Node http）

部署：腾讯云 `101.43.150.46:3210`，Docker（node:20-alpine，`--restart=always`），数据目录 `/www/wwwroot/msmate-api/data`，代码目录 `/www/msmate-api`。域名 `api.mosina.top` 备案中被腾讯云 DPI 拦截，客户端 `AUTH_API_BASE` 暂用纯 IP。

**路由表**：

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /ping | 健康检查 |
| GET | /v1/latest | 客户端检查更新 |
| GET | /v1/myip | 调用者公网 IP |
| POST | /v1/auth/send-code | 邮箱验证码（register/reset） |
| POST | /v1/auth/register | 邮箱注册（须勾选协议 agree:'v1'） |
| POST | /v1/auth/login | 邮箱登录 → {token,user} |
| POST | /v1/auth/reset | 验证码重置密码 |
| GET | /v1/auth/me | Bearer token 查当前用户 |
| PATCH | /v1/auth/profile | 改昵称 |
| POST | /v1/auth/avatar | 上传头像（≤200KB base64，保存前归一化路径） |
| GET | /avatars/* | 头像静态服务 |
| GET/PUT | /v1/sync | 云同步 blob（≤5MB） |
| POST | /v1/credits/orders | 创建充值订单（固定档位 ¥1/3/6/30/68/128） |
| POST | /v1/credits/orders/:id/voucher | 提交付款凭证（ntfy 推送通知管理员） |
| POST | /v1/credits/orders/:id/cancel | 取消订单（仅待支付/审核中） |
| GET | /v1/credits/orders/my | 我的订单 |
| GET | /v1/credits/balance | 积分余额 |
| POST | /v1/credits/signin | 签到（50 积分/日，累计上限 200） |
| POST/GET | /v1/presence | 设备 presence 心跳/列表 |
| GET | /v1/ai/models | 内置模型清单 |
| * | /v1/ai/openai/* | AI 代理（SSE 逐行转发，扣费帧在 `[DONE]` 前；先鉴权再查 aiProxyEntry） |
| GET | /admin | 批款后台网页（手机可用） |
| POST | /admin/api/login | 后台登录（ADMIN_PASS 或 data/admin.key） |
| GET | /admin/api/orders | 订单列表 |
| POST | /admin/api/orders/:id/approve\|reject | 批款 |

**关键机制**：
- 环境变量：`PORT`、`DATA_DIR`、`MSMATE_MAIL`（=on 才发真邮件）、`SMTP_HOST/PORT/USER/PASS/FROM`、`SF_API_KEY`（硅基流动 Key，只在服务端）、`NTFY_TOPIC`、`ADMIN_PASS`
- 防刷单三层防线：①有 1 笔未提交凭证订单不能开新单 ②待完成订单（未付+审核中）最多 5 笔 ③凭证号全局唯一（含已取消）
- 限流：普通 IP 限流、验证码发送限流、邮箱冷却、IP 小时上限
- Token 30 天、验证码 5 分钟、后台会话 1 小时
- 邮件：QQ 家族 `smtp.qq.com:465` + 授权码，验证码邮件为 multipart/alternative 品牌 HTML 模板
- 错误体兼容 OpenAI/代理/简单三种格式，不向客户端透出原始 JSON 错误

### relay/server.js（204 行，互联网中转）

TLS 桥接撮合服务器，默认端口 `9769`（RELAY_PORT）。只搬字节不解析业务。协议（JSON+\n 分帧）：`reg-host` 注册在线 → `bridge` 请求桥接 → `bridge-id`/`bridge-offer` 撮合 → `pipe` 管道首行后变纯字节转发。控制连接心跳 35 秒超时，证书由 openssl 自签生成于 `relay/certs/`。

## 八、测试与发布

- **test/**（60+ 脚本）分类：
  - 冒烟类：workbench-smoke（1066 断言，读渲染层用四文件拼接 `app.js+word-embed.js+word-rich.js+work.js`）、global-ui-smoke、md-render、transfer、pair、data-sync、history-persist 等
  - API 测试：api-v03-test、api-v04-ai-test、api-v05-sse-order-test（SSE 扣费帧顺序）
  - E2E：auth-e2e-cdp 等 CDP 真机测试（启动须加 `--dev` 参数避免走打包分支）
  - 探针类：probe-asar-v*.js（Electron 22 兼容性探针，新 npm 包必过）、office/docx 系列探针
- **tools/release.ps1**：一键发版——读 package.json 版本 → 自动对齐产物目录 release_build_vX → `npm run build`（electron-builder NSIS）→ GitHub Release（Mosina1102/MSMate，同 tag 幂等，UTF-8 中文说明）。token 读 `%APPDATA%\MSMate\release-token.txt`；发布后提醒 revoke token
- 真机测试纪律：`MSC_USER_DATA` 环境变量隔离 userData，避免与在用实例抢锁
- 服务端发版纪律：改 server.js 必须 `docker build` 重建镜像（run 只是重建容器），容器重建 = stop+rm+run，环境变量变更必须重建

## 九、部署架构（2026-09 现状）

| 节点 | 地址 | 说明 |
|---|---|---|
| 腾讯云练手机 | 101.43.150.46（CentOS 8，4核7G，宝塔） | msmate-api Docker 容器（端口 3210），另有 8 个网站勿动 |
| 老大域名 | mosina.top（阿里云） | `api.mosina.top` → 腾讯云；**备案未过，非 80/443 也被 DPI 拦截，暂用纯 IP** |
| 公司生产机 | 182.106.136.8:18432（80核62G，CentOS 7） | 老板要求先学 Docker，禁直接操作 |
| 中转服务器 | relay/server.js（默认 9769） | 互联网模式桥接撮合 |

## 十、工程红线（易踩坑速查）

1. SVG 图标一律 `innerHTML` 赋值，`textContent` 会显示乱码源码（事故×2）
2. server.js 内嵌 HTML 的 JS：避免内联 onclick 引号嵌套（用 data-* + 事件委托），交付前 `node --check` 验证
3. PowerShell 行数统计忽略空行，行号切割以 node `split('\n')` 为准
4. 客户端 SSE 遇 `[DONE]` 直接 return 会丢扣费帧
5. 复制粘贴终端命令易混入不可见脏字符，多行命令给单行版
6. Electron 22 = Chromium 108：无 `color-mix`、无全局 fetch（Node 16）
7. 积分计算：上游成本 ×100 ×1.5 毛利取整；¥1=100 积分
8. 生图/改图 45 积分/张，PaddleOCR-VL 1 积分/次仅视觉、语音识别免费
9. 模型分区显示：内置（扣积分）/ 我的模型（免费）
10. 服务端 SSE 逐行转发，扣费帧必须在 `[DONE]` 之前
