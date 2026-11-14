import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, ProtocolParseError, parseClientMessage } from "../src/protocol.js";

describe("parseClientMessage", () => {
  it("接受合法 hello 并保留可选字段", () => {
    const message = parseClientMessage(
      JSON.stringify({ type: "hello", protocol: PROTOCOL_VERSION, token: "t", modVersion: "0.1.0" }),
    );
    expect(message).toEqual({ type: "hello", protocol: PROTOCOL_VERSION, token: "t", modVersion: "0.1.0" });
  });

  it("hello 缺 protocol 时拒绝", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "hello" }))).toThrow(ProtocolParseError);
  });

  it("接受 response，成功与失败两种", () => {
    const success = parseClientMessage(JSON.stringify({ type: "response", id: 3, ok: true, result: { a: 1 } }));
    expect(success).toEqual({ type: "response", id: 3, ok: true, result: { a: 1 } });

    const failure = parseClientMessage(
      JSON.stringify({ type: "response", id: "x", ok: false, error: { code: "bad", message: "坏了" } }),
    );
    expect(failure).toEqual({ type: "response", id: "x", ok: false, error: { code: "bad", message: "坏了" } });
  });

  it("拒绝非对象、非法 JSON、未知类型、缺字段", () => {
    expect(() => parseClientMessage("[]")).toThrow(ProtocolParseError);
    expect(() => parseClientMessage("not json")).toThrow(ProtocolParseError);
    expect(() => parseClientMessage(JSON.stringify({ type: "what" }))).toThrow(ProtocolParseError);
    expect(() => parseClientMessage(JSON.stringify({ type: "event" }))).toThrow(ProtocolParseError);
    expect(() => parseClientMessage(JSON.stringify({ type: "response", id: 1 }))).toThrow(ProtocolParseError);
    expect(() => parseClientMessage(JSON.stringify({ type: "response", id: null, ok: true }))).toThrow(
      ProtocolParseError,
    );
  });

  it("错误对象缺 code/message 时补默认值，不崩", () => {
    const message = parseClientMessage(JSON.stringify({ type: "response", id: 1, ok: false, error: {} }));
    expect(message).toEqual({
      type: "response",
      id: 1,
      ok: false,
      error: { code: "unknown", message: "未知错误" },
    });
  });
});
