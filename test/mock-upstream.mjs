#!/usr/bin/env node
/** テスト用の偽 OpenCode Go。鍵なしで bridge と Codex の結合を検証する。 */
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT ?? 8799);
const log = (...a) => console.log("[mock]", ...a);

function chunks(text) {
  // 数文字ずつに割ってストリームを再現
  const out = [];
  for (let i = 0; i < text.length; i += 6) out.push(text.slice(i, i + 6));
  return out;
}

http
  .createServer(async (req, res) => {
    let data = "";
    for await (const c of req) data += c;
    const body = data ? JSON.parse(data) : {};
    log(req.method, req.url, "model:", body.model, "stream:", body.stream);

    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
    const text = typeof lastUser?.content === "string" ? lastUser.content : "";
    const wantsTool = /USE_TOOL_NOW/.test(text);

    if (req.url?.endsWith("/chat/completions")) {
      if (wantsTool) {
        const tc = {
          id: "call_mock_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
        };
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: tc.id, type: "function", function: { name: tc.function.name, arguments: "" } }] } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: tc.function.arguments } }] } }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: [tc] }, finish_reason: "tool_calls" }],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          }));
        }
        return;
      }

      const answer = "BRIDGE_OK";
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const part of chunks(answer)) {
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: part } }] })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ index: 0, message: { role: "assistant", content: answer }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        }));
      }
      return;
    }

    res.writeHead(404).end();
  })
  .listen(PORT, "127.0.0.1", () => log(`listening ${PORT}`));
