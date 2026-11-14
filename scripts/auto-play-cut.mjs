/**
 * 自动打「需要切割」的关卡：矿 → 切割机 → 目标半形进 Hub / 另一半进垃圾桶。
 *
 *   SHAPEZ1_MCP_TOKEN=... node scripts/auto-play-cut.mjs
 *
 * 只用 MCP 工具。适用条件：当前目标形状是某个完整形状切一半（例如 ----CuCu 由 CuCuCuCu 切出、
 * RuRu---- 由 RuRuRuRu 切出）。遇到需要旋切/染色/堆叠的目标会直接报「不是切割关卡」并退出。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = process.env.SHAPEZ1_MCP_PORT ?? "8765";
const token = process.env.SHAPEZ1_MCP_TOKEN ?? "";

const child = spawn(join(root, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
  cwd: root,
  env: { ...process.env, SHAPEZ1_MCP_PORT: port, SHAPEZ1_MCP_HOST: "0.0.0.0", ...(token ? { SHAPEZ1_MCP_TOKEN: token } : {}) },
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
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "auto-cut", version: "0" } });
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

for (let attempt = 0; attempt < 25; attempt++) {
  const status = await tool("shapez_status");
  if (status.value?.bridge?.connected) break;
  await sleep(1500);
}

const dismiss = async () => {
  const result = await tool("shapez_dismiss_dialogs");
  const dismissed = result.value?.dismissed ?? [];
  if (dismissed.length > 0) console.log("关掉弹窗:", JSON.stringify(dismissed));
  return result.value;
};
await dismiss();

const hubEntity = (await tool("shapez_query_entities", { buildingId: "hub", limit: 5 })).value?.entities?.[0];
let goals = (await tool("shapez_hub_goals")).value;
const goalShape = goals?.goalShape ?? "";
console.log(`关卡 ${goals?.level}：目标 ${goalShape} ×${goals?.required}`);

/**
 * 目标是否是某个完整形状的一半；返回原料形状短码。
 * 象限顺序是 [TR, BR, BL, TL]（顺时针），所以「相邻两格」= 任一半，
 * 例如 Cu----Cu（TR+TL）= 上半圆，CuCu----（TR+BR）= 右半圆。
 */
const sourceOfGoal = (goal) => {
  const firstLayer = goal.split(":")[0];
  if (firstLayer.length !== 8) return null;
  const quadrants = firstLayer.match(/.{2}/g) ?? [];
  const filled = quadrants.map((q, index) => (q === "--" ? null : { token: q, index })).filter(Boolean);
  if (filled.length !== 2) return null;
  const [a, b] = filled;
  if (a.token !== b.token) return null;
  const distance = Math.abs(a.index - b.index);
  if (distance !== 1 && distance !== 3) return null;
  return a.token.repeat(4);
};
const sourceShape = sourceOfGoal(goalShape);
if (!sourceShape) {
  console.log(`目标 ${goalShape} 不是「整形状切一半」，本脚本不适用（需要旋切/染色/堆叠等产线）`);
  child.kill("SIGTERM");
  process.exit(2);
}
console.log(`原料形状：${sourceShape}`);

const hubTiles = new Set();
for (let x = hubEntity.x; x < hubEntity.x + hubEntity.width; x++) {
  for (let y = hubEntity.y; y < hubEntity.y + hubEntity.height; y++) {
    hubTiles.add(key(x, y));
  }
}

const entities = async () => (await tool("shapez_query_entities", { limit: 2000 })).value?.entities ?? [];

if (process.argv.includes("--cleanup")) {
  const junk = (await entities()).filter(
    (entity) =>
      entity.buildingId !== "hub" &&
      Math.abs(entity.x - hubEntity.x) <= 40 &&
      Math.abs(entity.y - hubEntity.y) <= 40,
  );
  for (const entity of junk) {
    await tool("shapez_delete_building", { x: entity.x, y: entity.y });
  }
  console.log(`清理了 ${junk.length} 个旧建筑（Hub 保留）`);
}
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

const bfs = (start, blocked, target) => {
  const startKey = key(start.x, start.y);
  if (blocked.has(startKey)) return null;
  const queue = [[start.x, start.y]];
  const from = new Map([[startKey, null]]);
  let visited = 0;
  while (queue.length && visited < 40000) {
    const [cx, cy] = queue.shift();
    visited += 1;
    const current = key(cx, cy);
    if (target(cx, cy)) {
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
      if (Math.abs(nx - hubEntity.x) > 120 || Math.abs(ny - hubEntity.y) > 120) continue;
      from.set(k, current);
      queue.push([nx, ny]);
    }
  }
  return null;
};

