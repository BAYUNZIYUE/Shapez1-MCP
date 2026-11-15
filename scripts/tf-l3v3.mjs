/**
 * 第 3 关 v3：先在地图上找「红绿蓝三种染料都近」的位置，再把整条产线搬过去，
 * 这样每个染料口只需几格短带，不会再被长带围成迷宫。
 *
 * 主流（东西向，行 R，向东）：
 *   miner → 切缝 → 渗染(白) → 转120 → 切缝 → 渗染(青) → 转120 → 切缝 → 渗染(蓝) → Hub
 * 染料口（行 R-1，列 x0+5 / x0+12 / x0+19），每个口上方一条独立竖通道。
 */
import * as L from "./tf-lib.mjs";

const ORE = "eueueueueueueueueueueueu";
const TOP = 13; // 竖通道顶端行偏移（R-TOP 以上是开阔区）

await L.init();
const g = await L.goals();
console.log(`关卡 ${g.level}/${g.levelCount}，目标 ${g.goalShape} ×${g.required}`);

// 1) 找染料密集点：一次 eval 扫全图，算最近的红/绿/蓝距离
const nearest3 = async (x, y) =>
  (await L.tool("shapez_eval", {
    code: `
      var best = { red: 1e9, green: 1e9, blue: 1e9 };
      var at = {};
      for (var i = -70; i <= 70; i++) {
        for (var j = -70; j <= 70; j++) {
          var px = ${x} + i, py = ${y} + j;
          var it = root.map.getLowerLayerContentXY(px, py);
          if (!it || !it.constructor || it.constructor.name !== "ColorItem") continue;
          var d = Math.abs(i) + Math.abs(j);
          if (best[it.color] !== undefined && d < best[it.color]) { best[it.color] = d; at[it.color] = { x: px, y: py }; }
        }
      }
      best.at = at;
      return best;
    `,
  })).value?.value ?? {};

let site = null;
for (let x = -70; x <= 40; x += 10) {
  for (let y = -50; y <= 30; y += 10) {
    const n = await nearest3(x, y);
    if (!n || !n.at || !n.at.red || !n.at.green || !n.at.blue) continue;
    const worst = Math.max(n.red, n.green, n.blue);
    if (!site || worst < site.worst) site = { x, y, worst, near: n };
  }
}
if (!site) throw new Error("找不到三种染料都近的位置");
console.log(`染料密集点 (${site.x},${site.y})：红 ${site.near.red} 绿 ${site.near.green} 蓝 ${site.near.blue} 格`);

// 2) 清场
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

// 3) 选矿格：附近、向东 22 格空
const resources = (await L.tool("shapez_query_resources", {
  x: site.x,
  y: site.y,
  radius: 60,
  limit: 5000,
})).value;
const oreTiles = (resources.tiles ?? []).filter((t) => t.shape === ORE);
const cands = oreTiles
  .map((t) => ({ ...t, d: Math.abs(t.x - site.x) + Math.abs(t.y - site.y) }))
  .sort((a, b) => a.d - b.d);
let start = null;
for (const t of cands.slice(0, 80)) {
  let ok = true;
  for (let i = 1; i <= 22; i++) if (!L.free(t.x + i, t.y)) { ok = false; break; }
  for (let i = 1; i <= TOP + 6; i++) if (!L.free(t.x + 5, t.y - i)) { ok = false; break; }
  if (ok) { start = t; break; }
}
if (!start) throw new Error("附近没有合适矿格");
const x0 = start.x;
const R = start.y;
console.log(`矿机 (${x0},${R})，主流行 R=${R}`);

// 4) 主流
const seq = [
  { kind: "miner", x: x0, w: 1, rotation: 90 },
  { kind: "tf_machine_seamCut", x: x0 + 2, w: 1, rotation: 90 },
  { kind: "tf_machine_seepPaint", x: x0 + 4, w: 2, rotation: 0 },
  { kind: "tf_machine_rotate4", x: x0 + 7, w: 1, rotation: 90 },
  { kind: "tf_machine_seamCut", x: x0 + 9, w: 1, rotation: 90 },
  { kind: "tf_machine_seepPaint", x: x0 + 11, w: 2, rotation: 0 },
  { kind: "tf_machine_rotate4", x: x0 + 14, w: 1, rotation: 90 },
  { kind: "tf_machine_seamCut", x: x0 + 16, w: 1, rotation: 90 },
  { kind: "tf_machine_seepPaint", x: x0 + 18, w: 2, rotation: 0 },
];
for (const m of seq) await L.place(m.kind, m.x, R, m.rotation);
for (let i = 0; i < seq.length - 1; i++) {
  const cell = { x: seq[i + 1].x - 1, y: R };
  const res = await L.beltPath({
    from: { x: seq[i].x + seq[i].w - 1, y: R },
    start: cell,
    last: cell,
    target: { x: seq[i + 1].x, y: R },
  });
  if (!res || res.failed) throw new Error(`主流第 ${i} 段没铺上`);
}
console.log("主流已铺");

const colW = x0 + 5;
const colC = x0 + 12;
const colB = x0 + 19;

// 5) 混合器：白(R-4)+青2(R-8) 在 colW；青(R-4) 在 colC
await L.place("mixer", colW, R - 4, 180);
await L.place("mixer", colW, R - 8, 180);
await L.place("mixer", colC, R - 4, 180);

