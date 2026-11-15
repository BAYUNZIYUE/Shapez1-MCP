/**
 * 第 3 关 v6：不许交叉。做法是把整条产线横向平移 x0，直到六个染料入口所在的列上
 * 都正好有对应颜色的矿格——于是每条染料带都是「同列纯竖线」，一条都不相交。
 *
 * 需要的列（相对矿机 x0）：
 *   colW   = x0-5   绿（青2 第一入口）
 *   colW+1 = x0-4   蓝（青2 第二入口）
 *   colW+2 = x0-3   红（在 R+7 行向西拐一格进白混合器第二入口）
 *   colC   = x0-12  绿（青 第一入口）
 *   colC+1 = x0-11  蓝（青 第二入口）
 *   colB   = x0-19  蓝（直接进 paint3 染料口）
 */
import * as L from "./tf-lib.mjs";

const ORE = "eueueueueueueueueueueueu";
const SPAN = 30;

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

const resources = (await L.tool("shapez_query_resources", {
  x: L.state.hub.x,
  y: L.state.hub.y,
  radius: 95,
  limit: 5000,
})).value;
const oreTiles = (resources.tiles ?? []).filter((t) => t.shape === ORE);

// 列规格：相对 x0 的偏移 + 需要的颜色 + 入口行相对 R 的偏移
const cols = [
  { dx: -5, color: "green", back: 11, label: "青2-绿" },
  { dx: -4, color: "blue", back: 11, label: "青2-蓝" },
  { dx: -3, color: "red", back: 7, label: "白-红" },
  { dx: -12, color: "green", back: 7, label: "青-绿" },
  { dx: -11, color: "blue", back: 7, label: "青-蓝" },
  { dx: -19, color: "blue", back: 1, label: "蓝→paint3" },
];

/** 对候选 x0/R，检查六个列上是否都有对应颜色的矿（返回各列的候选 y 列表） */
const probeSite = async (x0, R) =>
  (await L.tool("shapez_eval", {
    code: `
      var out = {};
      var cols = ${JSON.stringify(cols.map((c) => ({ dx: c.dx, color: c.color, back: c.back })))};
      for (var i = 0; i < cols.length; i++) {
        var c = cols[i];
        var col = ${x0} + c.dx;
        var minY = ${R} + c.back + 2;
        var found = [];
        for (var y = minY; y <= ${R} + ${SPAN}; y++) {
          var it = root.map.getLowerLayerContentXY(col, y);
          if (it && it.constructor && it.constructor.name === "ColorItem" && it.color === c.color) {
            found.push(y);
            if (found.length >= 4) break;
          }
        }
        out[i] = found;
      }
      return out;
    `,
  })).value?.value ?? null;

const oreSorted = oreTiles
  .map((t) => ({ ...t, d: Math.abs(t.x - 5) + Math.abs(t.y) }))
  .sort((a, b) => a.d - b.d);

let chosen = null;
for (const t of oreSorted.slice(0, 60)) {
  let ok = true;
  for (let i = 1; i <= 22; i++) if (!L.free(t.x - i, t.y)) { ok = false; break; }
  if (!ok) continue;
  const site = await probeSite(t.x, t.y);
  if (!site) continue;
  const all = Object.values(site).every((arr) => Array.isArray(arr) && arr.length > 0);
  console.log(`候选 (${t.x},${t.y})：${all ? "六列都对齐" : Object.values(site).map((a) => a.length).join("/")}`);
  if (all) {
    chosen = { x0: t.x, R: t.y, site };
    break;
  }
}
if (!chosen) throw new Error("没有哪个矿格的六列都对齐");
const { x0, R } = chosen;
console.log(`选用矿机 (${x0},${R})`);

// 主流
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

// 六条纯竖线染料带
const results = [];
for (let i = 0; i < cols.length; i++) {
  const spec = cols[i];
  const col = x0 + spec.dx;
  const endRow = R + spec.back;
  const ys = chosen.site[i] ?? [];
  let done = false;
  for (const ty of ys) {
    const placed = await L.tool("shapez_place_building", { buildingId: "miner", x: col, y: ty, rotation: 0 });
    if (!placed.value?.ok) continue;
    L.state.blocked.add(L.key(col, ty));
    const cells = [];
    for (let y = ty - 1; y >= endRow; y--) cells.push({ x: col, y });
    // 红的入口需要向西拐一格
    const extra = spec.color === "red" ? [{ x: col - 1, y: endRow }] : [];
    const machineTile = spec.color === "red" ? { x: col - 1, y: endRow - 1 } : { x: col, y: endRow - 1 };
    const res = await L.tool("shapez_build_belt_path", {
      cells: [...cells, ...extra],
      from: { x: col, y: ty },
      target: machineTile,
    });
    if (res.value && !res.value.failed?.length) {
      for (const c of [...cells, ...extra]) L.state.blocked.add(L.key(c.x, c.y));
      console.log(`${spec.label}: ${spec.color} 矿 (${col},${ty})，${cells.length + extra.length} 格`);
      done = true;
      break;
    }
    await L.tool("shapez_delete_building", { x: col, y: ty });
    L.state.blocked.delete(L.key(col, ty));
  }
  results.push(done);
}
console.log("染料进度:", results.filter(Boolean).length, "/ 6");

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