const resources = (await tool("shapez_query_resources", { x: hubEntity.x, y: hubEntity.y, radius: 44, limit: 5000 })).value;
const tiles = (resources?.tiles ?? []).filter((tile) => tile.shape === sourceShape);
console.log(`附近 ${sourceShape} 资源格：${tiles.length}`);
if (tiles.length === 0) {
  child.kill("SIGTERM");
  process.exit(1);
}

const skipArg = process.argv.indexOf("--skip");
const skipCount = skipArg > 0 ? Number(process.argv[skipArg + 1] ?? 0) : 0;
const blocked = await blockedSet();
const candidates = tiles
  .map((tile) => ({ ...tile, dist: Math.abs(tile.x - hubEntity.x) + Math.abs(tile.y - hubEntity.y) }))
  .filter((tile) => !blocked.has(key(tile.x, tile.y)))
  .sort((a, b) => a.dist - b.dist)
  .slice(skipCount);

let site = null;
for (const candidate of candidates.slice(0, 25)) {
  const mx = candidate.x;
  const my = candidate.y;
  const need = [
    key(mx, my - 1),
    key(mx, my - 2),
    key(mx, my - 3),
    key(mx + 1, my - 3),
    key(mx, my - 4),
    key(mx + 1, my - 4),
    key(mx, my - 5),
    key(mx + 1, my - 5),
    key(mx, my - 6),
    key(mx + 1, my - 6),
  ];
  if (need.some((k) => blocked.has(k) || hubTiles.has(k))) continue;
  const laneA = { x: mx, y: my - 4 };
  const laneB = { x: mx + 1, y: my - 4 };
  const isHubAdjacent = (x, y) => DIRS.some((dir) => hubTiles.has(key(x + dir.dx, y + dir.dy)));
  if (!bfs(laneA, blocked, isHubAdjacent) && !bfs(laneB, blocked, isHubAdjacent)) continue;
  site = { mx, my, laneA, laneB };
  break;
}
if (!site) {
  console.log("找不到能放下 miner + 切割机 + 通到 Hub 的场地");
  child.kill("SIGTERM");
  process.exit(1);
}

const { mx, my, laneA, laneB } = site;
console.log(`场地：miner@${mx},${my}，切割机@${mx},${my - 3}，出料 ${JSON.stringify(laneA)} / ${JSON.stringify(laneB)}`);

const place = async (args) => (await tool("shapez_place_building", args)).value;
console.log("miner:", JSON.stringify(await place({ buildingId: "miner", x: mx, y: my, rotation: 0 })));
console.log(
  "进料带:",
  JSON.stringify((await tool("shapez_build_belt_path", { cells: [{ x: mx, y: my - 1 }, { x: mx, y: my - 2 }], from: { x: mx, y: my }, target: { x: mx, y: my - 3 } })).value),
);
console.log("cutter:", JSON.stringify(await place({ buildingId: "cutter", x: mx, y: my - 3, rotation: 0 })));
console.log(
  "探针带:",
  JSON.stringify(
    (await tool("shapez_place_buildings", {
      buildings: [
        { code: 1, x: laneA.x, y: laneA.y, rotation: 0 },
        { code: 1, x: laneB.x, y: laneB.y, rotation: 0 },
      ],
    })).value,
  ),
);

await dismiss();
await tool("shapez_set_speed", { mode: "regular" });
await tool("shapez_wait_ticks", { ticks: 420 });

const readLane = async (lane) => {
  const tile = (await tool("shapez_inspect_tile", { x: lane.x, y: lane.y })).value;
  return tile?.belt?.items?.[0]?.shape ?? null;
};
const shapeA = await readLane(laneA);
const shapeB = await readLane(laneB);
console.log(`出料形状：左 ${shapeA} / 右 ${shapeB}`);
let goalLane = shapeA === goalShape ? laneA : shapeB === goalShape ? laneB : null;
let goalFrom = goalLane ? { x: goalLane.x, y: goalLane.y + 1 } : null;
let goalVariant = null;
let rotorSourceLane = null;

