import { afterEach, describe, expect, it } from "vitest";
import { BridgeError, GameBridge } from "../src/bridge.js";
import { MockGame } from "../src/mock-game.js";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    await cleanup?.();
  }
});

async function startBridge(options: { token?: string; requestTimeoutMs?: number } = {}): Promise<{
  bridge: GameBridge;
  port: number;
}> {
  const bridge = new GameBridge({ port: 0, log: () => {}, ...options });
  const port = await bridge.listen();
  cleanups.push(() => bridge.close());
  return { bridge, port };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("等待条件超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function connectMock(url: string, token?: string): Promise<MockGame> {
  const game = new MockGame({ url, ...(token ? { token } : {}) });
  await game.connect();
  cleanups.push(() => game.close());
  return game;
}

describe("GameBridge", () => {
  it("接受 hello 后把请求转发给 mod 并回传结果", async () => {
    const { bridge, port } = await startBridge();
    await connectMock(`ws://127.0.0.1:${port}`);
    await waitFor(() => bridge.getStatus().connected);

    const result = (await bridge.call("status")) as { hasSave: boolean; speed: string };
    expect(result.hasSave).toBe(true);
    expect(result.speed).toBe("regular");
    expect(bridge.getStatus().modVersion).toContain("mock");
  });

  it("mod 端对非法建筑返回 ok=false（非异常），未知方法才抛 game_error", async () => {
    const { bridge, port } = await startBridge();
    await connectMock(`ws://127.0.0.1:${port}`);
    await waitFor(() => bridge.getStatus().connected);

    await expect(bridge.call("placeBuilding", { buildingId: "不存在的建筑", x: 0, y: 0 })).resolves.toMatchObject({
      ok: false,
      reason: "未知建筑 id: 不存在的建筑",
    });

    await expect(bridge.call("noSuchMethod")).rejects.toMatchObject({ name: "BridgeError", code: "game_error" });
    try {
      await bridge.call("noSuchMethod");
    } catch (error) {
      expect((error as BridgeError).message).toContain("假游戏不实现方法");
    }
  });

  it("未连接时立刻抛 not_connected，不等待", async () => {
    const { bridge } = await startBridge();
    const started = Date.now();
    await expect(bridge.call("status")).rejects.toMatchObject({ code: "not_connected" });
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("token 不匹配时断开，连接不成立", async () => {
    const { bridge, port } = await startBridge({ token: "correct" });
    await connectMock(`ws://127.0.0.1:${port}`, "wrong");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(bridge.getStatus().connected).toBe(false);
  });

  it("token 匹配时正常连接", async () => {
    const { bridge, port } = await startBridge({ token: "same" });
    await connectMock(`ws://127.0.0.1:${port}`, "same");
    await waitFor(() => bridge.getStatus().connected);
    await expect(bridge.call("hubGoals")).resolves.toMatchObject({ goalIndex: 3 });
  });

  it("请求超时会抛 timeout 并清理等待队列", async () => {
    const { bridge, port } = await startBridge({ requestTimeoutMs: 60 });
    const game = await connectMock(`ws://127.0.0.1:${port}`);
    await waitFor(() => bridge.getStatus().connected);
    game.close();
    await waitFor(() => !bridge.getStatus().connected);
    await expect(bridge.call("status")).rejects.toMatchObject({ code: "not_connected" });
  });

  it("游戏端断开时，进行中的请求以 disconnected 结束", async () => {
    const { bridge, port } = await startBridge();
    const game = await connectMock(`ws://127.0.0.1:${port}`);
    await waitFor(() => bridge.getStatus().connected);

    const inflight = bridge.call("status");
    game.close();
    await expect(inflight).rejects.toBeInstanceOf(BridgeError);
    await waitFor(() => !bridge.getStatus().connected);
  });

  it("新连接替换旧连接，服务不崩", async () => {
    const { bridge, port } = await startBridge();
    await connectMock(`ws://127.0.0.1:${port}`);
    await waitFor(() => bridge.getStatus().connected);
    await connectMock(`ws://127.0.0.1:${port}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(bridge.getStatus().connected).toBe(true);
    await expect(bridge.call("status")).resolves.toMatchObject({ hasSave: true });
  });
});
