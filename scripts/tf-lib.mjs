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
