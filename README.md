# Shapez1-MCP

给 **shapez 1**（shapez.io）接一个 MCP 接口：agent 基座通过 MCP 工具读写游戏状态——查地图、放/删建筑、读 Hub 目标与产出、切游戏速度。

私有仓库，个人使用。当前状态：**已在真实游戏里跑通**（见「已验证」）；未覆盖的部分列在「仍未验证」。

## 架构

```
agent 基座（MCP client）
        │  stdio（JSON-RPC，换行分隔）
        ▼
shapez1-mcp（Node 进程）
  ├── MCP server：11 个 shapez_* 工具
  └── WS 桥：ws://<主机>:8765（本机默认只监听回环）
        ▲  mod 主动连入
        │
shapez（Electron 桌面版，或自建的 dev 网页构建）
  └── mod/shapez1-mcp.js → window.shapez（游戏官方暴露面）
```

为什么是 WS 桥：游戏跑在浏览器上下文里，起不了监听端口也没有 stdio；Node 侧当 MCP server 最省事，agent 基座按普通 stdio MCP 配置即可。

## 快速开始

### 1. 装 mod

把 `mod/shapez1-mcp.js` 复制到 shapez 的 mods 目录，然后**重启游戏**：

| 平台 | 目录 |
|---|---|
| Windows | `%APPDATA%\shapez.io\mods` |
| macOS | `~/Library/Preferences/shapez.io/mods` |
| Linux | `~/.local/share/shapez.io/mods` |

游戏内 `Mods` 菜单有 “Open Mods Folder”。mod 只在启动时扫描，热改无效；开发时用 `--dev` 启动项，菜单里有 Restart。

**只有桌面版（Steam / itch / GOG）和自建的 dev 网页构建加载 mod**；官方网页版（shapez.io）没有 `window.shapez`。有 mod 时游戏会关闭 Steam 成就与统计，这是游戏自身行为。

### 2. 起 MCP server

```bash
npm install
npm start          # 默认桥端口 8765
```

```bash
SHAPEZ1_MCP_PORT=8765            # 桥端口；改了要同步 mod 的 CONFIG.port
SHAPEZ1_MCP_HOST=127.0.0.1       # 远程/网页部署时要改成 0.0.0.0（此时必须配 token）
SHAPEZ1_MCP_TOKEN=xxxx           # 非回环部署必填；mod 的 CONFIG.token 必须一致
SHAPEZ1_MCP_TIMEOUT_MS=15000
SHAPEZ1_MCP_BRIDGE_ONLY=1        # 只跑 WS 桥、不开 stdio（配合别的 MCP client 或调试用）
```

游戏启动后自动连上（mod 每 3 秒重试），`shapez_status` 里能看到 `bridge.connected: true`。

### 3. 接到 agent 基座

```json
{
  "mcpServers": {
    "shapez": {
      "command": "npx",
      "args": ["tsx", "<仓库绝对路径>/src/index.ts"],
      "env": { "SHAPEZ1_MCP_PORT": "8765" }
    }
  }
}
```

一个桥同时只服务一个游戏连接，也只能被一个进程占用端口：**要么** agent 基座拉起 `npm start`（推荐，进程跟着 client 走），**要么**手动 `SHAPEZ1_MCP_BRIDGE_ONLY=1` 常驻桥、再另想办法接 MCP（当前没做多客户端共享）。

## 工具

