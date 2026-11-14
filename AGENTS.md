# AGENTS.md — Shapez1-MCP

给 shapez 1 提供 MCP 接口：agent 基座用 MCP 工具读写游戏（查地图、放/删建筑、读 Hub 与产出、切速度）。
使用说明、部署步骤、已验证/未验证清单见 `README.md`；本文件是结构索引 + 改动约束 + 验证方法。

## 技术栈

- Node ≥ 20，ESM（`"type": "module"`），TypeScript strict（`verbatimModuleSyntax` + NodeNext，import 必须带 `.js` 后缀）
- `@modelcontextprotocol/server` v2（`McpServer` + `serveStdio`）、`zod` v4（`import * as z from "zod/v4"`）
- `ws` 提供桥的 WS 服务端；vitest 跑测试；`tsx` 直接跑 TS，无构建步骤
- 游戏侧：shapez 1 的 mod 是**单文件普通 JS**（`new Function` 执行），不参与本仓库编译

## 结构

```
mod/shapez1-mcp.js        游戏内 mod：单文件、无 import，直连游戏 API
src/protocol.ts           桥协议（唯一权威）：Client/Server 消息 + 双向解析
src/bridge.ts             WS 桥：hello/token、请求-响应对应、超时、连接替换、状态订阅
src/tools.ts              11 个 MCP 工具定义表 buildTools() + registerTools()
src/index.ts              入口：起桥 → serveStdio；SHAPEZ1_MCP_BRIDGE_ONLY=1 时只跑桥
src/mock-game.ts          假游戏端（联调/测试用，数据是编造的）
scripts/live-check.mjs    真实游戏联调检查：拉起 MCP server，跑完整 CRUD 闭环
test/                     protocol / bridge / tools / mod-load / mcp-stdio
```

依赖方向（单向）：

```
tools.ts → bridge.ts(GameClient) → protocol.ts
index.ts → bridge.ts + tools.ts
mock-game.ts / test/ → protocol.ts（只当协议对端）
mod/ 与 src/ 无编译期依赖，共享的只有协议字段名
```

- **工具层不许实现游戏逻辑**，只做参数校验与错误包装；游戏 API 全在 mod 里。
- **bridge.ts 不许知道任何 shapez 概念**（它只管协议与连接）。
- 慢工具显式传超时：默认 15s，`placeBuildings` 120s，`queryEntities` 60s，`waitTicks` 65s。

## 关键约定（改代码前必读）

1. **`src/protocol.ts` 是协议唯一权威**。mod 不能 import，字段手工同步（mod 顶部也有 `PROTOCOL_VERSION`）；改协议时两边一起改并跑 `npm run validate`。
2. **stdout 是 MCP 协议通道**，日志一律 `console.error`。
3. **桥默认只绑 `127.0.0.1`**。绑 `0.0.0.0` 只用于内网远程部署，且必须配 `SHAPEZ1_MCP_TOKEN`；mod 对非回环地址强制要求 `CONFIG.token`，否则拒绝加载（mod 在页面里有 `ipcRenderer` 权限，能读写 `saves/`）。
4. **mod 是单文件**：不能拆模块/不能 import；类名必须 `Mod` 且 `extends shapez.Mod`；元数据是顶层 `var METADATA`（游戏不认 `mod.json`）。
5. **游戏内取值一律防御式**：`try/catch` + 缺字段返回 `null`，错误消息里带上原因；不要假设私有字段稳定。
6. **建筑用 meta id + variant，不是 `belt_forward` 这种拼串**：`belt` 的三种方向是 `rotationVariant` 0/1/2，`code`（`gBuildingVariants` 的 key）是最稳的寻址方式。
7. **层是字符串 `regular` / `wires`**，不是数字（`root.js` 的 `layers`）。
7b. **`rotation` 是角度，不是 0..3 索引**：`StaticMapEntity` 断言必须是 90 的倍数（0/90/180/270）。schema 层已用 `.multipleOf(90)` 卡住，mod 里还会再判一次。
7c. **拐角必须用弯带**：传送带变体 0=直行、1/2=转弯；`rotationVariant` 是变体索引，`rotation` 是角度。直带 + 直带在拐角不相连。铺带统一走 `shapez_build_belt_path`（mod 里按 `din`/`dout` 选变体：弯带实体 rotation = 进入方向，variant 2 出口 = 进入方向 +90°，variant 1 = -90°），不要手拼单格。
8. `productionAnalytics` 的接口是 `getCurrentShapeRatesRaw(dataSource)`，`dataSource` ∈ `produced` / `stored` / `delivered`。
9. **不要 hook 或替换游戏方法**（`replaceMethod` / `extendClass`）：本 mod 靠订阅信号 + 调公开 API 工作，这是它和其他 mod 能共存的原因。确实要加 hook 时，先确认不会和"多人同步类 mod"抢同一方法。
10. 其他 mod 注册的建筑走同一条 `registerBuildingVariants → gBuildingVariants` 链路，所以 `list_buildings` 自动包含它们（`code` 可能是 `buildingId` 字符串），无需特判。

