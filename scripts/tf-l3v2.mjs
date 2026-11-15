/**
 * 第 3 关 v2：东西向主流 + 每个染料口一条独立向下通道（互不交叉）。
 *
 * 主流（向东，行 R）：miner → 切缝 → 渗染(白) → 转120 → 切缝 → 渗染(青) → 转120 → 切缝 → 渗染(蓝) → Hub
 * 染料口都在行 R-1，列分别 x0+5 / x0+12 / x0+19。
 * 每个口上方一条竖通道：
 *   x0+5 ：白混合器(R-4) ← 青2混合器(R-8) ← 绿/蓝
 *   x0+12：青混合器(R-4) ← 绿/蓝
 *   x0+19：蓝矿直下
 */
import * as L from "./tf-lib.mjs";

const ORE = "eueueueueueueueueueueueu";
const TOP = 14; // 竖通道顶端相对行偏移

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

// 矿格：向东 22 格空
const resources = (await L.tool("shapez_query_resources", {
  x: L.state.hub.x,
  y: L.state.hub.y,
  radius: 95,
  limit: 5000,
})).value;
const oreTiles = (resources.tiles ?? []).filter((t) => t.shape === ORE);
const candidates = oreTiles.sort((a, b) => Math.abs(a.y + 18) - Math.abs(b.y + 18));
let site = null;
for (const tile of candidates.slice(0, 90)) {
  let ok = true;
  for (let i = 1; i <= 22; i++) if (!L.free(tile.x + i, tile.y)) { ok = false; break; }
  if (ok) { site = tile; break; }
}
if (!site) throw new Error("找不到合适矿格");
const x0 = site.x;
const R = site.y;
console.log(`主流 y=${R}，矿机 (${x0},${R})`);

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

// 输出口（实测：paint rot0 的染料口 = (x+1, R-1)，目标格 (x+1,R)）
const colWhite = x0 + 5;
const colCyan = x0 + 12;
const colBlue = x0 + 19;

const mix = async (col, row) => {
  await L.place("mixer", col, row, 180);
  return { col, row };
};

// 白链：white(R-4) + cyan2(R-8)
const white = await mix(colWhite, R - 4);
const cyan2 = await mix(colWhite, R - 8);
// 青链
const cyan = await mix(colCyan, R - 4);

// 短连接：混合器出口 → 下游入口（同一列，向南）
const drop = async (fromRow, toRow, col, targetRow, label) => {
  const cells = [];
  for (let y = fromRow + 1; y <= toRow; y++) cells.push({ x: col, y });
  const res = await L.tool("shapez_build_belt_path", {
    cells,
    from: { x: col, y: fromRow },
    target: { x: col, y: targetRow },
  });
  if (!res.value || res.value.failed?.length) throw new Error(`${label} 失败: ${JSON.stringify(res.value?.failed)}`);
  for (const c of cells) L.state.blocked.add(L.key(c.x, c.y));
  console.log(`${label}: ${cells.length} 格`);
};
await drop(cyan2.row, white.row - 1, colWhite, white.row, "青2→白");
await drop(white.row, R - 1, colWhite, R, "白→paint1");
await drop(cyan.row, R - 1, colCyan, R, "青→paint2");

// 六条染料投送：都从上方竖着下来，每个通道一列
const findTiles = async (color, x, y, limit = 8) =>
  (await L.tool("shapez_find_resource", { x, y, color, radius: 100, limit })).value?.tiles ?? [];

const used = new Set();
const feedDown = async (color, col, endCell, machineTile, label) => {
  const tiles = (await findTiles(color, endCell.x, endCell.y))
    .filter((t) => L.free(t.x, t.y) && L.free(t.x, t.y - 1) && !used.has(L.key(t.x, t.y)));
  for (const t of tiles.slice(0, 6)) {
    used.add(L.key(t.x, t.y));
    const placed = await L.tool("shapez_place_building", { buildingId: "miner", x: t.x, y: t.y, rotation: 0 });
    if (!placed.value?.ok) continue;
    L.state.blocked.add(L.key(t.x, t.y));
    // 先沿开阔区走到本通道顶端，再竖直向下
    const topCell = { x: col, y: R - TOP };
    const part1 = await L.beltPath({
      from: { x: t.x, y: t.y },
      start: { x: t.x, y: t.y - 1 },
      last: topCell,
      target: { x: col, y: R - TOP + 1 },
    });
    if (part1 && !part1.failed) {
      const cells = [];
      for (let y = R - TOP + 1; y <= endCell.y; y++) cells.push({ x: col, y });
      const res = await L.tool("shapez_build_belt_path", {
        cells,
        from: topCell,
        target: machineTile,
      });
      if (res.value && !res.value.failed?.length) {
        for (const c of cells) L.state.blocked.add(L.key(c.x, c.y));
        console.log(`${label}: ${color} 矿 (${t.x},${t.y}) → 通道 ${col}，共 ${part1.path.length + cells.length} 格`);
        return true;
      }
      // 竖段失败：把第一段也拆掉重来
      for (const c of part1.path) {
        await L.tool("shapez_delete_building", { x: c.x, y: c.y });
        L.state.blocked.delete(L.key(c.x, c.y));
      }
    } else if (part1?.failed) {
      for (const c of part1.failedCells ?? []) {
        await L.tool("shapez_delete_building", { x: c.x, y: c.y });
        L.state.blocked.delete(L.key(c.x, c.y));
      }
    }
    await L.tool("shapez_delete_building", { x: t.x, y: t.y });
    L.state.blocked.delete(L.key(t.x, t.y));
  }
  throw new Error(`${label}: ${color} 没有能走通的矿格`);
};