| 工具 | 作用 |
|---|---|
| `shapez_status` | 连接状态、是否已加载存档、速度/暂停、当前层（`regular`/`wires`）、相机、实体总数 |
| `shapez_list_buildings` | **放置前先调**：列出 59 个建筑变体的 `code`、`buildingId`、`variant`、`rotationVariant`、占地 |
| `shapez_place_building` | 放一个建筑：`code`（推荐）或 `buildingId`+`variant`，加 `x`/`y`/`rotation`（**角度**：0/90/180/270） |
| `shapez_place_buildings` | 批量放置（游戏内 `performBulkOperation` 包裹，≤5000 条，单条失败不影响其余） |
| `shapez_build_belt_path` | 沿格子序列铺传送带，**自动选直行/左转/右转变体**（拐角必须用弯带，两条直带是不通的） |
| `shapez_delete_building` | 删掉某瓦片上的建筑（可指定层） |
| `shapez_query_entities` | 按矩形范围/层/建筑 id 查实体，带 `limit` 与 `truncated` |
| `shapez_hub_goals` | 等级、当前目标（形状/需求/已交付）、Hub 已存形状、各升级等级与加成 |
| `shapez_production_rates` | 产出/库存/交付三种数据源下各形状的切片数量 |
| `shapez_decode_shape` | 形状短码 → 四层四象限（`subShape` 是 `circle`/`rect` 这类全名，`color` 是 `uncolored`/`red`…） |
| `shapez_find_resource` | 按颜色/形状就近找资源格（距离排序，返回前 N 个） |
| `shapez_ports` | 读建筑真实端口：物料从哪格进、哪格出（世界坐标 + 方向） |
| `shapez_eval` | 在游戏上下文跑一小段 JS（诊断/适配用，只给 shapez/root/hub/map/dump） |
| `shapez_save_game` | 立即写盘（自动存档 60 秒一次；跳关/临时改动后不落盘，刷新页面会退回旧关卡） |
| `shapez_dev_skip_goal` | **仅 dev 构建**：直接完成当前目标进下一关（与游戏内按 `p` 同一条代码路径）；正常游玩不要用 |
| `shapez_set_speed` | `paused` / `regular` / `fast_forward`（不写存档） |
| `shapez_wait_ticks` | 按当前速度等待若干 tick（近似，暂停时立即返回） |

放置建筑的关键事实（都已在游戏里验证）：

- 建筑用的是 **meta id**（`belt`、`miner`、`balancer`、`cutter` …），**没有 `belt_forward` 这种 id**；方向由 `rotationVariant`（传送带 0=直行 1=左转 2=右转）与 `rotation` 决定。
- 最稳的用法是给 `code`（来自 `gBuildingVariants`，如 1/2/3 = 三种传送带），工具会自动带上正确的 variant 与 rotationVariant。
- 层是字符串 `regular` / `wires`，不是数字。
- `rotation` 是**角度**且必须是 90 的倍数（0=上 90=右 180=下 270=左）。传 0..3 的索引会被游戏断言拒绝：`Rotation of static map entity must be multiple of 90`。
- 拐角必须用**弯带**：传送带 `code` 1=直行、2/3=左右转（`rotationVariant`），两条直带在拐角是不通的。`shapez_build_belt_path` 会按进入/离开方向自动选，手工铺带时别硬拼直带。

## 和其他 mod 的关系（兼容性）

- **可以同时装多个 mod**：桌面版把多个 `.js` 丢进 mods 目录；dev 网页构建用 `externalModUrl` 数组。已实测：官方示例 `base.js` + `add_building_basic.js` + 本 mod 同时加载，建筑变体从 59 变成 60，MCP 工具照常工作。
- **本 mod 不 hook、不替换任何游戏方法**，只订阅 `gameStarted` / `gameDeserialized` 并调用公开 API，冲突面和“什么都不做的 mod”一样小。
- **其他 mod 新增的建筑会自动出现**在 `shapez_list_buildings` 里（示例 mod 的新建筑 `code` 就是它的 `buildingId` 字符串），可用 `buildingId` 或该 `code` 放置，已实测能放能删。
- **需要额外验证的场景**：替换了 `root.logic.tryPlaceBuilding` / `tryDeleteBuilding` 的 mod（例如多人同步 mod）。本 mod 直接调底层 API，会绕过这类 mod 的同步逻辑；两者一起用请先确认对方是否依赖方法 hook。
- 本 mod **不再声明 `doesNotAffectSavegame`**：agent 会放/删建筑，存档一定被改，卸载前游戏应当正常提示。
- 游戏会把存档创建时的 mod 列表记进存档，改 mod 后加载会弹「模组警告」（已实测）；这是游戏自身行为，不是本 mod 加的。
- **不兼容 shapez Community Edition**：CE 换了 mod 格式（`.asar` + `mod.json` + `disabled-mods.json`），本仓库只针对原版 1.x 的单文件 `.js` mod。

