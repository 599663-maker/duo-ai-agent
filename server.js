#!/usr/bin/env node
"use strict";

/* ============================================================
 * AI 辩论擂台 · 服务端（零依赖，Node 18+）
 * - 多人在线围观：SSE 实时推送
 * - 辩论队列：双方大模型每轮各发言一次，按轮数扣血
 * - DeepSeek 裁判：全量实录裁决胜负
 * - 历史记录：JSON 文件持久化
 * - 密钥：只保存在服务器 data/keys.json（chmod 600），
 *   辩手密钥由管理员在线填写，裁判密钥可用环境变量预置
 * ============================================================ */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const DATA_DIR = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "store.json");
const KEYS_FILE = path.join(DATA_DIR, "keys.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_ROUNDS = 1000;
const MAX_HISTORY = 300;
const MAX_BODY = 256 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

/* ============================================================
 * 数据存储
 * ============================================================ */
let store = { seq: 0, debates: [] };

function loadStore() {
  try { store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); } catch (_) {}
  if (!store || typeof store !== "object") store = { seq: 0, debates: [] };
  if (!Array.isArray(store.debates)) store.debates = [];
}

function saveStore() {
  if (store.debates.length > MAX_HISTORY) {
    store.debates = store.debates.slice(0, MAX_HISTORY);
  }
  const tmp = STORE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store));
  fs.renameSync(tmp, STORE_FILE);
}

loadStore();

/* 启动恢复：进程重启前处于进行中/裁决中的场次重新排队继续 */
{
  let recovered = false;
  for (const d of store.debates) {
    if (d.status === "running" || d.status === "judging") {
      d.status = "queued";
      d.phase = "queued";
      recovered = true;
    }
  }
  if (recovered) saveStore();
}

/* ============================================================
 * 模型配置（密钥只存服务器本地）
 * ============================================================ */
function defaultModelConfig() {
  return {
    a: { name: "豆包战斗队", base: "https://ark.cn-beijing.volces.com/api/v3", api: "chat", model: "glm-5-3-flash-260828", key: "" },
    b: { name: "DeepSeek", base: "https://api.deepseek.com", api: "chat", model: "deepseek-chat", key: "" },
    judge: {
      name: "DeepSeek 判官",
      base: "https://api.deepseek.com",
      api: "chat",
      model: "deepseek-chat",
      key: process.env.DEEPSEEK_API_KEY || process.env.JUDGE_API_KEY || "",
    },
  };
}

let modelConfig = defaultModelConfig();

function loadKeys() {
  try {
    const saved = JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"));
    for (const slot of ["a", "b", "judge"]) {
      if (saved[slot] && typeof saved[slot] === "object") {
        modelConfig[slot] = Object.assign({}, modelConfig[slot], saved[slot]);
      }
    }
  } catch (_) {}
}

function saveKeys() {
  fs.writeFileSync(KEYS_FILE, JSON.stringify(modelConfig, null, 2), { mode: 0o600 });
}

loadKeys();

function fightersReady() {
  return Boolean(modelConfig.a.key && modelConfig.b.key && modelConfig.judge.key);
}

const slotLabel = (s) => (s === "a" ? "正方" : s === "b" ? "反方" : "裁判");

/* ============================================================
 * 小工具
 * ============================================================ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round1 = (n) => Math.round(n * 10) / 10;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function buildUrl(base, api) {
  const u = String(base || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(u)) throw new Error("Base URL 需以 http:// 或 https:// 开头");
  const suffix = api === "responses" ? "/responses" : "/chat/completions";
  if (new RegExp(suffix.replace(/\//g, "\\/") + "$", "i").test(u)) return u;
  return u + suffix;
}

class ApiError extends Error {
  constructor(status, body) {
    let msg = "HTTP " + status;
    try {
      const j = JSON.parse(body);
      if (j && j.error && j.error.message) msg = String(j.error.message);
    } catch (_) {}
    super(msg);
    this.status = status;
  }
}

async function safeText(res) {
  try { return await res.text(); } catch (_) { return ""; }
}

function fetchWithTimeout(url, opts, ms) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  return fetch(url, Object.assign({}, opts, { signal: ac.signal })).finally(() => clearTimeout(timer));
}

/* ============================================================
 * 调用大模型（OpenAI 兼容接口，流式 + 自动降级非流式）
 * ============================================================ */
function buildRequestBody(cfg, messages, { temperature, maxTokens, stream }) {
  if (cfg.api === "responses") {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
    const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");
    const body = {
      model: cfg.model,
      input: user,
      temperature,
      max_output_tokens: maxTokens,
      stream: !!stream,
    };
    if (system) body.instructions = system;
    return body;
  }
  return { model: cfg.model, messages, temperature, max_tokens: maxTokens, stream: !!stream };
}

