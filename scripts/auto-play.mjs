/**
 * 用 MCP 工具自动玩 shapez：找矿 → 沿空格铺传送带到 Hub → 放 miner → 等升级。
 *
 *   SHAPEZ1_MCP_TOKEN=... node scripts/auto-play.mjs
 *   SHAPEZ1_MCP_TOKEN=... node scripts/auto-play.mjs --max-level 3 --cleanup
 *
 * 前置：游戏已进入存档、桥端口空闲。脚本只调用 MCP 工具，不碰游戏内部实现。
 * --cleanup：先把 Hub 周围 30 格内本脚本可能留下的 miner/传送带删掉，方便重复跑。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = process.env.SHAPEZ1_MCP_PORT ?? "8765";
const token = process.env.SHAPEZ1_MCP_TOKEN ?? "";
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] ?? fallback : fallback;
};
const maxLevel = Number(arg("--max-level", "2"));
const cleanup = process.argv.includes("--cleanup");

const child = spawn(join(root, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    SHAPEZ1_MCP_PORT: port,
    SHAPEZ1_MCP_HOST: "0.0.0.0",
    ...(token ? { SHAPEZ1_MCP_TOKEN: token } : {}),
  },
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
    /* 错误时保留原文 */
  }
  return { isError: res.result?.isError === true, value, text };
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 游戏里 rotation 是角度（0=上 90=右 180=下 270=左） */
const DIRS = [
  { dx: 0, dy: -1, rotation: 0, name: "上" },
  { dx: 1, dy: 0, rotation: 90, name: "右" },
  { dx: 0, dy: 1, rotation: 180, name: "下" },
  { dx: -1, dy: 0, rotation: 270, name: "左" },
];
const key = (x, y) => `${x},${y}`;
const BELT_CODE = 1;

await sleep(1800);
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "auto-play", version: "0" } });
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

let status = null;
for (let attempt = 0; attempt < 25; attempt++) {
  status = await tool("shapez_status");
  if (status.value?.bridge?.connected) break;
  await sleep(1500);
}
if (!status?.value?.bridge?.connected) {
  console.error("游戏未连接：先打开游戏并进入存档");
  child.kill("SIGTERM");
  process.exit(1);
}

const hubQuery = await tool("shapez_query_entities", { buildingId: "hub", limit: 5 });
const hub = hubQuery.value?.entities?.[0];
if (!hub) {
  console.error("找不到 Hub");
  child.kill("SIGTERM");
  process.exit(1);
}
const hubTiles = new Set();
for (let x = hub.x; x < hub.x + hub.width; x++) {
  for (let y = hub.y; y < hub.y + hub.height; y++) {
    hubTiles.add(key(x, y));
  }
}
console.log(`Hub @ (${hub.x},${hub.y}) ${hub.width}x${hub.height}`);

