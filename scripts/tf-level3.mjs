/**
 * 十二分形 第 3 关：三色分段环 `EbeueuecEceueuewEweueueb` ×120
 *
 * 配方（每步都用机器实测确认过）：
 *   矿(无接缝) → 切缝 → 渗染(白) → 转120° → 切缝 → 渗染(青) → 转120° → 切缝 → 渗染(蓝) → Hub
 * 渗染机只给「每条接缝两侧、还没染色的两片」上色，所以顺序必须是 白→青→蓝。
 * 染料：白 = (绿+蓝=青) + 红；青 = 绿+蓝；蓝直接用。
 *
 *   node scripts/tf-level3.mjs [--dry] [--probe-only]
 */
import * as L from "./tf-lib.mjs";

const DRY = process.argv.includes("--dry");
const ORE = "eueueueueueueueueueueueu";
const GOAL = "EbeueuecEceueuewEweueueb";

await L.init();
const g = await L.goals();
console.log(`关卡 ${g.level}/${g.levelCount}，目标 ${g.goalShape} ×${g.required}`);

// 主产线要竖着放，矿机必须落在矿格上，且上方 26 格空着
const resources = (await L.tool("shapez_query_resources", {
  x: L.state.hub.x,
  y: L.state.hub.y,
  radius: 70,
  limit: 5000,
})).value;
const oreTiles = (resources.tiles ?? []).filter((t) => t.shape === ORE);
if (!oreTiles.length) {
  console.log("附近没有矿石");
  process.exit(1);
}
const height = 26;
const candidates = oreTiles
  .map((t) => ({ ...t, score: Math.abs(t.x - 14) + Math.abs(t.y - L.state.hub.y) }))
  .sort((a, b) => a.score - b.score);
let site = null;
for (const tile of candidates.slice(0, 60)) {
  let ok = true;
  for (let i = 1; i <= height; i++) {
    if (!L.free(tile.x, tile.y - i)) {
      ok = false;
      break;
    }
  }
  if (ok) {
    site = tile;
    break;
  }
}
if (!site) {
  console.log("找不到上方 26 格空的矿格");
  process.exit(1);
}
const C = site.x;
const y0 = site.y;
console.log(`主产线列 x=${C}，矿机 y=${y0}（矿格 ${site.x},${site.y}）`);

// 主产线：从 (C,y0) 往上；height 决定机器占几格（渗染机 2 格）
const machines = [
  { kind: "miner", y: y0, height: 1 },
  { kind: "tf_machine_seamCut", y: y0 - 2, height: 1 },
  { kind: "tf_machine_seepPaint", y: y0 - 4, height: 2, dye: "white" },
  { kind: "tf_machine_rotate4", y: y0 - 7, height: 1 },
  { kind: "tf_machine_seamCut", y: y0 - 9, height: 1 },
  { kind: "tf_machine_seepPaint", y: y0 - 11, height: 2, dye: "cyan" },
  { kind: "tf_machine_rotate4", y: y0 - 14, height: 1 },
  { kind: "tf_machine_seamCut", y: y0 - 16, height: 1 },
  { kind: "tf_machine_seepPaint", y: y0 - 18, height: 2, dye: "blue" },
];

if (DRY) {
  for (const m of machines) console.log("  ", m.kind, `x=${C} y=${m.y}`);
  process.exit(0);
}

for (const m of machines) {
  await L.place(m.kind, C, m.y, m.kind === "tf_machine_seepPaint" ? 270 : 0);
}
console.log("主产线机器已放");

// 机器之间的单格带（都朝上）
for (let i = 0; i < machines.length - 1; i++) {
  const prev = machines[i];
  const next = machines[i + 1];
  const cell = { x: C, y: next.y + 1 };
  const res = await L.beltPath({
    from: { x: C, y: prev.y },
    start: cell,
    last: cell,
    target: { x: C, y: next.y },
  });
  if (!res) throw new Error(`第 ${i} 段带铺不了`);
}
console.log("主产线传送带已铺");

