/**
 * 十二分形（Twelvefold）通用产线：矿石 → 一串 1x1 机器 → Hub。
 *
 *   TF_SEQ="tf_machine_seamCut,tf_machine_rotate4,tf_machine_seamCut,tf_machine_rotate4,tf_machine_seamCut" \
 *   node <local-tmp>/tf-sequence.mjs [--cleanup] [--skip N] [--dry]
 *
 * 布局（一列向上，全部用 MCP 工具铺）：
 *   miner → belt → 机器① → belt → 机器② → … → belt → BFS 到 Hub
 * 脚本会逐级读传送带上的形状，验证每个环节到底做了什么，再决定接不接 Hub。
 */
import { tool, sleep, key } from "<local-tmp>/mcpc.mjs";

const seq = (process.env.TF_SEQ ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (seq.length === 0) {
  console.log("需要 TF_SEQ，例如 TF_SEQ=tf_machine_seamCut,tf_machine_rotate4");
  process.exit(2);
}
const DRY = process.argv.includes("--dry");
const SKIP = (() => {
  const i = process.argv.indexOf("--skip");
  return i > 0 ? Number(process.argv[i + 1] ?? 0) : 0;
})();
const DIRS = [
  { dx: 0, dy: -1, rotation: 0, name: "上" },
  { dx: 1, dy: 0, rotation: 90, name: "右" },
  { dx: 0, dy: 1, rotation: 180, name: "下" },
  { dx: -1, dy: 0, rotation: 270, name: "左" },
];

await tool("shapez_dismiss_dialogs");
await tool("shapez_set_speed", { mode: "regular" });

const goals = (await tool("shapez_hub_goals")).value;
console.log(`关卡 ${goals?.level}：目标 ${goals?.goalShape} ×${goals?.required}，已交付 ${goals?.delivered}`);
const goalShape = goals?.goalShape;

const hubEntity = (await tool("shapez_query_entities", { buildingId: "hub", limit: 5 })).value?.entities?.[0];
const hubTiles = new Set();
for (let x = hubEntity.x; x < hubEntity.x + hubEntity.width; x++) {
  for (let y = hubEntity.y; y < hubEntity.y + hubEntity.height; y++) {
    hubTiles.add(key(x, y));
  }
}

const entities = async () => (await tool("shapez_query_entities", { limit: 2000 })).value?.entities ?? [];
let blocked = new Set();
const refreshBlocked = async () => {
  blocked = new Set();
  for (const entity of await entities()) {
    for (let x = entity.x; x < entity.x + (entity.width ?? 1); x++) {
      for (let y = entity.y; y < entity.y + (entity.height ?? 1); y++) {
        blocked.add(key(x, y));
      }
    }
  }
  return blocked;
};

if (process.argv.includes("--cleanup")) {
  const junk = (await entities()).filter(
    (entity) =>
      entity.buildingId !== "hub" &&
      Math.abs(entity.x - hubEntity.x) <= 55 &&
      Math.abs(entity.y - hubEntity.y) <= 55,
  );
  for (const entity of junk) await tool("shapez_delete_building", { x: entity.x, y: entity.y });
  console.log(`清理了 ${junk.length} 个旧建筑`);
}

await refreshBlocked();

// 矿石：取半径内数量最多、且是 12 象限的那种（十二分形的矿）
const resCall = await tool("shapez_query_resources", { x: hubEntity.x, y: hubEntity.y, radius: 60, limit: 5000 });
if (resCall.isError) {
  console.log("查资源失败:", resCall.value);
  process.exit(1);
}
const res = resCall.value;
const counts = Object.entries(res?.counts ?? {})
  .filter(([hash, n]) => hash !== "null" && n > 20)
  .sort((a, b) => b[1] - a[1]);
if (counts.length === 0) {
  console.log("附近没有矿");
  process.exit(1);
}
const [oreHash, oreCount] = counts[0];
const decoded = (await tool("shapez_decode_shape", { key: oreHash })).value;
if ((decoded?.quadrantCount ?? 0) !== 12) {
  console.log(`最多的矿 ${oreHash} 只有 ${decoded?.quadrantCount} 象限，不是十二分形形状；候选：${JSON.stringify(counts.slice(0, 4))}`);
}
console.log(`矿 ${oreHash}（${oreCount} 格，${decoded?.quadrantCount} 象限）`);

const probes = []; // 每级之后的探针坐标
const height = 2 + seq.length * 2; // miner + belt + (机器 + belt)*n
const corridorFree = (x, y, need) => {
  for (let i = 1; i <= need; i++) {
    if (blocked.has(key(x, y - i))) return false;
  }
  return true;
};
const tiles = (res?.tiles ?? []).filter((t) => t.shape === oreHash);
const candidates = tiles
  .map((t) => ({ ...t, dist: Math.abs(t.x - hubEntity.x) + Math.abs(t.y - hubEntity.y) }))
  .sort((a, b) => a.dist - b.dist)
  .slice(SKIP);
const site = candidates.find((t) => !blocked.has(key(t.x, t.y)) && corridorFree(t.x, t.y, height + 2));
if (!site) {
  console.log("找不到能放下整列机器的矿格");
  process.exit(1);
}
const mx = site.x;
const my = site.y;
console.log(`场地 miner@${mx},${my}（距 Hub ${site.dist}）`);

if (DRY) {
  console.log("dry-run，未放置任何东西");
  process.exit(0);
}

const place = async (args) => (await tool("shapez_place_building", args)).value;
const belt = async (cells, from, target) =>
  (await tool("shapez_build_belt_path", { cells, from, target })).value;

console.log("miner:", JSON.stringify(await place({ buildingId: "miner", x: mx, y: my, rotation: 0 })));

let y = my;
for (let i = 0; i < seq.length; i++) {
  const beltY = y - 1;
  const machineY = y - 2;
  const afterY = y - 3;
  console.log(
    `进料带 ${i}:`,
    JSON.stringify(await belt([{ x: mx, y: beltY }], { x: mx, y }, { x: mx, y: machineY })),
  );
  console.log(
    `机器 ${i} ${seq[i]}:`,
    JSON.stringify(await place({ buildingId: seq[i], x: mx, y: machineY, rotation: 0 })),
  );
  console.log(
    `出料带 ${i}:`,
    JSON.stringify(await belt([{ x: mx, y: afterY }], { x: mx, y: machineY }, { x: mx, y: afterY - 1 })),
  );
  probes.push({ stage: i, machine: seq[i], at: { x: mx, y: beltY }, after: { x: mx, y: afterY } });
  y = afterY;
}
await refreshBlocked();

const readShape = async (cell) => {
  const tile = (await tool("shapez_inspect_tile", { x: cell.x, y: cell.y })).value;
  const items = tile?.belt?.items ?? [];
  return items.length ? items[0].shape : null;
};

const seen = new Map(); // stage -> Set(shapes)
const record = (stage, shape) => {
  if (!shape) return;
  if (!seen.has(stage)) seen.set(stage, new Set());
  seen.get(stage).add(shape);
};

for (let round = 0; round < 6; round++) {
  await tool("shapez_wait_ticks", { ticks: 260 });
  record(-1, await readShape({ x: mx, y: my - 1 }));
  for (const probe of probes) {
    record(probe.stage, await readShape(probe.after));
  }
}

console.log("\n各级传送带上看到过的形状：");
console.log("  矿石后:", JSON.stringify([...(seen.get(-1) ?? [])]));
for (const probe of probes) {
  console.log(`  ${probe.machine} 之后:`, JSON.stringify([...(seen.get(probe.stage) ?? [])]));
}

const lastStageShapes = [...(seen.get(seq.length - 1) ?? [])];
const goalReached = lastStageShapes.includes(goalShape);
console.log(`\n末级是否已产出目标 ${goalShape}: ${goalReached}`);

if (!goalReached) {
  console.log("末级没出目标形状，先不接 Hub（机器链留在原地，便于接着改）");
  process.exit(3);
}

// 从末级出料带接到 Hub
blocked.delete(key(mx, y));
const start = { x: mx, y };
const isGoal = (x, yy) => DIRS.some((d) => hubTiles.has(key(x + d.dx, yy + d.dy)));
const bfs = () => {
  const queue = [[start.x, start.y]];
  const from = new Map([[key(start.x, start.y), null]]);
  const isBlocked = (kx, ky) => (blocked.has(key(kx, ky)) && !(kx === start.x && ky === start.y)) || hubTiles.has(key(kx, ky));
  while (queue.length) {
    const [cx, cy] = queue.shift();
    const cur = key(cx, cy);
    if (isGoal(cx, cy)) {
      const path = [];
      let node = cur;
      while (node) {
        const [px, py] = node.split(",").map(Number);
        path.unshift({ x: px, y: py });
        node = from.get(node);
      }
      return path;
    }
    for (const d of DIRS) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      const k = key(nx, ny);
      if (from.has(k) || isBlocked(nx, ny)) continue;
      if (Math.abs(nx - hubEntity.x) > 120 || Math.abs(ny - hubEntity.y) > 120) continue;
      from.set(k, cur);
      queue.push([nx, ny]);
    }
  }
  return null;
};
const path = bfs();
if (!path) {
  console.log("末级到 Hub 没有通路");
  process.exit(1);
}
const last = path[path.length - 1];
const intoHub = DIRS.find((d) => hubTiles.has(key(last.x + d.dx, last.y + d.dy)));
console.log(
  `接 Hub 主带 ${path.length} 格:`,
  JSON.stringify(
    await belt(path, { x: mx, y: y - 1 }, intoHub ? { x: last.x + intoHub.dx, y: last.y + intoHub.dy } : undefined),
  ),
);

const rounds = Number(process.env.TF_WAIT_ROUNDS ?? Math.max(20, Math.ceil((goals?.required ?? 60) / 3)));
const startLevel = goals?.level ?? 1;
let now = goals;
for (let attempt = 0; attempt < rounds; attempt++) {
  await tool("shapez_dismiss_dialogs");
  await tool("shapez_wait_ticks", { ticks: 500 });
  now = (await tool("shapez_hub_goals")).value;
  console.log(`  交付 ${now?.delivered ?? 0}/${now?.required ?? "?"}，关卡 ${now?.level}`);
  if ((now?.level ?? startLevel) > startLevel) break;
}
console.log(`\n结果：关卡 ${now?.level}，目标 ${now?.goalShape}，已交付 ${now?.delivered}`);