function extractStreamChunk(api, j) {
  if (api === "responses") {
    if (j && j.type === "response.output_text.delta" && typeof j.delta === "string") return j.delta;
    return null;
  }
  const ch = j && j.choices && j.choices[0];
  if (ch && ch.delta && typeof ch.delta.content === "string") return ch.delta.content;
  return null;
}

function extractFinalText(api, j) {
  if (api === "responses") {
    if (typeof j.output_text === "string" && j.output_text.trim()) return j.output_text;
    if (Array.isArray(j.output)) {
      const parts = [];
      for (const it of j.output) {
        if (it && Array.isArray(it.content)) {
          for (const c of it.content) if (c && typeof c.text === "string") parts.push(c.text);
        } else if (it && typeof it.text === "string") parts.push(it.text);
      }
      const t = parts.join("\n");
      if (t.trim()) return t;
    }
    return null;
  }
  const t = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  return t && String(t).trim() ? String(t) : null;
}

const MANUS_STANCE_SCHEMA = {
  type: "object",
  properties: {
    stance: { type: "string", description: "立场：只能是「正方」或「反方」" },
    opening: { type: "string", description: "30～80 字的一句话立场声明" },
  },
  required: ["stance", "opening"],
  additionalProperties: false,
};

function extractManusResult(msgs, schema) {
  if (schema) {
    const so = msgs.find((m) => m.type === "structured_output_result" && m.structured_output_result);
    if (so && so.structured_output_result && so.structured_output_result.success) {
      return JSON.stringify(so.structured_output_result.value);
    }
  }
  for (const m of msgs) {
    if (m.type === "assistant_message" && m.assistant_message) {
      const t = String(m.assistant_message.content || "").trim();
      if (t) return t;
    }
  }
  throw new Error("Manus 未返回最终回复");
}

async function callManus(cfg, messages, { temperature = 0.9, maxTokens = 600, timeoutMs = 360000, onDelta, schema } = {}) {
  const base = String(cfg.base || "https://api.manus.ai").trim().replace(/\/+$/, "");
  const createUrl = base + "/v2/task.create";
  const listUrl = base + "/v2/task.listMessages";
  const headers = Object.assign({ "Content-Type": "application/json" }, cfg.key ? { "x-manus-api-key": cfg.key } : {});
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n\n");
  const prompt = [system, user].filter(Boolean).join("\n\n");

  const body = {
    message: { content: [{ type: "text", text: prompt }] },
    locale: "zh-CN",
    interactive_mode: false,
    hide_in_task_list: true,
  };
  if (schema) body.structured_output_schema = schema;
  const profile = String(cfg.model || "").trim().toLowerCase();
  if (/^(standard|lite|max)$/.test(profile)) body.agent_profile = profile;

  const res = await fetchWithTimeout(createUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, 60000);
  if (!res.ok) throw new ApiError(res.status, await safeText(res));
  const created = await res.json();
  const taskId = created && (created.task_id || (created.data && created.data.task_id));
  if (!taskId) throw new Error("Manus 未返回任务 ID");

  const deadline = Date.now() + timeoutMs;
  let lastBrief = "";
  while (Date.now() < deadline) {
    const lr = await fetchWithTimeout(
      listUrl + "?task_id=" + encodeURIComponent(taskId) + "&order=desc&limit=10",
      { method: "GET", headers },
      30000
    );
    if (!lr.ok) throw new ApiError(lr.status, await safeText(lr));
    const lj = await lr.json();
    if (!lj || lj.ok === false) throw new Error((lj && lj.error && lj.error.message) || "Manus 轮询失败");
    const msgs = Array.isArray(lj.messages) ? lj.messages : [];
    for (const m of msgs) {
      if (m.type !== "status_update" || !m.status_update) continue;
      const st = m.status_update;
      if (st.agent_status === "stopped") return extractManusResult(msgs, schema);
      if (st.agent_status === "error") {
        const em = msgs.find((x) => x.type === "error_message");
        const detail = em && em.error_message ? em.error_message : {};
        if (detail.error_type === "quota_limit") {
          throw new Error("Manus 账号余额不足，请到 manus.im 充值后重试");
        }
        throw new Error(String(detail.content || "Manus 任务执行出错"));
      }
      if (st.agent_status === "waiting") throw new Error("Manus 任务等待交互（已禁用交互模式），请重试");
      const brief = String(st.brief || st.description || "").trim();
      if (brief && brief !== lastBrief) {
        lastBrief = brief;
        if (onDelta) onDelta("🧠 " + brief);
      }
    }
    await sleep(5000);
  }
  throw new Error("Manus 任务超时（" + Math.round(timeoutMs / 60000) + " 分钟）");
}

