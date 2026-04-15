# Launch Posts Tracker

## V2EX 分享创造 — **POSTED**

**Node:** 分享创造 (`/go/create`)

**Title:** 分享一个自己做的 AI 编程 Agent 监控面板， 3D 机器人实时可视化

**Content:**

最近一直在用 Claude Code 写代码，经常同时开好几个会话，切来切去看哪个在等我 approve ，哪个跑完了，哪个卡住了。终端一多完全顾不过来。

所以做了这个本地监控面板：**AI Agent Session Center**。每个会话在 3D 场景里生成一个机器人，实时反映 Agent 状态。

最好用的几个功能：

- **Approval 警报** — 需要批准权限时黄色闪烁 + 声音提醒，再也不会漏掉。16 种内置合成音效，每个 Agent 动作（读文件、跑命令、等审批等）都有对应提示音，支持按 CLI 和动作自定义
- **内置终端** — 直接从面板管理所有终端会话，不用切来切去
- **Prompt 队列** — 拖拽排序，批量给 Agent 喂 prompt
- **书签标记** — terminal 输出和代码文件都能打书签加备注，review 的时候一键跳回关键位置，不用再满屏翻找"刚才 AI 改了哪里"、"那段回答说了什么"
- **历史搜索** — 所有 prompt 、response 、工具调用全文搜索，之前让 Agent 干过什么随时翻出来
- **实时文件浏览** — Markdown 渲染、PDF 预览、代码高亮，多窗口分屏随便开。吐槽一下 VS Code 的 Markdown 预览，又卡又丑还经常渲染出 bug ，用过的都懂...
- **Session resume** — 断开的会话一键重连
- **Team 可视化** — Sub-agent 之间的关系一目了然
- **多项目管理** — 一个面板管理所有项目，快速切换不同项目的会话
- **快捷键切换** — 键盘快捷键在会话之间秒切，不用鼠标点来点去
- **自定义命名** — 给会话起个好认的名字，一眼知道哪个在干什么
- **房间分类** — 用"房间"概念把会话按项目 / 用途分组，3D 场景里一目了然

hook 是轻量 bash 脚本，端到端延迟 3-17ms ，对 CLI 几乎零影响。目前主要支持 Claude Code ，Gemini CLI 和 Codex 支持很快加进来。

```
npx ai-agent-session-center
```

GitHub: https://github.com/coding-by-feng/ai-agent-session-center

MIT 开源，欢迎试用和反馈。

---

## V2EX 程序员 — **POSTED** https://www.v2ex.com/t/1197697

**Node:** 程序员 (`/go/programmer`)

(Same content as 分享创造 post)

---

## V2EX — Claude / 开源软件 节点

Remaining nodes to post:
- Claude (`/go/claude`)
- 开源软件 (`/go/opensource`)

---

# Reddit Posts (English)

## r/ClaudeAI

**Title:** I built a 3D dashboard to monitor all my Claude Code sessions in real time

**Content:**

I run multiple Claude Code sessions at once and constantly tab between terminals to check which one needs approval, which one finished, and which one is stuck. It got out of hand fast.

So I built **AI Agent Session Center** — a localhost dashboard where each session spawns a 3D robot character that reflects the agent's live status.

The features I use most:

- **Approval alerts** — yellow flash + sound when a session needs permission approval. Never miss one again. 16 built-in synthesized sounds — each agent action (file read, bash run, approval needed, etc.) has its own alert tone, customizable per CLI and per action
- **Built-in terminals** — manage all terminal sessions from the dashboard, no more tab-switching
- **Prompt queue** — drag-and-drop to reorder, batch-feed prompts to agents
- **Bookmarks** — bookmark terminal output and code files with notes. Jump back to key moments during review instead of scrolling through walls of text looking for "where did the AI change that" or "what did that response say"
- **Full-text search** — search across all prompts, responses, and tool calls. Instantly find anything an agent did in any past session
- **Live file browser** — Markdown rendering, PDF preview, syntax-highlighted code, multi-pane split view. (VS Code's Markdown preview is sluggish and buggy — if you've used it, you know...)
- **Session resume** — reconnect disconnected sessions with one click
- **Team visualization** — see sub-agent relationships at a glance
- **Multi-project management** — manage all your projects from one dashboard, quickly switch between sessions across different repos
- **Keyboard shortcuts** — instantly jump between sessions with hotkeys, no mouse needed
- **Custom session names** — rename sessions so you can tell at a glance what each agent is working on
- **Room-based organization** — group sessions into "rooms" by project or purpose. Each room is a zone in the 3D scene, so your workspace stays organized visually

