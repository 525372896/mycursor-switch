# mycursor-switch Token 泄露审计

> 审计对象：`mycursor-switch/src/*`（Electron 主进程 + preload + 渲染进程 + 补丁引擎）
> 结论：**账号 token 只会发给 Cursor 官方域名（`cursor.com` / `api2.cursor.sh`），不发给任何第三方、也不发给本项目作者的任何服务器；token 全程只存在本机 `accounts.json`，不进日志、不进补丁、不上传。**

## 1. 全部出网端点（唯一来源 `src/cursor.js`）

`rg 'https?://'` 在整个 `src` 里只有三个主机：

| 主机 | 用途 | 带 token 吗 |
|---|---|---|
| `cursor.com` | `/api/auth/me`、`/api/usage-summary`、`/api/dashboard/*`、`/api/auth/loginDeepCallbackControl`；额度页 webview 打开 `cursor.com/dashboard/usage`、`/spending` | 是（官方，必需） |
| `api2.cursor.sh` | `/auth/poll`（换号深链握手取回桌面 access/refresh） | 是（官方，必需） |
| `github.com` | 仅 `shell.openExternal(GITHUB_URL)` 打开项目主页 / 发布页（用户点「关于」「检查更新」时） | **否**，只开浏览器，不带任何数据 |

自动更新 `electron-updater` 走的是 GitHub Releases 的 `latest.yml`（`package.json` publish 配置），只下载安装包，不上传任何东西。

**没有** 任何自建后端、统计、遥测、埋点、`WebSocket`、`XMLHttpRequest`、`navigator.sendBeacon`、第三方分析 SDK。`rg 'fetch|XMLHttpRequest|WebSocket|sendBeacon|axios|analytics|telemetry'` 命中的全部是上面这几处官方 fetch。

## 2. token 发给谁、怎么发

`src/cursor.js` 里 token 只出现在两类请求头：

- **Cookie**：`Cookie: WorkosCursorSessionToken=<token>`，只设到 `cursor.com`（`cookieHeader()`）。
- **深链握手 body**：`/loginDeepCallbackControl` 带 cookie；`/auth/poll` body 里是握手的 `uuid`+`verifier`（PKCE），**不含原始 token**。

额度页（`accounts:openUsage`）：把 token 作为 cookie 写进一个**独立内存分区**（`session.fromPartition('uv-<id>-<时间戳>')`），只作用于 `.cursor.com`，每次一个新分区避免多账号串味；webview 只允许停在 `cursor.com/dashboard/usage|spending`。token 不进 URL、不进 localStorage。

## 3. token 存哪、会不会落地到别处

- **存储**：仅 `app.getPath('userData')/accounts.json`（`src/store.js`），纯本地明文 JSON，用户自己电脑上。列表接口 `store.list()` 对外只给 `email + tokenTail(尾 8 位)`，完整 token 只有 `tokenById()`（换号 / 查额度 / 打开额度页时）在主进程内部读取。
- **日志**：主进程 `log()` → 渲染进程「日志」框。审计所有 `log(...)` 调用，**没有任何一处把 token 或完整 access/refresh 打进日志**（只打邮箱、HTTP 状态、成功/失败文案）。渲染进程 `console` 也无 token。
- **补丁**：`sand_patch.js` / `sand_patch_engine.js` 只对 **Cursor 自己的 JS 文件**做字符串改写，全程不接触账号 token，也不联网。备份目录 `sand-patch/backups/*` 存的是 Cursor 原文件，与账号 token 无关。

## 4. 补丁注入进 Cursor 的代码会不会把 token 发给别的端？

补丁往 Cursor renderer 注入的唯一「会碰网络」的片段是**会员伪装** `SAND_MEMBERSHIP_SNIPPET`（`sand_patch.js`）。它 hook 了 `window.fetch`，但行为是：

- 只对**匹配 membership / usage-summary / get-me / AvailableModels 等**的响应，`response.clone().text()` 读出来、本地改字段（membershipType→enterprise、模型 defaultOn→true）、`new Response(...)` 原地返回；
- **不新增任何请求、不改请求目标、不外发任何数据**；其余请求 `return r` 原样放行；全程 try/catch，出错回原响应。

也就是说补丁只是把 Cursor **收到的**响应在本地改一下显示，不会把 token 或任何数据发到 Cursor 官方以外的地方。client-type 从 `ide`/`glass` 改成 `sand` 只改请求头的值，请求仍然发往 Cursor 官方 `api2.cursor.sh`（这正是 GrokBot 模式的原理），不涉及第三方。

## 5. 结论

- ✅ token 只发 Cursor 官方（`cursor.com` / `api2.cursor.sh`），换号 / 查额度 / 额度页三处，全部是登录 Cursor 本来就要走的官方接口。
- ✅ 无自建服务器、无第三方上报、无遥测。
- ✅ token 只存本机 `accounts.json`；日志 / 补丁 / 备份都不含 token。
- ✅ 补丁注入的 fetch hook 只在本地改写官方响应，不外发数据、不改请求去向。
- ✅ 界面对外只显示 token 尾 8 位。

> 唯一「离开本机」的数据就是账号 token 本身发给 **Cursor 官方**用于登录/查额度——这是本工具的功能所必需，且与用户直接用浏览器登录 cursor.com 完全等价。不存在「泄露给其他端」的情况。
