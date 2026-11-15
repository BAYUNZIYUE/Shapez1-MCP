/**
 * 自动打「需要把半形成再切一刀」的关卡（例如目标 Cu------ = 整圆切两刀取四分之一）。
 *
 *   SHAPEZ1_MCP_TOKEN=... node scripts/auto-play-quarter.mjs [--cleanup] [--skip N]
 *
 * 布局（全部用 MCP 工具铺）：
 *   miner → 2 格进料 → 切割机①（朝北，两个出料口在北侧）
 *   取需要的那条半形出料 → 拐到切割机②的西侧 → 切割机② 转 90°（西进、两个出口朝东）
 *   探针读出两个四分之一 → 目标形状那路接 Hub，另一路接垃圾桶
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const token = process.env.SHAPEZ1_MCP_TOKEN ?? "";
const skipArg = process.argv.indexOf("--skip");
const skipCount = skipArg > 0 ? Number(process.argv[skipArg + 1] ?? 0) : 0;

const child = spawn(join(root, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
  cwd: root,
  env: { ...process.env, SHAPEZ1_MCP_PORT: process.env.SHAPEZ1_MCP_PORT ?? "8765", SHAPEZ1_MCP_HOST: "0.0.0.0", ...(token ? { SHAPEZ1_MCP_TOKEN: token } : {}) },
  stdio: ["pipe", "pipe", "pipe"],
});
const pending = new Map();
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += String(chunk);
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  }
});
let nextId = 1;
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    const timer = setTimeout(() => resolve({ error: "timeout" }), 120_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
const tool = async (name, args = {}) => {
  const res = await rpc("tools/call", { name, arguments: args });
  const text = res.result?.content?.[0]?.text ?? "";
  let value = text;
  try {
    value = JSON.parse(text);
  } catch {
    /* 保留原文 */
  }
  return { isError: res.result?.isError === true, value, text };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DIRS = [
  { dx: 0, dy: -1, rotation: 0, name: "上" },
  { dx: 1, dy: 0, rotation: 90, name: "右" },
  { dx: 0, dy: 1, rotation: 180, name: "下" },
  { dx: -1, dy: 0, rotation: 270, name: "左" },
];
const key = (x, y) => `${x},${y}`;

await sleep(1800);
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "quarter", version: "0" } });
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
for (let attempt = 0; attempt < 20; attempt++) {
  const status = await tool("shapez_status");
  if (status.value?.bridge?.connected) break;
  await sleep(1500);
}

await tool("shapez_dismiss_dialogs");
const hubEntity = (await tool("shapez_query_entities", { buildingId: "hub", limit: 5 })).value?.entities?.[0];
let goals = (await tool("shapez_hub_goals")).value;
const goalShape = goals?.goalShape ?? "";
console.log(`关卡 ${goals?.level}：目标 ${goalShape} ×${goals?.required}`);

const quadrantsOf = (shape) => {
  const first = shape.split(":")[0];
  return first.length === 8 ? (first.match(/.{2}/g) ?? []) : [];
};
const filled = quadrantsOf(goalShape).filter((q) => q !== "--");
if (filled.length !== 1) {
  console.log(`目标 ${goalShape} 不是单象限（四分之一），本脚本不适用`);
  child.kill("SIGTERM");
  process.exit(2);
}
const quarterToken = filled[0];
const sourceShape = quarterToken.repeat(4);
console.log(`四分之一 ${quarterToken}，原料 ${sourceShape}`);

const hubTiles = new Set();
for (let x = hubEntity.x; x < hubEntity.x + hubEntity.width; x++) {
  for (let y = hubEntity.y; y < hubEntity.y + hubEntity.height; y++) {
    hubTiles.add(key(x, y));
  }
}
const entities = async () => (await tool("shapez_query_entities", { limit: 2000 })).value?.entities ?? [];
const blockedSet = async () => {
  const set = new Set();
  for (const entity of await entities()) {
    for (let x = entity.x; x < entity.x + (entity.width ?? 1); x++) {
      for (let y = entity.y; y < entity.y + (entity.height ?? 1); y++) {
        set.add(key(x, y));
      }
    }
  }
  return set;
};

if (process.argv.includes("--cleanup")) {
  const junk = (await entities()).filter(
    (entity) => entity.buildingId !== "hub" && Math.abs(entity.x - hubEntity.x) <= 45 && Math.abs(entity.y - hubEntity.y) <= 45,
  );
  for (const entity of junk) await tool("shapez_delete_building", { x: entity.x, y: entity.y });
  console.log(`清理了 ${junk.length} 个旧建筑`);
}

