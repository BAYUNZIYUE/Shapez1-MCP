import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * mod 不能 import，也没有类型；这里用假 shapez/WebSocket 把它真正求值一次，
 * 至少保证：语法可执行、能注册 10 个方法、CONFIG 的地址与 token 规则正确。
 * 真实游戏内的行为仍然只能人工验（见 README「未验证项」）。
 */

const modPath = join(process.cwd(), "mod", "shapez1-mcp.js");
const source = readFileSync(modPath, "utf-8");

interface FakeModInstance {
  methods: Record<string, unknown>;
  status: () => Record<string, unknown>;
  wsUrl?: string;
  init: () => void;
}

function loadMod(options: { hostname?: string; token?: string } = {}): {
  instances: FakeModInstance[];
  create: () => FakeModInstance;
} {
  const sockets: unknown[] = [];
  const shapez = {
    Mod: class {
      signals = { gameStarted: { add: () => {} }, gameDeserialized: { add: () => {} } };
    },
    Vector: class {
      constructor(
        public x: number,
        public y: number,
      ) {}
    },
    gMetaBuildingRegistry: { findById: () => null },
  };

  class FakeWebSocket {
    readyState = 3;
    onopen: (() => void) | null = null;
    onmessage: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    static OPEN = 1;
    constructor(public url: string) {
      sockets.push({ url });
    }
    send(): void {}
    close(): void {}
  }

  let patchedSource = source;
  if (options.token !== undefined) {
    patchedSource = patchedSource.replace('token: "",', `token: "${options.token}",`);
  }

  const sandbox = { location: { hostname: options.hostname ?? "127.0.0.1" } };
  const globals = globalThis as unknown as Record<string, unknown>;
  globals["window"] = sandbox;
  globals["shapez"] = shapez;
  globals["WebSocket"] = FakeWebSocket;

  const wrapper = `${patchedSource}\nreturn Mod;`;
  // eslint-disable-next-line no-new-func
  const ModClass = new Function("window", wrapper)(sandbox) as new () => FakeModInstance;

  const instances: FakeModInstance[] = [];
  return {
    instances,
    create: () => {
      const instance = new ModClass();
      instances.push(instance);
      return instance;
    },
  };
}

describe("游戏内 mod（假环境求值）", () => {
  it("能在假 shapez 环境里加载，并注册 10 个方法", async () => {
    const { create } = loadMod();
    const mod = create();
    expect(Object.keys(mod.methods)).toEqual([
      "status",
      "listBuildings",
      "buildBeltPath",
      "dismissDialogs",
      "devSkipGoal",
      "saveGame",
      "queryResources",
      "inspectTile",
      "queryEntities",
      "hubGoals",
      "productionRates",
      "decodeShape",
      "placeBuilding",
      "placeBuildings",
      "deleteBuilding",
      "setSpeed",
      "waitTicks",
    ]);
  });

  it("localStorage 场景：本地回环默认地址自动推导，能直接 init", () => {
    const { create } = loadMod({ hostname: "127.0.0.1" });
    const mod = create();
    expect(() => mod.init()).not.toThrow();
    expect(mod.wsUrl).toBe("ws://127.0.0.1:8765");
  });

  it("远程部署：hostname 取自页面，并自动指向该主机", () => {
    const { create } = loadMod({ hostname: "203.0.113.10", token: "secret" });
    const mod = create();
    mod.init();
    expect(mod.wsUrl).toBe("ws://203.0.113.10:8765");
  });

  it("远程地址没配 token 时拒绝加载", () => {
    const { create } = loadMod({ hostname: "203.0.113.10" });
    const mod = create();
    expect(() => mod.init()).toThrow(/必须同时配置 CONFIG.token/);
  });

  it("没有存档时 status 返回 hasSave=false，不抛异常", () => {
    const { create } = loadMod();
    const mod = create();
    mod.init();
    expect(mod.status()).toMatchObject({ hasSave: false, modVersion: "0.1.0" });
  });
});