async function callChat(cfg, messages, opts = {}) {
  if (cfg.api === "manus") return callManus(cfg, messages, opts);
  const retries = Math.max(0, Math.min(3, Number(opts.retries ?? 2)));
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await callChatOnce(cfg, messages, opts);
    } catch (e) {
      lastErr = e;
      const status = e && e.status;
      const retriable = status === undefined ? true : status >= 500 || status === 429;
      if (!retriable || i === retries) throw e;
      await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

async function callChatOnce(cfg, messages, { temperature = 0.9, maxTokens = 600, timeoutMs = 120000, onDelta, schema } = {}) {
  const api = cfg.api === "responses" ? "responses" : "chat";
  const url = buildUrl(cfg.base, api);
  const baseHeaders = {
    "Content-Type": "application/json",
    ...(cfg.key ? { Authorization: "Bearer " + cfg.key } : {}),
  };
  let text = "";
  try {
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: Object.assign({ Accept: "text/event-stream" }, baseHeaders),
      body: JSON.stringify(buildRequestBody(cfg, messages, { temperature, maxTokens, stream: true })),
    }, timeoutMs);
    if (!res.ok) throw new ApiError(res.status, await safeText(res));
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") { if (text.trim()) return text; }
        try {
          const j = JSON.parse(data);
          if (api === "responses" && j && j.type === "response.completed") {
            if (text.trim()) return text;
            const final = extractFinalText(api, j.response || {});
            if (final) { text = final; if (onDelta) onDelta(text); return text; }
          }
          const chunk = extractStreamChunk(api, j);
          if (chunk) {
            text += chunk;
            if (onDelta) onDelta(text);
          }
        } catch (_) {}
      }
    }
    if (text.trim()) return text;
    throw new Error("流式响应为空");
  } catch (e) {
    if (e instanceof ApiError) throw e;
    // 降级：非流式请求
    const res2 = await fetchWithTimeout(url, {
      method: "POST",
      headers: baseHeaders,
      body: JSON.stringify(buildRequestBody(cfg, messages, { temperature, maxTokens, stream: false })),
    }, timeoutMs);
    if (!res2.ok) throw new ApiError(res2.status, await safeText(res2));
    const j = await res2.json();
    const t = extractFinalText(api, j);
    if (!t) throw new Error("接口未返回内容");
    if (onDelta) onDelta(t);
    return t;
  }
}

/* ============================================================
 * 提示词
 * ============================================================ */
function transcriptText(d) {
  if (!d.messages.length) return "";
  return d.messages.map((m) => {
    const side = m.side === "A" ? "正方" : "反方";
    return `第${m.round}轮【${side}「${m.name}」】：\n${m.text}`;
  }).join("\n\n");
}

function buildSayMessages(d, step) {
  const me = step.side === "A" ? "正方" : "反方";
  const other = step.side === "A" ? "反方" : "正方";
  const my = step.side === "A" ? d.a : d.b;
  const opp = step.side === "A" ? d.b : d.a;
  const system = [
    `你是「${my.name}」，正在参加一场公开中文辩论赛。`,
    `辩题：「${d.topic}」。你的立场：${me}。对方「${opp.name}」的立场：${other}。`,
    `赛制：共 ${d.rounds} 轮，每轮双方各发言一次。你必须严格完成每一轮发言，绝不弃权。`,
    `要求：`,
    `1. 像顶级辩手一样犀利、幽默、有梗，逻辑严密，敢于正面反驳；`,
    `2. 每次发言 80～200 字，直接输出发言正文；`,
    `3. 禁止输出任何前缀、解释、括号说明或系统提示复述；`,
    `4. 不允许认输、求和或要求终止辩论。`,
  ].join("\n");
  const isOpening = step.round === 1 && step.side === "A";
  const instruction = isOpening
    ? `这是第 1 轮（共 ${d.rounds} 轮）。本轮由你先发言，请做开场立论，旗帜鲜明亮出${me}立场。`
    : `这是第 ${step.round} 轮（共 ${d.rounds} 轮）。请针对对方最新发言逐条反驳，并补强己方论点。`;
  const record = transcriptText(d);
  return [
    { role: "system", content: system },
    { role: "user", content: instruction + "\n\n当前交锋实录：\n\n" + (record || "（尚无发言，请先立论）") },
  ];
}

