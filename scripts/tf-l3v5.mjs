/**
 * 第 3 关 v5：产线向西流、渗染口朝南；每台染料矿机都放在自己那条竖列的正下方，
 * 于是每条染料带就是一条直线（最多矿机处横挪 1-2 格），不会互相穿插。
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

// 选矿格：向西 22 格空
const resources = (await L.tool("shapez_query_resources", {
  x: L.state.hub.x,
  y: L.state.hub.y,
  radius: 95,
  limit: 5000,
})).value;
const oreTiles = (resources.tiles ?? []).filter((t) => t.shape === ORE);
const cands = oreTiles
  .map((t) => ({ ...t, d: Math.abs(t.x - 10) + Math.abs(t.y) }))
  .sort((a, b) => a.d - b.d);
let start = null;
for (const t of cands.slice(0, 120)) {
  let ok = true;
  for (let i = 1; i <= 22 && ok; i++) if (!L.free(t.x - i, t.y)) ok = false;
  if (ok) { start = t; break; }
}
if (!start) throw new Error("找不到合适矿格");
const x0 = start.x;
const R = start.y;
console.log(`矿机 (${x0},${R})，产线向西`);

const seq = [
  { kind: "miner", x: x0, w: 1, rotation: 270 },
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

const colW = x0 - 5;
const colC = x0 - 12;
const colB = x0 - 19;

// 混合器（rot0 出料向北）
await L.place("mixer", colW, R + 6, 0);   // 白
await L.place("mixer", colW, R + 10, 0);  // 青2
await L.place("mixer", colC, R + 6, 0);   // 青

const verticalUp = async (col, fromRow, toRow, targetRow, label) => {
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
await verticalUp(colW, R + 10, R + 7, R + 6, "青2→白");
await verticalUp(colW, R + 6, R + 1, R, "白→paint1");
await verticalUp(colC, R + 6, R + 1, R, "青→paint2");

/**
 * 一条直线染料带：矿机尽量放在 col 正下方，然后竖直向上到 endRow。
 * 矿机允许按 x 对齐（找不到同列就 ±4 内找，再横挪一格）。
 */
const feedStraight = async (color, col, endRow, machineTile, label, extra = []) => {
  const candidates = (await L.tool("shapez_find_resource", {
    x: col,
    y: endRow + 16,
    color,
    radius: 80,
    limit: 80,
  })).value?.tiles ?? [];
  const usable = candidates
    .filter((t) => t.type === "ColorItem" && t.y > endRow + 6)
    .sort((a, b) => Math.abs(a.x - col) - Math.abs(b.x - col) || b.y - a.y);
  let reason = "无可用矿格";
  for (const t of usable) {
    if (!L.free(t.x, t.y)) { reason = "矿格被占"; continue; }
    const cells = [];
    // 矿机 → 先竖直向南退到开阔处（若矿机在南边则直接向北）
    const safeRow = Math.max(t.y, endRow + 20);
    for (let y = t.y + 1; y <= safeRow; y++) cells.push({ x: t.x, y });
    // 在 safeRow 横挪到目标列
    if (t.x !== col) {
      const step = t.x > col ? -1 : 1;
      for (let x = t.x + step; step < 0 ? x >= col : x <= col; x += step) cells.push({ x, y: safeRow });
    }
    // 竖直向上到 endRow
    for (let y = safeRow - 1; y >= endRow; y--) cells.push({ x: col, y });
    cells.push(...extra);
    let ok = true;
    let blockedAt = null;
    for (const c of cells) if (!L.free(c.x, c.y)) { ok = false; blockedAt = c; break; }
    if (!ok) { reason = `路径被占 ${blockedAt.x},${blockedAt.y}`; continue; }
    const placed = await L.tool("shapez_place_building", { buildingId: "miner", x: t.x, y: t.y, rotation: 180 });
    if (!placed.value?.ok) continue;
    L.state.blocked.add(L.key(t.x, t.y));
    const res = await L.tool("shapez_build_belt_path", {
      cells,
      from: { x: t.x, y: t.y },
      target: machineTile,
    });
    if (res.value && !res.value.failed?.length) {
      for (const c of cells) L.state.blocked.add(L.key(c.x, c.y));
      console.log(`${label}: ${color} 矿 (${t.x},${t.y}) → 列 ${col}，${cells.length} 格`);
      return true;
    }
    await L.tool("shapez_delete_building", { x: t.x, y: t.y });
    L.state.blocked.delete(L.key(t.x, t.y));
    reason = "铺带失败";
  }
  console.log(`  ${label} 失败：${reason}（候选 ${usable.length}）`);
  return false;
};

// 先量每条染料带最近矿格的距离，最长的先铺（先铺长带，短带再绕开它）
const feedSpecs = [
  { color: "green", col: colW, endRow: R + 11, machineTile: { x: colW, y: R + 10 }, label: "青2-绿" },
  { color: "blue", col: colW + 1, endRow: R + 11, machineTile: { x: colW + 1, y: R + 10 }, label: "青2-蓝" },
  { color: "red", col: colW + 2, endRow: R + 7, machineTile: { x: colW + 1, y: R + 6 }, label: "白-红", extra: [{ x: colW + 1, y: R + 7 }] },
  { color: "green", col: colC, endRow: R + 7, machineTile: { x: colC, y: R + 6 }, label: "青-绿" },
  { color: "blue", col: colC + 1, endRow: R + 7, machineTile: { x: colC + 1, y: R + 6 }, label: "青-蓝" },
  { color: "blue", col: colB, endRow: R + 1, machineTile: { x: colB, y: R }, label: "蓝→paint3" },
];
for (const spec of feedSpecs) {
  const found = (await L.tool("shapez_find_resource", {
    x: spec.col,
    y: spec.endRow + 16,
    color: spec.color,
    radius: 90,
    limit: 1,
  })).value?.tiles?.[0];
  spec.distance = found ? found.distance : 9999;
}
feedSpecs.sort((a, b) => b.distance - a.distance);
console.log("建造顺序:", feedSpecs.map((s) => `${s.label}(${s.distance})`).join(" → "));

const res1 = [];
for (const spec of feedSpecs) {
  res1.push(await feedStraight(spec.color, spec.col, spec.endRow, spec.machineTile, spec.label, spec.extra ?? []));
}
console.log("染料进度:", res1.filter(Boolean).length, "/ 6");

// 探针
const probes = [1, 3, 6, 8, 10, 13, 15, 17, 20].map((dx) => ({ x: x0 - dx, y: R }));
const seen = await L.probeShapes(probes, 500, 5);
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