const dropBelt = async (col, fromRow, toRow, targetRow, label) => {
  const cells = [];
  for (let y = fromRow + 1; y <= toRow; y++) cells.push({ x: col, y });
  const res = await L.tool("shapez_build_belt_path", {
    cells,
    from: { x: col, y: fromRow },
    target: { x: col, y: targetRow },
  });
  if (!res.value || res.value.failed?.length) throw new Error(`${label} 失败`);
  for (const c of cells) L.state.blocked.add(L.key(c.x, c.y));
  console.log(`${label}: ${cells.length} 格`);
};
await dropBelt(colW, R - 8, R - 5, R - 4, "青2→白");
await dropBelt(colW, R - 4, R - 1, R, "白→paint1");
await dropBelt(colC, R - 4, R - 1, R, "青→paint2");

// 6) 六条染料：每条从上方竖着下来，列互不相同
const built = [];
const tryFeed = async (color, searchAt, cells, machineTile, label) => {
  const tiles = (await L.tool("shapez_find_resource", {
    x: searchAt.x,
    y: searchAt.y,
    color,
    radius: 60,
    limit: 10,
  })).value?.tiles ?? [];
  const topCell = cells[0];
  const topFrom = { x: topCell.x, y: topCell.y - 1 };
  for (const t of tiles) {
    if (!L.free(t.x, t.y) || !L.free(t.x, t.y - 1) || t.type !== "ColorItem") continue;
    const placed = await L.tool("shapez_place_building", { buildingId: "miner", x: t.x, y: t.y, rotation: 0 });
    if (!placed.value?.ok) continue;
    L.state.blocked.add(L.key(t.x, t.y));
    const cleanup = async (built) => {
      for (const c of built) {
        await L.tool("shapez_delete_building", { x: c.x, y: c.y });
        L.state.blocked.delete(L.key(c.x, c.y));
      }
      await L.tool("shapez_delete_building", { x: t.x, y: t.y });
      L.state.blocked.delete(L.key(t.x, t.y));
    };
    const p1 = await L.beltPath({
      from: { x: t.x, y: t.y },
      start: { x: t.x, y: t.y - 1 },
      last: topFrom,
      target: topCell,
    });
    if (!p1 || p1.failed) {
      await cleanup(p1?.failedCells ?? []);
      continue;
    }
    const p2 = await L.tool("shapez_build_belt_path", {
      cells,
      from: topFrom,
      target: machineTile,
    });
    if (!p2.value || p2.value.failed?.length) {
      await cleanup([...p1.path, ...cells]);
      continue;
    }
    for (const c of cells) L.state.blocked.add(L.key(c.x, c.y));
    console.log(`${label}: ${color} 矿 (${t.x},${t.y}) → (${cells[cells.length - 1].x},${cells[cells.length - 1].y})，${p1.path.length + cells.length} 格`);
    return true;
  }
  return false;
};

const colCells = (col, fromRow, toRow) => {
  const out = [];
  for (let y = fromRow; y <= toRow; y++) out.push({ x: col, y });
  return out;
};

const okAll = [];
// 白链：绿走主列；蓝从西两列下来再向东拐；红从更西一列下来拐两次
okAll.push(await tryFeed("green", { x: colW, y: R - 9 }, colCells(colW, R - TOP + 1, R - 9), { x: colW, y: R - 8 }, "青2-绿"));
okAll.push(
  await tryFeed(
    "blue",
    { x: colW - 2, y: R - 9 },
    [...colCells(colW - 2, R - TOP + 1, R - 9), { x: colW - 1, y: R - 9 }],
    { x: colW - 1, y: R - 8 },
    "青2-蓝",
  ),
);
// 青链：绿走主列；蓝从西两列下来再拐
okAll.push(await tryFeed("green", { x: colC, y: R - 5 }, colCells(colC, R - TOP + 1, R - 5), { x: colC, y: R - 4 }, "青-绿"));
okAll.push(
  await tryFeed(
    "blue",
    { x: colC - 2, y: R - 5 },
    [...colCells(colC - 2, R - TOP + 1, R - 5), { x: colC - 1, y: R - 5 }],
    { x: colC - 1, y: R - 4 },
    "青-蓝",
  ),
);
okAll.push(await tryFeed("blue", { x: colB, y: R - 1 }, colCells(colB, R - TOP + 1, R - 1), { x: colB, y: R }, "蓝→paint3"));
console.log("染料进度:", okAll.filter(Boolean).length, "/ 5（红单独处理）");

// 红：从 colW-3 下来，在 R-5 行向东两格拐进白混合器第二入口
{
  const cells = [...colCells(colW - 3, R - TOP + 1, R - 5), { x: colW - 2, y: R - 5 }, { x: colW - 1, y: R - 5 }];
  const ok = await tryFeed("red", { x: colW - 3, y: R - 5 }, cells, { x: colW - 1, y: R - 4 }, "白-红");
  console.log(ok ? "红染料接通" : "红染料未接通");
}

// 7) 探针
const probes = [1, 3, 6, 8, 10, 13, 15, 17, 20].map((dx) => ({ x: x0 + dx, y: R }));
const seen = await L.probeShapes(probes, 500, 4);
console.log("\n各级形状：");
for (const [cell, shapes] of seen) console.log(`  ${cell}:`, JSON.stringify([...shapes]));
const lastShapes = [...(seen.get(`${x0 + 20},${R}`) ?? [])];
if (!lastShapes.includes(g.goalShape)) {
  console.log(`\n末级未出目标（现在 ${JSON.stringify(lastShapes)}）`);
  process.exit(3);
}

// 8) 接 Hub 并等交付
const hubRes = await L.beltToHub({ from: { x: x0 + 18, y: R }, start: { x: x0 + 20, y: R } });
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
