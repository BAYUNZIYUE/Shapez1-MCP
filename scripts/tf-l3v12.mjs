/**
 * 第 3 关 v11：逐格铺带（自己算朝向与弯道变体），碰到别人的带子就插隧道。
 * 不再依赖 build_belt_path 的批量逻辑，避免“段尾已经是带子”这类边界问题。
 */
import * as L from "./tf-lib.mjs";

const ORE = "eueueueueueueueueueueueu";
const DIRROT = { "0,-1": 0, "1,0": 90, "0,1": 180, "-1,0": 270 };

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
let startTile = null;
for (const t of cands.slice(0, 150)) {
  let ok = true;
  for (let i = 1; i <= 22 && ok; i++) if (!L.free(t.x - i, t.y)) ok = false;
  if (ok) { startTile = t; break; }
}
if (!startTile) throw new Error("找不到合适矿格");
const x0 = startTile.x;
const R = startTile.y;
console.log(`矿机 (${x0},${R})，产线向西`);

/** 逐格铺：cells 里每格朝向「下一格」；格子被占就插隧道；最后一格指向 targetTile */
const placeRun = async (cells, targetTile, fromTile) => {
  let tunnels = 0;
  const seqCells = [...cells];
  let prev = fromTile;
  let i = 0;
  while (i < seqCells.length) {
    const c = seqCells[i];
    const k = L.key(c.x, c.y);
    const belt = L.state.beltCells.has(k);
    const machine = L.state.blocked.has(k) && !belt;
    if (machine) return { ok: false, reason: `机器 ${c.x},${c.y}` };
    if (belt) {
      // 找到这段连续带子的末尾
      let j = i;
      while (j < seqCells.length && L.state.beltCells.has(L.key(seqCells[j].x, seqCells[j].y))) j += 1;
      if (j >= seqCells.length) return { ok: false, reason: `末尾是带子 ${c.x},${c.y}` };
      const sender = { x: prev.x, y: prev.y };
      const receiver = seqCells[j];
      const dx = receiver.x - sender.x;
      const dy = receiver.y - sender.y;
      const rotation = DIRROT[`${Math.sign(dx)},${Math.sign(dy)}`];
      const sres = await L.tool("shapez_place_building", {
        buildingId: "underground_belt",
        x: sender.x,
        y: sender.y,
        rotation,
        rotationVariant: 0,
      });
      const rres = await L.tool("shapez_place_building", {
        buildingId: "underground_belt",
        x: receiver.x,
        y: receiver.y,
        rotation,
        rotationVariant: 1,
      });
      if (!sres.value?.ok || !rres.value?.ok) return { ok: false, reason: `隧道 ${sender.x},${sender.y}` };
      L.state.blocked.add(L.key(sender.x, sender.y));
      L.state.blocked.add(L.key(receiver.x, receiver.y));
      tunnels += 1;
      prev = receiver;
      i = j + 1;
      continue;
    }
    const next = i + 1 < seqCells.length ? seqCells[i + 1] : targetTile;
    const din = DIRROT[`${Math.sign(c.x - prev.x)},${Math.sign(c.y - prev.y)}`];
    const dout = DIRROT[`${Math.sign(next.x - c.x)},${Math.sign(next.y - c.y)}`];
    let rotation = din;
    let rv = 0;
    if (din !== dout) {
      rotation = din;
      rv = dout === (din + 270) % 360 ? 1 : 2;
    }
    const res = await L.tool("shapez_place_building", {
      buildingId: "belt",
      x: c.x,
      y: c.y,
      rotation,
      rotationVariant: rv,
    });
    if (!res.value?.ok) return { ok: false, reason: `放带失败 ${c.x},${c.y}` };
    L.state.blocked.add(k);
    L.state.beltCells.add(k);
    prev = c;
    i += 1;
  }
  return { ok: true, tunnels };
};

const cellsBetween = (from, to) => {
  const sx = Math.sign(to.x - from.x);
  const sy = Math.sign(to.y - from.y);
  if (sx !== 0 && sy !== 0) return null;
  const out = [];
  let cur = { x: from.x + sx, y: from.y + sy };
  let guard = 0;
  while (guard++ < 300) {
    out.push({ x: cur.x, y: cur.y });
    if (cur.x === to.x && cur.y === to.y) break;
    cur = { x: cur.x + sx, y: cur.y + sy };
  }
  return out;
};


const clearAll = async () => {
  const all = (await L.tool("shapez_query_entities", { limit: 2000 })).value.entities;
  let removed = 0;
  for (const e of all) {
    if (e.buildingId === "hub") continue;
    await L.tool("shapez_delete_building", { x: e.x, y: e.y });
    removed += 1;
  }
  await L.refreshBlocked();
  await L.refreshBeltCells();
  return removed;
};

