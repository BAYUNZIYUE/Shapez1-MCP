/**
 * 十二分形 第 3 关（南向主流版）
 *
 * 主流沿列 C 向南（y 增大），染料从东侧进入——因为染料矿在地图东侧（x≈-58）。
 *
 * 端口（实测）：
 *   miner rot180      : 出 (x, y+1)
 *   seamCut rot180    : 进 (x, y-1)，出 (x, y+1)
 *   rotate4 rot180    : 同上
 *   seepPaint rot90   : 占 (x,y),(x,y+1)；进 (x,y-1)；染料 (x+1,y+1)；出 (x,y+2)
 *   mixer rot270      : 占 (x,y),(x,y-1)；两路进 (x+1,y)、(x+1,y-1)；出 (x-1,y)
 *
 *   node scripts/tf-l3.mjs [--dry] [--keep]
 */
import * as L from "./tf-lib.mjs";

const DRY = process.argv.includes("--dry");
const KEEP = process.argv.includes("--keep");
const ORE = "eueueueueueueueueueueueu";

await L.init();
const g = await L.goals();
console.log(`关卡 ${g.level}/${g.levelCount}，目标 ${g.goalShape} ×${g.required}`);

if (!KEEP && !DRY) {
  const all = (await L.tool("shapez_query_entities", { limit: 2000 })).value.entities;
  let removed = 0;
  for (const e of all) {
    if (e.buildingId === "hub") continue;
    await L.tool("shapez_delete_building", { x: e.x, y: e.y });
    removed += 1;
  }
  console.log(`清场：删掉 ${removed} 个建筑`);
  await L.refreshBlocked();
}

// 选矿格：下方 24 格空，尽量靠近染料区东侧
const resources = (await L.tool("shapez_query_resources", {
  x: L.state.hub.x,
  y: L.state.hub.y,
  radius: 95,
  limit: 5000,
})).value;
const oreTiles = (resources.tiles ?? []).filter((t) => t.shape === ORE);
const preferredX = Number(process.env.TF_COLUMN ?? -74);
const candidates = oreTiles
  .map((t) => ({ ...t, score: Math.abs(t.x - preferredX) + Math.abs(t.y + 10) }))
  .sort((a, b) => a.score - b.score);
let site = null;
let bestScore = -1;
for (const tile of candidates.slice(0, 120)) {
  let ok = true;
  for (let i = 1; i <= 24; i++) {
    if (!L.free(tile.x, tile.y + i)) {
      ok = false;
      break;
    }
  }
  if (!ok) continue;
  // 看这个位置东侧 12 格内三种染料各有多少（本地布线的关键）
  const counts = (await L.tool("shapez_eval", {
    code: `
      var c = { red: 0, green: 0, blue: 0 };
      for (var x = ${tile.x + 2}; x <= ${tile.x + 16}; x++) {
        for (var y = ${tile.y - 8}; y <= ${tile.y + 26}; y++) {
          var it = root.map.getLowerLayerContentXY(x, y);
          if (it && it.constructor && it.constructor.name === "ColorItem" && c[it.color] !== undefined) c[it.color]++;
        }
      }
      return c;
    `,
  })).value?.value;
  const score = (counts?.red ?? 0) + (counts?.green ?? 0) + (counts?.blue ?? 0);
  if (score > bestScore) {
    bestScore = score;
    site = { ...tile, counts };
  }
}
if (!site) throw new Error("找不到下方 24 格空的矿格");
const C = site.x;
const y0 = site.y;
console.log(`主产线列 x=${C}，矿机 (${C},${y0})，向南；东侧染料分布 ${JSON.stringify(site.counts)}`);

const seq = [
  { kind: "miner", y: y0, height: 1, rotation: 180 },
  { kind: "tf_machine_seamCut", y: y0 + 2, height: 1, rotation: 180 },
  { kind: "tf_machine_seepPaint", y: y0 + 4, height: 2, rotation: 90, dye: "white" },
  { kind: "tf_machine_rotate4", y: y0 + 7, height: 1, rotation: 180 },
  { kind: "tf_machine_seamCut", y: y0 + 9, height: 1, rotation: 180 },
  { kind: "tf_machine_seepPaint", y: y0 + 11, height: 2, rotation: 90, dye: "cyan" },
  { kind: "tf_machine_rotate4", y: y0 + 14, height: 1, rotation: 180 },
  { kind: "tf_machine_seamCut", y: y0 + 16, height: 1, rotation: 180 },
  { kind: "tf_machine_seepPaint", y: y0 + 18, height: 2, rotation: 90, dye: "blue" },
];
if (DRY) {
  for (const m of seq) console.log("  ", m.kind, `x=${C} y=${m.y} rot=${m.rotation}`);
  process.exit(0);
}

