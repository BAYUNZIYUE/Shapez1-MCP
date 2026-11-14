# Shapez1-MCP

给 **shapez 1**（shapez.io 桌面版）接一个 MCP 接口：agent 基座通过 MCP 读写游戏状态——查地图、放建筑、读 Hub 目标与产出速率、切游戏速度。

私有仓库，个人使用。当前状态：**骨架可跑通**，桥与 MCP 层有自动化测试；游戏内 mod 已按官方源码写的 API 实现，但**尚未在真实存档里逐项验证**（见下方「未验证项」）。

## 架构

```
agent 基座（MCP client）
        │  stdio（JSON-RPC，换行分隔）
        ▼
shapez1-mcp（Node 进程）
  ├── MCP server：10 个 shapez_* 工具
  └── WS 桥：ws://127.0.0.1:8765（只监听回环）
        ▲  mod 主动连入
        │
shapez 桌面版（Electron）
  └── mod/shapez1-mcp.js → window.shapez（游戏官方暴露面）
```

为什么是 WS 桥而不是让 mod 自己当 MCP server：游戏跑在浏览器环境里，起不了监听端口，也没有 stdio；反过来让 Node 侧当 MCP server 最省事，agent 基座按普通 stdio MCP 配置即可。

## 快速开始

### 1. 装 mod

把 `mod/shapez1-mcp.js` 复制到 shapez 的 mods 目录，然后**重启游戏**：

| 平台 | 目录 |
|---|---|
| Windows | `%APPDATA%\shapez.io\mods` |
| macOS | `~/Library/Preferences/shapez.io/mods` |
| Linux | `~/.local/share/shapez.io/mods` |

游戏内 `Mods` 菜单有 “Open Mods Folder”。mod 只在启动时扫描，热改无效；开发时用 `--dev` 启动项，菜单里有 Restart。

**只有桌面版（Steam / itch / GOG）加载 mod**，网页版没有 `window.shapez`。有 mod 时游戏会关闭 Steam 成就与统计，这是游戏自身行为。

### 2. 起 MCP server

```bash
npm install
npm start          # 默认桥端口 8765
```

```bash
# 可选环境变量
SHAPEZ1_MCP_PORT=8765      # 桥端口；改了要同步 mod 顶部 CONFIG.url
SHAPEZ1_MCP_HOST=127.0.0.1 # 不要改成 0.0.0.0
SHAPEZ1_MCP_TOKEN=xxxx     # 启用后 mod 的 CONFIG.token 必须一致
SHAPEZ1_MCP_TIMEOUT_MS=15000
```

游戏启动后会自动连上（mod 每 3 秒重试），`shapez_status` 里能看到 `bridge.connected: true`。

### 3. 接到 agent 基座

```json
{
  "mcpServers": {
    "shapez": {
      "command": "npx",
      "args": ["tsx", "/path/to/Shapez1-MCP/src/index.ts"],
      "env": { "SHAPEZ1_MCP_PORT": "8765" }
    }
  }
}
```

## 工具

| 工具 | 作用 |
|---|---|
| `shapez_status` | 连接状态、是否已加载存档、游戏版本、速度/暂停、当前层、相机、实体总数 |
| `shapez_place_building` | 在瓦片坐标放一个建筑（`buildingId`、`x`、`y`、`rotation`、`variant`） |
| `shapez_place_buildings` | 批量放置（游戏内 `performBulkOperation` 包裹，最多 5000 条，单条失败不影响其余） |
| `shapez_delete_building` | 删除瓦片上的建筑 |
| `shapez_query_entities` | 按矩形范围/层/建筑 id 查实体，带 `limit` 与 `truncated` |
| `shapez_hub_goals` | Hub 目标进度、已交付、升级等级、Hub 内已存形状 |
| `shapez_production_rates` | 各形状当前/历史产出速率 |
| `shapez_decode_shape` | 形状短码 → 四层四象限结构（subShape + color） |
| `shapez_set_speed` | `paused` / `regular` / `fast_forward`（不写存档） |
| `shapez_wait_ticks` | 按当前速度等待若干 tick（近似，暂停时直接返回） |

