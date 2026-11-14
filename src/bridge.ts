import { WebSocketServer, type WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  ProtocolParseError,
  encodeServerMessage,
  parseClientMessage,
  type RequestId,
  type ResponseMessage,
} from "./protocol.js";

export class BridgeError extends Error {
  constructor(
    readonly code: "not_connected" | "timeout" | "game_error" | "closed" | "disconnected",
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export interface BridgeStatus {
  listening: boolean;
  host: string;
  port: number;
  connected: boolean;
  modVersion: string | null;
  connectedAt: number | null;
  lastEvent: { event: string; at: number } | null;
}

/** MCP 工具层只依赖这个接口，测试可注入假实现。 */
export interface GameClient {
  call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  getStatus(): BridgeStatus;
}

export type Logger = (message: string) => void;

export interface GameBridgeOptions {
  host?: string;
  port?: number;
  /** 非空时 mod 的 hello 必须带同样 token，否则被断开。 */
  token?: string;
  requestTimeoutMs?: number;
  /** 必须写到 stderr —— stdout 是 MCP 协议通道。 */
  log?: Logger;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_PORT = 8765;
const DEFAULT_TIMEOUT_MS = 15_000;
const HELLO_TIMEOUT_MS = 10_000;

/**
 * 本地 WS 桥：游戏 mod 连进来，MCP 工具通过 call() 下发指令。
 *
 * 只监听 127.0.0.1（mod 和游戏在同一台机器），旧连接在新连接到来时被替换，
 * 便于玩家在游戏里重启 mod 或重载存档而不用重启 MCP server。
 */
export class GameBridge implements GameClient {
  private readonly host: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly log: Logger;
  private server: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private boundPort: number;
  private nextId = 1;
  private readonly pending = new Map<RequestId, PendingRequest>();
  private status: BridgeStatus;
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  private closing = false;

  constructor(options: GameBridgeOptions = {}) {
    this.host = options.host ?? "127.0.0.1";
    this.token = options.token && options.token.length > 0 ? options.token : undefined;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.log ?? ((message) => console.error(message));
    this.boundPort = options.port ?? DEFAULT_PORT;
    this.status = {
      listening: false,
      host: this.host,
      port: this.boundPort,
      connected: false,
      modVersion: null,
      connectedAt: null,
      lastEvent: null,
    };
  }

  /** 监听并返回实际端口（传 port: 0 时由系统分配，测试用）。 */
  async listen(): Promise<number> {
    const server = new WebSocketServer({ host: this.host, port: this.boundPort });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
    });

    const address = server.address();
    if (address && typeof address === "object") {
      this.boundPort = address.port;
    }
    this.status = { ...this.status, listening: true, port: this.boundPort };
    server.on("connection", (socket, request) => this.handleConnection(socket, request.socket.remoteAddress ?? "?"));
    this.log(`[bridge] 监听 ws://${this.host}:${this.boundPort}${this.token ? "（已启用 token 校验）" : ""}`);
    return this.boundPort;
  }

  getStatus(): BridgeStatus {
    return { ...this.status };
  }

  /** 订阅 "event"（mod 上报）与 "status"（连接状态变化）。 */
  on(topic: "event" | "status", listener: (payload: unknown) => void): () => void {
    const bucket = this.listeners.get(topic) ?? new Set<(payload: unknown) => void>();
    bucket.add(listener);
    this.listeners.set(topic, bucket);
    return () => bucket.delete(listener);
  }

  private emit(topic: "event" | "status", payload: unknown): void {
    for (const listener of this.listeners.get(topic) ?? []) {
      try {
        listener(payload);
      } catch (error) {
        this.log(`[bridge] 事件监听器抛错: ${describeError(error)}`);
      }
    }
  }

  async call(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== socket.OPEN) {
      throw new BridgeError(
        "not_connected",
        "游戏未连接：请确认 shapez 桌面版正在运行，且 Shapez1-MCP mod 已放入 mods 目录并重启过游戏",
      );
    }

    const id = this.nextId++;
    const effectiveTimeout = timeoutMs ?? this.timeoutMs;

    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new BridgeError("timeout", `游戏在 ${effectiveTimeout}ms 内没有响应 ${method}（可能游戏卡住或在大批量放置）`),
        );
      }, effectiveTimeout);
      this.pending.set(id, { resolve, reject, timer });

      try {
        socket.send(encodeServerMessage({ type: "request", id, method, ...(params ? { params } : {}) }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeError("closed", `发送请求失败: ${describeError(error)}`));
      }
    });

    return await response;
  }

  async close(): Promise<void> {
    this.closing = true;
    this.rejectAll(new BridgeError("closed", "桥已关闭"));
    const socket = this.socket;
    this.socket = null;
    socket?.close(1001, "server shutdown");
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.status = { ...this.status, listening: false, connected: false };
  }

  private handleConnection(socket: WebSocket, remote: string): void {
    if (this.closing) {
      socket.close(1001, "shutting down");
      return;
    }

    let greeted = false;
    const helloTimer = setTimeout(() => {
      if (!greeted) {
        this.log(`[bridge] 连接 ${remote} 在 ${HELLO_TIMEOUT_MS}ms 内没有 hello，断开`);
        socket.close(1008, "hello timeout");
      }
    }, HELLO_TIMEOUT_MS);

    socket.on("message", (raw) => {
      let message;
      try {
        message = parseClientMessage(String(raw));
      } catch (error) {
        const reason = error instanceof ProtocolParseError ? error.message : describeError(error);
        this.log(`[bridge] 丢弃非法消息: ${reason}`);
        socket.close(1008, "bad message");
        return;
      }

      if (message.type === "hello") {
        if (greeted) {
          this.log("[bridge] 重复 hello，忽略");
          return;
        }
        if (message.protocol !== PROTOCOL_VERSION) {
          this.log(`[bridge] mod 协议版本 ${message.protocol} 与桥 ${PROTOCOL_VERSION} 不匹配，断开`);
          socket.close(1008, "protocol mismatch");
          return;
        }
        if (this.token && message.token !== this.token) {
          this.log("[bridge] token 校验失败，断开（检查 mod 顶部 CONFIG.token 与 SHAPEZ1_MCP_TOKEN 是否一致）");
          socket.close(1008, "bad token");
          return;
        }

        greeted = true;
        clearTimeout(helloTimer);
        this.adoptSocket(socket, remote, message.modVersion ?? null);
        socket.send(encodeServerMessage({ type: "hello-ok", protocol: PROTOCOL_VERSION }));
        return;
      }

      if (!greeted) {
        this.log("[bridge] 未 hello 就发消息，断开");
        socket.close(1008, "hello required");
        return;
      }

      if (message.type === "response") {
        this.settle(message);
        return;
      }

      this.status = { ...this.status, lastEvent: { event: message.event, at: Date.now() } };
      this.emit("event", message);
    });

    socket.on("close", (code, reason) => {
      clearTimeout(helloTimer);
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;
      this.rejectAll(new BridgeError("disconnected", "游戏端连接已断开"));
      this.status = { ...this.status, connected: false, modVersion: null, connectedAt: null };
      this.log(`[bridge] 游戏端断开 (code=${code}${reason.length > 0 ? `, ${reason.toString()}` : ""})`);
      this.emit("status", this.getStatus());
    });

    socket.on("error", (error) => {
      this.log(`[bridge] socket 错误: ${describeError(error)}`);
    });
  }

  private adoptSocket(socket: WebSocket, remote: string, modVersion: string | null): void {
    const previous = this.socket;
    if (previous && previous !== socket) {
      this.rejectAll(new BridgeError("closed", "被新的游戏连接替换"));
      previous.close(1012, "replaced by new connection");
    }
    this.socket = socket;
    this.status = {
      ...this.status,
      connected: true,
      modVersion,
      connectedAt: Date.now(),
    };
    this.log(`[bridge] 游戏已连接 (${remote}${modVersion ? `, mod ${modVersion}` : ""})`);
    this.emit("status", this.getStatus());
  }

  private settle(message: ResponseMessage): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.log(`[bridge] 收到无人认领的响应 id=${String(message.id)}`);
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    const error = message.error;
    pending.reject(new BridgeError("game_error", error?.message ?? "游戏端返回失败", error?.detail ?? error));
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : JSON.stringify(error);
}