function buildJudgeMessages(d) {
  const system = "你是一位公正、毒舌且专业的辩论裁判。你只依据辩论实录裁决，绝不偏袒任何一方。你只输出一个合法 JSON 对象，不输出任何其他文字。";
  const user = [
    `辩题：「${d.topic}」`,
    `正方：「${d.a.name}」（模型 ${d.a.model}）`,
    `反方：「${d.b.name}」（模型 ${d.b.model}）`,
    ``,
    `完整辩论实录：`,
    `---`,
    transcriptText(d),
    `---`,
    ``,
    `请裁决并严格按以下 JSON 格式输出：`,
    `{"winner":"正方 或 反方","score":"正方 X 分 - 反方 Y 分","reason":"不超过150字的裁决理由","highlight":"全场最精彩的一句交锋"}`,
    ``,
    `硬性规则：`,
    `1. 必须分出胜负，winner 只能是「正方」或「反方」，绝对禁止「平局」；`,
    `2. 双方分数必须不同，至少相差 1 分；`,
    `3. 若双方表现接近，也要依据论证力度与反驳质量做出倾向性裁决。`,
  ].join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

/* ---------- 站队环节 ---------- */
function cfgFor(speaker) {
  const base = modelConfig[speaker.slot] || {};
  return { name: speaker.name, model: base.model || speaker.model, base: base.base, key: base.key, api: base.api };
}

function parseStance(text) {
  let s = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let obj = null;
  try { obj = JSON.parse(s); } catch (_) {}
  if (!obj) {
    const st = s.indexOf("{"), en = s.lastIndexOf("}");
    if (st >= 0 && en > st) { try { obj = JSON.parse(s.slice(st, en + 1)); } catch (_) {} }
  }
  if (obj && obj.stance) {
    const st = String(obj.stance);
    if (/反/.test(st)) return { stance: "反方", opening: String(obj.opening || "").trim() };
    if (/正/.test(st)) return { stance: "正方", opening: String(obj.opening || "").trim() };
  }
  return null;
}

function buildStanceMessages(d, speaker) {
  const system = [
    `你是大模型辩手「${speaker.name}」。`,
    `用户提出辩题后，你必须先独立判断自己的真实观点，然后站队。`,
    `立场只有两种：正方＝支持/肯定辩题命题；反方＝反对/否定辩题命题。`,
    `你的站队必须独立自主，不参考任何其他模型的意见。`,
  ].join("\n");
  const user = `辩题：「${d.topic}」\n\n请判断你的观点并站队，严格输出 JSON：\n{"stance":"正方 或 反方","opening":"30～80 字的一句话立场声明，说明你为何站这一边"}`;
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

async function speakStance(d, speaker, onDelta) {
  let text = "";
  const cfg = cfgFor(speaker);
  const isManus = cfg.api === "manus";
  for (let attempt = 0; attempt < 2; attempt++) {
    text = await callChat(cfg, buildStanceMessages(d, speaker), {
      temperature: 0.7, maxTokens: 300, timeoutMs: isManus ? 360000 : 180000, onDelta,
      schema: isManus ? MANUS_STANCE_SCHEMA : undefined,
    });
    const parsed = parseStance(text);
    if (parsed) return parsed;
  }
  return { stance: /反/.test(text) ? "反方" : "正方", opening: text.trim().slice(0, 80) };
}

function parseVerdict(text) {
  let s = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  let obj = null;
  try { obj = JSON.parse(s); } catch (_) {}
  if (!obj) {
    const st = s.indexOf("{"), en = s.lastIndexOf("}");
    if (st >= 0 && en > st) { try { obj = JSON.parse(s.slice(st, en + 1)); } catch (_) {} }
  }
  let winner = null;
  if (obj && obj.winner) {
    const w = String(obj.winner);
    if (/反/.test(w)) winner = "反方";
    else if (/正/.test(w)) winner = "正方";
  }
  return {
    winner,
    score: obj && obj.score ? String(obj.score) : "",
    reason: obj && obj.reason ? String(obj.reason) : "",
    highlight: obj && obj.highlight ? String(obj.highlight) : "",
  };
}

function parseScore(str) {
  const a = /正方\s*(\d+(?:\.\d+)?)/.exec(String(str || ""));
  const b = /反方\s*(\d+(?:\.\d+)?)/.exec(String(str || ""));
  return [a ? Number(a[1]) : null, b ? Number(b[1]) : null];
}

/* 裁判必须分出胜负：先正常裁决，无效则强化重判一次，仍无效按比分/交锋质量强制判定 */
async function resolveVerdict(d) {
  let lastFlush = 0;
  const onDelta = (t) => {
    const now = Date.now();
    if (now - lastFlush > 120) {
      lastFlush = now;
      broadcast("delta", { id: d.id, side: "judge", round: null, text: t });
    }
  };
  const ask = async (extra) => {
    const msgs = buildJudgeMessages(d);
    if (extra) msgs.push({ role: "user", content: extra });
    return callChat(modelConfig.judge, msgs, {
      temperature: 0.3,
      maxTokens: 1200,
      timeoutMs: 180000,
      onDelta,
    });
  };
  let text = await ask();
  let verdict = parseVerdict(text);
  if (verdict.winner !== "正方" && verdict.winner !== "反方") {
    text = await ask("注意：你上一次的裁决没有给出明确胜方。本场辩论必须分出胜负，请重新裁决并严格输出 JSON，winner 只能是「正方」或「反方」，比分必须有差距。");
    verdict = parseVerdict(text);
  }
  if (verdict.winner !== "正方" && verdict.winner !== "反方") {
    const [sa, sb] = parseScore(verdict.score);
    if (sa != null && sb != null && sa !== sb) {
      verdict.winner = sa > sb ? "正方" : "反方";
    } else {
      const ca = d.messages.filter((m) => m.stance === "正方").reduce((n, m) => n + String(m.text || "").length, 0);
      const cb = d.messages.filter((m) => m.stance === "反方").reduce((n, m) => n + String(m.text || "").length, 0);
      verdict.winner = ca >= cb ? "正方" : "反方";
      if (!verdict.reason) verdict.reason = "双方表现旗鼓相当，按交锋实录综合评定，" + verdict.winner + "略胜一筹。";
    }
  }
  d.verdict = verdict;
  return text;
}

/* ============================================================
 * 辩论执行（单场串行队列）
 * ============================================================ */
let running = false;

/* 启动后自动恢复排队中的场次（延迟到模块初始化完成后） */
setTimeout(pump, 200);

function buildSteps(d) {
  const steps = [
    { type: "stance", speaker: "p1" },
    { type: "stance", speaker: "p2" },
  ];
  for (let r = 1; r <= d.rounds; r++) {
    steps.push({ type: "say", side: "A", round: r });
    steps.push({ type: "say", side: "B", round: r });
  }
  steps.push({ type: "judge" });
  return steps;
}

function currentRound(d) {
  if (d.status === "finished" || d.status === "error" || d.status === "cancelled") return d.rounds;
  const stepIdx = Math.min(d.step, d.steps.length - 1);
  return Math.min(d.rounds, Math.floor(stepIdx / 2) + 1);
}

function nextSide(d) {
  if (d.status === "running") {
    if (d.phase === "stance") return d.step === 0 ? "p1" : "p2";
    return d.step % 2 === 0 ? "A" : "B";
  }
  if (d.status === "judging") return "judge";
  return null;
}

function summary(d) {
  const queued = store.debates.filter((x) => x.status === "queued");
  const pos = d.status === "queued" ? queued.indexOf(d) + 1 : 0;
  return {
    id: d.id,
    topic: d.topic,
    rounds: d.rounds,
    status: d.status,
    phase: d.phase || (d.status === "judging" ? "judge" : d.status === "running" ? "debate" : null),
    round: currentRound(d),
    hpA: round1(d.hpA),
    hpB: round1(d.hpB),
    createdAt: d.createdAt,
    startedAt: d.startedAt || null,
    finishedAt: d.finishedAt || null,
    error: d.error || null,
    p1Name: d.p1.name, p2Name: d.p2.name,
    aName: d.a.name, aModel: d.a.model, aAvatar: d.a.avatar || "a", aStance: d.aStance || null,
    bName: d.b.name, bModel: d.b.model, bAvatar: d.b.avatar || "b", bStance: d.bStance || null,
    msgCount: d.messages.length,
    winner: d.verdict ? d.verdict.winner : null,
    queuePos: pos,
    nextSide: nextSide(d),
  };
}

function pump() {
  if (running) return;
  if (!fightersReady()) return;
  const queued = store.debates.filter((d) => d.status === "queued");
  if (!queued.length) return;
  runDebate(queued[0]);
}

async function stanceTurn(d, speaker, key) {
  let lastFlush = 0;
  const stanceRes = await speakStance(d, speaker, (t) => {
    const now = Date.now();
    if (now - lastFlush > 120) {
      lastFlush = now;
      broadcast("delta", { id: d.id, side: key, round: 0, text: t });
    }
  });
  return {
    side: key,
    round: 0,
    stance: stanceRes.stance,
    text: stanceRes.opening || ("我选择站队" + stanceRes.stance),
    name: speaker.name,
    model: speaker.model,
    avatar: speaker.avatar,
    ts: Date.now(),
  };
}

async function runDebate(d) {
  running = true;
  try {
    d.status = "running";
    d.phase = "stance";
    d.startedAt = Date.now();
    saveStore();
    broadcast("debate", summary(d));

    if (d.step === 0 && d.steps[0] && d.steps[0].type === "stance") {
      const [m1, m2] = await Promise.all([stanceTurn(d, d.p1, "p1"), stanceTurn(d, d.p2, "p2")]);
      d.messages = d.messages.filter((m) => !(m.round === 0));
      d.messages.push(m1, m2);
      d.step = 2;
      saveStore();
      broadcast("message", { id: d.id, message: m1, hpA: d.hpA, hpB: d.hpB, debate: summary(d) });
      await sleep(2200);
      broadcast("message", { id: d.id, message: m2, hpA: d.hpA, hpB: d.hpB, debate: summary(d) });
    }

    for (let i = d.step; i < d.steps.length; i++) {
      const step = d.steps[i];

      /* ---- 站队环节 ---- */
      if (step.type === "stance") {
        const speaker = step.speaker === "p1" ? d.p1 : d.p2;
        const smsg = await stanceTurn(d, speaker, step.speaker);
        d.messages = d.messages.filter((m) => !(m.side === step.speaker && m.round === 0));
        d.messages.push(smsg);
        d.step = i + 1;
        saveStore();
        broadcast("message", { id: d.id, message: smsg, hpA: d.hpA, hpB: d.hpB, debate: summary(d) });
        continue;
      }

      /* ---- 双方站队完成：观点一致判平局，否则分配正反方 ---- */
      if (i === 2) {
        const s1 = d.messages.find((m) => m.side === "p1");
        const s2 = d.messages.find((m) => m.side === "p2");
        if (s1 && s2 && s1.stance === s2.stance) {
          d.aStance = s1.stance;
          d.bStance = s2.stance;
          d.phase = "finished";
          d.status = "finished";
          d.finishedAt = Date.now();
          d.verdict = {
            winner: "平局",
            score: "",
            reason: `${d.p1.name} 与 ${d.p2.name} 都选择「${s1.stance}」，英雄所见略同，无需开辩，直接握手言和！`,
            highlight: `双方观点一致：「${s1.stance}」`,
          };
          d.step = d.steps.length;
          saveStore();
          broadcast("verdict", { id: d.id, verdict: d.verdict, judgeText: "", debate: summary(d) });
          break;
        }
        if (s1 && s1.stance === "正方") { d.a = d.p1; d.b = d.p2; }
        else { d.a = d.p2; d.b = d.p1; }
        d.aStance = "正方";
        d.bStance = "反方";
        d.phase = "debate";
        saveStore();
        broadcast("debate", summary(d));
      }

      if (step.type === "judge") {
        d.status = "judging";
        saveStore();
        broadcast("debate", summary(d));
        broadcast("judging", { id: d.id });

        d.judgeText = await resolveVerdict(d);
        d.status = "finished";
        d.finishedAt = Date.now();
        d.hpA = 0;
        d.hpB = 0;
        d.step = d.steps.length;
        saveStore();
        broadcast("verdict", {
          id: d.id,
          verdict: d.verdict,
          judgeText: d.judgeText,
          debate: summary(d),
        });
        break;
      }

      // 辩手发言
      const speaker = step.side === "A" ? d.a : d.b;
      const cfg = cfgFor(speaker);
      let lastFlush = 0;
      const text = await callChat(cfg, buildSayMessages(d, step), {
        temperature: 0.9,
        maxTokens: 600,
        timeoutMs: cfg.api === "manus" ? 360000 : 180000,
        onDelta: (t) => {
          const now = Date.now();
          if (now - lastFlush > 120) {
            lastFlush = now;
            broadcast("delta", { id: d.id, side: step.side, round: step.round, text: t });
          }
        },
      });

      const msg = {
        side: step.side,
        round: step.round,
        stance: step.side === "A" ? "正方" : "反方",
        text,
        name: speaker.name,
        model: speaker.model,
        avatar: speaker.avatar,
        ts: Date.now(),
      };
      d.messages = d.messages.filter((m) => !(m.side === step.side && m.round === step.round));
      d.messages.push(msg);

      if (step.side === "B") {
        const remain = Math.max(0, 100 - (step.round / d.rounds) * 100);
        d.hpA = round1(remain);
        d.hpB = round1(remain);
      }

      d.step = i + 1;
      saveStore();
      broadcast("message", { id: d.id, message: msg, hpA: d.hpA, hpB: d.hpB, debate: summary(d) });
      await sleep(700);
    }
  } catch (e) {
    d.status = "error";
    d.error = String(e.message || e);
    saveStore();
    broadcast("debate", summary(d));
  } finally {
    running = false;
    pump();
  }
}

/* ============================================================
 * SSE 实时推送
 * ============================================================ */
const clients = new Set();
const clientViews = new Map();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    try { c.res.write(payload); } catch (_) {}
  }
}

