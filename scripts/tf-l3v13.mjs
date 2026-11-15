/**
 * 第 3 关 v10：路线全部由「直线段」组成（竖→横→竖），跨到别人的带子就插隧道。
 * 直线段简单可控，不再用通用 BFS 铺带，避免上次那种“缺一格”的问题。
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
await L.place("mixer", colW, R + 4, 0);
await L.place("mixer", colW, R + 8, 0);
await L.place("mixer", colC, R + 4, 0);

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
await verticalUp(colW, R + 8, R + 5, R + 4, "青2→白");
await verticalUp(colW, R + 4, R + 1, R, "白→paint1");
await verticalUp(colC, R + 4, R + 1, R, "青→paint2");

/**
 * 铺一条直线段：从 from 的下一格开始，按 dx/dy 走到 end（含）。
 * 遇到别人的带子就插隧道（sender 前一格、receiver 后一格）。
 */
const buildStraight = async ({ from, end, target, label }) => {
  const stepX = Math.sign(end.x - from.x);
  const stepY = Math.sign(end.y - from.y);
  const cells = [];
  let cur = { x: from.x + stepX, y: from.y + stepY };
  while (true) {
    cells.push({ x: cur.x, y: cur.y });
    if (cur.x === end.x && cur.y === end.y) break;
    cur = { x: cur.x + stepX, y: cur.y + stepY };
  }
  // 切分成「普通段 / 隧道段」
  const chunks = [];
  let buf = [];
  let i = 0;
  let tunnels = 0;
  while (i < cells.length) {
    const c = cells[i];
    const k = L.key(c.x, c.y);
    const belt = L.state.beltCells.has(k);
    const machine = L.state.blocked.has(k) && !belt;
    if (machine) return { ok: false, reason: `机器挡路 ${c.x},${c.y}` };
    if (belt) {
      let j = i;
      while (j < cells.length && L.state.beltCells.has(L.key(cells[j].x, cells[j].y))) j++;
      const run = j - i;
      if (run > 4 || buf.length === 0 || j >= cells.length) return { ok: false, reason: `穿越段 ${run} 无法处理` };
      const sender = buf.pop();
      if (buf.length) chunks.push({ belt: buf });
      buf = [];
      chunks.push({ tunnel: { sender, receiver: cells[j], run } });
      tunnels += 1;
      i = j + 1;
      continue;
    }
    buf.push(c);
    i += 1;
  }
  if (buf.length) chunks.push({ belt: buf });

  let prev = { x: from.x, y: from.y };
  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];
    const next = chunks[idx + 1];
    if (chunk.tunnel) {
      const { sender, receiver } = chunk.tunnel;
      const dx = receiver.x - sender.x;
      const dy = receiver.y - sender.y;
      const rotation = dx > 0 ? 90 : dx < 0 ? 270 : dy > 0 ? 180 : 0;
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
      if (!sres.value?.ok || !rres.value?.ok) return { ok: false, reason: `隧道放不下 ${sender.x},${sender.y}` };
      L.state.blocked.add(L.key(sender.x, sender.y));
      L.state.blocked.add(L.key(receiver.x, receiver.y));
      prev = { x: receiver.x, y: receiver.y };
      continue;
    }
    const nextTarget = next && next.tunnel ? next.tunnel.sender : target;
    const res = await L.tool("shapez_build_belt_path", {
      cells: chunk.belt,
      from: prev,
      target: nextTarget,
    });
    if (!res.value || res.value.failed?.length) return { ok: false, reason: `铺带失败 ${JSON.stringify(res.value?.failed?.slice(0, 2))}` };
    for (const c of chunk.belt) {
      L.state.blocked.add(L.key(c.x, c.y));
      L.state.beltCells.add(L.key(c.x, c.y));
    }
    prev = chunk.belt[chunk.belt.length - 1];
  }
  return { ok: true, tunnels, cells: cells.length };
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

