import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

/**
 * 端到端：起真正的 MCP stdio server 子进程，让假游戏连上它的桥，
 * 再用 JSON-RPC 走一遍 initialize / tools/list / tools/call。
 * 这是唯一能证明"MCP 层真的能接 agent 基座"的验证，别删。
 */

const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

interface Rpc {
  id?: number;
  result?: { tools?: { name: string }[]; content?: { text: string }[]; serverInfo?: unknown };
}

async function waitFor(predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("等待条件超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("MCP stdio 端到端", () => {
  it("列出 10 个工具，并能把 tools/call 透传到游戏端", async () => {
    const child: ChildProcessWithoutNullStreams = spawn(
      join(process.cwd(), "node_modules", ".bin", "tsx"),
      ["src/index.ts"],
      { cwd: process.cwd(), env: { ...process.env, SHAPEZ1_MCP_PORT: "0" }, stdio: ["pipe", "pipe", "pipe"] },
    );
    cleanups.push(() => child.kill("SIGKILL"));

    let stderr = "";
    const bridge: { port: number | null } = { port: null };
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      const matched = /桥端口 (\d+)/.exec(stderr);
      if (matched?.[1] && bridge.port === null) {
        bridge.port = Number(matched[1]);
      }
    });

    const replies: Rpc[] = [];
    let buffered = "";
    child.stdout.on("data", (chunk) => {
      buffered += String(chunk);
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          replies.push(JSON.parse(line) as Rpc);
        }
      }
    });

    await waitFor(() => bridge.port !== null);
    const bridgePort = bridge.port;
    if (bridgePort === null) {
      throw new Error("没有从 stderr 取到桥端口");
    }

    const game = new WebSocket(`ws://127.0.0.1:${bridgePort}`);
    cleanups.push(() => game.close());
    await new Promise<void>((resolve, reject) => {
      game.once("open", () => resolve());
      game.once("error", (error) => reject(error));
    });
    game.send(JSON.stringify({ type: "hello", protocol: 1, modVersion: "e2e" }));
    game.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { type: string; id?: number };
      if (message.type === "request") {
        game.send(
          JSON.stringify({
            type: "response",
            id: message.id,
            ok: true,
            result: { hasSave: true, speed: "regular", fromE2e: true },
          }),
        );
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const send = (payload: unknown): void => {
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    };
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "0" } },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });

    const find = (id: number): Rpc | undefined => replies.find((item) => item.id === id);
    await waitFor(() => find(2) !== undefined);

    const tools = find(2)?.result?.tools ?? [];
    expect(tools).toHaveLength(15);
    expect(tools.map((tool) => tool.name)).toContain("shapez_place_buildings");

    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "shapez_status", arguments: {} } });
    await waitFor(() => find(3) !== undefined);
    const payload = JSON.parse(find(3)?.result?.content?.[0]?.text ?? "null") as {
      bridge: { connected: boolean };
      game: { fromE2e: boolean; speed: string };
    };
    expect(payload.bridge.connected).toBe(true);
    expect(payload.game.fromE2e).toBe(true);
    expect(payload.game.speed).toBe("regular");
  }, 30_000);
});
