/**
 * 第 3 关 v4：产线向西流、渗染口朝南 —— 染料矿本来就在南侧，于是不用跨产线。
 *
 * 端口（实测）：
 *   miner rot270     : 出 (x-1, y)
 *   seamCut rot270   : 进 (x+1, y)，出 (x-1, y)
 *   rotate4 rot270   : 同上
 *   seepPaint rot180 : 占 (x,y),(x-1,y)；形进 (x+1,y)；染料 (x-1,y+1)；出 (x-2,y)
 *   mixer rot0       : 占 (x,y),(x+1,y)；两路进 (x,y+1),(x+1,y+1)；出 (x,y-1)
 */
import * as L from "./tf-lib.mjs";

const ORE = "eueueueueueueueueueueueu";

await L.init();
const g = await L.goals();
console.log(`关卡 ${g.level}/${g.levelCount}，目标 ${g.goalShape} ×${g.required}`);

// 清场
{
  const all = (await L.tool("shapez_query_entities", { limit: 2000 })).value.entities;
  let removed = 0;
  for (const e of all) {
    if (e.buildingId === "hub") continue;
    await L.tool("shapez_delete_building", { x: e.x, y: e.y });
    removed += 1;
  }
  console.log(`清场 ${removed} 个`);
  await L.refreshBlocked();
}

// 选矿格：向西 22 格空，且南侧 16 行内空（放染料区）
const resources = (await L.tool("shapez_query_resources", {
  x: L.state.hub.x,
  y: L.state.hub.y,
  radius: 95,
  limit: 5000,
})).value;
const oreTiles = (resources.tiles ?? []).filter((t) => t.shape === ORE);
const cands = oreTiles
  .map((t) => ({ ...t, d: Math.abs(t.x) + Math.abs(t.y + 15) / 2 }))
  .sort((a, b) => a.d - b.d);
let start = null;
for (const t of cands.slice(0, 120)) {
  let ok = true;
  for (let i = 1; i <= 22 && ok; i++) if (!L.free(t.x - i, t.y)) ok = false;
  for (let i = 1; i <= 12 && ok; i++) for (let j = 0; j <= 5 && ok; j++) if (!L.free(t.x - i, t.y + j)) ok = false;
  if (ok) { start = t; break; }
}
if (!start) throw new Error("找不到合适矿格");
const x0 = start.x;
const R = start.y;
console.log(`矿机 (${x0},${R})，产线向西`);

const seq = [
  { kind: "miner", x: x0, w: 1, rotation: 270, out: x0 - 1 },
  { kind: "tf_machine_seamCut", x: x0 - 2, w: 1, rotation: 270 },
  { kind: "tf_machine_seepPaint", x: x0 - 4, w: 2, rotation: 180 },
  { kind: "tf_machine_rotate4", x: x0 - 7, w: 1, rotation: 270 },
  { kind: "tf_machine_seamCut", x: x0 - 9, w: 1, rotation: 270 },
  { kind: "tf_machine_seepPaint", x: x0 - 11, w: 2, rotation: 180 },
  { kind: "tf_machine_rotate4", x: x0 - 14, w: 1, rotation: 270 },
  { kind: "tf_machine_seamCut", x: x0 - 16, w: 1, rotation: 270 },
  { kind: "tf_machine_seepPaint", x: x0 - 18, w: 2, rotation: 180 },
];
for (const m of seq) await L.place(m.kind, m.x, R, m.rotation);
for (let i = 0; i < seq.length - 1; i++) {
  const cell = { x: seq[i + 1].x + 1, y: R };
  const res = await L.beltPath({
    from: { x: seq[i].x - seq[i].w, y: R },
    start: cell,
    last: cell,
    target: { x: seq[i + 1].x, y: R },
  });
  if (!res || res.failed) throw new Error(`主流第 ${i} 段没铺上`);
}
console.log("主流已铺");

// 染料口：paint rot180 在 (x,y) 占 (x,y),(x-1,y)，染料口 (x-1, y+1)，目标格 (x-1,y)
const colW = x0 - 5;  // 白渗染机 x0-4 的染料口列
const colC = x0 - 12;
const colB = x0 - 19;

// 混合器（rot0，出料向北）
await L.place("mixer", colW, R + 4, 0);
await L.place("mixer", colW, R + 8, 0);
await L.place("mixer", colC, R + 4, 0);

const dropUp = async (col, fromRow, toRow, targetRow, label) => {
  const cells = [];
  for (let y = fromRow - 1; y >= toRow; y--) cells.push({ x: col, y });
  const res = await L.tool("shapez_build_belt_path", {
    cells,
    from: { x: col, y: fromRow },
    target: { x: col, y: targetRow },
  });
  if (!res.value || res.value.failed?.length) throw new Error(`${label} 失败`);
  for (const c of cells) L.state.blocked.add(L.key(c.x, c.y));
  console.log(`${label}: ${cells.length} 格`);
};
await dropUp(colW, R + 8, R + 5, R + 4, "青2→白");
await dropUp(colW, R + 4, R + 1, R, "白→paint1");
await dropUp(colC, R + 4, R + 1, R, "青→paint2");