工具层只做参数校验与错误包装，**所有游戏交互在 mod 侧**：游戏 API 变了只改 `mod/shapez1-mcp.js`。

## 桥协议

见 `src/protocol.ts`（唯一权威定义）：

| 方向 | 消息 |
|---|---|
| mod → 桥 | `hello`（protocol / token / modVersion）、`response`（id / ok / result / error）、`event` |
| 桥 → mod | `hello-ok`、`request`（id / method / params） |

- 协议版本 `1`，不匹配直接断开。
- **所有请求都由桥发起**，mod 不需要处理并发调用。
- 单次调用默认 15 秒超时；批量放置 120 秒，查询 60 秒，等待 tick 65 秒。
- 新连接会替换旧连接（方便重载存档后不用重启 MCP server）。

## 开发

```bash
npm install
npm start                 # 起 MCP server
npm run mock              # 另开一个终端：假游戏端，连上桥，用于没装游戏时联调
npm run typecheck         # 只跑类型检查
npm run test              # vitest：协议 / 桥 / 工具层 / MCP stdio 端到端
npm run validate          # typecheck + test（收尾必跑）
npm run build             # 编译到 dist/
```

`npm run mock` 的假游戏有编造的建筑表与 Hub 数据，只验证链路与错误透传，**不能替代游戏内验证**。

## 安全

- mod 跑在游戏页面里，拥有页面全部权限，并通过 `contextBridge` 能碰到 `ipcRenderer`（可读写 `saves/` 目录）。所以：桥只监听 `127.0.0.1`；`CONFIG.url` 只接受回环地址（mod 里有断言，改成局域网地址会拒绝加载）。
- 一个桥同时只服务一个游戏连接；token 非空时强制校验。
- 不要把桥端口暴露到公网，也不要在 remote URL / 提交里放 token。

## 合规

- 本仓库**不分发游戏源码或美术素材**，mod 只调用游戏运行时已暴露的 API。
- shapez 原版仓库 `LICENSE` 是 GPL-3.0（`package.json` 里的 `"license": "MIT"` 与之冲突，不可依赖）。这里不含游戏代码，因此不复制其许可；如果后续把游戏代码拷进来，必须按 GPL-3.0 处理。
- `mods` 目录里的东西会被游戏执行，请只放自己信得过的文件。

## 未验证项（重要）

以下按官方源码写的，**没有在真实游戏中逐项确认**，第一次跑请对照游戏内 DevTools 控制台：

1. Steam 现行 1.6.x 的 ModLoader 与公开仓库 `master`（最新 tag 1.5.1）是否一致。
2. `root.hubGoals` 的 `currentGoalIndex` / `upgradeLevels` / `storedShapes` 字段名与结构。
3. `root.productionAnalytics.getCurrentShapeRatesRaw()` / `getPastShapeRate(600)` 的入参与返回结构。
4. `staticMapEntity.getTileSpaceBounds()` 返回的 `w` / `h` 是否为瓦片尺寸。
5. `root.logic.tryPlaceBuilding` 放置是否进入撤销栈。
6. `root.time.speed` 替换后存档再读回的表现（预期回到正常速度）。
7. `shapez.PausedGameSpeed` / `FastForwardGameSpeed` / `RegularGameSpeed` 是否都在 `window.shapez` 上可访问。

失败时 mod 会 `console.warn("[Shapez1-MCP] …")`，用 `--dev` 启动项打开控制台看。

## 目录

```
mod/shapez1-mcp.js   游戏内 mod（单文件，游戏不认 mod.json）
src/protocol.ts      桥协议定义（唯一权威）
src/bridge.ts        WS 桥：hello/token/请求超时/连接替换
src/tools.ts         10 个 MCP 工具定义（与 server 解耦，便于单测）
src/index.ts         入口：起桥 + stdio MCP server（日志只走 stderr）
src/mock-game.ts     假游戏端（联调与测试用）
test/                协议、桥、工具、MCP 端到端
```