for (const m of seq) await L.place(m.kind, C, m.y, m.rotation);
for (let i = 0; i < seq.length - 1; i++) {
  const cell = { x: C, y: seq[i + 1].y - 1 };
  const res = await L.beltPath({
    from: { x: C, y: seq[i].y },
    start: cell,
    last: cell,
    target: { x: C, y: seq[i + 1].y },
  });
  if (!res) throw new Error(`主产线第 ${i} 段没铺上`);
}
console.log("主产线已铺");

// 染料口：paint rot90 在 (C,y) 占 y..y+1，染料口 = (C+1, y+1)，目标格 (C, y+1)
const dyePort = (machineY) => ({ cell: { x: C + 1, y: machineY + 1 }, target: { x: C, y: machineY + 1 } });

// 注意：mod 的 dump 会把数组截到 12 项，所以让游戏只回「离目标最近的 12 个」。
const colorTiles = async (color, target) => {
  const out = (await L.tool("shapez_eval", {
    code: `
      var best = [];
      for (var x = ${C + 2}; x <= ${L.state.hub.x + 100}; x++) {
        for (var y = ${L.state.hub.y - 100}; y <= ${L.state.hub.y + 100}; y++) {
          var it = root.map.getLowerLayerContentXY(x, y);
          if (!it || !it.constructor || it.constructor.name !== "ColorItem" || it.color !== "${color}") continue;
          var d = Math.abs(x - ${target.x}) + Math.abs(y - ${target.y});
          if (best.length < 12) {
            best.push({ x: x, y: y, d: d });
            best.sort(function (a, b) { return a.d - b.d; });
          } else if (d < best[11].d) {
            best[11] = { x: x, y: y, d: d };
            best.sort(function (a, b) { return a.d - b.d; });
          }
        }
      }
      return best;
    `,
  })).value?.value ?? [];
  return Array.isArray(out) ? out : [];
};