const bfs = (start, blocked) => {
  const isGoal = (x, y) => DIRS.some((dir) => hubTiles.has(key(x + dir.dx, y + dir.dy)));
  const startKey = key(start.x, start.y);
  if (blocked.has(startKey)) return null;
  const queue = [[start.x, start.y]];
  const from = new Map([[startKey, null]]);
  let visited = 0;
  while (queue.length && visited < 40000) {
    const [cx, cy] = queue.shift();
    visited += 1;
    const current = key(cx, cy);
    if (isGoal(cx, cy)) {
      const path = [];
      let node = current;
      while (node) {
        const [px, py] = node.split(",").map(Number);
        path.unshift({ x: px, y: py });
        node = from.get(node);
      }
      return path;
    }
    for (const dir of DIRS) {
      const nx = cx + dir.dx;
      const ny = cy + dir.dy;
      const k = key(nx, ny);
      if (from.has(k) || blocked.has(k) || hubTiles.has(k)) continue;
      if (Math.abs(nx - hubEntity.x) > 130 || Math.abs(ny - hubEntity.y) > 130) continue;
      from.set(k, current);
      queue.push([nx, ny]);
    }
  }
  return null;
};

const resources = (await tool("shapez_query_resources", { x: hubEntity.x, y: hubEntity.y, radius: 46, limit: 5000 })).value;
const tiles = (resources?.tiles ?? []).filter((tile) => tile.shape === sourceShape);
const blocked = await blockedSet();
const candidates = tiles
  .map((tile) => ({ ...tile, dist: Math.abs(tile.x - hubEntity.x) + Math.abs(tile.y - hubEntity.y) }))
  .filter((tile) => !blocked.has(key(tile.x, tile.y)))
  .sort((a, b) => a.dist - b.dist)
  .slice(skipCount);

const freeChain = (x, y, set) => {
  const cells = [key(x, y - 1), key(x, y - 2), key(x, y - 3), key(x, y - 4), key(x + 1, y - 3), key(x + 1, y - 4), key(x + 1, y - 5), key(x + 1, y - 6), key(x + 1, y - 7), key(x + 1, y - 8), key(x + 2, y - 8)];
  return cells.every((k) => !set.has(k));
};
const site = candidates.find((tile) => freeChain(tile.x, tile.y, blocked));
if (!site) {
  console.log("找不到能放下两级切割的场地");
  child.kill("SIGTERM");
  process.exit(1);
}
const mx = site.x;
const my = site.y;
console.log(`场地 miner@${mx},${my}`);

const place = async (args) => (await tool("shapez_place_building", args)).value;
console.log("miner:", JSON.stringify(await place({ buildingId: "miner", x: mx, y: my, rotation: 0 })));
console.log(
  "进料:",
  JSON.stringify((await tool("shapez_build_belt_path", { cells: [{ x: mx, y: my - 1 }, { x: mx, y: my - 2 }], from: { x: mx, y: my }, target: { x: mx, y: my - 3 } })).value),
);
console.log("切割机①:", JSON.stringify(await place({ buildingId: "cutter", x: mx, y: my - 3, rotation: 0 })));
console.log(
  "出料探针①:",
  JSON.stringify((await tool("shapez_place_buildings", { buildings: [{ code: 1, x: mx, y: my - 4, rotation: 0 }, { code: 1, x: mx + 1, y: my - 4, rotation: 0 }] })).value),
);
await tool("shapez_set_speed", { mode: "regular" });
await tool("shapez_wait_ticks", { ticks: 420 });
const laneLeft = (await tool("shapez_inspect_tile", { x: mx, y: my - 4 })).value?.belt?.items?.[0]?.shape ?? null;
const laneRight = (await tool("shapez_inspect_tile", { x: mx + 1, y: my - 4 })).value?.belt?.items?.[0]?.shape ?? null;
console.log(`第一刀出料：左 ${laneLeft} / 右 ${laneRight}`);
if (!laneLeft || !laneRight) {
  console.log("第一刀没出料（可能被封或矿机没产出），退出");
  child.kill("SIGTERM");
  process.exit(1);
}

