/**
 * 第 2 关用：circle 矿 → 切割机 → 目标半形进 Hub / 另一半进 trash。
 *
 *   SHAPEZ1_MCP_TOKEN=... node scripts/build-cutter-line.mjs
 *
 * 只用 MCP 工具。切割机 2x1：输入在南侧（slot (0,0) 朝下），两个输出在北侧
 * （slot (0,0) 与 (1,0) 朝上）。先各接 1 格探针传送带，读出两条带上的形状，
 * 再把目标形状那条接到 Hub，另一条接 trash。
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
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cutter-line", version: "0" } });
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

for (let attempt = 0; attempt < 25; attempt++) {
  const status = await tool("shapez_status");
  if (status.value?.bridge?.connected) break;
  await sleep(1500);
}

const hubEntity = (await tool("shapez_query_entities", { buildingId: "hub", limit: 5 })).value?.entities?.[0];
const goals = (await tool("shapez_hub_goals")).value;
console.log(`关卡 ${goals?.level} 目标 ${goals?.goalShape} ×${goals?.required}`);
const goalShape = goals?.goalShape;
const hubTiles = new Set();
for (let x = hubEntity.x; x < hubEntity.x + hubEntity.width; x++) {
  for (let y = hubEntity.y; y < hubEntity.y + hubEntity.height; y++) {
    hubTiles.add(key(x, y));
  }
}

const snapshot = async () => {
  const entities = (await tool("shapez_query_entities", { limit: 2000 })).value?.entities ?? [];
  const blocked = new Set();
  for (const entity of entities) {
    for (let x = entity.x; x < entity.x + (entity.width ?? 1); x++) {
      for (let y = entity.y; y < entity.y + (entity.height ?? 1); y++) {
        blocked.add(key(x, y));
      }
    }
  }
  return { entities, blocked };
};

const bfs = (start, blocked, isGoal) => {
  const startKey = key(start.x, start.y);
  if (blocked.has(startKey)) return null;
  const queue = [[start.x, start.y]];
  const cameFrom = new Map([[startKey, null]]);
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
        node = cameFrom.get(node);
      }
      return path;
    }
    for (const dir of DIRS) {
      const nx = cx + dir.dx;
      const ny = cy + dir.dy;
      const k = key(nx, ny);
      if (cameFrom.has(k) || blocked.has(k) || hubTiles.has(k)) continue;
      if (Math.abs(nx - hubEntity.x) > 120 || Math.abs(ny - hubEntity.y) > 120) continue;
      cameFrom.set(k, current);
      queue.push([nx, ny]);
    }
  }
  return null;
};

const resources = (await tool("shapez_query_resources", { x: hubEntity.x, y: hubEntity.y, radius: 40, limit: 4000 })).value;
const fullShape = (resources?.tiles ?? []).find((tile) => tile.shape && tile.shape.includes("Cu"))?.shape;
console.log(`资源形状候选：${fullShape}，目标半形：${goalShape}`);
const tiles = (resources?.tiles ?? []).filter((tile) => tile.shape === fullShape);
console.log(`可作为原料的资源格：${tiles.length}`);

const { blocked } = await snapshot();
const candidates = tiles
  .map((tile) => ({ ...tile, dist: Math.abs(tile.x - hubEntity.x) + Math.abs(tile.y - hubEntity.y) }))
  .filter((tile) => !blocked.has(key(tile.x, tile.y)))
  .sort((a, b) => a.dist - b.dist);

let site = null;
for (const candidate of candidates.slice(0, 20)) {
  const mx = candidate.x;
  const my = candidate.y;
  const need = [
    key(mx, my - 1),
    key(mx, my - 2),
    key(mx, my - 3),
    key(mx + 1, my - 3),
    key(mx, my - 4),
    key(mx + 1, my - 4),
  ];
  if (need.some((k) => blocked.has(k) || hubTiles.has(k))) continue;
  const laneA = { x: mx, y: my - 4 };
  const laneB = { x: mx + 1, y: my - 4 };
  const pathA = bfs(laneA, blocked, (x, y) => {
    for (const dir of DIRS) if (hubTiles.has(key(x + dir.dx, y + dir.dy))) return true;
    return false;
  });
  if (!pathA) continue;
  site = { mx, my, laneA, laneB, pathA };
  break;
}
if (!site) {
  console.log("没找到能同时放下 miner + 切割机 + 到 Hub 的场地");
  child.kill("SIGTERM");
  process.exit(1);
}

const { mx, my, laneA, laneB } = site;
console.log(`场地：miner@${mx},${my}，切割机@${mx},${my - 3}，输出 ${JSON.stringify(laneA)} / ${JSON.stringify(laneB)}`);

const place = async (args) => (await tool("shapez_place_building", args)).value;
console.log("miner:", JSON.stringify(await place({ buildingId: "miner", x: mx, y: my, rotation: 0 })));
await tool("shapez_place_buildings", {
  buildings: [
    { code: 1, x: mx, y: my - 1, rotation: 0 },
    { code: 1, x: mx, y: my - 2, rotation: 0 },
  ],
});
console.log("cutter:", JSON.stringify(await place({ buildingId: "cutter", x: mx, y: my - 3, rotation: 0 })));
console.log("探针传送带:", JSON.stringify((await tool("shapez_place_buildings", { buildings: [{ code: 1, ...laneA, rotation: 0 }, { code: 1, ...laneB, rotation: 0 }] })).value));

await tool("shapez_wait_ticks", { ticks: 420 });
const probeA = (await tool("shapez_inspect_tile", { x: laneA.x, y: laneA.y })).value;
const probeB = (await tool("shapez_inspect_tile", { x: laneB.x, y: laneB.y })).value;
console.log("左带:", JSON.stringify(probeA?.belt), "右带:", JSON.stringify(probeB?.belt));

const shapeA = probeA?.belt?.items?.[0]?.shape ?? null;
const shapeB = probeB?.belt?.items?.[0]?.shape ?? null;
const goalLane = shapeA === goalShape ? laneA : shapeB === goalShape ? laneB : null;
const wasteLane = goalLane === laneA ? laneB : goalLane === laneB ? laneA : null;
if (!goalLane) {
  console.log(`两条带上的形状都不是 ${goalShape}（${shapeA} / ${shapeB}），先停下`);
  child.kill("SIGTERM");
  process.exit(0);
}

const { blocked: blockedNow } = await snapshot();
const rest = site.pathA.slice(1);
const last = rest[rest.length - 1];
const intoHub = DIRS.find((d) => hubTiles.has(key(last.x + d.dx, last.y + d.dy)));
const beltResult = await tool("shapez_build_belt_path", {
  cells: rest,
  from: goalLane,
  ...(intoHub ? { target: { x: last.x + intoHub.dx, y: last.y + intoHub.dy } } : {}),
});
console.log(`目标形状在 ${goalLane === laneA ? "左" : "右"} 带，铺带结果:`, JSON.stringify(beltResult.value));

// 废料：目标带之外的那条，往上接 1 格传送带 + trash
const waste = { x: wasteLane.x, y: wasteLane.y - 1 };
console.log("废料弯带:", JSON.stringify((await tool("shapez_build_belt_path", { cells: [wasteLane], from: { x: wasteLane.x, y: wasteLane.y + 1 }, target: { x: wasteLane.x, y: wasteLane.y - 1 } })).value));
console.log("trash:", JSON.stringify(await place({ buildingId: "trash", x: waste.x, y: waste.y })));

for (let attempt = 0; attempt < 15; attempt++) {
  await tool("shapez_wait_ticks", { ticks: 300 });
  const now = (await tool("shapez_hub_goals")).value;
  console.log(`  交付 ${now?.delivered}/${now?.required}，关卡 ${now?.level}`);
  if ((now?.level ?? 1) > 2) break;
}
const final = (await tool("shapez_hub_goals")).value;
console.log(`\n结果：关卡 ${final?.level}，目标 ${final?.goalShape} ×${final?.required}，已交付 ${final?.delivered}`);
child.kill("SIGTERM");
await sleep(300);
process.exit(0);