const used = new Set();
const feedColor = async (color, targetCell, machineTile, label) => {
  const tiles = (await colorTiles(color, targetCell))
    .filter((t) => L.free(t.x, t.y) && !used.has(L.key(t.x, t.y)) && L.free(t.x, t.y - 1))
    .map((t) => ({ ...t, d: Math.abs(t.x - targetCell.x) + Math.abs(t.y - targetCell.y) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 30);
  for (const tile of tiles) {
    used.add(L.key(tile.x, tile.y));
    const placed = await L.tool("shapez_place_building", { buildingId: "miner", x: tile.x, y: tile.y, rotation: 0 });
    if (!placed.value?.ok) continue;
    L.state.blocked.add(L.key(tile.x, tile.y));
    const res = await L.beltPath({
      from: { x: tile.x, y: tile.y },
      start: { x: tile.x, y: tile.y - 1 },
      last: targetCell,
      target: machineTile,
    });
    if (res) {
      console.log(`${label}: ${color} 矿 (${tile.x},${tile.y}) → (${targetCell.x},${targetCell.y})，${res.path.length} 格`);
      return res;
    }
    await L.tool("shapez_delete_building", { x: tile.x, y: tile.y });
    L.state.blocked.delete(L.key(tile.x, tile.y));
    if (tiles.indexOf(tile) === 0) console.log(`  ${label} 首个候选 (${tile.x},${tile.y}) 走不通，继续试`);
  }
  throw new Error(`${label}: ${color} 没有能走通的矿格（候选 ${tiles.length} 个）`);
};

const straightWest = async (cells, from, target, label) => {
  const res = await L.tool("shapez_build_belt_path", { cells, from, target });
  if (!res.value || res.value.failed?.length) throw new Error(`${label} 铺带失败`);
  for (const c of cells) L.state.blocked.add(L.key(c.x, c.y));
  console.log(`${label}: ${cells.length} 格`);
};

// 蓝 → paint3
const p3 = dyePort(y0 + 18);
await feedColor("blue", p3.cell, p3.target, "蓝→paint3");

// 青 → paint2（混合器在染料口东侧，出料向西）
const p2 = dyePort(y0 + 11);
const mixerCyan = { x: C + 5, y: p2.cell.y };
await L.place("mixer", mixerCyan.x, mixerCyan.y, 270);
{
  const cells = [];
  for (let x = mixerCyan.x - 1; x >= p2.cell.x; x--) cells.push({ x, y: p2.cell.y });
  await straightWest(cells, { x: mixerCyan.x, y: p2.cell.y }, p2.target, "青混合器→paint2");
}
await feedColor("green", { x: mixerCyan.x + 1, y: p2.cell.y }, { x: mixerCyan.x, y: p2.cell.y }, "青-绿");
await feedColor("blue", { x: mixerCyan.x + 1, y: p2.cell.y - 1 }, { x: mixerCyan.x, y: p2.cell.y - 1 }, "青-蓝");

// 白 = 青2 + 红 → paint1
const p1 = dyePort(y0 + 4);
const mixerWhite = { x: C + 5, y: p1.cell.y };
await L.place("mixer", mixerWhite.x, mixerWhite.y, 270);
{
  const cells = [];
  for (let x = mixerWhite.x - 1; x >= p1.cell.x; x--) cells.push({ x, y: p1.cell.y });
  await straightWest(cells, { x: mixerWhite.x, y: p1.cell.y }, p1.target, "白混合器→paint1");
}
const mixerCyan2 = { x: C + 9, y: p1.cell.y };
await L.place("mixer", mixerCyan2.x, mixerCyan2.y, 270);
{
  const cells = [];
  for (let x = mixerCyan2.x - 1; x >= mixerWhite.x + 1; x--) cells.push({ x, y: p1.cell.y });
  await straightWest(cells, { x: mixerCyan2.x, y: p1.cell.y }, { x: mixerWhite.x, y: p1.cell.y }, "青2→白混合器");
}
await feedColor("green", { x: mixerCyan2.x + 1, y: p1.cell.y }, { x: mixerCyan2.x, y: p1.cell.y }, "青2-绿");
await feedColor("blue", { x: mixerCyan2.x + 1, y: p1.cell.y - 1 }, { x: mixerCyan2.x, y: p1.cell.y - 1 }, "青2-蓝");
await feedColor("red", { x: mixerWhite.x + 1, y: p1.cell.y - 1 }, { x: mixerWhite.x, y: p1.cell.y - 1 }, "白-红");

// 探针
const probes = [y0 + 3, y0 + 6, y0 + 8, y0 + 10, y0 + 13, y0 + 15, y0 + 17, y0 + 20].map((y) => ({ x: C, y }));
const seen = await L.probeShapes(probes, 500, 4);
console.log("\n各级形状：");
for (const [cell, shapes] of seen) console.log(`  ${cell}:`, JSON.stringify([...shapes]));
const lastShapes = [...(seen.get(`${C},${y0 + 20}`) ?? [])];
if (!lastShapes.includes(g.goalShape)) {
  console.log(`\n末级未出目标（现在 ${JSON.stringify(lastShapes)}），先不接 Hub`);
  process.exit(3);
}

const hubRes = await L.beltToHub({ from: { x: C, y: y0 + 18 }, start: { x: C, y: y0 + 20 } });
if (!hubRes) throw new Error("末级到 Hub 无通路");
console.log(`末级 → Hub：${hubRes.path.length} 格，进 ${JSON.stringify(hubRes.into)}`);

const rounds = Number(process.env.TF_WAIT_ROUNDS ?? 40);
let now = g;
for (let i = 0; i < rounds; i++) {
  await L.tool("shapez_dismiss_dialogs");
  await L.tool("shapez_wait_ticks", { ticks: 500 });
  now = await L.goals();
  console.log(`  交付 ${now.delivered}/${now.required}，关卡 ${now.level}`);
  if (now.level > g.level) break;
}
console.log(`\n结果：关卡 ${now.level}，目标 ${now.goalShape}，已交付 ${now.delivered}`);
