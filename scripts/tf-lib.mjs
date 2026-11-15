/**
 * 十二分形建线工具箱：端口几何、BFS 铺带、探针。
 *
 * 端口表（rotation 0，tile 坐标就是「物料来自/去向的那一格」）：
 *   seamCut / rotate4(1x1)：进 (x, y+1)，出 (x, y-1)
 *   seepPaint(2x1, rot 270)：进 (x, y+1)，出 (x, y-2)，染料从 (x-1, y-1) 进
 *   mixer(2x1, rot 0)：两路染料从 (x, y+1)、(x+1, y+1) 进，出 (x, y-1)
 */
import { tool, key } from "<local-tmp>/mcpc.mjs";

export const DIRS = [
  { dx: 0, dy: -1, rotation: 0, name: "上" },
  { dx: 1, dy: 0, rotation: 90, name: "右" },
  { dx: 0, dy: 1, rotation: 180, name: "下" },
  { dx: -1, dy: 0, rotation: 270, name: "左" },
];

export const state = {
  hub: null,
  hubTiles: new Set(),
  blocked: new Set(),
  belts: [],
};

export async function init() {
  await tool("shapez_dismiss_dialogs");
  state.hub = (await tool("shapez_query_entities", { buildingId: "hub", limit: 5 })).value.entities[0];
  state.hubTiles = new Set();
  for (let x = state.hub.x; x < state.hub.x + state.hub.width; x++) {
    for (let y = state.hub.y; y < state.hub.y + state.hub.height; y++) {
      state.hubTiles.add(key(x, y));
    }
  }
  await refreshBlocked();
}

export async function refreshBlocked() {
  state.blocked = new Set();
  const entities = (await tool("shapez_query_entities", { limit: 2000 })).value.entities ?? [];
  for (const e of entities) {
    for (let x = e.x; x < e.x + (e.width ?? 1); x++) {
      for (let y = e.y; y < e.y + (e.height ?? 1); y++) state.blocked.add(key(x, y));
    }
  }
}

export const free = (x, y) => !state.blocked.has(key(x, y)) && !state.hubTiles.has(key(x, y));

export async function place(buildingId, x, y, rotation = 0, extra = {}) {
  const res = await tool("shapez_place_building", { buildingId, x, y, rotation, ...extra });
  if (!res.value?.ok) throw new Error(`放置 ${buildingId}@${x},${y} 失败: ${res.value?.reason}`);
  for (let dx = 0; dx < (res.value.width ?? 1); dx++) state.blocked.add(key(x + dx, y));
  return res.value;
}

/**
 * 铺一条带：从 fromTile（已占用的建筑/矿机）→ 第一格 start → … → lastCell，最后指向 targetTile。
 * 例：矿机在 (x,y) 朝上出料 → from={x,y}, start={x,y-1}, lastCell=染料端口格, target=机器所在格。
 */
export async function beltPath({ from, start, last, target, extraBlocked = [] }) {
  const blocked = new Set(state.blocked);
  for (const k of extraBlocked) blocked.add(k);
  blocked.delete(key(start.x, start.y));
  blocked.delete(key(last.x, last.y));
  const goalKey = key(last.x, last.y);
  const queue = [[start.x, start.y]];
  const seen = new Map([[key(start.x, start.y), null]]);
  let end = null;
  while (queue.length) {
    const [cx, cy] = queue.shift();
    const cur = key(cx, cy);
    if (cur === goalKey) {
      end = cur;
      break;
    }
    for (const d of DIRS) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      const k = key(nx, ny);
      if (seen.has(k) || blocked.has(k) || state.hubTiles.has(k)) continue;
      if (Math.abs(nx - state.hub.x) > 150 || Math.abs(ny - state.hub.y) > 150) continue;
      seen.set(k, cur);
      queue.push([nx, ny]);
    }
  }
  if (!end) return null;
  const path = [];
  let node = end;
  while (node) {
    const [px, py] = node.split(",").map(Number);
    path.unshift({ x: px, y: py });
    node = seen.get(node);
  }
  const res = await tool("shapez_build_belt_path", { cells: path, from, target });
  if (!res.value || res.value.failed?.length) {
    return { failed: true, cells: path.length, failedCells: res.value?.failed ?? null };
  }
  for (const cell of path) state.blocked.add(key(cell.x, cell.y));
  state.belts.push(...path);
  return { path, result: res.value };
}

