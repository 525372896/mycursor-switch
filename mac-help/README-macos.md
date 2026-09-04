# macOS 安装说明（打开提示「已损坏 / 无法验证 / 已阻止以防恶意软件并移到废纸篓」怎么办）

## 这是怎么回事

MyCursor 换号助手的 macOS 版**没有做 Apple 付费签名/公证**，所以 macOS 的 Gatekeeper 会拦截「未知开发者」的 App。
新系统（macOS 15 Sequoia 起）更严格，可能直接提示**「已阻止以防恶意软件并已移到废纸篓」并把 App 删掉**。

> ⚠️ 这是 macOS 对所有未签名软件的统一拦截，**不代表软件是病毒**（源码公开，token 只发 Cursor 官方）。介意的话可到源码仓库自行编译。
> macOS 15 起「右键 → 打开」的老办法已经失效，请按下面的方法来。

选芯片：Apple 芯片（M1/M2/M3/M4）下 `MyCursorSwitch-mac-arm64.dmg`；Intel 芯片下 `MyCursorSwitch-mac-x64.dmg`。

---

## 方法一：系统设置里点「仍要打开」（最正规，不用开终端）

1. 双击 App，弹窗里点 **「完成」**（不要点「移到废纸篓」）。
2. **系统设置 → 隐私与安全性**，往下拉到「安全性」，看到「已阻止使用“MyCursorSwitch”……」，点 **「仍要打开」**。
3. 输入开机密码，再弹窗时点 **「打开」**。以后双击直接开。

没看到「仍要打开」按钮？回到第 1 步再双击一次 App，按钮只在刚被拦过之后出现。

---

## 方法二：终端一条命令（最稳、最快）

打开「终端」（启动台搜 Terminal），粘贴回车：

```bash
xattr -cr /Applications/MyCursorSwitch.app
```

然后双击打开即可。如果 App **一下载就被系统删掉**，先给 dmg 去隔离再重装（`arm64` / `x64` 按你下载的文件名改）：

```bash
xattr -cr ~/Downloads/MyCursorSwitch-mac-arm64.dmg
```

---

## 方法三：一键修复脚本 `fix-macos.command`

1. 打开下载的 `.dmg`，把里面的 **MyCursorSwitch** 拖进 **「应用程序」**。
2. 下载随附的 **`fix-macos.command`**，**右键点它 →「打开」**。
   - 第一次系统可能也拦它：去 **系统设置 → 隐私与安全性**，拉到底点 **「仍要打开」**；
   - 或在终端里：`chmod +x ~/Downloads/fix-macos.command && ~/Downloads/fix-macos.command`
3. 按提示可能要输入一次开机密码，看到 **✅ 修复完成** 就行。
4. 去「应用程序」双击 **MyCursorSwitch** 正常打开。

---

## 方法四：开发者工具法（专治「已阻止以防恶意软件并移到废纸篓」）

macOS 15 起可能直接把 App **自动移到废纸篓**。用「开发者工具」白名单绕开系统安全策略：

1. 打开「终端」，粘贴运行（提示没权限就前面加 `sudo `）：
   ```bash
   spctl developer-mode enable-terminal
   ```
2. **系统设置 → 隐私与安全性**，列表里会多出 **「开发者工具」（Developer Tools）**，点进去把 **「终端」右边的开关打开**（没看到就完全退出系统设置再打开一次）。
3. 打开「废纸篓」，找到 `MyCursorSwitch.app`，**右键 → 「放回原处」**。已经彻底删了就重新下载装一次。
4. **重启电脑**（至少完全退出并重开终端）。
5. 在终端里启动一次 App：
   ```bash
   open -a MyCursorSwitch
   ```
   之后一般直接双击就行；若又被拦，再从终端 `open -a MyCursorSwitch` 一次，或补做方法二。

---

## 方法五（不推荐）：允许「任何来源」

```bash
sudo spctl --master-disable
```

然后到 系统设置 → 隐私与安全性 → 「允许以下来源的应用程序」选 **「任何来源」**。会放开全系统 Gatekeeper，且 macOS 15 起 Apple 对它做了限制（可能要在系统设置里再确认、或不出现该选项）。前几种都不行时再试。

---

## 一劳永逸（面向分发者）

给最终用户零门槛「双击即开」，唯一根治办法是 **Apple Developer 账号（$99/年）签名 + 公证(notarize)**。
配好后 `electron-builder` 会自动签名公证，客户不再看到任何拦截。需要的话联系分发者开启。

---

## 常见问题

- **App 一下载就没了 / 被移到废纸篓**：方法四；或先执行方法二的「给 `.dmg` 去隔离」再重新装；已删的从 Release 页重新下载。
- **打补丁提示没权限（EPERM / EACCES）**：先完全退出 Cursor 再点「打补丁」；仍不行就把 Cursor.app 挪到 `~/Applications/` 再试。
- **换号后 Cursor 没自动起来**：手动从「应用程序」打开 Cursor 一次即可，登录态已经写好。
- **有新版本但不会自动装**：macOS 自动安装需要 Apple 签名，Mac 上只会弹「去下载」，到 Release 页下新 dmg 覆盖安装即可。
- **`fix-macos.command` 双击没反应**：右键 →「打开」；或终端里 `chmod +x fix-macos.command && ./fix-macos.command`。
