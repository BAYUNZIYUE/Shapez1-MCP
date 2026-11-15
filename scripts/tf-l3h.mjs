/**
 * 十二分形 第 3 关（东西向主流版）——染料链在产线上方各自一条竖列，互不交叉。
 *
 * 端口（实测）：
 *   miner rot90      : 出 (x+1, y)
 *   seamCut rot90    : 进 (x-1,y)，出 (x+1,y)
 *   rotate4 rot90    : 同上
 *   seepPaint rot0   : 占 (x,y),(x+1,y)；进 (x-1,y)；染料 (x+1,y-1)；出 (x+2,y)
 *   mixer rot180     : 占 (x,y),(x-1,y)；两路进 (x,y-1),(x-1,y-1)；出 (x,y+1)
 */
import * as L from "./tf-lib.mjs";

const DRY = process.argv.includes("--dry");
const ORE = "eueueueueueueueueueueueu";

await L.init();
const g = await L.goals();
console.log(`关卡 ${g.level}/${g.levelCount}，目标 ${g.goalShape} ×${g.required}`);

if (!DRY) {
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

// 矿格：向东 22 格空（主流向东）
const resources = (await L.tool("shapez_query_resources", {
  x: L.state.hub.x,
  y: L.state.hub.y,
  radius: 95,
  limit: 5000,
})).value;
const oreTiles = (resources.tiles ?? []).filter((t) => t.shape === ORE);
const candidates = oreTiles
  .map((t) => ({ ...t, score: Math.abs(t.y + 20) + Math.abs(t.x) / 3 }))
  .sort((a, b) => a.score - b.score);
let site = null;
for (const tile of candidates.slice(0, 80)) {
  let ok = true;
  for (let i = 1; i <= 22; i++) if (!L.free(tile.x + i, tile.y)) { ok = false; break; }
  if (ok) { site = tile; break; }
}
if (!site) throw new Error("找不到向东 22 格空的矿格");
const x0 = site.x;
const R = site.y;
console.log(`主产线 y=${R}，矿机 (${x0},${R})，向东`);

const seq = [
  { kind: "miner", x: x0, w: 1, rotation: 90 },
  { kind: "tf_machine_seamCut", x: x0 + 2, w: 1, rotation: 90 },
  { kind: "tf_machine_seepPaint", x: x0 + 4, w: 2, rotation: 0, dye: "white" },
  { kind: "tf_machine_rotate4", x: x0 + 7, w: 1, rotation: 90 },
  { kind: "tf_machine_seamCut", x: x0 + 9, w: 1, rotation: 90 },
  { kind: "tf_machine_seepPaint", x: x0 + 11, w: 2, rotation: 0, dye: "cyan" },
  { kind: "tf_machine_rotate4", x: x0 + 14, w: 1, rotation: 90 },
  { kind: "tf_machine_seamCut", x: x0 + 16, w: 1, rotation: 90 },
  { kind: "tf_machine_seepPaint", x: x0 + 18, w: 2, rotation: 0, dye: "blue" },
];
if (DRY) {
  for (const m of seq) console.log("  ", m.kind, `x=${m.x} y=${R} rot=${m.rotation}`);
  process.exit(0);
}
for (const m of seq) await L.place(m.kind, m.x, R, m.rotation);
for (let i = 0; i < seq.length - 1; i++) {
  const cell = { x: seq[i + 1].x - 1, y: R };
  const res = await L.beltPath({
    from: { x: seq[i].x + seq[i].w - 1, y: R },
    start: cell,
    last: cell,
    target: { x: seq[i + 1].x, y: R },
  });
  if (!res) throw new Error(`主流第 ${i} 段没铺上`);
}
console.log("主流已铺");

const colorTiles = async (color, target) => {
  const out = (await L.tool("shapez_eval", {
    code: `
      var best = [];
      for (var x = ${L.state.hub.x - 100}; x <= ${L.state.hub.x + 100}; x++) {
        for (var y = ${L.state.hub.y - 100}; y <= ${L.state.hub.y + 100}; y++) {
          var it = root.map.getLowerLayerContentXY(x, y);
          if (!it || !it.constructor || it.constructor.name !== "ColorItem" || it.color !== "${color}") continue;
          var d = Math.abs(x - ${target.x}) + Math.abs(y - ${target.y});
          if (best.length < 12) { best.push({ x: x, y: y, d: d }); best.sort(function (a, b) { return a.d - b.d; }); }
          else if (d < best[11].d) { best[11] = { x: x, y: y, d: d }; best.sort(function (a, b) { return a.d - b.d; }); }
        }
      }
      return best;
    `,
  })).value?.value ?? [];
  return Array.isArray(out) ? out : [];
};

const used = new Set();
const feed = async (color, cell, tile, label) => {
  const tiles = (await colorTiles(color, cell))
    .filter((t) => L.free(t.x, t.y) && !used.has(L.key(t.x, t.y)) && L.free(t.x, t.y - 1))
    .sort((a, b) => a.d - b.d)
    .slice(0, 12);
  if (!tiles.length) console.log(`  ${label}: 没有可用 ${color} 矿格（原始 ${(await colorTiles(color, cell)).length}）`);
  for (const t of tiles) {
    used.add(L.key(t.x, t.y));
    const placed = await L.tool("shapez_place_building", { buildingId: "miner", x: t.x, y: t.y, rotation: 0 });
    if (!placed.value?.ok) continue;
    L.state.blocked.add(L.key(t.x, t.y));
    const res = await L.beltPath({ from: { x: t.x, y: t.y }, start: { x: t.x, y: t.y - 1 }, last: cell, target: tile });
    if (res && !res.failed) {
      console.log(`${label}: ${color} 矿 (${t.x},${t.y}) → (${cell.x},${cell.y})，${res.path.length} 格`);
      return true;
    }
    if (res?.failed) console.log(`  ${label} 候选 (${t.x},${t.y})：路径 ${res.cells} 格但铺不上 ${JSON.stringify(res.failedCells).slice(0,120)}`);
    await L.tool("shapez_delete_building", { x: t.x, y: t.y });
    L.state.blocked.delete(L.key(t.x, t.y));
  }
  throw new Error(`${label}: ${color} 没有能走通的矿格（候选 ${tiles.length} 个）`);
};

const straightSouth = async (cells, from, target, label) => {
  const res = await L.tool("shapez_build_belt_path", { cells, from, target });
  if (!res.value || res.value.failed?.length) throw new Error(`${label} 失败`);
  for (const c of cells) L.state.blocked.add(L.key(c.x, c.y));
  console.log(`${label}: ${cells.length} 格`);
};

// 蓝 → paint3（染料口 (x0+19, R-1)）
const portBlue = { x: x0 + 19, y: R - 1 };
await feed("blue", portBlue, { x: portBlue.x, y: R }, "蓝→paint3");

// 青 → paint2：混合器在染料口上方
const portCyan = { x: x0 + 12, y: R - 1 };
const mixerCyan = { x: portCyan.x, y: R - 4 };
await L.place("mixer", mixerCyan.x, mixerCyan.y, 180);
{
  const cells = [];
  for (let y = mixerCyan.y + 1; y <= portCyan.y; y++) cells.push({ x: portCyan.x, y });
  await straightSouth(cells, mixerCyan, { x: portCyan.x, y: R }, "青混合器→paint2");
}
await feed("green", { x: mixerCyan.x, y: mixerCyan.y - 1 }, { x: mixerCyan.x, y: mixerCyan.y }, "青-绿");
await feed("blue", { x: mixerCyan.x - 1, y: mixerCyan.y - 1 }, { x: mixerCyan.x - 1, y: mixerCyan.y }, "青-蓝");

// 白 → paint1：白混合器 + 上方青2
const portWhite = { x: x0 + 5, y: R - 1 };
const mixerWhite = { x: portWhite.x, y: R - 4 };
await L.place("mixer", mixerWhite.x, mixerWhite.y, 180);
{
  const cells = [];
  for (let y = mixerWhite.y + 1; y <= portWhite.y; y++) cells.push({ x: portWhite.x, y });
  await straightSouth(cells, mixerWhite, { x: portWhite.x, y: R }, "白混合器→paint1");
}
const mixerCyan2 = { x: portWhite.x, y: R - 8 };
await L.place("mixer", mixerCyan2.x, mixerCyan2.y, 180);
{
  const cells = [];
  for (let y = mixerCyan2.y + 1; y <= mixerWhite.y - 1; y++) cells.push({ x: portWhite.x, y });
  await straightSouth(cells, mixerCyan2, { x: mixerWhite.x, y: mixerWhite.y - 1 }, "青2→白混合器");
}
await feed("green", { x: mixerCyan2.x, y: mixerCyan2.y - 1 }, { x: mixerCyan2.x, y: mixerCyan2.y }, "青2-绿");
await feed("blue", { x: mixerCyan2.x - 1, y: mixerCyan2.y - 1 }, { x: mixerCyan2.x - 1, y: mixerCyan2.y }, "青2-蓝");
await feed("red", { x: mixerWhite.x - 1, y: mixerWhite.y - 1 }, { x: mixerWhite.x - 1, y: mixerWhite.y }, "白-红");

const probes = [5, 6, 8, 10, 13, 15, 17, 20].map((dx) => ({ x: x0 + dx, y: R }));
const seen = await L.probeShapes(probes, 500, 4);
console.log("\n各级形状：");
for (const [cell, shapes] of seen) console.log(`  ${cell}:`, JSON.stringify([...shapes]));
const lastShapes = [...(seen.get(`${x0 + 20},${R}`) ?? [])];
if (!lastShapes.includes(g.goalShape)) {
  console.log(`\n末级未出目标（现在 ${JSON.stringify(lastShapes)}），先不接 Hub`);
  process.exit(3);
}
const hubRes = await L.beltToHub({ from: { x: x0 + 18, y: R }, start: { x: x0 + 20, y: R } });
if (!hubRes) throw new Error("末级到 Hub 无通路");
console.log(`末级 → Hub：${hubRes.path.length} 格`);
