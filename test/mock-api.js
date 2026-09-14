"use strict";
// 本地模拟 OpenAI 兼容接口（Chat Completions + Responses），用于离线端到端测试。
// 用法: node test/mock-api.js  （端口 3999）
//       MOCK_SAME_STANCE=1 node test/mock-api.js  （两个选手站队相同 → 测试平局路径）
const http = require("http");
const PORT = Number(process.env.MOCK_PORT || 3999);
let stanceCalls = 0;

function chooseStance() {
  if (process.env.MOCK_SAME_STANCE === "1") return "正方";
  stanceCalls += 1;
  return stanceCalls % 2 === 1 ? "正方" : "反方";
}

function generateText(system, user) {
  if (/裁判/.test(system)) {
    return '{"winner":"正方","score":"正方 9 分 - 反方 8 分","reason":"正方立论清晰、反驳有力，反方略显被动。","highlight":"正方在最终轮的绝地反击非常精彩。"}';
  }
  if (/站队/.test(user)) {
    const stance = chooseStance();
    return `{"stance":"${stance}","opening":"经过独立思考，我选择站队${stance}，因为我的观点天然属于这一边。"}`;
  }
  const zheng = /你的立场：正方/.test(system);
  const round = (user.match(/第 (\d+) 轮/) || [])[1] || "1";
  const side = zheng ? "正方" : "反方";
  return `${side}选手第${round}轮发言：我方观点立场坚定、论据充分，对方的论证存在明显漏洞，请裁判明察。（本段为本地模拟接口生成的测试文本，用于验证流程与动画。）`;
}

function sse(res, api, text) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const chunkSize = Math.max(1, Math.ceil(text.length / 6));
  let sent = 0;
  const timer = setInterval(() => {
    const part = text.slice(sent, sent + chunkSize);
    sent += chunkSize;
    if (part) {
      if (api === "responses") {
        res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: part })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
      }
    }
    if (sent >= text.length) {
      clearInterval(timer);
      if (api === "responses") {
        res.write(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed" })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }, 40);
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try { body = JSON.parse(body || "{}"); } catch (_) { body = {}; }
    const api = /\/responses/.test(req.url) ? "responses" : "chat";
    const messages = body.messages || [];
    const system = (body.instructions || "") + "\n" + messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const user = body.input || messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");
    const text = generateText(system, user);
    if (body.stream) return sse(res, api, text);
    if (api === "responses") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ id: "mock", output_text: text }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "mock", choices: [{ message: { role: "assistant", content: text } }] }));
  });
});

server.listen(PORT, () => console.log("mock api on http://127.0.0.1:" + PORT));
