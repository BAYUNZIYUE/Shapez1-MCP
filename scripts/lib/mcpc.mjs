/** 连常驻会话（mcp-cli.mjs 的 unix socket）的小客户端。 */
import { connect } from "node:net";

export const SOCK = process.env.SHAPEZ1_MCP_SOCK ?? "/tmp/shapez1-mcp.sock";

export function tool(toolName, args = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(SOCK);
    let acc = "";
    let done = false;
    socket.on("connect", () => socket.write(`${JSON.stringify({ tool: toolName, args })}\n`));
    socket.on("data", (chunk) => {
      acc += String(chunk);
      const idx = acc.indexOf("\n");
      if (idx < 0 || done) return;
      done = true;
      const line = acc.slice(0, idx);
      socket.end();
      try {
        const res = JSON.parse(line);
        let value = res.text;
        try {
          value = JSON.parse(res.text);
        } catch {
          /* 原文 */
        }
        resolve({ isError: res.isError === true, value });
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", reject);
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const key = (x, y) => `${x},${y}`;
