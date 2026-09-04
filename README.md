# MyCursor 换号助手

给终端用户的极简 Cursor 换号客户端，**Windows / macOS 双平台**，一套代码、GitHub Actions 自动出两个平台的安装包。

主要功能：

1. **添加账号**：粘贴 Cursor 会话 token（`user_xxx::eyJ…` 或整段 `WorkosCursorSessionToken=…` cookie），本地校验并保存。
2. **换号登录 Cursor**：点「换到它」——先做登录握手，关掉 Cursor，写入登录信息，自动重启 Cursor。
3. **查额度**：列表行懒加载套餐 / 用量百分比；也可用该账号登录态打开官网 Usage / Spending 页（只读）。
4. **本机 Cursor 补丁（Sand 模式）**：一键给本机 Cursor 打 / 卸补丁，自动备份、校验、失败回滚。

账号全部存在**本机**（Electron `userData` 目录下的 `accounts.json`：Windows 在 `%APPDATA%\mycursor-switch\`，macOS 在 `~/Library/Application Support/mycursor-switch/`），不联网上传、不依赖任何服务器。token 只会发给 Cursor 官方域名，详见 [`SECURITY-token审计.md`](./SECURITY-token审计.md)。

> 换号原理和 CursorManager 的一致：深链握手（`loginDeepCallbackControl` + `api2.cursor.sh/auth/poll`）→ 写 `state.vscdb` 的 `cursorAuth/*` → 重启 Cursor。握手这步必须做，否则换完聊天会报 `Authentication error`。

---

## 一、下载安装

发布页：<https://github.com/525372896/mycursor-switch/releases/latest>

| 平台 | 文件 | 说明 |
|---|---|---|
| Windows 10/11（x64） | `MyCursorSwitch-win.exe` | NSIS 安装器，可选安装目录；装完自带自动更新 |
| macOS · Apple 芯片（M1/M2/M3/M4） | `MyCursorSwitch-mac-arm64.dmg` | 打开 dmg 把 App 拖进「应用程序」 |
| macOS · Intel 芯片 | `MyCursorSwitch-mac-x64.dmg` | 同上；点错芯片也能装（Rosetta），但原生包更快 |
| macOS 打不开时的一键修复 | `fix-macos.command` | 见下文「三、macOS 打不开怎么办」 |

**永远指向最新版**的直链（给网站下载按钮用，发新版不用改）：

- Windows：`https://github.com/525372896/mycursor-switch/releases/latest/download/MyCursorSwitch-win.exe`
- macOS（Apple 芯片）：`https://github.com/525372896/mycursor-switch/releases/latest/download/MyCursorSwitch-mac-arm64.dmg`
- macOS（Intel）：`https://github.com/525372896/mycursor-switch/releases/latest/download/MyCursorSwitch-mac-x64.dmg`
- macOS 修复脚本：`https://github.com/525372896/mycursor-switch/releases/latest/download/fix-macos.command`

不知道自己 Mac 是哪种芯片：点左上角  → 「关于本机」，「芯片」一行写 Apple M 系列就下 arm64，写 Intel 就下 x64。

## 二、Windows 首次打开提示「未知发布者」

安装包没有买微软代码签名证书，SmartScreen 会拦一次：点 **「更多信息」→「仍要运行」** 即可。之后的版本通过程序内自动更新安装，不会再弹。

## 三、macOS 打不开怎么办（「已损坏」/「无法验证开发者」/「已阻止以防恶意软件并移到废纸篓」）

### 这是怎么回事

macOS 版**没有做 Apple 付费签名和公证**（Apple Developer 账号 99 美元/年），所以浏览器下载下来的 App 带着「隔离标记」，首次打开时 Gatekeeper 会拦。按系统版本不同，你可能看到这几种提示，**都不是软件有病毒**，处理方法见下：

| 你看到的提示 | 通常出现在 | 推荐处理 |
|---|---|---|
| 「无法打开“MyCursorSwitch”，因为 Apple 无法验证其是否包含恶意软件 / 无法验证开发者」 | macOS 13–15 | 方法一（系统设置里点「仍要打开」） |
| 「“MyCursorSwitch”已损坏，无法打开。您应该将它移到废纸篓。」 | 老版本安装包 | 方法二（`xattr` 一条命令）或方法三（一键脚本） |
| 「已阻止以防恶意软件并已移到废纸篓」/ App 一打开就消失、被自动丢进废纸篓 | macOS 15 Sequoia 及更新 | 方法四（开发者工具法），或先做方法二的「给 dmg 去隔离」再重装 |

> 从 v1.0.14 起，CI 出的 macOS 包会做一次完整的 **ad-hoc 签名**，所以大多数人只会看到第一种提示，直接走方法一就行。另外 **macOS 15 起「右键 → 打开」的老办法已经失效**，不用再试了。

### 方法一：系统设置里点「仍要打开」（最正规，不用开终端）

1. 双击 App，弹窗里点 **「完成」**（千万别点「移到废纸篓」）。
2. 打开 **系统设置 → 隐私与安全性**，往下拉到「安全性」一栏，会看到「已阻止使用“MyCursorSwitch”……」，点旁边的 **「仍要打开」**。
3. 输入一次开机密码，再弹窗时点 **「打开」**。以后双击直接开。

「仍要打开」按钮只在你刚被拦过之后的一段时间内出现；没看到就回到第 1 步再双击一次 App。

### 方法二：终端一条命令去掉隔离标记（最稳、最快）

打开「终端」（启动台搜 Terminal），把下面这行粘进去回车（可能要输一次开机密码）：

```bash
xattr -cr /Applications/MyCursorSwitch.app
```

然后正常双击打开即可。如果 App 还没装、或 **一下载就被系统删掉**，先给 dmg 去隔离再装（`arm64` / `x64` 按你下载的文件名改）：

```bash
xattr -cr ~/Downloads/MyCursorSwitch-mac-arm64.dmg
```

### 方法三：一键修复脚本 `fix-macos.command`

发布页附带了 [`fix-macos.command`](https://github.com/525372896/mycursor-switch/releases/latest/download/fix-macos.command)，效果等于方法二 + ad-hoc 重签名：

1. 先把 App 装进「应用程序」。
2. 下载 `fix-macos.command`，**右键它 → 「打开」**（它自己第一次也可能被拦：系统设置 → 隐私与安全性 → 底部「仍要打开」；或在终端里 `chmod +x ~/Downloads/fix-macos.command && ~/Downloads/fix-macos.command`）。
3. 看到 **✅ 修复完成** 后去「应用程序」双击 MyCursorSwitch。

### 方法四：开发者工具法（专治「已阻止以防恶意软件并移到废纸篓」）

macOS 15 Sequoia 起对未签名软件更狠，可能直接把 App **自动移到废纸篓**。这时用「开发者工具」白名单绕开系统安全策略（星露谷 mod 圈流传的同一招）：

1. 打开「终端」，粘贴运行（如果提示没权限，前面加 `sudo `）：
   ```bash
   spctl developer-mode enable-terminal
   ```
2. 打开 **系统设置 → 隐私与安全性**，列表里会多出一项 **「开发者工具」（Developer Tools）**，点进去把 **「终端」右边的开关打开**（没看到这一项就完全退出系统设置再打开一次）。
   这一项的说明是「允许下列应用在本地运行不符合系统安全策略的软件」——意思就是：从终端里启动的程序不再被拦。
3. 打开「废纸篓」，找到被丢进去的 `MyCursorSwitch.app`，**右键 → 「放回原处」**（放回「应用程序」）。如果已经被彻底删了，就到发布页重新下载安装一次。
4. **重启电脑**（至少要完全退出并重开终端）。
5. 在终端里启动一次 App：
   ```bash
   open -a MyCursorSwitch
   ```
   这次能正常打开。之后一般直接双击就行；若又被拦，再从终端 `open -a MyCursorSwitch` 一次，或补做方法二。

### 方法五（不推荐）：允许「任何来源」

```bash
sudo spctl --master-disable
```

运行后到 系统设置 → 隐私与安全性 → 「允许以下来源的应用程序」选 **「任何来源」**。这会放开全系统的 Gatekeeper，安全性下降；而且 macOS 15 起 Apple 对这条命令做了限制，可能要在系统设置里再确认一次、或者根本不出现该选项。只当前几种都不行时再试。

### 其它 macOS 常见问题

- **打补丁提示没权限（EPERM / EACCES）**：补丁要改 `/Applications/Cursor.app` 里的文件。把 Cursor 完全退出后再点「打补丁」；仍不行就把 Cursor.app 挪到 `~/Applications/` 再试。打完补丁本工具会自动给 Cursor.app 做 `xattr -cr` + ad-hoc 重签名，否则系统会因为签名失效拒绝启动 Cursor。
- **换号后 Cursor 没自动起来**：日志里会提示「没能自动拉起」，手动从「应用程序」打开 Cursor 一次即可，登录态已经写好。
- **有新版本但不会自动装**：macOS 自动安装更新需要 Apple 签名，所以 Mac 上只会弹「去下载」，到发布页下新 dmg 覆盖安装即可（Windows 是后台下载 + 一键重启安装）。

### 一劳永逸（面向分发者）

给最终用户零门槛「双击即开」，唯一根治办法是 **Apple Developer 账号签名 + 公证（notarize）**。配好 `CSC_LINK` / `CSC_KEY_PASSWORD` / Apple ID 相关 secrets 后，electron-builder 会自动签名公证；`build/afterPack.js` 检测到有真证书会自动跳过 ad-hoc 签名。

---

## 四、本地跑（开发/自测）

```bash
npm install
npm start
```

`npm install` 会自动为 Electron 重建原生模块 `better-sqlite3`（Windows / macOS 都是）。

## 五、本地打包（出当前系统的安装包）

```bash
npm run pack     # 产物在 dist/：Windows 出 MyCursorSwitch-win.exe；macOS 出 MyCursorSwitch-mac-arm64.dmg + MyCursorSwitch-mac-x64.dmg
```

> 在 Windows 上只能打 Windows 包，macOS 包必须在 macOS 或 CI 上打（见下）。

## 六、发布新版本（一键脚本，推荐）

Windows 上**双击 [`发布新版本.bat`](./发布新版本.bat)**（内部调用 `release.ps1`），它会：

1. 读出 `package.json` 当前版本，提示输入新版本号（直接回车 = 补丁号 +1）；
2. 改写 `package.json` 的 `version` → `git add -A` → `git commit -m "release vX.Y.Z"` → `git tag vX.Y.Z`；
3. 推送 `main` 和 tag（自动带上 Windows 系统代理，失败自动重试 6 次）；
4. tag 推上去后 GitHub Actions（[`.github/workflows/build.yml`](./.github/workflows/build.yml)）在 `windows-latest` + `macos-latest` 两台机器并行构建，约 5–10 分钟后自动创建 **Release** 并上传：
   - `MyCursorSwitch-win.exe`（+ `latest.yml`，Windows 自动更新用）
   - `MyCursorSwitch-mac-arm64.dmg`、`MyCursorSwitch-mac-x64.dmg`（+ `latest-mac.yml`）
   - `fix-macos.command`、`README-macos.md`（macOS 修复脚本和说明）

构建进度看 <https://github.com/525372896/mycursor-switch/actions>。`GITHUB_TOKEN` 是 Actions 自带的，无需配置任何密钥。

**推送中途断网怎么办**：等网络恢复后再双击脚本、输入**同一个版本号**，脚本检测到本地已有该 tag 会跳过改版本/提交，直接断点补推。

不用脚本、手动发布等价于：

```bash
# 改 package.json 的 version 后
git add -A && git commit -m "release v1.0.14"
git tag v1.0.14
git push origin main && git push origin v1.0.14
```

也可以在 Actions 页手动触发 `build`（workflow_dispatch）做一次**只构建不发布**的试跑，产物在该次运行的 Artifacts 里。

---

## 七、Windows / macOS 适配说明

同一套源码，靠 `process.platform` 分支适配两个平台，改代码时注意保持两边都有实现：

| 事项 | Windows | macOS |
|---|---|---|
| Cursor 登录库 `state.vscdb` | `%APPDATA%\Cursor\User\globalStorage\` | `~/Library/Application Support/Cursor/User/globalStorage/` |
| Cursor 用户设置 `settings.json` | `%APPDATA%\Cursor\User\` | `~/Library/Application Support/Cursor/User/` |
| Cursor 安装目录（打补丁的目标） | `%LOCALAPPDATA%\Programs\cursor\resources\app`（也查注册表 / 运行中进程 / 自定义路径） | `/Applications/Cursor.app/Contents/Resources/app`（也查 `~/Applications`） |
| 关闭 Cursor | `taskkill /F /IM Cursor.exe` | `osascript` 让 Cursor 正常退出，600ms 后 `pkill -x Cursor` 兜底 |
| 启动 Cursor | `shell.openPath(Cursor.exe)`（不弹黑窗） | `open -a Cursor.app` |
| 打补丁后收尾 | 无 | `xattr -cr` + `codesign --force --deep --sign -` 重签 Cursor.app，否则签名失效无法启动 |
| 本工具自动更新 | 后台下载 → 一键重启安装 | 只提示「去下载」（自动安装需 Apple 签名） |
| 安装包 | NSIS `.exe`（x64） | `.dmg` × 2（arm64 / x64），CI 里 `build/afterPack.js` 做 ad-hoc 签名 |
| 首次打开拦截 | SmartScreen「仍要运行」 | Gatekeeper，见「三」 |
| 本工具数据目录 | `%APPDATA%\mycursor-switch\` | `~/Library/Application Support/mycursor-switch/` |

---

## 目录结构

```
src/
  main.js               Electron 主进程 + IPC（换号 / 额度 / 补丁 / 自动更新）
  preload.js            安全桥接（contextIsolation）
  cursor.js             核心：握手 / 写 state.vscdb / 关开 Cursor（分 Win/Mac 路径）
  cursor_settings.js    改 Cursor 的 settings.json（禁止 Cursor 自动更新等）
  cursor_tap.js         读取 Cursor 日志目录（排障用）
  http2.js              打补丁后把 Cursor 切到 HTTP/2 兼容模式
  store.js              本地账号存储（accounts.json）
  sand_patch.js         补丁的纯字符串变换规则
  sand_patch_engine.js  补丁引擎：定位 Cursor / 备份 / 写入校验 / 回滚 / 关重启（分 Win/Mac）
  sand_client.js        Sand 通道模型探测客户端
  sand_checksum.js / sand_protobuf.js / sand_errors.js   探测客户端的辅助模块
  trace.js              诊断日志
  renderer/             界面（原生 HTML/CSS/JS，无需构建）
build/
  icon.ico / icon.png   安装包与窗口图标
  afterPack.js          electron-builder 钩子：macOS 包做 ad-hoc 签名
mac-help/
  fix-macos.command     macOS 打不开时的一键修复脚本（随 Release 发布）
  README-macos.md       给 macOS 用户的独立说明（随 Release 发布）
.github/workflows/build.yml   打 tag 自动构建 Win + Mac 并发布到 Release
发布新版本.bat / release.ps1   一键发版脚本
SECURITY-token审计.md         token 流向审计：只发 Cursor 官方，不上传任何服务器
```