Hooks are lightweight bash scripts — 3-17ms end-to-end latency, near-zero impact on the CLI. Primarily supports Claude Code today, with Gemini CLI and Codex support coming soon.

```
npx ai-agent-session-center
```

GitHub: https://github.com/coding-by-feng/ai-agent-session-center

MIT licensed. Happy to hear feedback!

---

## r/SideProject

**Title:** I built a 3D monitoring dashboard for AI coding agents (Claude Code, Gemini CLI, Codex)

**Content:**

(Same content as r/ClaudeAI post)

---

## r/selfhosted

**Title:** AI Agent Session Center — a self-hosted dashboard to monitor AI coding agents with 3D visualization

**Content:**

(Same content as r/ClaudeAI post, add the following intro line:)

Fully local, no cloud, no accounts. One command to start:

```
npx ai-agent-session-center
```

---

## r/opensource

**Title:** AI Agent Session Center — open-source 3D dashboard for monitoring AI coding agents

**Content:**

(Same content as r/ClaudeAI post)

---

## r/webdev

**Title:** Built a real-time 3D dashboard with React 19 + Three.js + Express 5 to monitor AI coding agents

**Content:**

(Same content as r/ClaudeAI post, add the following tech stack section at the end:)

**Tech stack:** React 19, Three.js (@react-three/fiber), Zustand, Vite 7, Express 5, WebSocket, SQLite, IndexedDB (Dexie), xterm.js, node-pty. File-based message queue for hook delivery (~0.1ms append latency).

---

## r/node

**Title:** Built a real-time session monitor with Express 5 + WebSocket + file-based MQ (3-17ms end-to-end)

**Content:**

(Same content as r/ClaudeAI post, add the following tech details at the end:)

**Backend highlights:**
- Express 5 + ESM throughout
- File-based JSONL message queue — hooks append via POSIX atomic write (~0.1ms), server reads via `fs.watch()` + byte-offset tracking
- WebSocket broadcast with 20ms per-session debounce and 500-event ring buffer for reconnect replay
- SQLite (better-sqlite3) for persistence, node-pty for terminal sessions
- Coordinator pattern: sessionStore delegates to focused sub-modules (matcher, approval detector, team manager, process monitor)

---

## r/threejs

**Title:** 3D robot characters that reflect real-time AI agent status — built with @react-three/fiber

**Content:**

I built a monitoring dashboard for AI coding agents (Claude Code, Gemini CLI, Codex) where each session gets a procedurally generated 3D robot character. The robot's animation reflects the agent's live state:

- **Idle** — breathing animation
- **Prompting** — wave + walking
- **Working** — running
- **Waiting for approval** — waiting pose + yellow glow
- **Finished** — thumbs up / dance
- **Ended** — death animation

The scene includes a cyberdrome environment (floor, walls, rooms), status particle effects, speech bubble overlays, and animated connection lines between sub-agents.

Built with `@react-three/fiber` + `@react-three/drei`. The robots are procedural geometry (no external models), so the whole thing loads instantly.

GitHub: https://github.com/coding-by-feng/ai-agent-session-center

---

## r/LocalLLaMA

**Title:** Built a self-hosted dashboard to monitor AI coding agents — fully local, no cloud

**Content:**

(Same content as r/ClaudeAI post, emphasize local-first:)

Everything runs on localhost. No cloud, no telemetry, no accounts. Your session data stays on your machine (SQLite + IndexedDB).

---

## Reddit Post Tracker

| Subreddit | Status | Date | Link |
|-----------|--------|------|------|
| r/ClaudeAI | TODO | | |
| r/SideProject | TODO | | |
| r/selfhosted | TODO | | |
| r/opensource | TODO | | |
| r/webdev | TODO | | |
| r/node | TODO | | |
| r/threejs | TODO | | |
| r/LocalLLaMA | TODO | | |