/** 从 Hub 外面最近的空地找一个能放整列机器的位置（垂直列，向上）。 */
export function findColumn(height, nearX = null) {
  const hub = state.hub;
  for (let dist = 6; dist <= 26; dist++) {
    for (const sign of [1, -1]) {
      const x = nearX === null ? hub.x + sign * dist : nearX;
      if (nearX !== null && dist > 6) break;
      for (let y = hub.y + 4; y <= hub.y + 40; y++) {
        let ok = true;
        for (let i = 0; i <= height; i++) {
          if (!free(x, y - i)) {
            ok = false;
            break;
          }
        }
        if (ok) return { x, y };
      }
      if (nearX !== null) break;
    }
  }
  return null;
}

export async function probeShapes(cells, ticks = 300, rounds = 2) {
  const seen = new Map();
  for (let round = 0; round < rounds; round++) {
    await tool("shapez_wait_ticks", { ticks });
    for (const cell of cells) {
      const tile = (await tool("shapez_inspect_tile", { x: cell.x, y: cell.y })).value;
      const items = tile?.belt?.items ?? [];
      const name = `${cell.x},${cell.y}`;
      if (!seen.has(name)) seen.set(name, new Set());
      for (const item of items) if (item.shape) seen.get(name).add(item.shape);
      for (const item of items) if (item.type && item.shape === null) seen.get(name).add(`color:${item.type}`);
    }
  }
  return seen;
}

export async function goals() {
  return (await tool("shapez_hub_goals")).value;
}

export { tool, key };

/** 从 start 接到 Hub：BFS 到任意贴 Hub 的空格，最后指向 Hub 那一格。 */
export async function beltToHub({ from, start }) {
  const hub = state.hub;
  const goalOf = (x, y) => DIRS.find((d) => state.hubTiles.has(key(x + d.dx, y + d.dy)));
  const blocked = new Set(state.blocked);
  blocked.delete(key(start.x, start.y));
  const queue = [[start.x, start.y]];
  const seen = new Map([[key(start.x, start.y), null]]);
  let end = null;
  let into = null;
  while (queue.length) {
    const [cx, cy] = queue.shift();
    const cur = key(cx, cy);
    const dir = goalOf(cx, cy);
    if (dir) {
      end = cur;
      into = { x: cx + dir.dx, y: cy + dir.dy };
      break;
    }
    for (const d of DIRS) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      const k = key(nx, ny);
      if (seen.has(k) || blocked.has(k) || state.hubTiles.has(k)) continue;
      if (Math.abs(nx - hub.x) > 150 || Math.abs(ny - hub.y) > 150) continue;
      seen.set(k, cur);
      queue.push([nx, ny]);
    }
  }
  if (!end) return null;
  const path = [];
  let node = end;
  while (node) {
    const [px, py] = node.split(",").map(Number);
    path.unshift({ x: px, y: py });
    node = seen.get(node);
  }
  const res = await tool("shapez_build_belt_path", { cells: path, from, target: into });
  for (const cell of path) state.blocked.add(key(cell.x, cell.y));
  return { path, result: res.value, into };
}

/** 记录当前哪些格是带子（可穿），哪些是机器（不可穿）。 */
export async function refreshBeltCells() {
  state.beltCells = new Set();
  const entities = (await tool("shapez_query_entities", { limit: 2000 })).value.entities ?? [];
  for (const e of entities) {
    if (e.buildingId === "belt") state.beltCells.add(key(e.x, e.y));
  }
}

/**
 * 带隧道插入的铺带：cells 里被别的带子占用的格子，用 sender/receiver 从下面穿过去。
 *   from   —— cells 之前那一格（矿机/机器）
 *   cells  —— 规划好的路线（格子序列）
 *   target —— 最后要接进去的机器格
 */
