import WebSocket from "ws";
import { pathToFileURL } from "node:url";
import { PROTOCOL_VERSION, parseServerMessage } from "./protocol.js";

/**
 * 假游戏端：在没装 shapez 的机器上验证"mod ↔ 桥 ↔ MCP 工具"整条链路。
 *
 * 它只说桥协议，不实现游戏逻辑；建筑表、Hub 数据都是编造的，
 * 用来验证协议、超时、错误透传，不能替代游戏内验证。
 */

export interface MockGameOptions {
  url: string;
  token?: string;
  modVersion?: string;
}

interface Placement {
  buildingId: string;
  x: number;
  y: number;
  rotation: number;
  variant: number;
  rotationVariant: number;
}

interface Entity extends Placement {
  uid: number;
  layer: number;
}

const KNOWN_BUILDINGS = new Set([
  "belt_forward",
  "belt_left",
  "belt_right",
  "miner",
  "balancer",
  "underground_belt_entry",
  "underground_belt_exit",
  "hub",
]);

export class MockGame {
  private ws: WebSocket | null = null;
  private nextUid = 1000;
  private readonly world = new Map<string, Entity>();
  private speed: "paused" | "regular" | "fast_forward" = "regular";
  private readonly options: MockGameOptions;

  constructor(options: MockGameOptions) {
    this.options = options;
  }

