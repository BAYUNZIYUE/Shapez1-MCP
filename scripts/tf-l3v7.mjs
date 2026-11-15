/**
 * 第 3 关 v7：本地规划器（不靠 BFS），六条染料带逐格校验后再铺。
 *
 * 规则（保证互不相交）：
 *   - 每条带占用一列 c_i（互不相同）和一行 r_i（互不相同）。
 *   - 路线：矿机 (t.x,t.y) 向南到 r_i → 向东到 c_i → 向北到入口行。
 *   - 规划前先按列升序、行升序分配，并在本地网格里逐格检查冲突；冲突就换矿格/换行。
 */
import * as L from "./tf-lib.mjs";

const ORE = "eueueueueueueueueueueueu";
const DIRV = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] };

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

// 矿格
const resources = (await L.tool("shapez_query_resources", {
  x: L.state.hub.x,
  y: L.state.hub.y,
  radius: 95,
  limit: 5000,
})).value;
const oreTiles = (resources.tiles ?? []).filter((t) => t.shape === ORE);
const cands = oreTiles.map((t) => ({ ...t, d: Math.abs(t.x - 10) + Math.abs(t.y) })).sort((a, b) => a.d - b.d);
let start = null;
for (const t of cands.slice(0, 150)) {
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

await L.place("mixer", colW, R + 6, 0);
await L.place("mixer", colW, R + 10, 0);
await L.place("mixer", colC, R + 6, 0);

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

// ---------------------------------------------------------------- 本地规划器
// 六条带：列严格递增、矿机一律放在自己那列的西侧，于是竖段永远不会撞到别人横段。
const specs = [
  { color: "blue", endCol: colB, endRow: R + 1, col: colB, label: "蓝→paint3" },
  { color: "green", endCol: colC, endRow: R + 7, col: colC, label: "青-绿" },
  { color: "blue", endCol: colC + 1, endRow: R + 7, col: colC + 1, label: "青-蓝" },
  { color: "green", endCol: colW, endRow: R + 11, col: colW, label: "青2-绿" },
  { color: "blue", endCol: colW + 1, endRow: R + 11, col: colW + 1, label: "青2-蓝" },
  { color: "red", endCol: colW + 1, endRow: R + 7, col: colW + 2, label: "白-红" },
];
specs.sort((a, b) => a.col - b.col);

const occupied = new Set(L.state.blocked);

// 选矿格：颜色对、在自己那列西侧、格子空
const chosen = [];
for (const spec of specs) {
  const tiles = (await L.tool("shapez_find_resource", {
    x: spec.col - 6,
    y: spec.endRow + 18,
    color: spec.color,
    radius: 90,
    limit: 200,
  })).value?.tiles ?? [];
  const pick = tiles
    .filter(
      (t) =>
        t.type === "ColorItem" &&
        t.x < spec.col &&
        t.y > R + 16 &&
        t.y < R + 45 &&
        !occupied.has(L.key(t.x, t.y)),
    )
    .sort(
      (a, b) =>
        Math.abs(a.x - (spec.col - 4)) + Math.abs(a.y - (R + 24)) -
        (Math.abs(b.x - (spec.col - 4)) + Math.abs(b.y - (R + 24))),
    )[0];
  if (!pick) {
    console.log(`  ${spec.label}: 找不到西侧 ${spec.color} 矿格`);
    chosen.push(null);
    continue;
  }
  chosen.push(pick);
  console.log(`  ${spec.label}: ${spec.color} 矿 (${pick.x},${pick.y})，列 ${spec.col}`);
}

const valid = specs.map((spec, i) => i).filter((i) => chosen[i]);
const baseRow = Math.max(...valid.map((i) => chosen[i].y)) + 2;
console.log(`横段基行 ${baseRow}`);

let done = 0;
const reserved = new Set();
for (let idx = 0; idx < specs.length; idx++) {
  const spec = specs[idx];
  const tile = chosen[idx];
  if (!tile) continue;
  const row = baseRow + idx * 2;
  const cells = [];
  for (let y = tile.y + 1; y <= row; y++) cells.push({ x: tile.x, y });
  for (let x = tile.x + 1; x <= spec.col; x++) cells.push({ x, y: row });
  for (let y = row - 1; y >= spec.endRow; y--) cells.push({ x: spec.col, y });
  const extra = spec.col !== spec.endCol ? [{ x: spec.endCol, y: spec.endRow }] : [];
  const all = [...cells, ...extra];
  let conflict = null;
  for (const c of all) {
    const k = L.key(c.x, c.y);
    if (occupied.has(k) || reserved.has(k)) { conflict = c; break; }
  }
  if (conflict) {
    console.log(`  ${spec.label}: 与已有线路冲突 ${conflict.x},${conflict.y}`);
    continue;
  }
  for (const c of all) reserved.add(L.key(c.x, c.y));
  const miner = await L.tool("shapez_place_building", {
    buildingId: "miner",
    x: tile.x,
    y: tile.y,
    rotation: 180,
  });
  if (!miner.value?.ok) {
    console.log(`  ${spec.label}: 矿机放不下`);
    continue;
  }
  const machineTile = extra.length ? { x: spec.endCol, y: spec.endRow - 1 } : { x: spec.col, y: spec.endRow - 1 };
  const res = await L.tool("shapez_build_belt_path", {
    cells: all,
    from: { x: tile.x, y: tile.y },
    target: machineTile,
  });
  if (res.value && !res.value.failed?.length) {
    for (const c of all) occupied.add(L.key(c.x, c.y));
    console.log(`${spec.label}: 矿 (${tile.x},${tile.y}) → 列 ${spec.col} 行 ${row}，${all.length} 格`);
    done += 1;
  } else {
    console.log(`  ${spec.label}: 铺带失败`);
    await L.tool("shapez_delete_building", { x: tile.x, y: tile.y });
  }
}
console.log("染料进度:", done, "/ 6");

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
