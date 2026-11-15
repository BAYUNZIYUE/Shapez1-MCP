/**
 * 第 3 关 v9：不再规避交叉——用地下传送带（sender/receiver）从别的带子下面穿过去。
 * 路线用带权 BFS 找（空格 1、已有带子 12），能绕就绕、绕不过就钻。
 */
import * as L from "./tf-lib.mjs";

const ORE = "eueueueueueueueueueueueu";

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
  await L.refreshBeltCells();
}

const resources = (await L.tool("shapez_query_resources", {
  x: L.state.hub.x,
  y: L.state.hub.y,
  radius: 95,
  limit: 5000,
})).value;
const oreTiles = (resources.tiles ?? []).filter((t) => t.shape === ORE);
const cands = oreTiles.map((t) => ({ ...t, d: Math.abs(t.x - 5) + Math.abs(t.y) })).sort((a, b) => a.d - b.d);
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
  for (const c of cells) {
    L.state.blocked.add(L.key(c.x, c.y));
    L.state.beltCells.add(L.key(c.x, c.y));
  }
  console.log(`${label}: ${cells.length} 格`);
};
await verticalUp(colW, R + 10, R + 7, R + 6, "青2→白");
await verticalUp(colW, R + 6, R + 1, R, "白→paint1");
await verticalUp(colC, R + 6, R + 1, R, "青→paint2");

// 六条染料：带权 BFS + 隧道
const feeds = [
  { color: "green", col: colW, endRow: R + 11, label: "青2-绿" },
  { color: "blue", col: colW + 1, endRow: R + 11, label: "青2-蓝" },
  { color: "red", col: colW + 1, endRow: R + 7, label: "白-红" },
  { color: "green", col: colC, endRow: R + 7, label: "青-绿" },
  { color: "blue", col: colC + 1, endRow: R + 7, label: "青-蓝" },
  { color: "blue", col: colB, endRow: R + 1, label: "蓝→paint3" },
];

// 先量距离，最长的先铺（少些隧道）
for (const f of feeds) {
  const t = (await L.tool("shapez_find_resource", {
    x: f.col,
    y: f.endRow + 14,
    color: f.color,
    radius: 90,
    limit: 1,
  })).value?.tiles?.[0];
  f.distance = t ? t.distance : 9999;
}
feeds.sort((a, b) => b.distance - a.distance);
console.log("建造顺序:", feeds.map((f) => `${f.label}(${f.distance})`).join(" → "));

let done = 0;
// 预留所有入口格：别的线不许从上面过
const reservedEnds = new Set();
const ownEnds = new Map();
for (const f of feeds) {
  const own = new Set();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -2; dy <= 6; dy++) {
      const k = L.key(f.col + dx, f.endRow + dy);
      reservedEnds.add(k);
      own.add(k);
    }
  }
  ownEnds.set(f.label, own);
}
for (const f of feeds) {
  // 机器（不可穿）＝ blocked 里不是带子的格 + 别人的入口格
  const machines = new Set();
  for (const k of L.state.blocked) if (!L.state.beltCells.has(k)) machines.add(k);
  const own = ownEnds.get(f.label) ?? new Set();
  for (const k of reservedEnds) {
    if (own.has(k)) continue;
    machines.add(k);
  }
  const tiles = (await L.tool("shapez_find_resource", {
    x: f.col,
    y: f.endRow + 14,
    color: f.color,
    radius: 90,
    limit: 20,
  })).value?.tiles ?? [];
  let placed = false;
  for (const t of tiles) {
    if (!L.free(t.x, t.y) || !L.free(t.x, t.y - 1)) continue;
    let route = L.findRoute({
      from: { x: t.x, y: t.y },
      start: { x: t.x, y: t.y - 1 },
      last: { x: f.col, y: f.endRow },
      target: { x: f.col, y: f.endRow - 1 },
      blockedMachines: machines,
    });
    // 末端两格不能是别人的带子（否则隧道会顶到入口）
    for (let attempt = 0; attempt < 3 && route; attempt++) {
      const tail = route.slice(-3, -1).filter((c) => L.state.beltCells.has(L.key(c.x, c.y)));
      if (!tail.length) break;
      for (const c of tail) machines.add(L.key(c.x, c.y));
      route = L.findRoute({
        from: { x: t.x, y: t.y },
        start: { x: t.x, y: t.y - 1 },
        last: { x: f.col, y: f.endRow },
        target: { x: f.col, y: f.endRow - 1 },
        blockedMachines: machines,
      });
    }
    if (!route) continue;
    const miner = await L.tool("shapez_place_building", { buildingId: "miner", x: t.x, y: t.y, rotation: 0 });
    if (!miner.value?.ok) continue;
    L.state.blocked.add(L.key(t.x, t.y));
    // 最后一格手工放（保证朝北指向机器），其余交给隧道铺带
    const lastCell = route[route.length - 1];
    const body = route.slice(0, -1);
    const res = await L.buildRouteWithTunnels({
      from: { x: t.x, y: t.y },
      cells: body,
      target: lastCell,
    });
    if (res && res.ok) {
      const endBelt = await L.tool("shapez_place_building", {
        buildingId: "belt",
        x: lastCell.x,
        y: lastCell.y,
        rotation: 0,
      });
      if (!endBelt.value?.ok) res.ok = false;
      else {
        L.state.blocked.add(L.key(lastCell.x, lastCell.y));
        L.state.beltCells.add(L.key(lastCell.x, lastCell.y));
      }
    }
    if (res && !res.ok) console.log(`  ${f.label} 试 (${t.x},${t.y})：${res.reason}`);
    if (res && res.ok) {
      console.log(`${f.label}: ${f.color} 矿 (${t.x},${t.y}) → (${f.col},${f.endRow})，${route.length} 格，隧道 ${res.tunnels}`);
      done += 1;
      placed = true;
      break;
    }
    // 回滚矿机（带子可能已铺一部分，这里只删矿机，残留交给下一轮清场）
    await L.tool("shapez_delete_building", { x: t.x, y: t.y });
    L.state.blocked.delete(L.key(t.x, t.y));
    await L.refreshBlocked();
    await L.refreshBeltCells();
  }
  if (!placed) console.log(`  ${f.label}: 没铺成`);
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
