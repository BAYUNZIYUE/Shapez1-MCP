/**
 * 一次性调用 MCP 工具，起 server → 调一个工具 → 打印 JSON → 退出（约 3-5 秒）。
 *
 *   node scripts/mcp-call.mjs shapez_hub_goals
 *   node scripts/mcp-call.mjs shapez_inspect_tile '{"x":-8,"y":0}'
 *   node scripts/mcp-call.mjs shapez_place_building '{"buildingId":"trash","x":-8,"y":0}'
 *
 * 适合短动作；需要多步流程时用 auto-play*.mjs（它们自己管生命周期）。
 * 注意：桥端口是独占的，调用期间别的脚本/客户端不能同时占着 8765。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [toolName, rawArgs] = process.argv.slice(2);
if (!toolName) {
  console.error("用法: node scripts/mcp-call.mjs <tool> ['{json args}']");
  process.exit(1);
}
let args = {};
if (rawArgs) {
  try {
    args = JSON.parse(rawArgs);
  } catch (error) {
    console.error("参数不是合法 JSON:", error.message);
    process.exit(1);
  }
}

const child = spawn(join(root, "node_modules", ".bin", "tsx"), ["src/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    SHAPEZ1_MCP_HOST: process.env.SHAPEZ1_MCP_HOST ?? "0.0.0.0",
    SHAPEZ1_MCP_PORT: process.env.SHAPEZ1_MCP_PORT ?? "8765",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

const pending = new Map();
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
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  }
});

const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e6);
    const timer = setTimeout(() => resolve({ error: "timeout" }), 90_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });

await new Promise((resolve) => setTimeout(resolve, 1800));
await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcp-call", version: "0" } });
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

// mod 每 3 秒重连一次，而本进程只活几秒：先等它连上，否则第一个调用会撞 not_connected
for (let attempt = 0; attempt < 10; attempt++) {
  const probe = await rpc("tools/call", { name: "shapez_status", arguments: {} });
  const text = probe.result?.content?.[0]?.text ?? "";
  if (text.includes('"connected":true')) break;
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

const response = await rpc("tools/call", { name: toolName, arguments: args });
const text = response.result?.content?.[0]?.text ?? JSON.stringify(response.error ?? null);
if (response.result?.isError) {
  console.error(`工具返回失败: ${text}`);
} else {
  console.log(text);
}
child.kill("SIGTERM");
await new Promise((resolve) => setTimeout(resolve, 300));
process.exit(response.result?.isError ? 1 : 0);