function viewerCounts() {
  const m = {};
  for (const s of clientViews.values()) {
    for (const id of s) m[id] = (m[id] || 0) + 1;
  }
  return m;
}

function broadcastPresence() {
  broadcast("presence", { online: clients.size, viewers: viewerCounts() });
}

function cleanupViews(clientId) {
  clientViews.delete(clientId);
}

/* ============================================================
 * 管理员会话
 * ============================================================ */
const sessions = new Map(); // token -> 过期时间
const SESSION_MS = 24 * 3600 * 1000;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const cookies = parseCookies(req.headers.cookie);
  const hdr = req.headers.authorization || "";
  const token = (hdr.startsWith("Bearer ") ? hdr.slice(7) : "") || cookies.arena_admin || "";
  const exp = sessions.get(token);
  return Boolean(token && exp && exp > Date.now());
}

/* ============================================================
 * 限流：每 IP 12 场 / 10 分钟
 * ============================================================ */
const createLog = new Map();
function rateOk(ip) {
  const now = Date.now();
  const arr = (createLog.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (arr.length >= 12) return false;
  arr.push(now);
  createLog.set(ip, arr);
  return true;
}

/* ============================================================
 * HTTP 基础
 * ============================================================ */
function json(res, code, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(code, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }, extraHeaders));
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("请求体过大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch (_) { reject(new Error("JSON 解析失败")); }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function serveStatic(req, res, pathname) {
  let file = pathname === "/" ? "index.html" : pathname === "/admin" ? "admin.html" : pathname.slice(1);
  const fp = path.resolve(PUBLIC_DIR, file);
  if (fp !== PUBLIC_DIR && !fp.startsWith(PUBLIC_DIR + path.sep)) return json(res, 404, { error: "not found" });
  fs.readFile(fp, (err, data) => {
    if (err) return json(res, 404, { error: "not found" });
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(fp).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

/* ============================================================
 * API 路由
 * ============================================================ */
async function api(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  // 实时推送
  if (p === "/api/events" && method === "GET") return sse(req, res);

  // 公开接口
  if (p === "/api/state" && method === "GET") {
    return json(res, 200, {
      debates: store.debates.map(summary),
      config: maskedConfig(),
      fightersReady: fightersReady(),
      presence: { online: clients.size, viewers: viewerCounts() },
    });
  }

  if (p === "/api/debates" && method === "POST") {
    const body = await readBody(req);
    const topic = String(body.topic || "").trim();
    const rounds = Number(body.rounds);
    if (!topic) throw Object.assign(new Error("请填写辩题"), { code: 400 });
    if (topic.length > 200) throw Object.assign(new Error("辩题最多 200 字"), { code: 400 });
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) {
      throw Object.assign(new Error(`轮数需为 1～${MAX_ROUNDS} 的整数`), { code: 400 });
    }
    const ip = req.socket.remoteAddress || "unknown";
    if (!rateOk(ip)) throw Object.assign(new Error("创建太频繁，请稍后再试"), { code: 429 });

    const id = "d" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
    const d = {
      id,
      topic,
      rounds,
      status: "queued",
      phase: "queued",
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      p1: { slot: "a", name: modelConfig.a.name, model: modelConfig.a.model, avatar: "a" },
      p2: { slot: "b", name: modelConfig.b.name, model: modelConfig.b.model, avatar: "b" },
      a: { slot: "a", name: modelConfig.a.name, model: modelConfig.a.model, avatar: "a" },
      b: { slot: "b", name: modelConfig.b.name, model: modelConfig.b.model, avatar: "b" },
      aStance: null,
      bStance: null,
      steps: buildSteps({ rounds }),
      step: 0,
      messages: [],
      hpA: 100,
      hpB: 100,
      judgeText: null,
      verdict: null,
      error: null,
    };
    store.debates.unshift(d);
    saveStore();
    broadcast("debate", summary(d));
    pump();
    return json(res, 200, summary(d));
  }

  const dm = p.match(/^\/api\/debates\/([\w-]+)$/);
  if (dm) {
    const d = store.debates.find((x) => x.id === dm[1]);
    if (!d) return json(res, 404, { error: "该场辩论不存在" });

    if (method === "GET") {
      return json(res, 200, {
        id: d.id, topic: d.topic, rounds: d.rounds, status: d.status,
        phase: d.phase || null,
        createdAt: d.createdAt, startedAt: d.startedAt, finishedAt: d.finishedAt,
        a: d.a, b: d.b, p1: d.p1, p2: d.p2,
        aStance: d.aStance || null, bStance: d.bStance || null,
        hpA: round1(d.hpA), hpB: round1(d.hpB),
        round: currentRound(d), nextSide: nextSide(d),
        messages: d.messages,
        judgeText: d.judgeText, verdict: d.verdict,
        error: d.error,
        queuePos: summary(d).queuePos,
      });
    }

    if (method === "POST" && p.endsWith("/view")) {
      const body = await readBody(req);
      const clientId = String(body.clientId || "");
      const viewing = Boolean(body.viewing);
      if (!clientId) return json(res, 400, { error: "缺少 clientId" });
      if (!clientViews.has(clientId)) clientViews.set(clientId, new Set());
      if (viewing) clientViews.get(clientId).add(d.id);
      else clientViews.get(clientId).delete(d.id);
      broadcastPresence();
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: "接口不存在" });
  }

  // 管理员接口
  if (p === "/api/admin/login" && method === "POST") {
    const body = await readBody(req);
    const pw = String(body.password || "");
    if (!pw || pw !== ADMIN_PASSWORD) {
      await sleep(600);
      return json(res, 401, { error: "密码错误" });
    }
    const token = crypto.randomBytes(24).toString("hex");
    sessions.set(token, Date.now() + SESSION_MS);
    return json(res, 200, { ok: true }, {
      "Set-Cookie": `arena_admin=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`,
    });
  }

  if (p === "/api/admin/status" && method === "GET") {
    return json(res, 200, { authed: isAuthed(req) });
  }

  if (!isAuthed(req)) {
    return json(res, 401, { error: "未登录管理员" });
  }

  if (p === "/api/admin/config" && method === "GET") {
    return json(res, 200, { config: maskedConfig(), fightersReady: fightersReady() });
  }

  if (p === "/api/admin/config" && method === "POST") {
    const body = await readBody(req);
    for (const slot of ["a", "b", "judge"]) {
      const inc = body[slot] || {};
      const cur = modelConfig[slot];
      const base = String(inc.base ?? cur.base).trim();
      const model = String(inc.model ?? cur.model).trim();
      if (!/^https?:\/\//i.test(base)) throw Object.assign(new Error(slotLabel(slot) + "：Base URL 无效"), { code: 400 });
      if (!model) throw Object.assign(new Error(slotLabel(slot) + "：模型名不能为空"), { code: 400 });
      const key = inc.clearKey ? "" : (String(inc.key ?? "").trim() || cur.key);
      modelConfig[slot] = {
        name: String(inc.name ?? cur.name).trim() || slotLabel(slot) + "选手",
        base,
        api: ["chat", "responses", "manus"].includes(inc.api) ? inc.api : "chat",
        model,
        key,
      };
    }
    saveKeys();
    broadcast("config", { fightersReady: fightersReady() });
    pump();
    return json(res, 200, { ok: true, fightersReady: fightersReady() });
  }

  if (p === "/api/admin/test" && method === "POST") {
    const body = await readBody(req);
    const slot = ["a", "b", "judge"].includes(body.slot) ? body.slot : "a";
    const cfg = Object.assign({}, modelConfig[slot]);
    const text = await callChat(cfg, [{ role: "user", content: "请只回复两个字：OK" }], {
      temperature: 0.2, maxTokens: 16, timeoutMs: cfg.api === "manus" ? 180000 : 30000,
    });
    return json(res, 200, { ok: true, reply: text.trim().slice(0, 60) });
  }

  if (p === "/api/admin/action" && method === "POST") {
    const body = await readBody(req);
    const d = store.debates.find((x) => x.id === body.id);
    if (!d) return json(res, 404, { error: "该场辩论不存在" });
    if (body.action === "retry") {
      if (d.status !== "error") return json(res, 400, { error: "仅失败场次可重试" });
      d.status = "queued";
      d.error = null;
      saveStore();
      broadcast("debate", summary(d));
      pump();
      return json(res, 200, { ok: true });
    }
    if (body.action === "cancel") {
      if (d.status !== "queued") return json(res, 400, { error: "仅排队中的场次可取消" });
      d.status = "cancelled";
      saveStore();
      broadcast("debate", summary(d));
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { error: "未知操作" });
  }

  return json(res, 404, { error: "接口不存在" });
}

function maskedConfig() {
  const mask = (c) => ({
    name: c.name,
    base: c.base,
    api: c.api || "chat",
    model: c.model,
    keySet: Boolean(c.key),
    keyHint: c.key ? c.key.slice(0, 4) + "••••" + c.key.slice(-4) : "",
  });
  return { a: mask(modelConfig.a), b: mask(modelConfig.b), judge: mask(modelConfig.judge) };
}

function sse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  const client = { id: crypto.randomBytes(8).toString("hex"), res };
  clients.add(client);
  res.write(`event: hello\ndata: ${JSON.stringify({ clientId: client.id, online: clients.size })}\n\n`);
  broadcastPresence();
  const hb = setInterval(() => { try { res.write(": ping\n\n"); } catch (_) {} }, 25000);
  req.on("close", () => {
    clearInterval(hb);
    clients.delete(client);
    cleanupViews(client.id);
    broadcastPresence();
  });
}

/* ============================================================
 * 服务启动
 * ============================================================ */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      await api(req, res, url);
    } else {
      serveStatic(req, res, url.pathname);
    }
  } catch (e) {
    const code = e.code === 400 ? 400 : e.code === 429 ? 429 : 500;
    if (!res.headersSent) json(res, code, { error: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log("⚔️  AI 辩论擂台已启动");
  console.log("   地址: http://localhost:" + PORT);
  console.log("   管理: http://localhost:" + PORT + "/admin");
  console.log("   辩手密钥: " + (fightersReady() ? "已就绪 ✓" : "未配置，请在管理后台在线填写"));
  console.log("   裁判密钥: " + (modelConfig.judge.key ? "已就绪 ✓" : "未配置（可用环境变量 DEEPSEEK_API_KEY 或后台填写）"));
  console.log("   管理员密码: " + (process.env.ADMIN_PASSWORD ? "来自环境变量 ADMIN_PASSWORD" : "默认 admin123（请尽快修改：ADMIN_PASSWORD=xxx node server.js）"));
});