## 在服务器上跑 dev 网页版（远程访问）

官方网页版不加载 mod，但 `G_IS_DEV` 的 dev 构建会，并且官方留了 mod 取用通道 `globalConfig.debug.externalModUrl`。本仓库验证过的一条路径（Linux，无 sudo）：

```bash
# 1) 依赖：Node 16 + Java（atlas 打包）+ ffmpeg（音频转码），都不用装到系统
#    Node 16 tarball → ~/.local/share/shapez-toolchain/node-v16.20.2-linux-x64
#    Temurin JRE 17 → ~/.local/share/shapez-toolchain/jre17
#    johnvansickle 静态 ffmpeg → ~/.local/share/shapez-toolchain/bin/ffmpeg
git clone --depth 1 https://github.com/tobspr-games/shapez.io shapez-io-dev
cd shapez-io-dev && yarn install            # 约 5 GB node_modules
cd gulp && yarn install && cd ..

# 2) 告诉 dev 构建从哪里取 mod：同源、相对路径（browser-sync 的第二 root 是 mod_examples）
cat > src/js/core/config.local.js <<'EOF'
export default { externalModUrl: "/shapez1-mcp.js" };
EOF
cp <本仓库>/mod/shapez1-mcp.js mod_examples/shapez1-mcp.js   # token 填进 CONFIG.token

# 3) 起服务（默认任务 = serve.web-localhost，browser-sync 监听 :3005，所有网卡）
PATH=~/.local/share/shapez-toolchain/bin:$PATH cd gulp && PATH=... yarn gulp
```

两个坑，踩过：

- **Java 不是可选项**：每次启动都会删 `res_built` 并重建 atlas，jar 下载失败只会 warn，结果是“编得过、贴图全崩”。
- **fluent-ffmpeg 2.1.2 与 ffmpeg 7 的 `-formats` 输出不兼容**：解析出 0 个格式，`sounds.sfxOptimize` 报 `Output format mp3 is not available`。本地补丁在 `gulp/node_modules/fluent-ffmpeg/lib/capabilities.js` 的 `getAvailableFormats` 里（兼容两代列宽），重装依赖后要重新打。

访问 `http://<服务器>:3005`。跨机时 mod 自动连 `ws://<页面主机>:8765`，**必须同时配 `CONFIG.token` 与 `SHAPEZ1_MCP_TOKEN` 并把桥绑到 `0.0.0.0`**（非回环且无 token 时 mod 会拒绝加载）。

## 开发

```bash
npm install
npm start                 # MCP server（stdio + 桥）
npm run mock              # 另开终端：假游戏端，没装游戏时联调
npm run typecheck         # 类型检查
npm run test              # vitest：协议 / 桥 / 工具 / mod 求值 / MCP stdio 端到端
npm run validate          # typecheck + test（收尾必跑）
npm run build             # 编译到 dist/
```

自动玩（脚本只用 MCP 工具，找矿 → 铺传送带 → 送 Hub → 等升级）：

```bash
SHAPEZ1_MCP_TOKEN=... node scripts/auto-play.mjs --max-level 2 --cleanup
```

真实游戏联调（需要先在游戏里进入存档、桥已启动）：

```bash
SHAPEZ1_MCP_TOKEN=... node scripts/live-check.mjs
```

它会拉起 MCP server，依次验证：`status` → `list_buildings` → 放一条传送带 → 查询确认 → 删除确认 → Hub/产出/形状解析 是否报错。

## 安全

- mod 跑在游戏页面里，拥有页面全部权限，并能通过 `contextBridge` 碰到 `ipcRenderer`（可读写 `saves/`）。所以远程部署**必须**配 token；mod 里对非回环地址强制校验 token（没配直接拒绝加载）。
- 桥默认只绑 `127.0.0.1`；绑 `0.0.0.0` 只应在自己的内网里做，别暴露到公网。
- 不要把 token 提交进仓库（`mod_examples` 里的那份是部署副本，不进 git）。

## 合规