export async function buildRouteWithTunnels({ from, cells, target }) {
  if (!cells.length) return null;
  if (!state.beltCells) await refreshBeltCells();
  const isBelt = (c) => state.beltCells.has(key(c.x, c.y));
  const isMachine = (c) => state.blocked.has(key(c.x, c.y)) && !isBelt(c);

  const chunks = [];
  let buf = [];
  let i = 0;
  let tunnels = 0;
  while (i < cells.length) {
    const c = cells[i];
    if (isMachine(c)) return { ok: false, reason: `机器格 ${c.x},${c.y}` };
    if (isBelt(c)) {
      let j = i;
      while (j < cells.length && isBelt(cells[j])) j += 1;
      const run = j - i;
      if (run > 4 || buf.length === 0 || j >= cells.length) return { ok: false, reason: `穿越段太长 ${run}（${cells[i].x},${cells[i].y}）` };
      const sender = buf.pop();
      if (buf.length) chunks.push({ type: "belt", cells: buf });
      buf = [];
      chunks.push({ type: "tunnel", sender, receiver: cells[j], run });
      tunnels += 1;
      i = j + 1;
      continue;
    }
    buf.push(c);
    i += 1;
  }
  if (buf.length) chunks.push({ type: "belt", cells: buf });

  let prevTile = { x: from.x, y: from.y };
  for (let idx = 0; idx < chunks.length; idx++) {
    const chunk = chunks[idx];
    const next = chunks[idx + 1];
    if (chunk.type === "tunnel") {
      const { sender, receiver } = chunk;
      const dx = receiver.x - sender.x;
      const dy = receiver.y - sender.y;
      const rotation = dx > 0 ? 90 : dx < 0 ? 270 : dy > 0 ? 180 : 0;
      const sres = await tool("shapez_place_building", {
        buildingId: "underground_belt",
        x: sender.x,
        y: sender.y,
        rotation,
        rotationVariant: 0,
      });
      const rres = await tool("shapez_place_building", {
        buildingId: "underground_belt",
        x: receiver.x,
        y: receiver.y,
        rotation,
        rotationVariant: 1,
      });
      if (!sres.value?.ok || !rres.value?.ok) return { ok: false, reason: `隧道放不下 ${sender.x},${sender.y}→${receiver.x},${receiver.y}` };
      state.blocked.add(key(sender.x, sender.y));
      state.blocked.add(key(receiver.x, receiver.y));
      prevTile = { x: receiver.x, y: receiver.y };
      continue;
    }
    const nextTarget = next && next.type === "tunnel" ? next.sender : target;
    const res = await tool("shapez_build_belt_path", {
      cells: chunk.cells,
      from: prevTile,
      target: nextTarget,
    });
    if (!res.value || res.value.failed?.length) return { ok: false, reason: `铺带失败 ${JSON.stringify(res.value?.failed?.slice(0, 2))}` };
    for (const c of chunk.cells) {
      state.blocked.add(key(c.x, c.y));
      state.beltCells.add(key(c.x, c.y));
    }
    prevTile = chunk.cells[chunk.cells.length - 1];
  }
  return { ok: true, tunnels };
}

/** 带权 BFS：空格 1、已有带子 12（尽量少走，但允许穿）。返回格子序列。 */
export function findRoute({ from, start, last, target, blockedMachines }) {
  const startKey = key(start.x, start.y);
  const goalKey = key(last.x, last.y);
  const dist = new Map([[startKey, 0]]);
  const prev = new Map([[startKey, null]]);
  const net = [key(from.x, from.y)];
  const visited = new Set(net);
  const queue = [[0, start.x, start.y]];
  const isFree = (x, y) => {
    const k = key(x, y);
    if (blockedMachines.has(k)) return false;
    if (state.hubTiles.has(k)) return false;
    return true;
  };
  while (queue.length) {
    queue.sort((a, b) => a[0] - b[0]);
    const [cost, cx, cy] = queue.shift();
    const cur = key(cx, cy);
    if (visited.has(cur) && cur !== startKey) continue;
    if (cur === goalKey) {
      const path = [];
      let node = cur;
      while (node) {
        const [px, py] = node.split(",").map(Number);
        path.unshift({ x: px, y: py });
        node = prev.get(node);
      }
      return path;
    }
    for (const d of DIRS) {
      const nx = cx + d.dx;
      const ny = cy + d.dy;
      const k = key(nx, ny);
      if (!isFree(nx, ny)) continue;
      if (state.blocked.has(k) && !(state.beltCells && state.beltCells.has(k))) continue;
      if (Math.abs(nx - state.hub.x) > 140 || Math.abs(ny - state.hub.y) > 140) continue;
      const w = state.beltCells && state.beltCells.has(k) ? 12 : 1;
      const nd = cost + w;
      if (dist.has(k) && dist.get(k) <= nd) continue;
      dist.set(k, nd);
      prev.set(k, cur);
      queue.push([nd, nx, ny]);
    }
  }
  return null;
}
