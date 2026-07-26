# Omeety Terminal

**简体中文** | [English](README.en.md)

[![Release](https://img.shields.io/github/v/release/littlejoely/omeety-terminal?display_name=tag&style=flat-square)](https://github.com/littlejoely/omeety-terminal/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-7dd3fc?style=flat-square)](LICENSE)
[![Platform: Windows/macOS](https://img.shields.io/badge/platform-Windows_%7C_macOS-8aa4ff?style=flat-square)](#已知限制--安全)
[![MCP tools: 29](https://img.shields.io/badge/MCP_tools-29-5ee7b1?style=flat-square)](#支持的浏览器工具29-个agent-自动可用)

**Omeety Terminal 是 CLI Agent 的浏览器外骨骼：把真实本地终端放进
Edge/Chrome 侧栏，让 Codex、Claude Code、Kimi Code 以及任何支持 MCP 的
CLI Agent 共用当前网页的同一双眼睛和手。**

[3 分钟快速开始](#3-分钟快速开始) · [为什么是 Omeety](#为什么是-omeety) ·
[工作原理](#它怎么工作一张图) · [29 个浏览器工具](#支持的浏览器工具29-个agent-自动可用) ·
[安全边界](#已知限制--安全) · [参与开发](CONTRIBUTING.md)

![Omeety 通过真实 MCP 路径读取并操作当前标签页](docs/images/omeety-demo.gif)

> 上面的可复现演示使用确定性的本地 MCP 客户端，实际经过扩展、Native
> Messaging、ConPTY 和浏览器工具；Codex、Claude Code、Kimi Code 使用同一套
> 同一套浏览器工具。演示不依赖模型账号或预录的模型回答。

没有专用聊天模式，也没有模型切换按钮——它就是一个真实 shell。你仍然可以运行
`git`、`npm`、`claude`、`codex`、`kimi` 或任意本地命令；区别是里面的 Agent
自动获得了当前浏览器标签页的感知和操作能力。

这是一个独立开发的 Windows/macOS Beta 项目，不是 OpenAI、Anthropic、Moonshot AI、
Microsoft 或 xterm.js 的官方产品。

## 为什么是 Omeety

| 能力 | Omeety Terminal | 常见独立 Browser MCP | 集成式桌面 Agent |
|---|:---:|:---:|:---:|
| 操作你正在使用、已经登录的浏览器标签页 | ✅ | 视实现而定 | 视产品而定 |
| 真实本地 PTY / 普通 Shell | ✅ | — | 通常不是 |
| Codex、Claude Code、Kimi Code 共用一套能力 | ✅ | 部分支持 | 通常绑定自家 Agent |
| Agent / 模型中立的 MCP 工具契约 | ✅ | ✅ | 通常不是 |
| 页面元素选取、截图、Console、真实 CDP 输入 | ✅ | 视实现而定 | 视产品而定 |
| 本地桥接；MCP 仅监听 `127.0.0.1` | ✅ | 视实现而定 | 视产品而定 |
| 提交、删除、保存等危险操作保留确认 | ✅ | 视实现而定 | 视产品而定 |

## 3 分钟快速开始

当前版本已在 **Windows 11 + Microsoft Edge** 和 **macOS + Google Chrome** 验证。先安装 Node.js LTS，以及
你准备使用的 `codex`、`claude` 或 `kimi` CLI。

macOS：

```bash
git clone https://github.com/littlejoely/omeety-terminal.git
cd omeety-terminal
./installer/install.sh
```

Windows：

```powershell
git clone https://github.com/littlejoely/omeety-terminal.git
cd omeety-terminal
powershell -ExecutionPolicy Bypass -File installer\install.ps1
```

然后：

1. 打开 `chrome://extensions` 或 `edge://extensions` → 开启开发者模式 → **加载已解压的扩展**。
2. 选择仓库里的 `extension` 文件夹。
3. 点击 Omeety 图标打开侧栏，在真实终端里运行 `codex`、`claude` 或 `kimi`。
4. 对 Agent 说：**“描述当前网页”**；或点侧栏的**选取**，连续点多个元素，
   按 Enter/点「完成选取」，上下文会自动写进当前 Agent 输入框。

需要完整安装原理、配置位置和卸载步骤，请继续阅读下文。也可以直接下载
[最新 Release](https://github.com/littlejoely/omeety-terminal/releases/latest)。

## 产品定位：Agent 的浏览器外骨骼

可以把 LLM 理解为操控者，把 Codex、Claude Code、Kimi Code 等 CLI Agent
理解为各有特长的战甲；**Omeety 是套在这些 Agent 外面的浏览器外骨骼**：
它不替代里面的 Agent，而是为任意“模型 + Agent”组合提供同一双浏览器眼睛、
同一双手和一条真实终端通道。

换一种说法，Omeety 是一套**兼容不同赛车和车手的浏览器赛道遥测与操作系统**。
它不绑定 GPT、Claude、GLM、Kimi 或某一家 CLI，也不要求它们为 Omeety 做专门
适配；支持 MCP 的 Agent 都应能复用同一套浏览器能力。

这也决定了项目的开发原则：

- **Agent 中立**：浏览器能力走开放协议和稳定工具契约，不把能力锁进某个模型或 CLI。
- **保持终端纯粹**：核心仍是真 PTY + xterm.js，不在侧栏里另造聊天 Agent、文件树或完整 IDE。
- **做强眼睛和手脚**：优先提高页面感知、元素定位、真实输入、跨导航操作、截图和上下文交接的可靠性。
- **本地优先、权限可见**：终端拥有本机用户权限；浏览器操作在本机桥接，危险动作保留确认边界。
- **渐进增强**：Agent 即使不认识 Omeety 的 UI，也能只凭 MCP 工具工作；高级能力应当可选，不破坏普通 shell。

### 给 Clone / Fork 的二开方向

推荐围绕“外骨骼”继续扩展，而不是把核心变成另一个封闭 Agent：

1. 完善 PTY、键盘、IME、渲染和会话恢复，让它更接近系统终端。
2. 增强浏览器遥测（DOM、Console、Network、截图）以及稳定、可审计的操作能力。
3. 将选取元素、页面片段和图片组合成标准 Context Bundle，交给不同 CLI Agent。
4. 为更多 MCP Agent、浏览器和操作系统增加薄适配层，保持核心工具契约一致。
5. 把权限组、只读模式、域名边界等做成可选安全层，而不是绑定某个模型的策略。

当前第一优先级是**可靠性与可测性能**：终端输入输出和浏览器工具必须做到“结果
真实、错误可信、页面跳转不中断”，并用真实 PTY/WebGL 基准防止资源与吞吐回退。
连续选取已经具备稳定元素引用和终端上下文注入，后续会演进为标准 Context Bundle。

## 它怎么工作（一张图）

```
扩展侧栏 [ xterm.js 终端 ]  ←─ native messaging ─→  本地 host（Node，一个进程）
                                                        ├─ PTY：真实 shell，I/O 桥到终端
                                                        └─ MCP Streamable HTTP @ http://127.0.0.1:49171/mcp
                                                               ↑ claude/codex/kimi 用各自配置连它
                                                         工具调用 → 转发到 content.js（操控当前标签页）
```

- 首次打开终端面板时，浏览器拉起 host；之后 offscreen 保活会让 host/PTY 在侧栏关闭后继续运行。
- 重新打开侧栏会复用原会话并回放有限的近期输出；退出浏览器、重载扩展或 host 异常退出才会结束会话。
- 一个进程干三件事：终端 I/O 中继、PTY（真 shell）、MCP 服务。

## ⚠ 前置：必须有一个本地 host

纯浏览器扩展**不能**启动本地程序。所以这个终端需要一个一次性的本地 native messaging host（Node）。安装器会自动装好，**不需要**像旧版 Codeg 那样常驻服务/Token/握手。

需要：**Node.js（建议 LTS）** 已安装。已装的 `claude` / `codex` / `kimi` 会被自动配上浏览器工具。

## 完整安装说明

### macOS（Chrome）

```bash
# 请在 macOS 自带 Terminal / iTerm 中，从项目根目录执行
./installer/install.sh
```

如果 macOS 询问是否允许 `node` 使用开发者工具，请选择**允许**；拒绝后
`node-pty` 原生模块将无法加载，可在“系统设置 → 隐私与安全性 → 开发者工具”中重新允许。

### Windows（Edge / Chrome）

```powershell
# 在项目根目录
powershell -ExecutionPolicy Bypass -File installer\install.ps1
```

安装器会：
1. 给 host 装 npm 依赖（`node-pty` / MCP SDK / express）。
2. 生成 `host/host-manifest.json`；Windows 注册到 HKCU，macOS 安装到浏览器用户级 `NativeMessagingHosts` 目录，均不需要管理员权限。
3. 把 MCP（`http://127.0.0.1:49171/mcp`）写进 `claude`、`codex`、`kimi` 的配置（先备份成 `*.bak-时间戳`）。

> 扩展 ID 由 `manifest.json` 的 `key` 固定为 `fjhjkmpldbepgcpfkhpolnnheccjaamg`，所以注册表的 `allowed_origins` 跨重载/换机稳定。

然后加载扩展：
1. `chrome://extensions`（或 `edge://extensions`）→ 打开**开发者模式**。
2. **加载已解压的扩展** → 选择项目中的 `extension` 目录。
3. 确认扩展 ID = `fjhjkmpldbepgcpfkhpolnnheccjaamg`。

## 使用

1. 点扩展图标开侧栏 → 首次有"真·终端=整机权限"的确认门，点「我了解」。
2. 出现系统 Shell 提示符（Windows 为 PowerShell，macOS 为 zsh）。敲 `claude`（或 `codex` / `kimi`）。
3. 在 agent 里：
   - `/mcp`（claude）能看到 `omeety_terminal` + 29 个 `omeety_*` 工具已连上。
   - 让它"描述当前网页" → 它会读取你**当前 Chrome/Edge 标签页**的内容。
4. 设置（⚙）：可切换系统默认 Shell、zsh/bash/fish、PowerShell/CMD/Git Bash 或自定义路径。

## 终端快捷键 / 特性

- **Ctrl+F**：终端内搜索输出（Enter 下一个 / Shift+Enter 上一个 / Esc 关闭）。
- **Ctrl+点击链接**：在浏览器新标签页打开终端里的 URL。
- **选中即复制**；**Ctrl+V / 右键粘贴**（bracketed paste：多行粘进 claude/PSReadLine 不会逐行提交）。
- **Ctrl+滚轮 / Ctrl+= / Ctrl+- / Ctrl+0**：调字号（自动记住，重开不丢）。
- **Ctrl+Alt+T** 新终端 tab · **Ctrl+Alt+W** 关闭当前 · **Ctrl+Alt+←/→** 切换 tab（Ctrl+T/W/Tab 被浏览器占用，故用 Ctrl+Alt）。
- tab 栏：点击切换、**中键关闭**、右键重命名；shell 上报的窗口标题（cmd `title`、PS `$Host.UI.RawUI.WindowTitle`）自动变成 tab 标题。
- **OSC52**：shell 里的程序（claude `/copy`、tmux、vim）可直接写系统剪贴板。
- **连续选取**：点「选取」后在网页连续点选（再次点击可取消该项），按 Enter 或点
  「完成选取」结束；`pick-1…N` 稳定引用和简洁摘要会写入当前终端输入行，且不会自动回车执行。

## 支持的浏览器工具（29 个，agent 自动可用）

**查看 / 获取**：`omeety_get_page_snapshot`（元素 uid 跨快照稳定）、`omeety_get_selected_context`、`omeety_capture_visible_tab`（截图，1280 宽自适应下采样）、`omeety_fetch_with_cookie`、`omeety_get_user_pick`（兼容最近单个选取）、`omeety_get_user_picks`（连续选取的 `pick-1…N`）、`omeety_list_tabs`、`omeety_get_console_logs`（CDP 收 console/异常）。

**操作**：`omeety_click`、`omeety_click_text`、`omeety_click_at`、`omeety_fill`、`omeety_type_text`、`omeety_press_key`、`omeety_select`、`omeety_scroll`、`omeety_hover`、`omeety_upload_file`、`omeety_open_tab`、`omeety_switch_tab`、`omeety_navigate`、`omeety_reload`、`omeety_go_back`、`omeety_close_tab`、`omeety_wait_for`（可跨 reload/导航等待元素或文本）、`omeety_execute_js`（通过 CDP 在严格 CSP 页面执行 JS 的逃生舱）、`omeety_apply_preview_patch`、`omeety_rollback_preview_patch`、`omeety_request_user_confirmation`。

危险操作（提交/保存/删除/同意类点击、非 GET 请求）会自动弹浏览器确认框，需你同意才执行。富文本编辑器（飞书等）合成事件不认时，给 `click_at`/`fill`/`type_text`/`press_key` 传 `cdp:true` 走真实输入。

## 常见问题

| 现象 | 处理 |
|---|---|
| 终端连不上（状态红点）| 重新运行当前系统的安装器（macOS：`install.sh`；Windows：`install.ps1`），确认扩展 ID 与 `allowed_origins` 一致、Node 已装 |
| `/mcp` 里没有 omeety_terminal | 重新运行安装器（会重写 agent 配置）；Codex 可用 `codex mcp add omeety_terminal --url http://127.0.0.1:49171/mcp` |
| codex/kimi 连不上 MCP | 确认配置 URL 是 `http://127.0.0.1:49171/mcp`；检查 `~/.codex/config.toml`、`~/.kimi-code/config.toml` |
| 终端里找不到 claude/codex/kimi | host 的 PATH 来自浏览器环境；用全路径运行，或把它们的目录加到系统 PATH 后重启浏览器 |
| 关闭侧栏后再打开，少量旧输出没显示 | 会话仍在运行，但只回放最近 64KB 输出；继续输入即可，完整历史应由终端程序自身保存 |
| `execute_js` 后出现浏览器调试提示条 | 该工具为兼容严格 CSP 使用 CDP；这是 Chromium 对 `debugger` 权限的可见提示，不影响普通终端 |

## 卸载

macOS：

```bash
./installer/uninstall.sh
```

Windows：

```powershell
powershell -ExecutionPolicy Bypass -File installer\uninstall.ps1
```
移除 Native Messaging 注册 + 从各 Agent 配置删除 `omeety_terminal`（备份保留）。然后到浏览器扩展管理页移除扩展。

## 目录

```
extension/    MV3 扩展（终端 + native 端口 + content 工具）
host/         native messaging host（PTY + MCP Streamable HTTP，兼容 legacy SSE）
installer/    Windows PowerShell 与 macOS zsh 安装/卸载脚本
shared/       协议说明
tools/        gen-key.js（生成扩展 key + 固定 ID）
_test/        mock-native 冒烟测试（无需浏览器）
_pwtest/      有头 Edge 回归探针（仅提交可公开复现脚本）
```

## 已知限制 / 安全

- **真终端 = 整机权限**：这是固有特性。host 的 MCP 只 bind `127.0.0.1`（不对外）；危险浏览器操作仍走页面内确认框。
- 侧栏关闭后 offscreen document 会尽力保活 host/PTY，并只缓存最近 64KB 输出；退出浏览器、重载扩展、native host 崩溃或被系统回收仍会结束会话。
- 已验证 Windows ConPTY 与 macOS Chrome + zsh PTY；Linux 尚未完成浏览器真机回归。
- Safari 当前不受支持：Safari 没有 Chromium `sidePanel`、`offscreen`、`chrome.debugger/CDP` 的等价组合，并且其 Native Messaging 必须通过包含扩展的 macOS App。Safari 版需要独立容器 App 和浏览器适配层，不能直接加载本目录。
- Codex 在浏览器侧栏终端中的光标/中文 IME 兼容性跟踪：
  [openai/codex#35438](https://github.com/openai/codex/issues/35438)。
- 除 `docs/images` 中经审查的公开图片外，本地私钥、浏览器 Profile、日志、
  调试截图和安装器生成文件均不会提交；详见
  [`SECURITY.md`](SECURITY.md)。

## 开源协议

Omeety Terminal 使用 [MIT License](LICENSE) 开源。项目包含的第三方组件保留
各自的版权和许可声明，详见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

如果 Omeety 的确帮你减少了浏览器与工具之间的切换，欢迎给仓库一个 Star。
Bug 报告和范围清晰的 Pull Request 也都欢迎，参与方式见
[`CONTRIBUTING.md`](CONTRIBUTING.md)。
