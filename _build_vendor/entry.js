import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebglAddon } from "@xterm/addon-webgl"
import { SearchAddon } from "@xterm/addon-search"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { ClipboardAddon } from "@xterm/addon-clipboard"

// 暴露为全局，供 sidepanel.html 以经典 <script> 加载
window.Terminal = Terminal
window.FitAddon = FitAddon
window.WebglAddon = WebglAddon // GPU 渲染，滚动/重绘更流畅
window.SearchAddon = SearchAddon // Ctrl+F 终端内搜索
window.WebLinksAddon = WebLinksAddon // Ctrl+点击链接在浏览器打开
window.ClipboardAddon = ClipboardAddon // OSC52：shell 里的程序（claude/tmux 等）写系统剪贴板