- 本仓库不分发游戏源码或美术素材，mod 只调用游戏运行时已暴露的 API。
- shapez 原版仓库 `LICENSE` 是 GPL-3.0（`package.json` 里的 `"license": "MIT"` 与之冲突，不可依赖）。这里不含游戏代码；如果后续把游戏代码拷进来，必须按 GPL-3.0 处理。

## 已验证（真实游戏，2026-11-14）

在自建 dev 网页构建（`serve.web-localhost`）+ 局域网浏览器里验证过：

- mod 加载、token 校验、断线重连、`hello`/请求-响应链路正常。
- `status`：`hasSave`、速度 `RegularGameSpeed`、暂停、当前层、相机、实体数。
- `list_buildings`：59 个变体，`belt` 的 code 是 1/2/3。
- `place_building`（用 `code` 放传送带）→ `query_entities` 确认 → `delete_building` → 再查为空，完整闭环。
- `hub_goals`：等级 1、目标形状 `CuCuCuCu`、需求 10、升级等级与加成。
- `decode_shape`：`CuCuCuCu` → 4 个 `circle`/`uncolored` 象限。
- `production_rates`：三个数据源都返回对象（新存档为空，不报错）。
- **自动通关 1–3 关**（全程只有 MCP 工具调用）：
  1. 第 1 关 `CuCuCuCu` ×10：找 22 格矿、BFS 选路、铺带、放 miner → 交付 10 个升级。
  2. 第 2 关 `----CuCu` ×20：miner → 切割机（2x1，南进北出两条）→ 探针读两条带上的形状（`----CuCu`/`CuCu----`）→ 目标那路进 Hub、废料那路进 trash → 交付 20 个升级。
  3. 第 3 关 `RuRuRuRu` ×30：换矿、重新选路 → 交付 30 个升级。
- 目前停在第 4 关（`RuRu----` ×30，需要「切割 Ru 矿」的产线）。

## 关卡进度（2026-11-14 实测）

- **真实生产打到第 5 关**：第 1 关（`CuCuCuCu` ×10）、第 2 关（切割半形 ×20）、第 3 关（`RuRuRuRu` ×30）、第 4 关（切割 + 选对出料口 ×30）、第 5 关（切割 + 顺时针旋转器 ×75）全部由 MCP 工具自己建线、自己交付。
- 第 6 关起关卡表换成完整版（26 关）。第 6–24 关的产量要求是 270 / 300 / 480 / … / 25000，且形状是多层 + 染色 + 混合，单个会话内建不出这种产线，所以这几关是用 `shapez_dev_skip_goal`（游戏自带 dev 捷径）推进的，**不是生产交付**。
- 当前停在第 24 关（`CcRcCcRc:RwCwRwCw:Sr--Sw--:CyCyCyCy` ×25000），已解锁 23 项奖励，含蓝图、电线/逻辑门、滤器、分离器、四切机、显示器。

> demo 关卡表只有 9 关且第 9 关就结束，要打到 24 关必须让 dev 构建用完整关卡表：
> 在 `src/js/game/modes/levels.js` 的 `generateLevelsForVariant()` 里给 `STANDALONE_LEVELS()` 分支加上 `|| G_IS_DEV`（本地改动，不入库）。

## 仍未验证

1. `wires` 层上的放置/查询/删除（电线、逻辑门）。
2. 放置是否进入撤销栈；`place_buildings` 大批量（上千条）的表现。
2b. 第 2 关起需要切割机（`cutter`）+ 废料（`trash`）的产线，`auto-play.mjs` 目前只会“矿直连 Hub”，不会切形状。
3. `wait_ticks` 的换算是否接近真实 tick 速率（当前按 60 tick/s × 速度倍率估算）。
4. `set_speed` 后存档再读回的行为（预期回正常速度）。
5. `production_rates` 有真实产出时的数值语义（现在只有空对象；切片时长见游戏 `analyticsSliceDurationSeconds`）。
6. Steam 现行 1.6.x 的 ModLoader 与公开仓库（tag 1.5.1）是否一致；`gameVersion` 在 dev 构建里拿不到（返回 `null`）。
7. 桌面版（Electron）里同一套 mod 的加载路径（代码相同，但未在本机跑过）。
