/**
 * 第 3 关染料链（确定性布局）：混合器与染料口同一行，朝东直连，不再用长 BFS 穿行。
 *
 * 主产线（已建，列 x=17）：矿 -6 → 切缝 -8 → 渗染(白) -10 → 转120 -13 → 切缝 -15
 *                        → 渗染(青) -17 → 转120 -20 → 切缝 -22 → 渗染(蓝) -24
 * 染料口：白 (16,-11)、青 (16,-18)、蓝 (16,-25)
 *
 *   node scripts/tf-dyes.mjs
 */
import * as L from "./tf-lib.mjs";

const C = 17;
const rowWhite = -11;
const rowCyan = -18;
const rowBlue = -25;

await L.init();

// 0) 清掉之前的乱麻（只清染料区，不动主产线 x=17）
const rect = { x1: -1, y1: -30, x2: 16, y2: -2 };
const junk = (await L.tool("shapez_query_entities", { limit: 2000 })).value.entities.filter(
  (e) =>
    e.buildingId !== "hub" &&
    e.buildingId !== "miner" &&
    e.x >= rect.x1 &&
    e.x <= rect.x2 &&
    e.y >= rect.y1 &&
    e.y <= rect.y2,
);
for (const e of junk) await L.tool("shapez_delete_building", { x: e.x, y: e.y });
console.log(`清掉染料区 ${junk.length} 个旧建筑`);
await L.refreshBlocked();

// 1) 混合器（rot 90：占 (x,y) 与 (x,y-1)，两路从西侧进，向东出）
const mixers = {
  cyanA: { x: 8, y: rowWhite, feeds: ["green", "blue"] },
  white: { x: 12, y: rowWhite, feeds: null },
  cyanB: { x: 10, y: rowCyan, feeds: ["green", "blue"] },
};
for (const [name, m] of Object.entries(mixers)) {
  await L.place("mixer", m.x, m.y, 90);
  console.log(`${name} 混合器 @${m.x},${m.y}`);
}

const beltCells = async (cells, from, target) =>
  (await L.tool("shapez_build_belt_path", { cells, from, target })).value;

// 2) 短直带
console.log("cyanA→white:", JSON.stringify(await beltCells(
  [{ x: 9, y: rowWhite }, { x: 10, y: rowWhite }, { x: 11, y: rowWhite }],
  { x: 8, y: rowWhite },
  { x: 12, y: rowWhite },
)));
console.log("white→paint1:", JSON.stringify(await beltCells(
  [{ x: 13, y: rowWhite }, { x: 14, y: rowWhite }, { x: 15, y: rowWhite }, { x: 16, y: rowWhite }],
  { x: 12, y: rowWhite },
  { x: 17, y: rowWhite },
)));
console.log("cyanB→paint2:", JSON.stringify(await beltCells(
  [{ x: 11, y: rowCyan }, { x: 12, y: rowCyan }, { x: 13, y: rowCyan }, { x: 14, y: rowCyan }, { x: 15, y: rowCyan }, { x: 16, y: rowCyan }],
  { x: 10, y: rowCyan },
  { x: 17, y: rowCyan },
)));

// 3) 已有矿机的位置与颜色
const minerInfo = (await L.tool("shapez_eval", {
  code: `
    var out = [];
    root.entityMgr.entities.forEach(function (e) {
      var sm = e.components.StaticMapEntity; if (!sm) return;
      var id = null; try { id = sm.getMetaBuilding().getId(); } catch (x) {}
      if (id !== "miner") return;
      var it = root.map.getLowerLayerContentXY(sm.origin.x, sm.origin.y);
      out.push({ x: sm.origin.x, y: sm.origin.y, color: it && it.color ? it.color : null });
    });
    return out;
  `,
})).value?.value ?? [];
const freeMiners = minerInfo.filter((m) => m.color);
console.log("已有矿机:", JSON.stringify(freeMiners));

const takeMiner = (color) => {
  const idx = freeMiners.findIndex((m) => m.color === color);
  if (idx < 0) return null;
  const [m] = freeMiners.splice(idx, 1);
  return m;
};

// 4) 把染料送到各混合器/渗染机的入口（都是从西侧进、朝东）
const feed = async (color, lastCell, targetTile, label) => {
  const miner = takeMiner(color);
  if (!miner) throw new Error(`没有可用的 ${color} 矿机`);
  const res = await L.beltPath({
    from: { x: miner.x, y: miner.y },
    start: { x: miner.x, y: miner.y - 1 },
    last: lastCell,
    target: targetTile,
  });
  if (!res) throw new Error(`${label}: ${color} 矿 ${miner.x},${miner.y} 到 ${lastCell.x},${lastCell.y} 无通路`);
  console.log(`${label}: ${color} 矿 ${miner.x},${miner.y} → (${lastCell.x},${lastCell.y})，${res.path.length} 格`);
  return res;
};

await feed("green", { x: 7, y: rowWhite }, { x: 8, y: rowWhite }, "cyanA-绿");
await feed("blue", { x: 7, y: rowWhite - 1 }, { x: 8, y: rowWhite }, "cyanA-蓝");
await feed("green", { x: 9, y: rowCyan }, { x: 10, y: rowCyan }, "cyanB-绿");
await feed("blue", { x: 9, y: rowCyan - 1 }, { x: 10, y: rowCyan }, "cyanB-蓝");
await feed("red", { x: 11, y: rowWhite - 1 }, { x: 12, y: rowWhite }, "white-红");
await feed("blue", { x: 16, y: rowBlue }, { x: 17, y: rowBlue }, "blue→paint3");

console.log("\n染料链铺完，等物料到位…");
const probeCells = [
  { x: 16, y: rowWhite },
  { x: 16, y: rowCyan },
  { x: 16, y: rowBlue },
  { x: 17, y: -12 },
  { x: 17, y: -19 },
  { x: 17, y: -26 },
];
const seen = await L.probeShapes(probeCells, 400, 3);
for (const [cell, shapes] of seen) console.log(`  ${cell}:`, JSON.stringify([...shapes]));
