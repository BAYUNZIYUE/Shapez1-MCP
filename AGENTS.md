# AGENTS.md — Shapez1-MCP

给 shapez 1 桌面版提供 MCP 接口：agent 基座用 MCP 工具读写游戏（查地图、放/删建筑、读 Hub 与产出、切速度）。
使用说明见 `README.md`；本文件是给后续落地开发/接手的 AI 与人的结构索引。

## 技术栈

- Node ≥ 20，ESM（`"type": "module"`），TypeScript strict（`verbatimModuleSyntax` + NodeNext，所以 import 必须带 `.js` 后缀）
- `@modelcontextprotocol/server` v2（`McpServer` + `serveStdio`）、`zod` v4（`import * as z from "zod/v4"`）
- `ws` 提供桥的 WS 服务端
- vitest 跑测试；`tsx` 直接跑 TS，无构建步骤

## 结构

```
mod/shapez1-mcp.js   游戏内 mod：单文件、无 import、普通 JS（游戏用 new Function 执行）
src/protocol.ts      桥协议（唯一权威）：ClientMessage/ServerMessage + 双向解析
src/bridge.ts        WS 桥：hello/token 校验、请求-响应对应、超时、连接替换、状态订阅
src/tools.ts         MCP 工具定义表 buildTools() + registerTools()，与 MCP server 解耦以便单测
src/index.ts         进程入口：先起桥，再 serveStdio；所有日志走 stderr
src/mock-game.ts     假游戏端，联调/测试用（编造数据，不代表游戏真实行为）
test/                protocol / bridge / tools / mcp-stdio 四组
```

依赖方向（单向，不要反向）：

```
tools.ts  →  bridge.ts(GameClient 接口)  →  protocol.ts
index.ts  →  bridge.ts + tools.ts
mock-game.ts / test/  →  protocol.ts（只当协议对端）
```

- **工具层不许实现游戏逻辑**，只做参数校验与错误包装；游戏 API 全部在 `mod/shapez1-mcp.js` 里，这样游戏版本变动只改 mod。
- `bridge.ts` 不许知道任何 shapez 概念（它只管协议与连接），否则测试和复用都会变难。
- `mod/` 与 `src/` 之间没有编译期依赖，共享的只有协议常量与字段名。

## 关键约定（改代码前必读）

1. **`src/protocol.ts` 是协议唯一权威**。mod 侧不能 import，字段必须手工同步（mod 顶部也写了 `PROTOCOL_VERSION`）；改协议时两边一起改，并跑 `npm run validate` 的 mcp-stdio 端到端。
2. **stdout 是 MCP 协议通道**，日志一律 `console.error`。一个 `console.log` 就会污染 JSON-RPC。
3. **桥只 bind `127.0.0.1`**，`CONFIG.url` 有回环断言。mod 在游戏页面里有 `ipcRenderer` 权限（能读写 `saves/`），不要放宽监听地址。
4. **mod 是单文件**：不能拆模块、不能 `import`，类名必须是 `Mod` 且 `extends shapez.Mod`；元数据放顶层 `var METADATA`（游戏不读 `mod.json`）。
5. **游戏内取值一律防御式**：`try/catch` + 可选字段返回 `null`，不要假设某个内部字段一定存在——它们是游戏私有实现，可能随版本变。
6. 请求超时：默认 15s；`placeBuildings` 120s、`queryEntities` 60s、`waitTicks` 65s。新增慢工具记得显式传超时。
7. 只有桌面版（Steam/itch/GOG）加载 mod；网页版没有 `window.shapez`。写文档/报错提示时别再假设网页版可用。

## 构建 & 验证

```bash
npm install        # 装依赖（esbuild 的 postinstall 可能被 npm 的 allowScripts 拦，若 tsx/vitest 报错先看这个）
```

- 开发：`npm start` 起 MCP server；另开终端 `npm run mock` 起假游戏端；真实游戏则装 `mod/shapez1-mcp.js` 后重启。
- 快速验证（改一小块后）：`npm run typecheck && npm run test`
- 完整验证（收尾必跑）：`npm run validate`（= typecheck + vitest，含起真进程的 MCP stdio 端到端）
- 构建：`npm run build`（输出 `dist/`，已 gitignore）

**自动化验证覆盖不到的部分（必须人工/游戏内验证）**：

- mod 在真实游戏里的行为：字段名、放置是否成功、撤销栈、速度切换、存档重载表现。列表见 `README.md` 的「未验证项」。
- 手动核对方法：把 mod 放进 mods 目录，用 `--dev` 启动项开控制台，看 `[Shapez1-MCP]` 日志；MCP 侧先调 `shapez_status`，再逐个工具试。
- 真游戏联调前，`npm run mock` 只能证明协议与工具层没问题，不能证明 mod 没问题。

## 已知问题

- `mod` 侧全部游戏 API 都来自 `tobspr-games/shapez.io` 公开源码推断，**尚未在真实存档验证**；Steam 现行 1.6.x 与公开 `master`（tag 1.5.1）是否一致也未确认。
- `waitTicks` 是按 60 tick/s 与当前速度倍率换算的**近似**等待，不是真实 tick 计数；暂停时直接返回。
- 一个桥同时只服务一个游戏连接，新连接会顶掉旧连接（有意为之，方便重载存档）。
