'use strict';
// electron-builder afterPack 钩子：给 macOS 的 .app 做一次完整的 ad-hoc 签名。
//
// 背景：CI 上没有 Apple 开发者证书，electron-builder 会整体跳过 macOS 签名。但 Electron 自带的二进制
// 本身带着 Electron 官方的 ad-hoc 签名，而 electron-builder 又改写了 Info.plist / 图标 / 资源，
// 于是整个 bundle 的签名变成「不一致」。带隔离标记（浏览器下载）首次打开时 Gatekeeper 会把这种
// 不一致签名判成「已损坏，无法打开，您应该将它移到废纸篓」，且系统设置里不会出现「仍要打开」按钮。
//
// 用 `codesign --force --deep --sign -` 重新做一遍一致的 ad-hoc 签名后，Gatekeeper 会把它当成普通的
// 「未签名 / 未知开发者」应用：提示变成「无法验证开发者」，并且 系统设置 > 隐私与安全性 会出现
// 「仍要打开」，用户不需要开终端就能放行。Apple 芯片要求所有可执行文件必须有签名，ad-hoc 也算。
//
// 只在 macOS 构建时生效；若配置了真正的 Apple 证书（CSC_LINK / CSC_NAME），electron-builder 之后会
// 用真证书 --force 覆盖签名，这里就不做无用功。
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;

  const appName = context.packager.appInfo.productFilename + '.app';
  const appPath = path.join(context.appOutDir, appName);
  console.log(`  • afterPack: ad-hoc codesign ${appPath}`);
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
    console.log('  • afterPack: ad-hoc codesign ok');
  } catch (e) {
    // 签名失败不阻断打包：产物退化为以前那种未签名包，用户仍可按 README 的 xattr 方法打开。
    console.warn('  • afterPack: ad-hoc codesign failed (continuing with unsigned bundle): ' + (e && e.message));
  }
};