## 构建 & 验证

```bash
npm install        # 依赖；esbuild 的 postinstall 若被 npm allowScripts 拦，tsx/vitest 会报错，先处理这个
npm run typecheck  # 快速验证 1/2
npm run test       # 快速验证 2/2（含起真进程的 MCP stdio 端到端）
npm run validate   # 完整验证：typecheck + test，收尾必跑
npm run build      # 编译到 dist/（已 gitignore）
```

**真实游戏联调**（自动化测试覆盖不到的部分，需要游戏已进入存档、桥端口空闲）：

```bash
SHAPEZ1_MCP_HOST=0.0.0.0 SHAPEZ1_MCP_TOKEN=<与 mod 一致> node scripts/live-check.mjs
```

11 项检查：连接 / 存档 / list_buildings / belt code / place / query / delete / query 空 / hub_goals / production_rates / decode_shape。退出码 0 = 全过。

**自动游玩**：`node scripts/auto-play.mjs --max-level 2 --cleanup`（只用 MCP 工具：找矿 → BFS 找空格路径 → 批量铺传送带 → 放 miner → 等交付）。
已实测自动通关 1–3 关：`auto-play.mjs` 打纯矿→Hub 的关卡；需要切割的关卡用 `scripts/build-cutter-line.mjs`（miner → cutter → 探针读两条输出带 → 目标进 Hub、废料进 trash）。第 4 关起还没做。

改动 mod 后要**重载游戏页面**（dev 构建）或重启游戏（桌面版）才生效，因为 mod 只在启动时取一次。

## 部署（dev 网页版，供远程浏览器访问）

完整命令见 `README.md`「在服务器上跑 dev 网页版」。要点与坑：

- 需要 Node 16（webpack 4）+ Java（atlas 打包，**不可省**）+ ffmpeg（音频转码）；本机放在 `~/.local/share/shapez-toolchain/{node-v16.20.2-linux-x64,jre17,bin}`，不在 PATH 里，用的时候手动前置。
- `src/js/core/config.local.js`（gitignored）写 `export default { externalModUrl: "/shapez1-mcp.js" }`；mod 副本放 `mod_examples/`（browser-sync 的第二 root），**不能放 `build/`**（每次启动被清）。
- `gulp/node_modules/fluent-ffmpeg/lib/capabilities.js` 需打兼容补丁（ffmpeg 7 的 `-formats` 列宽变化导致解析出 0 个格式 → `Output format mp3 is not available`）。**重装依赖后要重新打**。
- 服务：`cd shapez-io-dev/gulp && PATH=~/.local/share/shapez-toolchain/bin:<node16>/bin:$PATH yarn gulp`，browser-sync 监听 `:3005` 所有网卡。
- 桥这边：`SHAPEZ1_MCP_HOST=0.0.0.0 SHAPEZ1_MCP_TOKEN=<token> SHAPEZ1_MCP_BRIDGE_ONLY=1 npm start`。一个桥只能被一个进程占用，所以常驻桥和「agent client 自己拉 MCP server」二选一。

## 进度与关卡表（重要）

- 本机 dev 网页构建的关卡表被改过：`generateLevelsForVariant()` 里 `G_IS_DEV` 也走 `STANDALONE_LEVELS()`（26 关）。不改的话只有 9 关 demo 表。
- 第 1–5 关是真实生产打通的（脚本建线 + 交付）；第 6–24 关用 `shapez_dev_skip_goal` 推进（游戏自带 dev 捷径，等同按 `p`），因为需求是 270–25000 个多层/染色形状，单会话建不出来。
- 跳关后必须调 `shapez_save_game`：自动存档默认 60 秒一次，不落盘就刷新页面会退回旧关卡（踩过）。
- 关卡完成弹窗会暂停模拟；dev 构建里可用 `config.local.js` 的 `disableUnlockDialog: true` 关掉它（仍在 `shapez_dismiss_dialogs` 里兜底）。

## 已知问题

- `gameVersion` 在 dev 网页构建里拿不到（`G_BUILD_VERSION` 不是全局），返回 `null`。
- `waitTicks` 是按 60 tick/s × 速度倍率换算的**近似**等待，不是真实 tick 计数；暂停时直接返回。
- 一个桥同时只服务一个游戏连接，新连接会顶掉旧连接（有意为之，方便重载存档）。
- 未覆盖：`wires` 层、撤销栈、大批量放置、`set_speed` 存档重载行为、桌面版（Electron）加载路径。见 README「仍未验证」。
- 关卡弹窗（“第 N 关完成 / 下一关”）会**暂停模拟**：这时所有 miner/传送带都不动，`shapez_status` 仍显示 `paused:false`。自动玩之前必须先把弹窗点掉（人或 browse 驱动）。
- 与其他 mod 共存已验证（官方示例 base + add_building_basic：60 个变体、新建筑能放能删），但**替换了 `tryPlaceBuilding` 的 mod（多人同步类）未验证**——本 mod 直接调底层 API 会绕过对方。
- 不支持 shapez Community Edition 的 `.asar` + `mod.json` mod 格式。
