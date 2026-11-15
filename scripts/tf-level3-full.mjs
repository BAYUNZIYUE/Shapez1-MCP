/**
 * 十二分形 第 3 关（整线重建版）：主产线搬到染料区旁边，只留短的染料带。
 *
 *   矿(无接缝) → 切缝 → 渗染(白) → 转120° → 切缝 → 渗染(青) → 转120° → 切缝 → 渗染(蓝) → Hub
 *   白 = (绿+蓝=青) + 红；青 = 绿+蓝；蓝直接挖
 *
 *   node scripts/tf-level3-full.mjs [--dry] [--keep]
 *   --keep 只建不清理（调试用）
 */
import * as L from "./tf-lib.mjs";

const DRY = process.argv.includes("--dry");
const KEEP = process.argv.includes("--keep");
const ORE = "eueueueueueueueueueueueu";

await L.init();
const g = await L.goals();
console.log(`关卡 ${g.level}/${g.levelCount}，目标 ${g.goalShape} ×${g.required}`);

// 1) 清场：只留 Hub
if (!KEEP && !DRY) {
  const all = (await L.tool("shapez_query_entities", { limit: 2000 })).value.entities;
  let removed = 0;
  for (const e of all) {
    if (e.buildingId === "hub") continue;
    await L.tool("shapez_delete_building", { x: e.x, y: e.y });
    removed += 1;
  }
  console.log(`清场：删掉 ${removed} 个建筑（含旧矿机与旧产线）`);
  await L.refreshBlocked();
}

// 2) 选矿格：上方 26 格空，尽量靠近染料区（x ≈ -45）
const resources = (await L.tool("shapez_query_resources", {
  x: L.state.hub.x,
  y: L.state.hub.y,
  radius: 90,
  limit: 5000,
})).value;
const oreTiles = (resources.tiles ?? []).filter((t) => t.shape === ORE);
const candidates = oreTiles
  .map((t) => ({ ...t, score: Math.abs(t.x + 72) + Math.abs(t.y - 10) }))
  .sort((a, b) => a.score - b.score);
let site = null;
for (const tile of candidates.slice(0, 80)) {
  let ok = true;
  for (let i = 1; i <= 27; i++) {
    if (!L.free(tile.x, tile.y - i)) {
      ok = false;
      break;
    }
  }
  if (ok) {
    site = tile;
    break;
  }
}
if (!site) throw new Error("找不到上方 27 格空的矿格");
const C = site.x;
const y0 = site.y;
console.log(`主产线列 x=${C}，矿机 (${site.x},${site.y})`);

// 3) 主产线
const machines = [
  { kind: "miner", y: y0, height: 1 },
  { kind: "tf_machine_seamCut", y: y0 - 2, height: 1 },
  { kind: "tf_machine_seepPaint", y: y0 - 4, height: 2, dye: "white" },
  { kind: "tf_machine_rotate4", y: y0 - 7, height: 1 },
  { kind: "tf_machine_seamCut", y: y0 - 9, height: 1 },
  { kind: "tf_machine_seepPaint", y: y0 - 11, height: 2, dye: "cyan" },
  { kind: "tf_machine_rotate4", y: y0 - 14, height: 1 },
  { kind: "tf_machine_seamCut", y: y0 - 16, height: 1 },
  { kind: "tf_machine_seepPaint", y: y0 - 18, height: 2, dye: "blue" },
];
if (DRY) {
  for (const m of machines) console.log("  ", m.kind, `x=${C} y=${m.y}`);
  process.exit(0);
}
for (const m of machines) {
  await L.place(m.kind, C, m.y, m.kind === "tf_machine_seepPaint" ? 270 : 0);
}
for (let i = 0; i < machines.length - 1; i++) {
  const cell = { x: C, y: machines[i + 1].y + 1 };
  const res = await L.beltPath({
    from: { x: C, y: machines[i].y },
    start: cell,
    last: cell,
    target: { x: C, y: machines[i + 1].y },
  });
  if (!res) throw new Error(`主产线第 ${i} 段没铺上`);
}
console.log("主产线已铺");

// 4) 染料
const ports = {
  white: { y: y0 - 5 },
  cyan: { y: y0 - 12 },
  blue: { y: y0 - 19 },
};

const colorTilesCache = {};
const colorTiles = async (color) => {
  if (colorTilesCache[color]) return colorTilesCache[color];
  const out = (await L.tool("shapez_eval", {
    code: `
      var hub = ${JSON.stringify({ x: L.state.hub.x, y: L.state.hub.y })};
      var res = [];
      for (var x = hub.x - 90; x <= hub.x + 20 && res.length < 400; x++) {
        for (var y = hub.y - 90; y <= hub.y + 90 && res.length < 400; y++) {
          var it = root.map.getLowerLayerContentXY(x, y);
          if (it && it.constructor && it.constructor.name === "ColorItem" && it.color === "${color}") res.push({ x: x, y: y });
        }
      }
      return res;
    `,
  })).value?.value ?? [];
  colorTilesCache[color] = out;
  return out;
};