const feeds = [
  { color: "red", col: colW + 1, endRow: R + 5, label: "白-红", searchDx: -12, via: colW + 2 },
  { color: "green", col: colW, endRow: R + 9, label: "青2-绿" },
  { color: "blue", col: colW + 1, endRow: R + 9, label: "青2-蓝" },
  { color: "green", col: colC, endRow: R + 5, label: "青-绿", via: colC - 1 },
  { color: "blue", col: colC + 1, endRow: R + 5, label: "青-蓝", via: colC + 2 },
  { color: "blue", col: colB, endRow: R + 1, label: "蓝→paint3" },
];

const byLabel = (n) => feeds.find((f) => f.label === n);

const buildFactory = async (order) => {
  await clearAll();
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
  const colW = x0 - 5;
  const colC = x0 - 12;
  const colB = x0 - 19;
  await L.place("mixer", colW, R + 4, 0);
  await L.place("mixer", colW, R + 8, 0);
  await L.place("mixer", colC, R + 4, 0);
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
  };
  await verticalUp(colW, R + 8, R + 5, R + 4, "青2→白");
  await verticalUp(colW, R + 4, R + 1, R, "白→paint1");
  await verticalUp(colC, R + 4, R + 1, R, "青→paint2");

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
      if (!L.free(t.x, t.y) || t.y === lane) continue;
      const minerRotation = lane > t.y ? 180 : 0;
      const miner = await L.tool("shapez_place_building", { buildingId: "miner", x: t.x, y: t.y, rotation: minerRotation });
      if (!miner.value?.ok) continue;
      L.state.blocked.add(L.key(t.x, t.y));
      const seg1 = await buildStraight({
        from: { x: t.x, y: t.y },
        end: { x: t.x, y: lane },
        target: { x: via, y: lane },
        label: `${f.label}-1`,
      });
      if (!seg1.ok) {
        await L.tool("shapez_delete_building", { x: t.x, y: t.y });
        L.state.blocked.delete(L.key(t.x, t.y));
        await L.refreshBlocked();
        await L.refreshBeltCells();
        continue;
      }
      let ok = true;
      if (t.x !== via) {
        const seg2 = await buildStraight({
          from: { x: t.x, y: lane },
          end: { x: via, y: lane },
          target: { x: via, y: lane - 1 },
          label: `${f.label}-2`,
        });
        ok = seg2.ok;
      }
      if (ok) {
        const seg3 = await buildStraight({
          from: { x: via, y: lane },
          end: { x: via, y: f.endRow },
          target: via === f.col ? { x: f.col, y: f.endRow - 1 } : { x: f.col, y: f.endRow },
          label: `${f.label}-3`,
        });
        ok = seg3.ok;
        if (ok && via !== f.col) {
          const seg4 = await buildStraight({
            from: { x: via, y: f.endRow },
            end: { x: f.col, y: f.endRow },
            target: { x: f.col, y: f.endRow - 1 },
            label: `${f.label}-4`,
          });
          ok = seg4.ok;
        }
      }
      if (ok) {
        done += 1;
        built = true;
        break;
      }
      await L.refreshBlocked();
      await L.refreshBeltCells();
    }
    if (!built) failed.push(f.label);
  }
  return { done, failed };
};

const orders = [
  ["白-红", "青-绿", "青-蓝", "青2-绿", "青2-蓝", "蓝→paint3"],
  ["青-绿", "青-蓝", "青2-绿", "青2-蓝", "白-红", "蓝→paint3"],
  ["青2-绿", "青2-蓝", "白-红", "青-绿", "青-蓝", "蓝→paint3"],
  ["蓝→paint3", "青-绿", "青-蓝", "白-红", "青2-绿", "青2-蓝"],
  ["白-红", "青2-绿", "青2-蓝", "青-绿", "青-蓝", "蓝→paint3"],
];

let chosen = null;
for (let oi = 0; oi < orders.length; oi++) {
  const res = await buildFactory(orders[oi].map(byLabel));
  console.log(`顺序 ${oi + 1}: ${res.done}/6${res.failed.length ? "，缺 " + res.failed.join(",") : ""}`);
  if (res.done === 6) { chosen = res; break; }
}
if (!chosen) {
  console.log("没有顺序能全通");
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
