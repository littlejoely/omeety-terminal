# Browser Core v2 设计与实测报告

## 目标

Browser Core v2 在不改变 Omeety Terminal 日常使用方式的前提下，提高复杂网页中的
观察、定位、操作恢复和权限可控性。它不是新的 Agent，也不是第二个常驻后端：Host
仍是浏览器启动的同一个 Node 进程，扩展仍由 Chrome/Edge 加载。

## 架构

```text
CLI Agent
  -> 41 个 MCP 工具
  -> Host Browser Core
       目标注册表 / 权限策略 / 高层工具映射 / 指标 / 脱敏审计
  -> Native Messaging
  -> 扩展 Service Worker + Browser Adapter
       CDP Target/Frame / DOMSnapshot / Accessibility / 动作与恢复
  -> content.js
       页面语义快照 / 复合定位器 / 页面内交互
```

Host 维护标签页、Target、Frame 和文档代次，不再只依赖“调用瞬间的活动标签页”。扩展
对跨进程 iframe 和 worker 使用扁平 CDP 自动附加，并把主文档与子 Target 的快照合并。

## 新增能力

1. **统一观察**：`omeety_browser_observe` 合并页面语义、DOMSnapshot、Accessibility
   Tree 和 Frame/Target 拓扑；`deep:false` 可保留轻量调用。
2. **稳定查询与定位**：`omeety_browser_query` 返回排序后的候选；旧 `uN` 失效时，按
   role、label、text、属性、父节点、选择器和几何位置评分恢复，歧义时停止操作。
3. **动作事务**：`omeety_browser_act` 和 `omeety_browser_transaction` 默认走
   `omeety_act_and_verify`，支持后置条件、失败即停、跨导航等待和有限自动重试。
4. **目标生命周期**：Host 注册标签页、Frame、OOPIF 和文档代次；工具继续支持显式
   `tabId`，避免用户切换标签页时改变任务目标。
5. **执行隔离**：事务用 `tabId` 锁定目标，CDP 输入按标签页串行，避免并发输入交错。
6. **权限边界**：设置中提供只读、允许操作、允许提交三种模式。Host 在转发前检查，
   页面端原有危险动作确认继续作为第二层保护。
7. **诊断与审计**：`omeety_browser_status` 返回拓扑、调用、失败和恢复指标。审计记录
   对 Cookie、Token、密码、请求体和 JavaScript 代码脱敏，只写入本机用户状态目录，
   5MB 轮转且不会进入仓库。

## v2.1 准确率与性能优化

- 高层观察默认使用 compact profile，只保留操作所需的 uid、语义、边界框和稳定属性，
  不重复发送完整 CSS path；需要排障时仍可显式使用 `profile:"standard"`。
- 语义查询和 `click_text` 会把纯文本叶子提升到最近的可点击父卡片，适配飞书联系人、
  部门目录和其他没有 role/onclick 的 SPA 容器。
- 动作结果区分 `dispatched`、`applied`、`committed`。只有
  `expect.persistAfterReload:true` 刷新后复验仍通过，才报告业务结果已持久化。
- 导航与刷新等待绑定新的文档代次，避免旧页面的同名文本提前满足后置条件。
- `press_key` 支持 Meta/Control/Alt/Shift 组合键。显式锁定非活动 tab 的截图改用
  `Page.captureScreenshot`，不再截到前台的另一个标签页。

## 使用差异

原来的安装、侧栏终端和自然语言使用方式不变，31 个原有浏览器工具仍可直接调用。
Agent 可以优先使用 7 个 `omeety_browser_*` 高层工具；不认识新工具的 Agent 仍按旧契约
工作。设置页新增浏览器权限模式；终端顶栏保持原来的简洁布局。

## 前后对比

测试环境为当前 macOS + Playwright Chromium；数据来自同一工作区的改造前基线与改造
后回归。耗时与内存均为单次本机测量，只用于防止明显回退，不代表跨机器性能承诺。

| 指标 | 改造前 | 改造后 | 变化 |
|---|---:|---:|---:|
| MCP 工具 | 34（31 浏览器 + 3 下载） | 41（38 浏览器 + 3 下载） | +7 个兼容高层入口 |
| 100 次重渲染后旧元素引用命中 | 0/100（旧属性 UID） | 100/100（复合定位恢复） | 0% -> 100% |
| 恢复平均耗时 | 不适用 | 约 1.26ms | 有界本地计算 |
| 跨域 iframe 深度语义 | 只标记受限拓扑 | 2 Frame / 2 DOM 文档 / 2 个可交互 AX 控件 | OOPIF 内容可观察 |
| 未变化增量快照体积 | 1317 bytes 全量 | 286 bytes 增量 | 减少 78.3% |
| `npm test` 实际耗时 | 11.93s | 10.81s | -9.4%（单次波动） |
| `npm test` 最大 RSS | 183.68MB | 181.31MB | -1.3% |
| `npm test` peak footprint | 27.13MB | 27.41MB | +1.0% |
| 冒烟断言 | 16 | 20 | 增加高层映射与状态验证 |

v2.1 的 44 控件真实 Chromium 夹具测得：standard 快照 13,697 bytes，compact 快照
7,335 bytes，减少 46.4%；100 次中文语义查询的含消息往返平均 1.05ms；100 次重渲染
恢复仍为 100/100，平均 1.27ms。持久动作在刷新后返回 `committed`，后台标签页截图的
实际 transport 为 `cdp:Page.captureScreenshot`。这些是同机单次回归数据，用于识别性能
倒退，不作为跨设备基准承诺。完整 `npm test` 仍为 10.81s；本轮峰值 RSS 为
179.37MB，较本轮优化前的 183.12MB 低约 2.0%，peak footprint 从 27.32MB 微降至
27.28MB，说明新增准确性检查没有引入常驻性能回退。

真实浏览器夹具还验证了 101 次定位恢复全部成功且无歧义；深度观察捕获 22 个 DOM
节点、13 个布局节点、16 个 Accessibility 节点，跨域子 Frame 的按钮可被识别。

## 验证

```bash
cd host
npm test

cd ..
node _pwtest/test_browser_core_v2.mjs
```

第二条测试使用本机可用的 Node Playwright 和独立临时浏览器配置，验证真实重渲染、
OOPIF、DOMSnapshot、Accessibility 与 420px 宽侧栏布局，不读取个人浏览器 Profile。

## 边界

- 深度观察依赖 Chromium 的 `chrome.debugger`/CDP，因此当前适用于 Chrome、Edge 和
  Chromium；Safari 仍需要单独的容器 App 与适配层。
- 复合定位恢复不会在候选分数接近时猜测，Agent 应重新观察或让用户选取元素。
- `read` 模式阻止动作；`act` 模式阻止提交类动作；`submit` 模式仍保留页面确认机制。