// 半形先过旋转器转 90°，再切一刀才是四分之一（切割机只按行切，半形直接再切不变）
const rotorCell = { x: mx + 1, y: my - 5 };
console.log("旋转器:", JSON.stringify(await place({ buildingId: "rotater", x: rotorCell.x, y: rotorCell.y, rotation: 0, variant: "ccw" })));
console.log(
  "过渡带:",
  JSON.stringify((await tool("shapez_build_belt_path", { cells: [{ x: mx + 1, y: my - 6 }], from: rotorCell, target: { x: mx + 1, y: my - 7 } })).value),
);
console.log("切割机②:", JSON.stringify(await place({ buildingId: "cutter", x: mx + 1, y: my - 7, rotation: 0 })));
console.log(
  "出料探针②:",
  JSON.stringify((await tool("shapez_place_buildings", { buildings: [{ code: 1, x: mx + 1, y: my - 8, rotation: 0 }, { code: 1, x: mx + 2, y: my - 8, rotation: 0 }] })).value),
);
await tool("shapez_wait_ticks", { ticks: 600 });
const outA = (await tool("shapez_inspect_tile", { x: mx + 1, y: my - 8 })).value?.belt?.items?.[0]?.shape ?? null;
const outB = (await tool("shapez_inspect_tile", { x: mx + 2, y: my - 8 })).value?.belt?.items?.[0]?.shape ?? null;
console.log(`第二刀出料：${outA} / ${outB}`);

const goalLane = outA === goalShape ? { x: mx + 1, y: my - 8 } : outB === goalShape ? { x: mx + 2, y: my - 8 } : null;
const wasteLane = goalLane?.x === mx + 1 ? { x: mx + 2, y: my - 8 } : { x: mx + 1, y: my - 8 };
if (!goalLane) {
  console.log(`两路都不是 ${goalShape}，先停在这里`);
  child.kill("SIGTERM");
  process.exit(1);
}

const blockedNow = await blockedSet();
blockedNow.delete(key(goalLane.x, goalLane.y));
const path = bfs(goalLane, blockedNow);
if (!path) {
  console.log("目标四分之一到 Hub 没路");
  child.kill("SIGTERM");
  process.exit(1);
}
const last = path[path.length - 1];
const intoHub = DIRS.find((dir) => hubTiles.has(key(last.x + dir.dx, last.y + dir.dy)));
console.log(
  `主带 ${path.length} 格:`,
  JSON.stringify(
    (await tool("shapez_build_belt_path", {
      cells: path,
      from: { x: goalLane.x, y: goalLane.y + 1 },
      ...(intoHub ? { target: { x: last.x + intoHub.dx, y: last.y + intoHub.dy } } : {}),
    })).value,
  ),
);

// 废料：接一个垃圾桶（直行/弯带都试）
let trashOk = false;
for (const dir of DIRS) {
  const target = { x: wasteLane.x + dir.dx, y: wasteLane.y + dir.dy };
  const probe = (await tool("shapez_inspect_tile", { x: target.x, y: target.y })).value;
  if (probe?.building || hubTiles.has(key(target.x, target.y))) continue;
  const feed = await tool("shapez_build_belt_path", {
    cells: [{ x: wasteLane.x, y: wasteLane.y }],
    from: { x: wasteLane.x, y: wasteLane.y + 1 },
    target,
  });
  if (feed.value?.placed !== 1) continue;
  const trash = await place({ buildingId: "trash", x: target.x, y: target.y });
  if (trash?.ok === true) {
    console.log(`废料接桶 @${target.x},${target.y}（${dir.name}）`);
    trashOk = true;
    break;
  }
}
if (!trashOk) console.log("废料没接上桶，这条线会堵");

const rounds = Number(process.env.SHAPEZ_WAIT_ROUNDS ?? Math.max(20, Math.ceil((goals?.required ?? 60) / 4)));
const startLevel = goals?.level ?? 1;
for (let attempt = 0; attempt < rounds; attempt++) {
  await tool("shapez_dismiss_dialogs");
  await tool("shapez_wait_ticks", { ticks: 600 });
  goals = (await tool("shapez_hub_goals")).value;
  console.log(`  交付 ${goals?.delivered ?? 0}/${goals?.required ?? "?"}，关卡 ${goals?.level}`);
  if ((goals?.level ?? startLevel) > startLevel) break;
}
console.log(`\n结果：关卡 ${goals?.level}，目标 ${goals?.goalShape}，已交付 ${goals?.delivered}`);
child.kill("SIGTERM");
await sleep(300);
process.exit(0);
