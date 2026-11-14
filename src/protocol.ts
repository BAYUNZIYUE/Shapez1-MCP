/**
 * 桥接协议（游戏内 mod ↔ 本地 MCP server）。
 *
 * 方向约定：
 *   - 游戏 mod 是 TCP/WS 客户端，先发 hello，随后可发 event / response；
 *   - 桥是 WS 服务端，下发 request，因此**所有请求都由桥发起**。
 * 这样 mod 侧不需要处理并发请求，只需要按 JSON-RPC 风格回包。
 *
 * 注意：mod 侧是单文件纯 JS，跑在 `new Function(code)` 里，不能 import 本文件，
 * 改动字段时必须两边同步（mod/shapez1-mcp.js 顶部有对应的常量）。
 */

export const PROTOCOL_VERSION = 1;

export type RequestId = string | number;

export interface HelloMessage {
  type: "hello";
  protocol: number;
  token?: string;
  modVersion?: string;
}

export interface EventMessage {
  type: "event";
  event: string;
  data?: unknown;
}

export interface ResponseMessage {
  type: "response";
  id: RequestId;
  ok: boolean;
  result?: unknown;
  error?: ProtocolError;
}

export interface RequestMessage {
  type: "request";
  id: RequestId;
  method: string;
  params?: Record<string, unknown>;
}

export interface HelloOkMessage {
  type: "hello-ok";
  protocol: number;
}

export interface ProtocolError {
  code: string;
  message: string;
  detail?: unknown;
}

/** mod → 桥 */
export type ClientMessage = HelloMessage | EventMessage | ResponseMessage;
/** 桥 → mod */
export type ServerMessage = HelloOkMessage | RequestMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

export class ProtocolParseError extends Error {}

function readType(value: Record<string, unknown>): string {
  const type = value["type"];
  if (typeof type !== "string") {
    throw new ProtocolParseError("消息缺少字符串字段 type");
  }
  return type;
}

/**
 * 解析并校验 mod 发来的一条消息，非法时抛 ProtocolParseError。
 * 采用手写校验而不是 zod：协议只有 3 种消息，且桥侧对未知字段应当宽容（前向兼容）。
 */
export function parseClientMessage(raw: string): ClientMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolParseError("消息不是合法 JSON");
  }
  if (!isRecord(parsed)) {
    throw new ProtocolParseError("消息不是 JSON 对象");
  }

  const type = readType(parsed);

  if (type === "hello") {
    const protocol = parsed["protocol"];
    if (typeof protocol !== "number" || !Number.isInteger(protocol)) {
      throw new ProtocolParseError("hello 缺少整数字段 protocol");
    }
    const message: HelloMessage = { type, protocol };
    if (typeof parsed["token"] === "string") {
      message.token = parsed["token"];
    }
    if (typeof parsed["modVersion"] === "string") {
      message.modVersion = parsed["modVersion"];
    }
    return message;
  }

  if (type === "event") {
    const event = parsed["event"];
    if (typeof event !== "string" || event.length === 0) {
      throw new ProtocolParseError("event 缺少字符串字段 event");
    }
    const message: EventMessage = { type, event };
    if ("data" in parsed) {
      message.data = parsed["data"];
    }
    return message;
  }

  if (type === "response") {
    const id = parsed["id"];
    if (!isRequestId(id)) {
      throw new ProtocolParseError("response 的 id 必须是字符串或数字");
    }
    const ok = parsed["ok"];
    if (typeof ok !== "boolean") {
      throw new ProtocolParseError("response 缺少布尔字段 ok");
    }
    const message: ResponseMessage = { type, id, ok };
    if ("result" in parsed) {
      message.result = parsed["result"];
    }
    if (isRecord(parsed["error"])) {
      const error = parsed["error"];
      message.error = {
        code: typeof error["code"] === "string" ? error["code"] : "unknown",
        message: typeof error["message"] === "string" ? error["message"] : "未知错误",
        ...(error["detail"] === undefined ? {} : { detail: error["detail"] }),
      };
    }
    return message;
  }

  throw new ProtocolParseError(`未知消息类型: ${type}`);
}

export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

/**
 * mod 侧需要解析桥下发的消息（hello-ok / request）。
 * mock-game 与真实 mod 都走同一套校验规则。
 */
export function parseServerMessage(raw: string): ServerMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProtocolParseError("消息不是合法 JSON");
  }
  if (!isRecord(parsed)) {
    throw new ProtocolParseError("消息不是 JSON 对象");
  }

  const type = readType(parsed);

  if (type === "hello-ok") {
    const protocol = parsed["protocol"];
    if (typeof protocol !== "number" || !Number.isInteger(protocol)) {
      throw new ProtocolParseError("hello-ok 缺少整数字段 protocol");
    }
    return { type, protocol };
  }

  if (type === "request") {
    const id = parsed["id"];
    if (!isRequestId(id)) {
      throw new ProtocolParseError("request 的 id 必须是字符串或数字");
    }
    const method = parsed["method"];
    if (typeof method !== "string" || method.length === 0) {
      throw new ProtocolParseError("request 缺少字符串字段 method");
    }
    const message: RequestMessage = { type, id, method };
    if (isRecord(parsed["params"])) {
      message.params = parsed["params"];
    }
    return message;
  }

  throw new ProtocolParseError(`未知的下行消息类型: ${type}`);
}