// 3) 三种染料
const dyePorts = {
  white: { last: { x: C - 1, y: y0 - 5 }, target: { x: C, y: y0 - 5 } },
  cyan: { last: { x: C - 1, y: y0 - 12 }, target: { x: C, y: y0 - 12 } },
  blue: { last: { x: C - 1, y: y0 - 19 }, target: { x: C, y: y0 - 19 } },
};

const colorTiles = async (color) => {
  const scan = await L.tool("shapez_eval", {
    code: `
      var hub = ${JSON.stringify(L.state.hub)}; var out = [];
      for (var x = hub.x - 70; x <= hub.x + 70 && out.length < 300; x++) {
        for (var y = hub.y - 70; y <= hub.y + 70 && out.length < 300; y++) {
          var it = root.map.getLowerLayerContentXY(x, y);
          if (it && it.constructor && it.constructor.name === "ColorItem" && it.color === "${color}") out.push({ x: x, y: y });
        }
      }
      return out;
    `,
  });
  return scan.value?.value ?? [];
};

const nearestFree = (tiles) =>
  tiles
    .map((t) => ({ ...t, d: Math.abs(t.x - C - 10) + Math.abs(t.y - y0) }))
    .filter((t) => L.free(t.x, t.y))
    .sort((a, b) => a.d - b.d);

const mineTo = async (color, dyeTarget, label) => {
  const tiles = await colorTiles(color);
  if (!tiles.length) throw new Error(`地图上没有 ${color} 染料`);
  for (const tile of nearestFree(tiles)) {
    await L.place("miner", tile.x, tile.y, 0);
    const res = await L.beltPath({
      from: { x: tile.x, y: tile.y },
      start: { x: tile.x, y: tile.y - 1 },
      last: dyeTarget.last,
      target: dyeTarget.target,
    });
    if (res) {
      console.log(`${label}: ${color} 矿 ${tile.x},${tile.y} → ${dyeTarget.last.x},${dyeTarget.last.y}（${res.path.length} 格）`);
      return { miner: tile, res };
    }
    await L.tool("shapez_delete_building", { x: tile.x, y: tile.y });
  }
  throw new Error(`${label}: ${color} 矿到染料口没有通路`);
};

// 蓝染料直接进 paint3
await mineTo("blue", dyePorts.blue, "蓝");

// 青色 = 绿 + 蓝，进 paint2
const findMixerSpot = (preferX, preferY) => {
  for (let r = 0; r < 12; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = preferX + dx;
        const y = preferY + dy;
        if (L.free(x, y) && L.free(x + 1, y)) return { x, y };
      }
    }
  }
  return null;
};

const cyanMixer = findMixerSpot(C - 6, y0 - 16);
if (!cyanMixer) throw new Error("找不到放青色混合器的位置");
await L.place("mixer", cyanMixer.x, cyanMixer.y, 0);
console.log(`青色混合器 @${cyanMixer.x},${cyanMixer.y}`);
await mineTo("green", { last: { x: cyanMixer.x, y: cyanMixer.y + 1 }, target: { x: cyanMixer.x, y: cyanMixer.y } }, "青-绿");
await mineTo("blue", { last: { x: cyanMixer.x + 1, y: cyanMixer.y + 1 }, target: { x: cyanMixer.x, y: cyanMixer.y } }, "青-蓝");
// 混合器输出 → paint2 的染料口
{
  const res = await L.beltPath({
    from: { x: cyanMixer.x, y: cyanMixer.y },
    start: { x: cyanMixer.x, y: cyanMixer.y - 1 },
    last: dyePorts.cyan.last,
    target: dyePorts.cyan.target,
  });
  if (!res) throw new Error("青色到 paint2 没通路");
  console.log(`青色 → paint2：${res.path.length} 格`);
}