// 染料投送：一律从南边上来
const upCells = (col, fromRow, toRow) => {
  const out = [];
  for (let y = fromRow; y >= toRow; y--) out.push({ x: col, y });
  return out;
};
const feedFromSouth = async (color, col, cells, machineTile, label) => {
  const last = cells[cells.length - 1];
  const tiles = (await L.tool("shapez_find_resource", {
    x: col,
    y: last.y + 12,
    color,
    radius: 70,
    limit: 12,
  })).value?.tiles ?? [];
  for (const t of tiles) {
    if (!L.free(t.x, t.y) || !L.free(t.x, t.y + 1) || t.type !== "ColorItem") continue;
    const placed = await L.tool("shapez_place_building", { buildingId: "miner", x: t.x, y: t.y, rotation: 180 });
    if (!placed.value?.ok) continue;
    L.state.blocked.add(L.key(t.x, t.y));
    const startCell = { x: t.x, y: t.y + 1 };
    const p1 = await L.beltPath({
      from: { x: t.x, y: t.y },
      start: startCell,
      last: { x: cells[0].x, y: cells[0].y + 1 },
      target: cells[0],
    });
    if (!p1 || p1.failed) {
      for (const c of p1?.failedCells ?? []) {
        await L.tool("shapez_delete_building", { x: c.x, y: c.y });
        L.state.blocked.delete(L.key(c.x, c.y));
      }
      await L.tool("shapez_delete_building", { x: t.x, y: t.y });
      L.state.blocked.delete(L.key(t.x, t.y));
      continue;
    }
    const p2 = await L.tool("shapez_build_belt_path", {
      cells,
      from: { x: cells[0].x, y: cells[0].y + 1 },
      target: machineTile,
    });
    if (!p2.value || p2.value.failed?.length) {
      for (const c of [...p1.path, ...cells]) {
        await L.tool("shapez_delete_building", { x: c.x, y: c.y });
        L.state.blocked.delete(L.key(c.x, c.y));
      }
      await L.tool("shapez_delete_building", { x: t.x, y: t.y });
      L.state.blocked.delete(L.key(t.x, t.y));
      continue;
    }
    for (const c of cells) L.state.blocked.add(L.key(c.x, c.y));
    console.log(`${label}: ${color} 矿 (${t.x},${t.y}) → (${last.x},${last.y})，${p1.path.length + cells.length} 格`);
    return true;
  }
  return false;
};

const results = [];
// 白链：绿 (colW,R+9)、蓝 (colW+1,R+9)、红 (colW+1,R+5)
results.push(await feedFromSouth("green", colW, upCells(colW, R + 9, R + 9), { x: colW, y: R + 8 }, "青2-绿"));
results.push(await feedFromSouth("blue", colW + 1, upCells(colW + 1, R + 9, R + 9), { x: colW + 1, y: R + 8 }, "青2-蓝"));
results.push(await feedFromSouth("red", colW + 1, upCells(colW + 1, R + 5, R + 5), { x: colW + 1, y: R + 4 }, "白-红"));
// 青链：绿 (colC,R+5)、蓝 (colC+1,R+5)
results.push(await feedFromSouth("green", colC, upCells(colC, R + 5, R + 5), { x: colC, y: R + 4 }, "青-绿"));
results.push(await feedFromSouth("blue", colC + 1, upCells(colC + 1, R + 5, R + 5), { x: colC + 1, y: R + 4 }, "青-蓝"));
// 蓝 → paint3
results.push(await feedFromSouth("blue", colB, upCells(colB, R + 2, R + 1), { x: colB, y: R }, "蓝→paint3"));
console.log("染料进度:", results.filter(Boolean).length, "/ 6");

// 探针
const probes = [1, 3, 6, 8, 10, 13, 15, 17, 20].map((dx) => ({ x: x0 - dx, y: R }));
const seen = await L.probeShapes(probes, 500, 4);
console.log("\n各级形状：");
for (const [cell, shapes] of seen) console.log(`  ${cell}:`, JSON.stringify([...shapes]));
const lastShapes = [...(seen.get(`${x0 - 20},${R}`) ?? [])];
if (!lastShapes.includes(g.goalShape)) {
  console.log(`\n末级未出目标（现在 ${JSON.stringify(lastShapes)}）`);
  process.exit(3);
}

const hubRes = await L.beltToHub({ from: { x: x0 - 18, y: R }, start: { x: x0 - 20, y: R } });
if (!hubRes) throw new Error("到 Hub 无通路");
console.log(`末级 → Hub：${hubRes.path.length} 格`);

const rounds = Number(process.env.TF_ROUNDS ?? 60);
let now = g;
for (let i = 0; i < rounds; i++) {
  await L.tool("shapez_dismiss_dialogs");
  await L.tool("shapez_wait_ticks", { ticks: 500 });
  now = await L.goals();
  console.log(`  交付 ${now.delivered}/${now.required}，关卡 ${now.level}`);
  if (now.level > g.level) break;
}
console.log(`\n结果：关卡 ${now.level}，目标 ${now.goalShape}，已交付 ${now.delivered}`);