const buildFactory = async (order) => {
  await clearAll();
  const colW = x0 - 5;
  const colC = x0 - 12;
  const colB = x0 - 19;
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


  // 混合器 + 到染料口的竖带
  await L.place("mixer", colW, R + 4, 0);
  await L.place("mixer", colW, R + 8, 0);
  await L.place("mixer", colC, R + 4, 0);
  const dropRun = async (col, fromRow, toRow, targetRow, label) => {
    const cells = [];
    for (let y = fromRow - 1; y >= toRow; y--) cells.push({ x: col, y });
    const r = await placeRun(cells, { x: col, y: targetRow }, { x: col, y: fromRow });
    if (!r.ok) console.log(`${label} 失败: ${r.reason}`);
    return r.ok;
  };
  await dropRun(colW, R + 8, R + 5, R + 4, "青2→白");
  await dropRun(colW, R + 4, R + 1, R, "白→paint1");
  await dropRun(colC, R + 4, R + 1, R, "青→paint2");

  let done = 0;
  const failed = [];
  for (let fi = 0; fi < order.length; fi++) {
    const f = order[fi];
    const lane = R + 20 + fi * 2;
    const via = f.via ?? f.col;
    const tiles = (await L.tool("shapez_find_resource", {
      x: f.col + (f.searchDx ?? 0),
      y: f.endRow + 16,
      color: f.color,
      radius: 90,
      limit: 12,
    })).value?.tiles ?? [];
    let built = false;
    for (const t of tiles) {
      if (!L.free(t.x, t.y)) continue;
      const rotation = lane > t.y ? 180 : 0;
      const miner = await L.tool("shapez_place_building", { buildingId: "miner", x: t.x, y: t.y, rotation });
      if (!miner.value?.ok) continue;
      L.state.blocked.add(L.key(t.x, t.y));
      const seg1 = cellsBetween({ x: t.x, y: t.y }, { x: t.x, y: lane });
      const seg2 = cellsBetween({ x: t.x, y: lane }, { x: via, y: lane });
      const seg3 = cellsBetween({ x: via, y: lane }, { x: via, y: f.endRow });
      if (!seg1 || !seg2 || !seg3) continue;
      const cells = [...seg1, ...seg2, ...seg3];
      const corner = via !== f.col ? [{ x: f.col, y: f.endRow }] : [];
      const r1 = await placeRun(cells, corner.length ? corner[0] : { x: f.col, y: f.endRow - 1 }, { x: t.x, y: t.y });
      if (!r1.ok) {
        await L.tool("shapez_delete_building", { x: t.x, y: t.y });
        L.state.blocked.delete(L.key(t.x, t.y));
        await L.refreshBlocked();
        await L.refreshBeltCells();
        continue;
      }
      let r2 = { ok: true, tunnels: 0 };
      if (corner.length) {
        r2 = await placeRun(corner, { x: f.col, y: f.endRow - 1 }, { x: via, y: f.endRow });
        if (!r2.ok) {
          await L.refreshBlocked();
          await L.refreshBeltCells();
          continue;
        }
      }
      done += 1;
      built = true;
      break;
    }
    if (!built) failed.push(f.label);
  }
  return { done, failed };
};

const feeds = [
  { color: "red", col: x0 - 4, endRow: R + 5, label: "白-红", searchDx: -12, via: x0 - 3 },
  { color: "green", col: x0 - 5, endRow: R + 9, label: "青2-绿" },
  { color: "blue", col: x0 - 4, endRow: R + 9, label: "青2-蓝" },
  { color: "green", col: x0 - 12, endRow: R + 5, label: "青-绿", via: x0 - 13 },
  { color: "blue", col: x0 - 11, endRow: R + 5, label: "青-蓝", via: x0 - 10 },
  { color: "blue", col: x0 - 19, endRow: R + 1, label: "蓝→paint3" },
];

const byName = (n) => feeds.find((f) => f.label === n);
const orders = [
  ["白-红", "青-绿", "青-蓝", "青2-绿", "青2-蓝", "蓝→paint3"],
  ["青2-绿", "青2-蓝", "白-红", "青-绿", "青-蓝", "蓝→paint3"],
  ["蓝→paint3", "青-绿", "青-蓝", "白-红", "青2-绿", "青2-蓝"],
  ["青-绿", "青-蓝", "白-红", "青2-绿", "青2-蓝", "蓝→paint3"],
  ["青2-绿", "青-绿", "青-蓝", "青2-蓝", "白-红", "蓝→paint3"],
  ["青-绿", "青2-绿", "青2-蓝", "青-蓝", "白-红", "蓝→paint3"],
];

let best = null;
for (let oi = 0; oi < orders.length; oi++) {
  const order = orders[oi].map(byName);
  const res = await buildFactory(order);
  console.log(`顺序 ${oi + 1}: ${res.done}/6${res.failed.length ? "，缺 " + res.failed.join(",") : ""}`);
  if (res.done === 6) { best = res; break; }
}
if (!best) {
  console.log("所有顺序都没能六条全通");
  process.exit(4);
}

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
