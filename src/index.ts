import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { GameBridge } from "./bridge.js";
import { registerTools } from "./tools.js";

const VERSION = "0.1.0";

/** stdout 是 MCP 协议通道，所有日志必须走 stderr。 */
const log = (message: string): void => {
  console.error(message);
};

function readPort(raw: string | undefined): number {
  if (!raw) {
    return 8765;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    log(`[启动] SHAPEZ1_MCP_PORT="${raw}" 不合法，回退到 8765`);
    return 8765;
  }
  return value;
}

/** 各平台官方 mods 目录（取自 electron/index.js 的路径拼装逻辑）。 */
function modsDirHint(): string {
  if (process.platform === "win32") {
    return String.raw`%APPDATA%\shapez.io\mods`;
  }
  if (process.platform === "darwin") {
    return "~/Library/Preferences/shapez.io/mods";
  }
  return "~/.local/share/shapez.io/mods";
}

const bridge = new GameBridge({
  host: process.env["SHAPEZ1_MCP_HOST"] ?? "127.0.0.1",
  port: readPort(process.env["SHAPEZ1_MCP_PORT"]),
  token: process.env["SHAPEZ1_MCP_TOKEN"],
  requestTimeoutMs: Number(process.env["SHAPEZ1_MCP_TIMEOUT_MS"] ?? 15_000),
  log,
});

const port = await bridge.listen();

log(`[启动] shapez1-mcp ${VERSION} 就绪，桥端口 ${port}`);
log(`[启动] mod 目录：${modsDirHint()}（把 mod/shapez1-mcp.js 放进去后重启游戏）`);
if (port !== 8765) {
  log(`[启动] 注意：mod 顶部 CONFIG.url 默认是 ws://127.0.0.1:8765，端口不是 8765 时需要同步修改`);
}

let servers = 0;
const bridgeOnly = process.env["SHAPEZ1_MCP_BRIDGE_ONLY"] === "1";
if (bridgeOnly) {
  // 部署模式：只跑 WS 桥，不占 stdio（多个 MCP 客户端各自起自己的 server 连同一座桥时用）
  log("[启动] SHAPEZ1_MCP_BRIDGE_ONLY=1：仅运行 WS 桥，不提供 stdio MCP 通道");
} else {
  serveStdio(() => {
    servers += 1;
    const server = new McpServer({ name: "shapez1-mcp", version: VERSION });
    registerTools(server, { game: bridge, log });
    log(`[mcp] 第 ${servers} 个客户端接入（stdio）`);
    return server;
  });
}

const shutdown = async (signal: string): Promise<void> => {
  log(`[退出] 收到 ${signal}，关闭桥`);
  await bridge.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
