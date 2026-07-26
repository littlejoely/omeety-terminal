# Omeety Terminal 中文发布素材

仓库：https://github.com/littlejoely/omeety-terminal

演示：`docs/images/omeety-demo.gif`

## 推荐标题

我把真实终端放进了浏览器侧栏，让 Codex、Claude Code、Kimi Code 共用同一双浏览器“眼睛和手”

## V2EX / 掘金 / 知乎正文

我做了一个开源项目 **Omeety Terminal**：它是 Edge/Chrome 侧栏里的真实本地
终端，同时为终端中的 CLI Agent 提供浏览器控制 MCP。

在里面运行 Codex、Claude Code、Kimi Code，或者其他支持 MCP 的 CLI，它们就
可以读取和操作你当前正在使用、已经登录的浏览器标签页。

我把它定位为 **CLI Agent 的浏览器外骨骼**：

- 不替代 Codex、Claude Code 或 Kimi Code；
- 不绑定 GPT、Claude、GLM、Kimi 或某个模型；
- 保持真实 PTY 和普通 Shell，不在侧栏里再造一个聊天 Agent；
- 为不同“模型 + Agent”组合提供统一的浏览器眼睛和手；
- 所有能力本地桥接，MCP 只监听 `127.0.0.1`；
- 提交、删除、保存等危险操作仍需浏览器确认。

当前公开 Beta 包含：

- Windows ConPTY 真实终端与多终端标签页；
- 侧栏关闭后的会话保活与近期输出回放；
- 31 个 MCP 浏览器工具；
- 页面快照、稳定元素 UID、元素选取、截图、Console、跨导航等待；
- CDP 真实输入、文件上传和可回滚页面预览；
- Codex、Claude Code、Kimi Code 配置自动写入；
- Streamable HTTP `/mcp`，兼容旧 SSE `/sse`。

目前主要在 Windows 11 + Edge 验证，仍是早期版本。欢迎试用、提交 Issue，或者
围绕浏览器遥测、输入可靠性和更多平台做二次开发。如果它对你有用，也欢迎给个 Star。

GitHub：https://github.com/littlejoely/omeety-terminal

## 即刻 / 朋友圈短版

开源了 Omeety Terminal：Edge/Chrome 侧栏里的真实本地终端，也是 Codex、
Claude Code、Kimi Code 等 CLI Agent 的浏览器外骨骼。不同 Agent 共用当前网页的
同一双眼睛和手，31 个 MCP 工具，本地桥接，MIT 开源。目前支持 Windows 与 macOS Chrome。

https://github.com/littlejoely/omeety-terminal

## 首次发布检查

- 发布时附上动态 GIF，而不是只贴仓库链接。
- 明确写“Windows Beta”，避免用户误以为已经跨平台验证。
- 发布后优先回答安装失败和安全边界问题。
- 不复制粘贴同一段内容刷屏；根据社区规则调整标题与长度。
