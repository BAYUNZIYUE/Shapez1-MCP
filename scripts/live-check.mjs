#!/usr/bin/env node
/**
 * 真实游戏联调检查：需要游戏已在运行、存档已进入、桥端口空闲。
 *
 *   SHAPEZ1_MCP_TOKEN=... node scripts/live-check.mjs
 *   SHAPEZ1_MCP_PORT=8765 SHAPEZ1_MCP_HOST=127.0.0.1 node scripts/live-check.mjs
 *
 * 它会拉起一个真正的 MCP stdio server（占用桥端口），等游戏连上后按顺序验证：
 *   status → list_buildings → place(code) → query → delete → query 为空
 *   → hub_goals / production_rates / decode_shape 不报错
 * 全部通过退出码 0，任一失败退出码 1。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const port = process.env.SHAPEZ1_MCP_PORT ?? "8765";
const host = process.env.SHAPEZ1_MCP_HOST ?? "127.0.0.1";
const token = process.env.SHAPEZ1_MCP_TOKEN ?? "";

const child = spawn(join(root, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    SHAPEZ1_MCP_PORT: port,
    SHAPEZ1_MCP_HOST: host,
    ...(token ? { SHAPEZ1_MCP_TOKEN: token } : {}),
  },
  stdio: ["pipe", "pipe", "pipe"],
});

const waiters = new Map();
let buffer = "";
let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += String(chunk);
});
child.stdout.on("data", (chunk) => {
  buffer += String(chunk);
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const waiter = waiters.get(message.id);
    if (waiter) {
      waiters.delete(message.id);
      waiter(message);
    }
  }
});

let nextId = 1;
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时: ${method}`)), 70_000);
    waiters.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

async function tool(name, args = {}) {
  const response = await rpc("tools/call", { name, arguments: args });
  const text = response.result?.content?.[0]?.text ?? "";
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* 保持原文 */
  }
  return { isError: response.result?.isError === true, value: parsed, text };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
}

try {
  await sleep(1500);
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "live-check", version: "0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  let status;
  for (let attempt = 0; attempt < 20; attempt++) {
    status = await tool("shapez_status");
    if (status.value?.bridge?.connected) break;
    await sleep(1500);
  }
  check("桥与游戏连接", status.value?.bridge?.connected === true, status.value?.bridge?.host + ":" + port);
  check("已加载存档", status.value?.game?.hasSave === true, `层=${status.value?.game?.currentLayer}`);

  const buildings = await tool("shapez_list_buildings");
  const variants = buildings.value?.buildings ?? [];
  check("list_buildings", variants.length > 0, `${variants.length} 个变体`);
  const beltCodes = variants.filter((item) => item.buildingId === "belt").map((item) => item.code);
  check("belt 有 code", beltCodes.length === 3, `code=${JSON.stringify(beltCodes)}`);

  const camera = status.value?.game?.camera ?? { x: 0, y: 0 };
  let placed = null;
  let at = null;
  for (const [dx, dy] of [[6, 0], [0, 6], [8, 8], [12, -4], [-6, 4], [20, 20], [-20, -20]]) {
    const x = Math.round((camera.x ?? 0) + dx);
    const y = Math.round((camera.y ?? 0) + dy);
    const result = await tool("shapez_place_building", { code: beltCodes[0], x, y });
    if (result.value?.ok) {
      placed = result.value;
      at = { x, y };
      break;
    }
  }
  check("place_building", !!placed, placed ? `uid=${placed.uid} @${at.x},${at.y}` : "所有候选位置都失败");

  if (placed) {
    const near = await tool("shapez_query_entities", {
      x1: at.x,
      y1: at.y,
      x2: at.x,
      y2: at.y,
      limit: 5,
    });
    check("放置后能查到", (near.value?.total ?? 0) >= 1, JSON.stringify(near.value?.entities?.[0] ?? {}));
    const deleted = await tool("shapez_delete_building", { x: at.x, y: at.y });
    check("delete_building", deleted.value?.ok === true, `uid=${deleted.value?.uid}`);
    const after = await tool("shapez_query_entities", {
      x1: at.x,
      y1: at.y,
      x2: at.x,
      y2: at.y,
      limit: 5,
    });
    check("删除后查不到", (after.value?.total ?? 1) === 0);
  }

  const hub = await tool("shapez_hub_goals");
  check("hub_goals", !hub.isError && typeof hub.value?.level === "number", `目标=${hub.value?.goalShape} 需求=${hub.value?.required}`);

  const rates = await tool("shapez_production_rates");
  check("production_rates", !rates.isError && rates.value?.produced !== null);

  const shape = await tool("shapez_decode_shape", { key: "CuCuCuCu" });
  check("decode_shape", shape.value?.valid === true, `层数=${shape.value?.layers?.length}`);
} catch (error) {
  check("执行过程", false, String(error?.message ?? error));
} finally {
  child.kill("SIGTERM");
  await sleep(400);
}

const failed = checks.filter((item) => !item.ok);
if (failed.length > 0) {
  console.error("\n失败项：", failed.map((item) => item.name).join(", "));
  console.error(stderr.split("\n").slice(0, 8).join("\n"));
  process.exit(1);
}
console.log("\n全部通过。");
process.exit(0);