// 白色 = 青 + 红，进 paint1
const cyan2 = findMixerSpot(C - 11, y0 - 9);
if (!cyan2) throw new Error("找不到放第二个青色混合器的位置");
await L.place("mixer", cyan2.x, cyan2.y, 0);
console.log(`第二台青色混合器 @${cyan2.x},${cyan2.y}`);
await mineTo("green", { last: { x: cyan2.x, y: cyan2.y + 1 }, target: { x: cyan2.x, y: cyan2.y } }, "白-绿");
await mineTo("blue", { last: { x: cyan2.x + 1, y: cyan2.y + 1 }, target: { x: cyan2.x, y: cyan2.y } }, "白-蓝");

const whiteMixer = findMixerSpot(C - 11, y0 - 4);
if (!whiteMixer) throw new Error("找不到放白色混合器的位置");
await L.place("mixer", whiteMixer.x, whiteMixer.y, 0);
console.log(`白色混合器 @${whiteMixer.x},${whiteMixer.y}`);
{
  const res = await L.beltPath({
    from: { x: cyan2.x, y: cyan2.y },
    start: { x: cyan2.x, y: cyan2.y - 1 },
    last: { x: whiteMixer.x, y: whiteMixer.y + 1 },
    target: { x: whiteMixer.x, y: whiteMixer.y },
  });
  if (!res) throw new Error("第二个青色到白色混合器没通路");
  console.log(`青色 → 白：${res.path.length} 格`);
}
await mineTo("red", { last: { x: whiteMixer.x + 1, y: whiteMixer.y + 1 }, target: { x: whiteMixer.x, y: whiteMixer.y } }, "白-红");
{
  const res = await L.beltPath({
    from: { x: whiteMixer.x, y: whiteMixer.y },
    start: { x: whiteMixer.x, y: whiteMixer.y - 1 },
    last: dyePorts.white.last,
    target: dyePorts.white.target,
  });
  if (!res) throw new Error("白色到 paint1 没通路");
  console.log(`白 → paint1：${res.path.length} 格`);
}

// 4) 探针：看每一级出来的形状
const probeCells = [
  { x: C, y: y0 - 3 },
  { x: C, y: y0 - 6 },
  { x: C, y: y0 - 8 },
  { x: C, y: y0 - 10 },
  { x: C, y: y0 - 13 },
  { x: C, y: y0 - 15 },
  { x: C, y: y0 - 17 },
  { x: C, y: y0 - 20 },
];
const seen = await L.probeShapes(probeCells, 300, 2);
console.log("\n各级形状：");
for (const [cell, shapes] of seen) console.log(`  ${cell}:`, JSON.stringify([...shapes]));

const lastShapes = [...(seen.get(`${C},${y0 - 20}`) ?? [])];
if (!lastShapes.includes(GOAL)) {
  console.log(`\n末级还没出目标（现在 ${JSON.stringify(lastShapes)}），先不接 Hub`);
  process.exit(3);
}

// 5) 接到 Hub
{
  const res = await L.beltToHub({
    from: { x: C, y: y0 - 18 },
    start: { x: C, y: y0 - 20 },
  });
  if (!res) throw new Error("末级到 Hub 没通路");
  console.log(`末级 → Hub：${res.path.length} 格，进 Hub ${JSON.stringify(res.into)}`);
}

const rounds = Number(process.env.TF_WAIT_ROUNDS ?? Math.max(24, Math.ceil((g.required ?? 120) / 3)));
const startLevel = g.level;
let now = g;
for (let i = 0; i < rounds; i++) {
  await L.tool("shapez_dismiss_dialogs");
  await L.tool("shapez_wait_ticks", { ticks: 500 });
  now = await L.goals();
  console.log(`  交付 ${now.delivered}/${now.required}，关卡 ${now.level}`);
  if (now.level > startLevel) break;
}
console.log(`\n结果：关卡 ${now.level}，目标 ${now.goalShape}，已交付 ${now.delivered}`);