const snapshot = async () => {
  const all = await tool("shapez_query_entities", { limit: 2000 });
  const entities = all.value?.entities ?? [];
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

if (cleanup) {
  const { entities } = await snapshot();
  const targets = entities.filter(
    (entity) =>
      (entity.buildingId === "belt" || entity.buildingId === "miner") &&
      Math.abs(entity.x - hub.x) <= 32 &&
      Math.abs(entity.y - hub.y) <= 32,
  );
  for (const entity of targets) {
    await tool("shapez_delete_building", { x: entity.x, y: entity.y });
  }
  console.log(`清理了 ${targets.length} 个旧的 miner/传送带`);
}

const pathToHub = (start, blocked) => {
  const goals = new Set();
  for (const tile of hubTiles) {
    const [hx, hy] = tile.split(",").map(Number);
    for (const dir of DIRS) {
      const k = key(hx + dir.dx, hy + dir.dy);
      if (!hubTiles.has(k)) goals.add(k);
    }
  }
  const startKey = key(start.x, start.y);
  if (blocked.has(startKey)) return null;

  const queue = [[start.x, start.y]];
  const cameFrom = new Map([[startKey, null]]);
  let visited = 0;
  while (queue.length > 0 && visited < 40000) {
    const [cx, cy] = queue.shift();
    visited += 1;
    const current = key(cx, cy);
    if (goals.has(current)) {
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
      if (Math.abs(nx - hub.x) > 120 || Math.abs(ny - hub.y) > 120) continue;
      cameFrom.set(k, current);
      queue.push([nx, ny]);
    }
  }
  return null;
};

let goals = await tool("shapez_hub_goals");
console.log(`关卡 ${goals.value?.level}：目标 ${goals.value?.goalShape} ×${goals.value?.required}，已交付 ${goals.value?.delivered}`);

for (let round = 0; round < 8 && (goals.value?.level ?? 1) < maxLevel; round++) {
  const goalShape = goals.value?.goalShape;
  const required = goals.value?.required ?? 10;
  console.log(`\n=== 第 ${goals.value?.level} 关：${goalShape} ×${required} ===`);

  const resources = await tool("shapez_query_resources", { x: hub.x, y: hub.y, radius: 44, limit: 5000 });
  const tiles = (resources.value?.tiles ?? []).filter((tile) => tile.shape === goalShape);
  console.log(`附近 ${goalShape} 资源格：${tiles.length}`);
  if (tiles.length === 0) break;

  const { blocked } = await snapshot();
  const candidates = tiles
    .map((tile) => ({ ...tile, dist: Math.abs(tile.x - hub.x) + Math.abs(tile.y - hub.y) }))
    .filter((tile) => !blocked.has(key(tile.x, tile.y)))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 15);

  let built = null;
  for (const candidate of candidates) {
    const toward =
      Math.abs(hub.x - candidate.x) >= Math.abs(hub.y - candidate.y)
        ? DIRS.find((dir) => dir.dx === Math.sign(hub.x - candidate.x) && dir.dx !== 0)
        : DIRS.find((dir) => dir.dy === Math.sign(hub.y - candidate.y) && dir.dy !== 0);
    if (!toward) continue;
    const front = { x: candidate.x + toward.dx, y: candidate.y + toward.dy };
    if (blocked.has(key(front.x, front.y))) continue;

    const path = pathToHub(front, blocked);
    if (!path) continue;

    const last = path[path.length - 1];
    const hubTarget = DIRS.find((dir) => hubTiles.has(key(last.x + dir.dx, last.y + dir.dy)));
    const beltResult = await tool("shapez_build_belt_path", {
      cells: path,
      from: { x: candidate.x, y: candidate.y },
      ...(hubTarget ? { target: { x: last.x + hubTarget.dx, y: last.y + hubTarget.dy } } : {}),
    });
    const placedCount = beltResult.value?.placed ?? 0;
    if (!beltResult.value || placedCount !== path.length) {
      console.log(`传送带 ${placedCount}/${path.length}：${beltResult.text.slice(0, 160)}`);
      continue;
    }

    const miner = await tool("shapez_place_building", {
      buildingId: "miner",
      x: candidate.x,
      y: candidate.y,
      rotation: toward.rotation,
    });
    if (miner.value?.ok !== true) {
      console.log(`miner 失败 @${candidate.x},${candidate.y}：${miner.value?.reason ?? miner.text}`);
      for (const cell of path) {
        await tool("shapez_delete_building", { x: cell.x, y: cell.y });
      }
      continue;
    }
    console.log(`miner @${candidate.x},${candidate.y} 朝${toward.name}，传送带 ${path.length} 格`);
    built = { candidate, path };
    break;
  }

  if (!built) {
    console.log("找不到能连到 Hub 的路线");
    break;
  }

  await tool("shapez_set_speed", { mode: "regular" });
  const startLevel = goals.value?.level ?? 1;
  for (let attempt = 0; attempt < 15; attempt++) {
    await tool("shapez_wait_ticks", { ticks: 300 });
    goals = await tool("shapez_hub_goals");
    const delivered = goals.value?.delivered ?? 0;
    console.log(`  交付 ${delivered}/${required}，关卡 ${goals.value?.level}`);
    if ((goals.value?.level ?? startLevel) > startLevel) break;
  }
}

goals = await tool("shapez_hub_goals");
console.log(`\n结果：关卡 ${goals.value?.level}，目标 ${goals.value?.goalShape} ×${goals.value?.required}，已交付 ${goals.value?.delivered}，Hub 存货 ${JSON.stringify(goals.value?.stored)}`);
child.kill("SIGTERM");
await sleep(300);
process.exit(0);
