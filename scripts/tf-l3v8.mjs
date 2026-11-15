/**
 * 第 3 关 v8：先搜一个「六条染料带都能做到互不相交」的矿格，再动工。
 *
 * 不吃交叉的规则：
 *   - 六条带各占一列（严格递增），矿机一律在该列**西侧**；
 *   - 横段各占一行（严格递增），竖段从入口行一路下到自己的横段行。
 *   => 竖段只会穿过比自己更靠南的行，而那些行的横段都在更东的列，不会相交。
 */
import * as L from "./tf-lib.mjs";

const ORE = "eueueueueueueueueueueueu";
const Y_LO = 4; // 矿机允许的最北位置（相对 R）
const Y_HI = 60; // 最南

await L.init();
const g = await L.goals();
console.log(`关卡 ${g.level}/${g.levelCount}，目标 ${g.goalShape} ×${g.required}`);

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

const resources = (await L.tool("shapez_query_resources", {
  x: L.state.hub.x,
  y: L.state.hub.y,
  radius: 95,
  limit: 5000,
})).value;
const oreTiles = (resources.tiles ?? []).filter((t) => t.shape === ORE);
const oreCands = oreTiles.map((t) => ({ ...t, d: Math.abs(t.x - 5) + Math.abs(t.y) })).sort((a, b) => a.d - b.d);

// 六个入口（列相对 x0、颜色、入口行相对 R）
const specsRel = [
  { color: "blue", colOff: -19, endOff: 1, label: "蓝→paint3" },
  { color: "green", colOff: -12, endOff: 7, label: "青-绿" },
  { color: "blue", colOff: -11, endOff: 7, label: "青-蓝" },
  { color: "green", colOff: -5, endOff: 11, label: "青2-绿" },
  { color: "blue", colOff: -4, endOff: 11, label: "青2-蓝" },
  { color: "red", colOff: -4, endOff: 7, label: "白-红" },
];

const probeSite = async (x0, R) =>
  (await L.tool("shapez_eval", {
    code: `
      var specs = ${JSON.stringify(specsRel)};
      var out = [];
      for (var i = 0; i < specs.length; i++) {
        var s = specs[i];
        var endCol = ${x0} + s.colOff;
        var endRow = ${R} + s.endOff;
        var best = null, bestD = 1e9;
        for (var off = -1; off <= 1; off++) {
          var col = endCol + off;
          for (var y = endRow + 3; y <= ${R} + ${Y_HI}; y++) {
            var it = root.map.getLowerLayerContentXY(col, y);
            if (!it || !it.constructor || it.constructor.name !== "ColorItem" || it.color !== s.color) continue;
            var d = Math.abs(y - (endRow + 10)) + Math.abs(off) * 3;
            if (d < bestD) { bestD = d; best = { x: col, y: y, col: col }; }
          }
        }
        out.push(best);
      }
      return out;
    `,
  })).value?.value ?? null;

let site = null;
const ranking = [];
for (const t of oreCands.slice(0, 160)) {
  let ok = true;
  for (let i = 1; i <= 22 && ok; i++) if (!L.free(t.x - i, t.y)) ok = false;
  if (!ok) continue;
  const found = await probeSite(t.x, t.y);
  if (!found) continue;
  const hit = found.filter((v) => v && typeof v.x === "number").length;
  ranking.push({ x0: t.x, R: t.y, hit, found });
  if (hit === 6 && !site) site = { x0: t.x, R: t.y, found };
}
ranking.sort((a, b) => b.hit - a.hit);
console.log("候选排名:", ranking.slice(0, 5).map((r) => `(${r.x0},${r.R})=${r.hit}/6`).join(" "));
if (!site && ranking.length) {
  const best = ranking[0];
  console.log("最高分候选的缺口:", best.found.map((f, i) => (f ? "ok" : specsRel[i].label)).join(" "));
}
if (!site) throw new Error("找不到六条带都能落位的矿格");
const { x0, R, found } = site;
console.log(`选用矿机 (${x0},${R})`);

// ---- 主产线
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

// ---- 六条染料带：纯竖线（±1 列时用一个拐角进料口）
const occupied = new Set(L.state.blocked);
const usedCols = new Set();
let done = 0;
for (let i = 0; i < specsRel.length; i++) {
  const spec = specsRel[i];
  const tile = found[i];
  if (!tile) { console.log(`  ${spec.label}: 没有落点`); continue; }
  const endCol = x0 + spec.colOff;
  const endRow = R + spec.endOff;
  const col = tile.col ?? tile.x;
  if (usedCols.has(col) && col !== endCol) { console.log(`  ${spec.label}: 列 ${col} 已被占用`); continue; }
  const cells = [];
  for (let y = tile.y - 1; y >= endRow; y--) cells.push({ x: col, y });
  const extra = col !== endCol ? [{ x: endCol, y: endRow }] : [];
  const all = [...cells, ...extra];
  let conflict = null;
  for (const c of all) {
    const k = L.key(c.x, c.y);
    if (occupied.has(k)) { conflict = c; break; }
  }
  if (conflict) { console.log(`  ${spec.label}: 冲突 ${conflict.x},${conflict.y}`); continue; }
  const miner = await L.tool("shapez_place_building", { buildingId: "miner", x: tile.x, y: tile.y, rotation: 0 });
  if (!miner.value?.ok) { console.log(`  ${spec.label}: 矿机放不下`); continue; }
  const res = await L.tool("shapez_build_belt_path", {
    cells: all,
    from: { x: tile.x, y: tile.y },
    target: { x: endCol, y: endRow - 1 },
  });
  if (res.value && !res.value.failed?.length) {
    for (const c of all) occupied.add(L.key(c.x, c.y));
    usedCols.add(col);
    console.log(`${spec.label}: 矿 (${tile.x},${tile.y}) → 列 ${col}，${all.length} 格`);
    done += 1;
  } else {
    console.log(`  ${spec.label}: 铺带失败`);
    await L.tool("shapez_delete_building", { x: tile.x, y: tile.y });
  }
}
console.log("染料进度:", done, "/ 6");

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
