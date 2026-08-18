# Omeety Terminal

**简体中文** · [English](README.en.md)

[![Release](https://img.shields.io/github/v/release/littlejoely/omeety-terminal?display_name=tag&style=flat-square)](https://github.com/littlejoely/omeety-terminal/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-7dd3fc?style=flat-square)](LICENSE)
[![Platform: Windows/macOS](https://img.shields.io/badge/platform-Windows_%7C_macOS-8aa4ff?style=flat-square)](#支持范围)

## 让 AI，真的动手

**Omeety Terminal 把真实本地终端放进 Chrome / Edge 侧栏，让你已经在用的
CLI Agent 获得当前浏览器的眼睛和手。**

它不是另一个 AI，也不替换 Codex、Claude Code 或 Kimi Code。你仍在熟悉的终端里
工作，只是 Agent 现在能看见、理解并操作你正在使用的网页，包括已有登录状态的标签页。

![Omeety 通过真实 MCP 路径读取并操作当前标签页](docs/images/omeety-demo.gif)

> 演示经过真实扩展、Native Messaging、PTY 与 MCP 链路，不是预录的模型回答。

[下载最新版](https://github.com/littlejoely/omeety-terminal/releases/latest) ·
[3 分钟开始使用](#3-分钟开始使用) ·
[安全边界](#安全边界) ·
[参与开发](CONTRIBUTING.md)

## 它解决什么

AI 已经很强，工作却仍然卡在网页、终端和复制粘贴之间。

Omeety 把这条链路接起来：

- **看得见**：读取当前标签页、结构化页面、截图、Console 和 iframe 内容。
- **点得动**：点击、输入、选择、滚动、上传文件，并验证动作是否真正生效。
- **接得上本地工作**：侧栏里是真实 PTY，可以直接运行 `git`、`npm`、`codex`、
  `claude`、`kimi` 和其他本地命令。
- **过程可见**：你和 Agent 共用同一个浏览器与终端，操作目标、执行过程和结果都在眼前。
- **不绑定模型**：浏览器能力通过 MCP 提供，支持 MCP 的 CLI Agent 可以复用同一套工具。

一句话：**普通终端管电脑，Omeety 还看得见浏览器。**

## 适合做什么

| 场景 | 示例 |
|---|---|
| 网页业务操作 | 填表、审批、后台配置、重复录入 |
| 跨系统流程 | 从一个网站导出数据，再上传到另一个系统 |
| 网页与本地联动 | 把页面内容保存为文件，处理后再填回网页 |
| 信息整理 | 翻页读取列表、提取结构化数据、生成本地结果 |
| 复杂页面操作 | 通过元素选取、截图和真实 CDP 输入处理图标、Canvas 或富文本界面 |

提交、保存、删除、同意以及非 GET 请求等高风险动作会保留用户确认。Omeety 提供执行
能力，不替用户决定权限边界。

## 3 分钟开始使用

已验证环境：**Windows 11 + Microsoft Edge**、**macOS + Google Chrome**。
请先安装 Node.js LTS，以及你准备使用的 CLI Agent。

### 1. 获取 Omeety

可直接下载包含生产依赖的
[最新版离线包](https://github.com/littlejoely/omeety-terminal/releases/latest)，也可以克隆仓库：

```bash
git clone https://github.com/littlejoely/omeety-terminal.git
cd omeety-terminal
```

### 2. 安装本地 Host

macOS：

```bash
./installer/install.sh
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File installer\install.ps1
```

安装器会准备 Native Messaging Host，并把本地 MCP 地址写入检测到的 Codex、
Claude Code 与 Kimi Code 配置；修改前会生成带时间戳的备份。

### 3. 加载扩展

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 开启“开发者模式”，点击“加载已解压的扩展”。
3. 选择项目中的 `extension` 文件夹。
4. 点击 Omeety 图标打开侧栏，在终端里运行你的 Agent。
5. 对它说：**“描述当前网页。”**

如果遇到没有文字的图标或复杂控件，点击侧栏的“选取”，连续选择页面元素后按 Enter；
Omeety 会把稳定引用和简洁摘要交给当前 Agent，不会自动提交命令。

## 为什么不是普通 Browser MCP

| | Omeety Terminal | 独立 Browser MCP / 自动化进程 |
|---|---|---|
| 浏览器 | 你正在使用、已经登录的标签页 | 常见做法是独立浏览器或独立上下文 |
| 工作入口 | 真实本地终端 | 通常只有工具服务 |
| Agent | Codex、Claude Code、Kimi Code 等可复用 | 取决于各自接入方式 |
| 交互 | 侧栏中同时看到终端和网页 | 经常需要在多个窗口之间切换 |
| 安全边界 | 本地桥接，高风险网页动作确认 | 取决于具体实现 |

Omeety 的原则是**加法，不是替换**：保留现有 Agent、Shell、浏览器登录态与工作习惯，
只补上稳定的浏览器感知和操作能力。

## 工作原理

```text
Chrome / Edge 侧栏
┌──────────────────────────────┐
│ xterm.js · 真实本地 PTY      │
└────────── Native Messaging ──┘
                 │
                 ▼
本地 Node Host（仅本机）
├─ PTY 与会话恢复
├─ Browser Core：目标、权限、动作验证与脱敏审计
├─ Browser Adapter / CDP：页面观察与真实输入
├─ Download Core：断点续传、代理择路与 SHA-256 校验
└─ MCP · http://127.0.0.1:49171/mcp
                 ▲
        Codex / Claude Code / Kimi Code / 其他 MCP Agent
```

Browser Core 提供 7 个高层工具以及兼容的底层浏览器工具；另有 3 个持久化下载工具，
合计 41 个 MCP 工具。高层调用负责目标锁定、权限检查、旧元素引用恢复、动作后验证、
指标与脱敏审计。实现与测试细节见 [Browser Core v2](docs/browser-core-v2.md) 和
[协议说明](shared/protocol.md)。

## 终端体验

- 多终端 Tab、重命名、恢复仍在运行的会话，以及有限近期输出回放。
- 终端内搜索、链接打开、选中复制、括号粘贴、OSC52 与 True Color。
- 仅活动 Tab 保留 WebGL Renderer，后台会话继续运行但释放 GPU 渲染资源。
- 可配置持续保活、空闲 30 分钟后结束或关闭侧栏立即结束。
- Windows 使用 ConPTY；macOS 使用真实 zsh PTY。

## 常见问题

| 现象 | 处理 |
|---|---|
| 终端状态红点 | 重新运行安装器，确认 Node 已安装，并核对扩展 ID 与 Native Host 配置 |
| Agent 中没有 `omeety_terminal` | 重新运行安装器后重启 Agent；MCP 地址为 `http://127.0.0.1:49171/mcp` |
| 终端找不到 Agent 命令 | 将 CLI 所在目录加入系统 PATH 后完全重启浏览器，或先使用绝对路径 |
| 浏览器提示无法与原生消息宿主通信 | 将项目移动到纯英文、无空格路径后重新安装 |
| 加载扩展失败 | 选择含有 `manifest.json` 的 `extension` 文件夹，不要选择项目根目录或 zip 文件 |
| macOS 拒绝原生模块 | 在“系统设置 → 隐私与安全性 → 开发者工具”中允许对应 Node，然后重跑安装器 |

## 安全边界

- **真实终端拥有当前系统用户的权限。** 只在你信任的 Agent 与任务中使用。
- MCP 服务只监听 `127.0.0.1`，不会直接暴露到局域网或公网。
- 高风险浏览器操作需要页面内确认；权限支持 `read`、`act`、`submit` 分级。
- 下载开始前显示来源、文件名、保存位置与校验信息；下载内容不会自动执行。
- 审计记录会对输入值、认证头、URL 凭据和敏感查询参数做脱敏。
- Omeety 可以复用浏览器登录态，因此页面内容可能被发送给你所使用的模型服务商；
  数据边界同时受 Agent、模型与目标网站的隐私政策约束。
- 不提交本地私钥、浏览器 Profile、日志、调试截图、安装配置或备份。完整政策见
  [SECURITY.md](SECURITY.md)。

## 支持范围

- 已验证：Windows 11 + Edge、macOS + Chrome。
- Chromium 系浏览器可以尝试，但未全部完成真机回归。
- Linux 尚未完成正式浏览器回归。
- Safari 暂不支持；其扩展、侧栏、CDP 与 Native Messaging 模型需要独立适配。
- 当前仍是独立开发的 Beta 项目，不是 OpenAI、Anthropic、Moonshot AI、Microsoft
  或 xterm.js 的官方产品。

## 开发与卸载

```bash
cd host
npm test
```

macOS 卸载：

```bash
./installer/uninstall.sh
```

Windows 卸载：

```powershell
powershell -ExecutionPolicy Bypass -File installer\uninstall.ps1
```

主要目录：`extension/`（MV3 扩展）、`host/`（PTY、Browser Core、下载与 MCP）、
`installer/`（安装脚本）、`shared/`（协议）、`_test/` 与 `_pwtest/`（回归测试）。

## License

[MIT](LICENSE) · 第三方组件许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

如果 Omeety 确实减少了你在网页与工具之间的切换，欢迎给项目一个 Star。
