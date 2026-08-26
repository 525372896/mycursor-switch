# MyCursor 换号助手

给终端用户的极简 Cursor 换号客户端（Windows / macOS）。只有两个功能：

1. **添加账号**：粘贴 Cursor 会话 token（`user_xxx::eyJ…` 或整段 `WorkosCursorSessionToken=…` cookie），本地校验并保存。
2. **换号登录 Cursor**：点「换到它」——先做登录握手，关掉 Cursor，写入登录信息，自动重启 Cursor。

账号全部存在**本机**（用户数据目录的 `accounts.json`），不联网上传、不依赖任何服务器。

> 换号原理和 CursorManager 的一致：深链握手（`loginDeepCallbackControl` + `api2.cursor.sh/auth/poll`）→ 写 `state.vscdb` 的 `cursorAuth/*` → 重启 Cursor。握手这步必须做，否则换完聊天会报 `Authentication error`。

---

## 一、本地跑（开发/自测）

```bash
npm install
npm start
```

Windows 上 `npm install` 会自动为 Electron 重建原生模块 `better-sqlite3`。

## 二、本地打包（出当前系统的安装包）

```bash
npm run pack     # 产物在 dist/：Windows 出 MyCursorSwitch-win.exe；macOS 出 MyCursorSwitch-mac.dmg
```

> 在 Windows 上只能打 Windows 包，macOS 包必须在 macOS 或 CI 上打（见下）。

## 三、用 GitHub Actions 自动出 Win + Mac 包并发布（推荐）

1. 在 GitHub 建一个仓库（例如 `你的用户名/mycursor-switch`），把本目录整个推上去：
   ```bash
   git init
   git add .
   git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/你的用户名/mycursor-switch.git
   git push -u origin main
   ```
2. 打一个版本 tag 并推送 —— 会自动触发构建：
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
3. 等 Actions 跑完（约 5–10 分钟），会自动创建一个 **Release** 并上传两个安装包：
   - `MyCursorSwitch-win.exe`（Windows 安装器）
   - `MyCursorSwitch-mac.dmg`（macOS，通用包，Intel/Apple Silicon 都能装）

   > `GITHUB_TOKEN` 是 Actions 自带的，无需你配置任何密钥。

4. 稳定下载链接（`OWNER/REPO` 换成你的仓库）——始终指向最新版本：
   - Windows：`https://github.com/OWNER/REPO/releases/latest/download/MyCursorSwitch-win.exe`
   - macOS：`https://github.com/OWNER/REPO/releases/latest/download/MyCursorSwitch-mac.dmg`

   把这两个链接发我，我就把「工具下载」区接进你的查码小站。

## 四、关于签名（首次打开的提示）

未做代码签名，所以：
- Windows：SmartScreen 可能提示「未知发布者」，点「更多信息 → 仍要运行」。
- macOS：Gatekeeper 会拦，右键 App →「打开」，或系统设置→隐私与安全性里「仍要打开」。

（和你参考的 fly-cursor-free 一样，属正常现象。要去掉提示需要买开发者证书做签名，后面需要可以再加。）

---

## 目录结构

```
src/
  main.js        Electron 主进程 + IPC
  preload.js     安全桥接（contextIsolation）
  cursor.js      核心：握手 / 写 state.vscdb / 关开 Cursor（分 Win/Mac 路径）
  store.js       本地账号存储（accounts.json）
  renderer/      界面（原生 HTML/CSS/JS，无需构建）
.github/workflows/build.yml   打 tag 自动构建并发布
```