const usedMinerTiles = new Set();
const feedColor = async (color, targetCell, machineTile, label) => {
  const tiles = (await colorTiles(color))
    .filter((t) => L.free(t.x, t.y) && !usedMinerTiles.has(L.key(t.x, t.y)) && L.free(t.x, t.y - 1))
    .map((t) => ({ ...t, d: Math.abs(t.x - targetCell.x) + Math.abs(t.y - targetCell.y) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 25);
  let lastErr = null;
  for (const tile of tiles) {
    usedMinerTiles.add(L.key(tile.x, tile.y));
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
    // 走不通就拆掉这台矿机，换下一个矿格
    await L.tool("shapez_delete_building", { x: tile.x, y: tile.y });
    L.state.blocked.delete(L.key(tile.x, tile.y));
    lastErr = tile;
  }
  throw new Error(`${label}: ${color} 找不到能走通的矿格（试过 ${tiles.length} 个，最后 ${JSON.stringify(lastErr)}）`);
};

const straightEast = async (cells, from, target, label) => {
  const res = await L.tool("shapez_build_belt_path", { cells, from, target });
  if (res.value?.failed?.length) throw new Error(`${label} 铺带有失败格子`);
  for (const c of cells) L.state.blocked.add(L.key(c.x, c.y));
  console.log(`${label}: ${cells.length} 格`);
};

// 4a) 蓝 → paint3
await feedColor("blue", { x: C - 1, y: ports.blue.y }, { x: C, y: ports.blue.y }, "蓝→paint3");

// 4b) 青：混合器在西侧同一行
const cyanMixer = { x: C - 6, y: ports.cyan.y };
await L.place("mixer", cyanMixer.x, cyanMixer.y, 90);
const cyanBelts = [];
for (let x = cyanMixer.x + 1; x <= C - 1; x++) cyanBelts.push({ x, y: ports.cyan.y });
await straightEast(cyanBelts, { x: cyanMixer.x, y: ports.cyan.y }, { x: C, y: ports.cyan.y }, "青混合器→paint2");
await feedColor("green", { x: cyanMixer.x - 1, y: ports.cyan.y }, { x: cyanMixer.x, y: ports.cyan.y }, "青-绿");
await feedColor("blue", { x: cyanMixer.x - 1, y: ports.cyan.y + 1 }, { x: cyanMixer.x, y: ports.cyan.y + 1 }, "青-蓝");

// 4c) 白 = 青2 + 红
const whiteMixer = { x: C - 6, y: ports.white.y };
const cyan2 = { x: C - 10, y: ports.white.y };
await L.place("mixer", cyan2.x, cyan2.y, 90);
await L.place("mixer", whiteMixer.x, whiteMixer.y, 90);
const between = [];
for (let x = cyan2.x + 1; x <= whiteMixer.x - 1; x++) between.push({ x, y: ports.white.y });
await straightEast(between, { x: cyan2.x, y: ports.white.y }, { x: whiteMixer.x, y: ports.white.y }, "青2→白混合器");
const outBelts = [];
for (let x = whiteMixer.x + 1; x <= C - 1; x++) outBelts.push({ x, y: ports.white.y });
await straightEast(outBelts, { x: whiteMixer.x, y: ports.white.y }, { x: C, y: ports.white.y }, "白混合器→paint1");
await feedColor("green", { x: cyan2.x - 1, y: ports.white.y }, { x: cyan2.x, y: ports.white.y }, "青2-绿");
await feedColor("blue", { x: cyan2.x - 1, y: ports.white.y + 1 }, { x: cyan2.x, y: ports.white.y + 1 }, "青2-蓝");
await feedColor("red", { x: whiteMixer.x - 1, y: ports.white.y + 1 }, { x: whiteMixer.x, y: ports.white.y + 1 }, "白-红");

// 5) 探针
const probeCells = [
  { x: C, y: y0 - 3 },
  { x: C, y: y0 - 6 },
  { x: C, y: y0 - 8 },
  { x: C, y: y0 - 10 },
  { x: C, y: y0 - 13 },
  { x: C, y: y0 - 15 },
  { x: C, y: y0 - 17 },
  { x: C, y: y0 - 20 },
];
const seen = await L.probeShapes(probeCells, 500, 3);
console.log("\n各级形状：");
for (const [cell, shapes] of seen) console.log(`  ${cell}:`, JSON.stringify([...shapes]));
const lastShapes = [...(seen.get(`${C},${y0 - 20}`) ?? [])];
if (!lastShapes.includes(g.goalShape)) {
  console.log(`\n末级未出目标（现在 ${JSON.stringify(lastShapes)}），先不接 Hub`);
  process.exit(3);
}

// 6) 接 Hub
const hubRes = await L.beltToHub({ from: { x: C, y: y0 - 18 }, start: { x: C, y: y0 - 20 } });
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
