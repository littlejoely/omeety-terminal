# Contributing / 参与开发

Thank you for helping improve Omeety Terminal. The project stays focused on a
simple role: a real terminal that gives different CLI agents one reliable,
local browser-control layer.

感谢你帮助改进 Omeety Terminal。项目会保持一个清晰角色：它首先是真实终端，
并为不同 CLI Agent 提供统一、可靠、本地优先的浏览器控制层。

## Before opening an issue / 提交 Issue 前

Please include / 请提供：

- Windows and browser version / Windows 与浏览器版本；
- Omeety commit or release / Omeety 提交或版本；
- selected shell and CLI agent / 使用的 Shell 与 CLI Agent；
- exact reproduction steps / 最短复现步骤；
- expected and actual behavior / 预期与实际结果；
- sanitized logs or screenshots when useful / 已去敏的日志或截图。

Never upload browser profiles, cookies, local configuration backups, private
keys, access tokens, or unreviewed `host-debug.log` files.

不要上传浏览器 Profile、Cookie、本地配置备份、私钥、访问令牌，或未经检查的
`host-debug.log`。

## Local development / 本地开发

Requirements / 环境：

- Windows 11 or macOS (current verified platforms)
- Microsoft Edge or Google Chrome
- Node.js LTS
- Python + Playwright only for headed browser probes

```powershell
git clone https://github.com/littlejoely/omeety-terminal.git
cd omeety-terminal
Set-Location host
npm ci
Set-Location ..
powershell -ExecutionPolicy Bypass -File installer\install.ps1
```

Load `extension` as an unpacked extension, then reload it after changing
extension JavaScript. Restart the side panel and any CLI agent after changing
the native host or MCP configuration.

修改扩展 JavaScript 后需要在扩展管理页重载；修改 native host 或 MCP 配置后，
还需要重新打开侧栏并启动新的 CLI Agent 会话。

## Tests / 测试

Fast, profile-free checks / 快速无浏览器测试：

```bash
cd host
npm test
```

The smoke runner has a 30-second hard timeout and cleans up its Host/PTY on
success, failure, interruption, and timeout. Do not register it as a persistent
`launchctl` or Task Scheduler job.

冒烟测试内置 30 秒硬超时，并在成功、失败、中断和超时时清理 Host/PTY；不要把它
注册成常驻 `launchctl` 或 Windows 计划任务。

Headed Edge probes use isolated profiles and ports. See
[`_pwtest/README.md`](_pwtest/README.md). The settings reconnect regression is:

```powershell
python _pwtest\test_settings_reconnect.py
```

## Pull requests / Pull Request 约定

- Keep changes focused and explain the user-visible behavior.
- Add or update a regression test for bug fixes when practical.
- Preserve the real-terminal and agent-neutral design principles.
- Do not commit generated host manifests, logs, profiles, screenshots with
  personal data, agent configuration backups, or secrets.
- Run `git diff --check` and the relevant tests before submitting.

请保持改动范围清晰，修 Bug 时尽量补回归测试，并保护真实终端、Agent 中立与
本地优先的产品边界。提交前运行 `git diff --check` 和相关测试。

By contributing, you agree that your contribution is licensed under the
project's [MIT License](LICENSE).
