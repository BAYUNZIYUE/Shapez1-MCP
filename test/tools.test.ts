import { describe, expect, it } from "vitest";
import { BridgeError, type BridgeStatus, type GameClient } from "../src/bridge.js";
import { buildTools } from "../src/tools.js";

const connectedStatus: BridgeStatus = {
  listening: true,
  host: "127.0.0.1",
  port: 8765,
  connected: true,
  modVersion: "0.1.0",
  connectedAt: 1,
  lastEvent: null,
};

function fakeGame(overrides: Partial<GameClient> = {}): GameClient & { calls: { method: string; params?: Record<string, unknown> }[] } {
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  const game: GameClient & { calls: typeof calls } = {
    calls,
    getStatus: () => ({ ...connectedStatus }),
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push(params ? { method, params } : { method });
      return { ok: true, method };
    },
    ...overrides,
  };
  return game;
}

function tool(name: string, game: GameClient) {
  const found = buildTools({ game }).find((item) => item.name === name);
  if (!found) {
    throw new Error(`工具不存在: ${name}`);
  }
  return found;
}

function parse(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0]?.text ?? "null");
}

describe("MCP 工具层", () => {
  it("注册 18 个工具且名称唯一", () => {
    const names = buildTools({ game: fakeGame() }).map((item) => item.name);
    expect(names).toHaveLength(18);
    expect(new Set(names).size).toBe(18);
    expect(names).toContain("shapez_eval");
    expect(names).toContain("shapez_save_game");
    expect(names).toContain("shapez_dev_skip_goal");
    expect(names).toContain("shapez_dismiss_dialogs");
    expect(names).toContain("shapez_build_belt_path");
    expect(names).toContain("shapez_query_resources");
    expect(names).toContain("shapez_inspect_tile");
    expect(names).toContain("shapez_place_buildings");
    expect(names).toContain("shapez_list_buildings");
  });

  it("place_building 把参数原样下发给游戏端", async () => {
    const game = fakeGame();
    const result = await tool("shapez_place_building", game).handler({
      buildingId: "belt",
      x: 3,
      y: -2,
      rotation: 1,
    });
    expect(result.isError).toBeUndefined();
    expect(game.calls).toHaveLength(1);
    expect(game.calls[0]?.method).toBe("placeBuilding");
    expect(game.calls[0]?.params).toMatchObject({ buildingId: "belt", x: 3, y: -2, rotation: 1 });
  });

  it("输入校验：非法旋转与越界 limit 被 schema 拒绝", () => {
    const schema = tool("shapez_place_building", fakeGame()).inputSchema;
    expect(schema.safeParse({ buildingId: "belt", x: 0, y: 0, rotation: 5 }).success).toBe(false);
    expect(schema.safeParse({ buildingId: "belt", x: 0, y: 0, rotation: 45 }).success).toBe(false);
    expect(schema.safeParse({ buildingId: "belt", x: 0, y: 0, rotation: 90 }).success).toBe(true);
    expect(schema.safeParse({ buildingId: "", x: 0, y: 0 }).success).toBe(false);
    expect(schema.safeParse({ buildingId: "belt", x: 0.5, y: 0 }).success).toBe(false);
    expect(schema.safeParse({ buildingId: "belt", x: 0, y: 0 }).success).toBe(true);
    expect(schema.safeParse({ code: 1, x: 0, y: 0 }).success).toBe(true);

    const query = tool("shapez_query_entities", fakeGame()).inputSchema;
    expect(query.safeParse({ limit: 5000 }).success).toBe(false);
    expect(query.safeParse({}).success).toBe(true);
  });

  it("游戏端错误转成 isError 文本，不抛异常", async () => {
    const game = fakeGame({
      call: async () => {
        throw new BridgeError("game_error", "该位置已有建筑");
      },
    });
    const result = await tool("shapez_place_building", game).handler({ buildingId: "miner", x: 1, y: 1 });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("game_error");
    expect(result.content[0]?.text).toContain("该位置已有建筑");
  });

  it("未连接时 status 直接给提示，不调用游戏端", async () => {
    const game = fakeGame({
      getStatus: () => ({ ...connectedStatus, connected: false }),
    });
    const result = await tool("shapez_status", game).handler({});
    const payload = parse(result) as { game: unknown; hint: string };
    expect(payload.game).toBeNull();
    expect(payload.hint).toContain("mods 目录");
    expect(game.calls).toHaveLength(0);
  });

  it("已连接时 status 合并桥与游戏两端状态", async () => {
    const game = fakeGame({ call: async () => ({ hasSave: true, speed: "paused" }) });
    const payload = parse(await tool("shapez_status", game).handler({})) as {
      bridge: { connected: boolean };
      game: { speed: string };
    };
    expect(payload.bridge.connected).toBe(true);
    expect(payload.game.speed).toBe("paused");
  });
});