  async connect(): Promise<void> {
    const ws = new WebSocket(this.options.url);
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (error) => reject(error));
    });

    ws.on("message", (raw) => this.handle(String(raw)));
    ws.send(
      JSON.stringify({
        type: "hello",
        protocol: PROTOCOL_VERSION,
        modVersion: this.options.modVersion ?? `mock-${PROTOCOL_VERSION}`,
        ...(this.options.token ? { token: this.options.token } : {}),
      }),
    );
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private handle(raw: string): void {
    let message;
    try {
      message = parseServerMessage(raw);
    } catch {
      return;
    }
    if (message.type !== "request") {
      return;
    }

    try {
      const result = this.dispatch(message.method, message.params ?? {});
      this.reply({ type: "response", id: message.id, ok: true, result });
    } catch (error) {
      this.reply({
        type: "response",
        id: message.id,
        ok: false,
        error: { code: "mock_error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private reply(message: unknown): void {
    this.ws?.send(JSON.stringify(message));
  }

  private dispatch(method: string, params: Record<string, unknown>): unknown {
    switch (method) {
      case "status":
        return {
          hasSave: true,
          gameVersion: "mock-1.6.0",
          paused: this.speed === "paused",
          speed: this.speed,
          currentLayer: 0,
          camera: { x: 0, y: 0, zoom: 1 },
          entities: this.world.size,
        };
      case "placeBuilding":
        return this.place(params);
      case "placeBuildings": {
        const list = params["buildings"];
        if (!Array.isArray(list)) {
          throw new Error("buildings 必须是数组");
        }
        const results = list.map((item) => this.place(this.asRecord(item)));
        return {
          placed: results.filter((result) => result["ok"] === true).length,
          failed: results
            .map((result, index) => ({ index, reason: result["reason"] as string | undefined, ok: result["ok"] }))
            .filter((item) => item.ok !== true)
            .map(({ index, reason }) => ({ index, reason })),
        };
      }
      case "deleteBuilding": {
        const x = this.int(params, "x");
        const y = this.int(params, "y");
        const layer = params["layer"] === undefined || Number(params["layer"]) < 0 ? 0 : this.int(params, "layer");
        const key = `${x},${y},${layer}`;
        const entity = this.world.get(key);
        if (!entity) {
          return { ok: false, reason: "该位置没有建筑" };
        }
        this.world.delete(key);
        return { ok: true, uid: entity.uid, buildingId: entity.buildingId };
      }
      case "queryEntities": {
        const limit = params["limit"] === undefined ? 200 : this.int(params, "limit");
        const bounds = ["x1", "y1", "x2", "y2"].every((key) => params[key] === undefined)
          ? null
          : {
              x1: params["x1"] === undefined ? -Infinity : this.int(params, "x1"),
              y1: params["y1"] === undefined ? -Infinity : this.int(params, "y1"),
              x2: params["x2"] === undefined ? Infinity : this.int(params, "x2"),
              y2: params["y2"] === undefined ? Infinity : this.int(params, "y2"),
            };
        const all = [...this.world.values()].filter((entity) => {
          if (typeof params["buildingId"] === "string" && entity.buildingId !== params["buildingId"]) {
            return false;
          }
          if (params["layer"] !== undefined && entity.layer !== Number(params["layer"])) {
            return false;
          }
          if (!bounds) {
            return true;
          }
          return (
            entity.x >= bounds.x1 && entity.x <= bounds.x2 && entity.y >= bounds.y1 && entity.y <= bounds.y2
          );
        });
        return { total: all.length, truncated: all.length > limit, entities: all.slice(0, limit) };
      }
      case "hubGoals":
        return {
          goalIndex: 3,
          delivered: 1200,
          stored: [
            { key: "CuCuCuCu", amount: 800 },
            { key: "RuRuRuRu", amount: 400 },
          ],
          upgrades: { belts: 2, miners: 1 },
        };
      case "productionRates":
        return { current: { CuCuCuCu: 4.5, RuRuRuRu: 2.25 }, past: { CuCuCuCu: 4.1 } };
      case "decodeShape": {
        const key = params["key"];
        if (typeof key !== "string" || key.length === 0) {
          throw new Error("key 必须是非空字符串");
        }
        const layerCount = key.split(":").length;
        return { valid: true, key, layers: layerCount, mock: true };
      }
      case "setSpeed": {
        const mode = params["mode"];
        if (mode !== "paused" && mode !== "regular" && mode !== "fast_forward") {
          throw new Error(`未知速度模式: ${String(mode)}`);
        }
        this.speed = mode;
        return { speed: this.speed };
      }
      case "waitTicks": {
        const ticks = params["ticks"] === undefined ? 60 : this.int(params, "ticks");
        return { ticks, waitedMs: Math.min(ticks, 20) * 5, mock: true };
      }
      default:
        throw new Error(`假游戏不实现方法: ${method}`);
    }
  }

  private place(params: Record<string, unknown>): Record<string, unknown> {
    const buildingId = String(params["buildingId"] ?? "");
    if (!KNOWN_BUILDINGS.has(buildingId)) {
      return { ok: false, reason: `未知建筑 id: ${buildingId}` };
    }
    const x = this.int(params, "x");
    const y = this.int(params, "y");
    const layer = params["layer"] === undefined ? 0 : this.int(params, "layer");
    const key = `${x},${y},${layer}`;
    if (this.world.has(key)) {
      return { ok: false, reason: "该位置已有建筑" };
    }
    const entity: Entity = {
      uid: this.nextUid++,
      buildingId,
      x,
      y,
      layer,
      rotation: params["rotation"] === undefined ? 0 : this.int(params, "rotation"),
      variant: params["variant"] === undefined ? 0 : this.int(params, "variant"),
      rotationVariant: params["rotationVariant"] === undefined ? 0 : this.int(params, "rotationVariant"),
    };
    this.world.set(key, entity);
    return { ok: true, uid: entity.uid };
  }

  private int(params: Record<string, unknown>, key: string): number {
    const raw = params[key];
    const value = Number(raw);
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error(`${key} 必须是整数，收到 ${String(raw)}`);
    }
    return value;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("列表元素必须是对象");
    }
    return value as Record<string, unknown>;
  }
}

async function main(): Promise<void> {
  const url = process.env["MOCK_GAME_URL"] ?? "ws://127.0.0.1:8765";
  const game = new MockGame({ url, token: process.env["SHAPEZ1_MCP_TOKEN"] });
  console.error(`[mock] 连接 ${url}`);
  await game.connect();
  console.error("[mock] 已连接，Ctrl+C 退出");
  process.on("SIGINT", () => {
    game.close();
    process.exit(0);
  });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