await feedDown("green", colWhite, { x: colWhite, y: cyan2.row - 1 }, { x: colWhite, y: cyan2.row }, "青2-绿");
await feedDown("blue", colWhite - 1, { x: colWhite - 1, y: cyan2.row - 1 }, { x: colWhite - 1, y: cyan2.row }, "青2-蓝");
await feedDown("green", colCyan, { x: colCyan, y: cyan.row - 1 }, { x: colCyan, y: cyan.row }, "青-绿");
await feedDown("blue", colCyan - 1, { x: colCyan - 1, y: cyan.row - 1 }, { x: colCyan - 1, y: cyan.row }, "青-蓝");
await feedDown("blue", colBlue, { x: colBlue, y: R - 1 }, { x: colBlue, y: R }, "蓝→paint3");

// 红：白混合器的第二入口，从西侧拐进来（避免和青2-蓝同列）
{
  const endCell = { x: colWhite - 1, y: white.row - 1 };
  const tiles = (await findTiles("red", endCell.x, endCell.y)).filter(
    (t) => L.free(t.x, t.y) && L.free(t.x, t.y - 1) && !used.has(L.key(t.x, t.y)),
  );
  let ok = false;
  for (const t of tiles.slice(0, 6)) {
    used.add(L.key(t.x, t.y));
    const placed = await L.tool("shapez_place_building", { buildingId: "miner", x: t.x, y: t.y, rotation: 0 });
    if (!placed.value?.ok) continue;
    L.state.blocked.add(L.key(t.x, t.y));
    const via = { x: colWhite - 2, y: white.row - 1 };
    const part1 = await L.beltPath({
      from: { x: t.x, y: t.y },
      start: { x: t.x, y: t.y - 1 },
      last: via,
      target: { x: colWhite - 1, y: white.row - 1 },
    });
    if (part1 && !part1.failed) {
      const res = await L.tool("shapez_build_belt_path", {
        cells: [{ x: colWhite - 1, y: white.row - 1 }],
        from: via,
        target: { x: colWhite - 1, y: white.row },
      });
      if (res.value && !res.value.failed?.length) {
        L.state.blocked.add(L.key(colWhite - 1, white.row - 1));
        console.log(`白-红: red 矿 (${t.x},${t.y}) → (${colWhite - 1},${white.row - 1})，${part1.path.length + 1} 格`);
        ok = true;
        break;
      }
    }
    await L.tool("shapez_delete_building", { x: t.x, y: t.y });
    L.state.blocked.delete(L.key(t.x, t.y));
  }
  if (!ok) throw new Error("白-红 走不通");
}

// 探针
const probes = [5, 6, 8, 10, 13, 15, 17, 20].map((dx) => ({ x: x0 + dx, y: R }));
const seen = await L.probeShapes(probes, 500, 4);
console.log("\n各级形状：");
for (const [cell, shapes] of seen) console.log(`  ${cell}:`, JSON.stringify([...shapes]));
const lastShapes = [...(seen.get(`${x0 + 20},${R}`) ?? [])];
if (!lastShapes.includes(g.goalShape)) {
  console.log(`\n末级未出目标（现在 ${JSON.stringify(lastShapes)}）`);
  process.exit(3);
}
const hubRes = await L.beltToHub({ from: { x: x0 + 18, y: R }, start: { x: x0 + 20, y: R } });
if (!hubRes) throw new Error("到 Hub 无通路");
console.log(`末级 → Hub：${hubRes.path.length} 格`);