if (!goalLane) {
  // 目标可能是「半形再转 90°」（例如 Cu----Cu = 圆的左半再顺时针转），用旋转器现场试
  for (const lane of [laneA, laneB]) {
    for (const variant of ["default", "ccw"]) {
      const rotorCell = { x: lane.x, y: lane.y - 1 };
      const probeCell = { x: lane.x, y: lane.y - 2 };
      const rotor = await place({ buildingId: "rotater", x: rotorCell.x, y: rotorCell.y, rotation: 0, variant });
      const probe = await place({ code: 1, x: probeCell.x, y: probeCell.y, rotation: 0 });
      if (rotor?.ok !== true || probe?.ok !== true) {
        console.log(`旋转器 ${variant} @${rotorCell.x},${rotorCell.y} 放不下：${rotor?.reason ?? probe?.reason ?? ""}`);
        await tool("shapez_delete_building", { x: rotorCell.x, y: rotorCell.y });
        await tool("shapez_delete_building", { x: probeCell.x, y: probeCell.y });
        continue;
      }
      await tool("shapez_wait_ticks", { ticks: 420 });
      const rotated = await readLane(probeCell);
      console.log(`旋转器 ${variant} @${lane.x},${lane.y}：${rotated}`);
      if (rotated === goalShape) {
        goalLane = probeCell;
        goalFrom = rotorCell;
        goalVariant = variant;
        rotorSourceLane = lane;
        break;
      }
      await tool("shapez_delete_building", { x: rotorCell.x, y: rotorCell.y });
      await tool("shapez_delete_building", { x: probeCell.x, y: probeCell.y });
    }
    if (goalLane) break;
  }
}

// 没通往 Hub 的那条出料要接垃圾桶，否则切割机第二个出料口堵住、整条线停摆
const feedingLane = rotorSourceLane ?? (goalLane === laneA ? laneA : goalLane === laneB ? laneB : null);
const wasteLane = feedingLane === laneA ? laneB : feedingLane === laneB ? laneA : null;
if (!goalLane) {
  console.log("两条出料 + 旋转器都做不出目标形状（可能需要染色/堆叠/混合）");
  child.kill("SIGTERM");
  process.exit(1);
}
console.log(`目标带：${JSON.stringify(goalLane)}${goalVariant ? `（旋转器 ${goalVariant}）` : ""}`);

const blockedNow = await blockedSet();
// 目标出料口自己就是一条探针带，先把它从障碍里摘掉（buildBeltPath 会原地替换它）
blockedNow.delete(key(goalLane.x, goalLane.y));
const isHubAdjacent = (x, y) => DIRS.some((dir) => hubTiles.has(key(x + dir.dx, y + dir.dy)));
const path = bfs(goalLane, blockedNow, isHubAdjacent);
if (!path) {
  console.log("目标出料口到 Hub 找不到路径");
  child.kill("SIGTERM");
  process.exit(1);
}
const last = path[path.length - 1];
const intoHub = DIRS.find((dir) => hubTiles.has(key(last.x + dir.dx, last.y + dir.dy)));
console.log(
  `目标带铺 ${path.length} 格:`,
  JSON.stringify(
    (await tool("shapez_build_belt_path", {
      cells: path,
      from: goalFrom,
      ...(intoHub ? { target: { x: last.x + intoHub.dx, y: last.y + intoHub.dy } } : {}),
    })).value,
  ),
);

// 废料：出料口正上方放垃圾桶；被占用就往边上挪一格
if (wasteLane) {
  const wasteSpot = { x: wasteLane.x, y: wasteLane.y - 1 };
  const existing = (await tool("shapez_inspect_tile", { x: wasteSpot.x, y: wasteSpot.y })).value;
  if (existing?.building) {
    console.log(`废料格 ${wasteSpot.x},${wasteSpot.y} 已被 ${existing.building.buildingId} 占用，跳过垃圾桶`);
  } else {
    console.log("垃圾桶:", JSON.stringify(await place({ buildingId: "trash", x: wasteSpot.x, y: wasteSpot.y })));
  }
} else {
  console.log("没有可识别的废料出料口，跳过垃圾桶");
}

const startLevel = goals?.level ?? 1;
const waitRounds = Math.max(18, Math.ceil((goals?.required ?? 30) / 4));
for (let attempt = 0; attempt < waitRounds; attempt++) {
  await dismiss();
  await tool("shapez_wait_ticks", { ticks: 600 });
  goals = (await tool("shapez_hub_goals")).value;
  console.log(`  交付 ${goals?.delivered ?? 0}/${goals?.required ?? "?"}，关卡 ${goals?.level}`);
  if ((goals?.level ?? startLevel) > startLevel) break;
}
await dismiss();
console.log(`\n结果：关卡 ${goals?.level}，目标 ${goals?.goalShape} ×${goals?.required}，已交付 ${goals?.delivered}`);
child.kill("SIGTERM");
await sleep(300);
process.exit(0);
