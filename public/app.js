"use strict";

/* ============================================================
 * AI 辩论擂台 · 前端
 * 流程：排队 → PK站队（双方独立选正/反方，观点一致平局）
 *       → 观点对立开辩（每轮双方各发言一次、扣血）
 *       → DeepSeek 判官生成结果 → 胜利动画
 * ============================================================ */
const $ = (id) => document.getElementById(id);

const state = {
  list: [],
  filter: "all",
  current: null,
  presence: { online: 0, viewers: {} },
  fightersReady: true,
  victoryShown: false,
  pkStances: { p1: null, p2: null },
};

const liveBubbles = {};
let es = null;

/* ---------- 工具 ---------- */
function toast(msg, type = "ok", ms = 3600) {
  const wrap = $("toast-wrap");
  const t = document.createElement("div");
  t.className = "toast " + type;
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    t.style.transition = "opacity .3s";
    setTimeout(() => t.remove(), 320);
  }, ms);
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60e3) return "刚刚";
  if (diff < 3600e3) return Math.floor(diff / 60e3) + " 分钟前";
  if (diff < 86400e3) return Math.floor(diff / 3600e3) + " 小时前";
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

const STATUS_TEXT = { queued: "排队中", running: "进行中", judging: "裁判审议", finished: "已结束", error: "出错", cancelled: "已取消" };
const STATUS_CLS = { queued: "st-queued", running: "st-running", judging: "st-judging", finished: "st-finished", error: "st-error", cancelled: "st-cancelled" };

/* ============================================================
 * 列表视图
 * ============================================================ */
function upsertList(s) {
  const idx = state.list.findIndex((x) => x.id === s.id);
  if (idx >= 0) state.list[idx] = s;
  else state.list.unshift(s);
}

function renderList() {
  const wrap = $("debate-list");
  wrap.innerHTML = "";
  const list = state.list.filter((d) => {
    if (state.filter === "live") return ["queued", "running", "judging", "error"].includes(d.status);
    if (state.filter === "done") return ["finished", "cancelled"].includes(d.status);
    return true;
  });
  $("list-count").textContent = `${list.length} 场`;
  $("list-empty").classList.toggle("hidden", list.length > 0);

  for (const d of list) {
    const card = document.createElement("div");
    card.className = "debate-card";
    const viewerN = (state.presence.viewers || {})[d.id] || 0;
    let winnerTxt = "";
    if (d.winner === "平局") winnerTxt = '<span class="dc-winner wd">🤝 平局</span>';
    else if (d.winner === "正方") winnerTxt = '<span class="dc-winner wa">🏆 正方胜</span>';
    else if (d.winner === "反方") winnerTxt = '<span class="dc-winner wb">🏆 反方胜</span>';
    card.innerHTML = `
      <div class="dc-status"><span class="status-badge ${STATUS_CLS[d.status]}">${STATUS_TEXT[d.status]}</span></div>
      <div class="dc-main">
        <div class="dc-topic">${escapeHtml(d.topic)}</div>
        <div class="dc-meta">
          <span>${d.rounds} 轮</span><span>${fmtTime(d.createdAt)}</span>
          ${d.queuePos ? `<span>前面 ${d.queuePos} 场</span>` : ""}
          ${viewerN ? `<span>👁 ${viewerN} 人围观</span>` : ""}
        </div>
        <div class="dc-fighters">
          <img src="/avatar-a.svg" alt="">${escapeHtml(d.p1Name || d.aName)}<span style="color:var(--muted)">vs</span><img src="/avatar-b.svg" alt="">${escapeHtml(d.p2Name || d.bName)}
        </div>
      </div>
      <div class="dc-hp">
        <div class="hp-row"><span class="hp-track"><span class="hp-fill a" style="width:${d.hpA}%"></span></span><span class="hp-val">${Math.round(d.hpA)}%</span></div>
        <div class="hp-row"><span class="hp-track"><span class="hp-fill b" style="width:${d.hpB}%"></span></span><span class="hp-val">${Math.round(d.hpB)}%</span></div>
      </div>
      ${winnerTxt}`;
    card.addEventListener("click", () => openDetail(d.id));
    wrap.appendChild(card);
  }
}

/* ============================================================
 * 详情视图
 * ============================================================ */
function setViewing(id, viewing) {
  if (!state.clientId) return;
  fetch("/api/debates/" + id + "/view", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId: state.clientId, viewing }),
  }).catch(() => {});
}

function leaveDetail() {
  if (state.current) setViewing(state.current.id, false);
  state.current = null;
  clearLiveBubbles();
  $("detail-view").classList.add("hidden");
  $("list-view").classList.remove("hidden");
  stopConfetti();
  hideVictory();
  hideJudgeStage();
  hidePk();
  $("arena-box").classList.remove("hidden");
}

async function openDetail(id) {
  try {
    const res = await fetch("/api/debates/" + id);
    if (!res.ok) throw new Error("该场辩论不存在");
    const d = await res.json();
    leaveDetail();
    state.current = d;
    state.victoryShown = false;
    state.pkStances = { p1: null, p2: null };
    $("list-view").classList.add("hidden");
    $("detail-view").classList.remove("hidden");
    renderDetail(d);
    setViewing(id, true);
    history.replaceState(null, "", "#/d/" + id);
    window.scrollTo({ top: 0 });
  } catch (e) {
    toast(e.message, "err");
  }
}

function renderDetail(d) {
  const s = detailToSummary(d);
  syncSummary(s);
  renderChat(d.messages || []);
  renderJudge(d);
  updateDetailActions(d);
  updatePresence();
  // 历史站队消息 → PK 舞台展示
  for (const m of d.messages || []) {
    if (m.round === 0 && (m.side === "p1" || m.side === "p2")) pkRevealStance(m.side, m.stance, true);
  }
  if (d.status === "finished" && d.verdict && d.verdict.winner === "平局") {
    $("pk-statusline").textContent = "🤝 双方观点一致，英雄所见略同，握手言和！";
  }
}

function detailToSummary(d) {
  return {
    id: d.id, topic: d.topic, rounds: d.rounds, status: d.status, phase: d.phase,
    round: d.round, hpA: d.hpA, hpB: d.hpB,
    p1Name: d.p1 && d.p1.name, p2Name: d.p2 && d.p2.name,
    aName: d.a && d.a.name, aModel: d.a && d.a.model, aAvatar: d.a && d.a.avatar, aStance: d.aStance,
    bName: d.b && d.b.name, bModel: d.b && d.b.model, bAvatar: d.b && d.b.avatar, bStance: d.bStance,
    winner: d.verdict ? d.verdict.winner : null,
    nextSide: d.nextSide, queuePos: d.queuePos, error: d.error,
  };
}

function setFighter(which, s) {
  const name = s[which + "Name"] || (which === "a" ? s.p1Name : s.p2Name) || "—";
  const model = s[which + "Model"] || "";
  const avatar = s[which + "Avatar"] || (which === "a" ? "a" : "b");
  const stance = s[which + "Stance"] || null;
  $("f-" + which + "-name").textContent = name;
  $("f-" + which + "-model").textContent = model;
  $("f-" + which + "-avatar").src = "/avatar-" + avatar + ".svg";
  const badge = $("f-" + which + "-side");
  if (stance) {
    badge.textContent = stance;
    badge.className = "f-side " + (stance === "正方" ? "side-a" : "side-b");
  } else {
    badge.textContent = "待站队";
    badge.className = "f-side pending";
  }
}

function syncSummary(s) {
  setFighter("a", s);
  setFighter("b", s);

  const v = s.winner;
  let roundTxt = "等待开赛";
  if (s.status === "queued") roundTxt = `排队中 · 第 ${s.queuePos || 1} 位`;
  else if (s.status === "running" && s.phase === "stance") roundTxt = "🎯 站队中";
  else if (s.status === "running") roundTxt = `第 ${s.round} / ${s.rounds} 轮`;
  else if (s.status === "judging") roundTxt = "⚖️ 生成结果中";
  else if (s.status === "finished") roundTxt = v ? (v === "平局" ? "🤝 平局" : `🏆 ${v}胜`) : "已结束";
  else if (s.status === "error") roundTxt = "⚠️ 中断";
  else if (s.status === "cancelled") roundTxt = "已取消";
  $("round-info").textContent = roundTxt;

  $("status-line").innerHTML = statusLineHtml(s);
  updateHp(s.hpA, s.hpB, true);

  // 舞台切换
  const stanceDraw = s.status === "finished" && v === "平局" && s.phase === "finished";
  if (s.status === "running" && s.phase === "stance") {
    showPk(s, false);
  } else if (stanceDraw) {
    showPk(s, true);
  } else {
    hidePk();
    $("arena-box").classList.remove("hidden");
  }

  if (s.status === "judging") showJudgeStage(s);
  else hideJudgeStage();

  const vs = $("vs-badge");
  vs.classList.toggle("anim", s.status === "running" || s.status === "judging");
  $("fighter-a").classList.toggle("active", s.status === "running" && s.phase !== "stance" && s.nextSide === "A");
  $("fighter-b").classList.toggle("active", s.status === "running" && s.phase !== "stance" && s.nextSide === "B");
  $("fighter-a").classList.toggle("loser", s.status === "finished" && v === "反方");
  $("fighter-b").classList.toggle("loser", s.status === "finished" && v === "正方");

  updateDetailActions(s);
}

function statusLineHtml(s) {
  if (s.status === "queued") return `⏳ 排队等待开赛（第 ${s.queuePos || 1} 位），双方密钥就绪后自动开始`;
  if (s.status === "running") {
    if (s.phase === "stance") {
      const nm = s.nextSide === "p1" ? s.p1Name : s.p2Name;
      return `🎯 ${nm} 正在独立判断观点并站队<span class="dots"></span>`;
    }
    const side = s.nextSide === "A" ? `正方「${s.aName}」` : `反方「${s.bName}」`;
    return `${side} 正在发言<span class="dots"></span>`;
  }
  if (s.status === "judging") return `⚖️ DeepSeek 判官正在生成裁决结果<span class="dots"></span>`;
  if (s.status === "error") return `⚠️ 本场辩论中断：${escapeHtml(s.error || "未知错误")}（管理员可在后台重试）`;
  if (s.status === "cancelled") return "🚫 本场辩论已取消";
  if (s.status === "finished") {
    if (s.winner === "平局") return "🤝 双方观点一致，握手言和，本场判平局";
    return `✅ 辩论结束 · ${s.winner}获胜（${s.aName} vs ${s.bName}）`;
  }
  return "";
}

function updateHp(hpA, hpB, animate) {
  const oldA = parseFloat($("hp-a").style.width || "100");
  const oldB = parseFloat($("hp-b").style.width || "100");
  $("hp-a").style.width = hpA + "%";
  $("hp-b").style.width = hpB + "%";
  $("hp-a-num").textContent = Math.round(hpA) + "%";
  $("hp-b-num").textContent = Math.round(hpB) + "%";
  if (animate && (hpA < oldA || hpB < oldB)) {
    document.querySelectorAll(".hp").forEach((el) => {
      el.classList.remove("hit");
      void el.offsetWidth;
      el.classList.add("hit");
    });
  }
}

function updateDetailActions(s) {
  const show = ["finished", "error", "cancelled"].includes(s.status);
  $("detail-actions").classList.toggle("hidden", !show);
  $("btn-replay").classList.toggle("hidden", !(s.status === "finished" && s.winner));
}

/* ============================================================
 * PK 站队舞台
 * ============================================================ */
function showPk(s, draw) {
  const stage = $("pk-stage");
  stage.classList.remove("hidden");
  $("arena-box").classList.add("hidden");
  $("pk-left-name").textContent = s.p1Name || "选手 1";
  $("pk-right-name").textContent = s.p2Name || "选手 2";
  $("pk-statusline").textContent = draw
    ? "🤝 双方观点一致，英雄所见略同，握手言和！"
    : "🎯 双方正在独立判断观点并站队…";
  $("pk-statusline").classList.toggle("draw", draw);
  stage.classList.remove("enter");
  void stage.offsetWidth;
  stage.classList.add("enter");
}

function hidePk() {
  $("pk-stage").classList.add("hidden");
}

function pkRevealStance(side, stance, silent) {
  if (!stance || (side !== "p1" && side !== "p2")) return;
  state.pkStances[side] = stance;
  const card = $(`pk-${side}-card`);
  const tag = $(`pk-${side}-tag`);
  $(`pk-${side}-stance`).textContent = stance;
  card.className = "pk-stance-card " + (stance === "正方" ? "st-zheng" : "st-fan");
  card.classList.remove("hidden");
  void card.offsetWidth;
  card.classList.add("reveal");
  tag.textContent = "已站队";
  const ring = side === "p1" ? $("pk-left") : $("pk-right");
  ring.classList.add("locked");

  if (!silent) {
    const clash = $("pk-clash");
    clash.classList.remove("hidden");
    void clash.offsetWidth;
    clash.classList.add("pop");
    setTimeout(() => clash.classList.add("hidden"), 700);
  }

  if (state.pkStances.p1 && state.pkStances.p2) {
    if (state.pkStances.p1 === state.pkStances.p2) {
      $("pk-statusline").textContent = `🤝 双方都选择「${state.pkStances.p1}」，观点一致，握手言和！`;
      $("pk-statusline").classList.add("draw");
    } else {
      $("pk-statusline").textContent = "⚔️ 观点对立，即将开战！";
      const clash = $("pk-clash");
      clash.classList.remove("hidden");
      void clash.offsetWidth;
      clash.classList.add("big");
      setTimeout(() => clash.classList.add("hidden"), 1100);
    }
  }
}

/* ============================================================
 * 裁判生成结果动画
 * ============================================================ */
function showJudgeStage() {
  $("judge-stage").classList.remove("hidden");
  $("judge-stage").classList.remove("replay");
  void $("judge-stage").offsetWidth;
  $("judge-stage").classList.add("replay");
}

function hideJudgeStage() {
  $("judge-stage").classList.add("hidden");
}

/* ============================================================
 * 聊天流
 * ============================================================ */
function renderChat(messages) {
  const chat = $("chat");
  chat.innerHTML = "";
  clearLiveBubbles();
  let lastRound = 0;
  let stanceDiv = false;
  for (const m of messages) {
    if (m.round === 0 && !stanceDiv) {
      chat.appendChild(divider("🎯 站队环节", "stance-divider"));
      stanceDiv = true;
    }
    if (m.round > 0 && m.round !== lastRound) {
      chat.appendChild(divider("第 " + m.round + " 轮"));
      lastRound = m.round;
    }
    chat.appendChild(bubbleEl(m, true));
  }
  addPendingBubble();
}

function divider(text, cls) {
  const d = document.createElement("div");
  d.className = "round-divider " + (cls || "");
  d.textContent = text;
  return d;
}

function bubbleEl(m, done) {
  const isZheng = m.stance === "正方";
  const isFan = m.stance === "反方";
  const cls = isFan ? "b" : isZheng ? "a" : "s";
  const avatar = m.avatar ? `/avatar-${m.avatar}.svg` : isFan ? "/avatar-b.svg" : "/avatar-a.svg";
  const sideBadge = m.stance
    ? `<span class="m-side ${cls}">${escapeHtml(m.stance)}</span>`
    : `<span class="m-side pending">站队中…</span>`;
  const el = document.createElement("div");
  el.className = "msg " + cls;
  const meta = done && m.text ? `<span class="m-len">${m.text.length} 字</span>` : "";
  el.innerHTML = `
    <img class="avatar-sm" src="${avatar}" alt="">
    <div class="bubble">
      <div class="meta">
        ${sideBadge}
        <span class="m-model">${escapeHtml(m.name)}</span>
        ${m.round ? `<span class="m-round">第 ${m.round} 轮</span>` : ""}
        ${meta}
      </div>
      <div class="content">${done ? escapeHtml(m.text) : '<span class="typing"><i></i><i></i><i></i></span>'}</div>
    </div>`;
  el._content = el.querySelector(".content");
  return el;
}

function clearLiveBubbles() {
  for (const k of Object.keys(liveBubbles)) delete liveBubbles[k];
}

function liveKey(m) {
  return m.side === "judge" ? "judge" : m.side + "-" + m.round;
}

function ensureLiveBubble(m) {
  const key = liveKey(m);
  if (liveBubbles[key]) return liveBubbles[key];
  const el = bubbleEl(m, false);
  $("chat").appendChild(el);
  liveBubbles[key] = el;
  scrollChat();
  return el;
}

function setLiveText(m) {
  const el = ensureLiveBubble(m);
  el._content.innerHTML = escapeHtml(m.text) + '<span class="cursor"></span>';
  scrollChat();
}

function addPendingBubble() {
  const d = state.current;
  if (!d) return;
  if (d.status === "running" && d.phase === "stance") {
    ensureLiveBubble({ side: "p1", round: 0, stance: null, name: d.p1.name, avatar: d.p1.avatar, text: "" });
    ensureLiveBubble({ side: "p2", round: 0, stance: null, name: d.p2.name, avatar: d.p2.avatar, text: "" });
  } else if (d.status === "running" && d.nextSide) {
    const side = d.nextSide;
    const speaker = side === "A" ? d.a : d.b;
    ensureLiveBubble({ side, round: d.round, stance: side === "A" ? "正方" : "反方", name: speaker.name, avatar: speaker.avatar, text: "" });
  } else if (d.status === "judging") {
    ensureLiveBubble({ side: "judge", round: null, stance: null, name: "DeepSeek 判官", avatar: null, text: "" });
  }
}

function finalizeMessage(m) {
  const key = liveKey(m);
  if (liveBubbles[key]) {
    liveBubbles[key].remove();
    delete liveBubbles[key];
  }
  const chat = $("chat");
  Array.from(chat.querySelectorAll(".msg")).forEach((el) => { if (el._key === key) el.remove(); });
  const el = bubbleEl(m, true);
  el._key = key;

  if (m.round === 0 && !chat.querySelector(".stance-divider")) {
    chat.insertBefore(divider("🎯 站队环节", "stance-divider"), chat.firstChild);
  }
  const idx = findInsertIndex(m);
  chat.insertBefore(el, chat.children[idx] || null);
  scrollChat();
}

function findInsertIndex(m) {
  const chat = $("chat");
  const kids = Array.from(chat.children);
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (!k.classList.contains("msg")) continue;
    const key = k._key || "";
    if (key === "judge") return i;
    const parts = key.split("-");
    if (parts.length === 2) {
      const r = Number(parts[1]);
      const s = parts[0];
      if (r > m.round) return i;
      if (r === m.round) {
        if (m.side === "p1" && s === "p2") return i;
        if (m.side === "a" && s === "b") return i;
      }
    }
  }
  return chat.children.length;
}

function scrollChat() {
  $("chat").scrollIntoView({ block: "end", behavior: "smooth" });
}

/* ============================================================
 * 裁判卡
 * ============================================================ */
function renderJudge(d) {
  const wrap = $("judge-wrap");
  wrap.innerHTML = "";
  if ((d.judgeText == null || d.judgeText === "") && d.status !== "judging" && !(d.verdict && d.status === "finished")) return;
  const hasJudge = Boolean(d.judgeText) || d.status === "judging";
  const div = document.createElement("div");
  div.className = "judge";
  div.innerHTML = `
    <div class="judge-head">${hasJudge ? "⚖️ 裁判裁决" : "🤝 站队结果"} <span>DeepSeek 判官</span></div>
    <div class="judge-content">${d.judgeText ? escapeHtml(d.judgeText) : d.status === "judging" ? '<span class="typing"><i></i><i></i><i></i></span>' : ""}</div>
    <div class="verdict ${d.verdict ? "" : "hidden"}" id="verdict-box"></div>`;
  wrap.appendChild(div);
  if (d.verdict) fillVerdictBox($("verdict-box"), d.verdict);
}

function fillVerdictBox(box, v) {
  const cls = v.winner === "正方" ? "win-a" : v.winner === "反方" ? "win-b" : "win-draw";
  const emoji = v.winner === "平局" ? "🤝" : "🏆";
  box.innerHTML = `
    <div class="winner ${cls}">${emoji} ${escapeHtml(v.winner === "平局" ? "势均力敌 · 平局" : v.winner + "获胜")}</div>
    ${v.conclusion ? `<div class="conclusion">📌 最终结论：${escapeHtml(v.conclusion)}</div>` : ""}
    ${v.score ? `<div class="score">${escapeHtml(v.score)}</div>` : ""}
    ${v.reason ? `<div class="reason">${escapeHtml(v.reason)}</div>` : ""}
    ${v.highlight ? `<div class="highlight">💬 ${escapeHtml(v.highlight)}</div>` : ""}`;
  box.classList.remove("hidden");
}

/* ============================================================
 * SSE 实时事件
 * ============================================================ */
function connectSSE() {
  if (es) es.close();
  es = new EventSource("/api/events");

  es.addEventListener("hello", (e) => {
    const j = JSON.parse(e.data);
    state.clientId = j.clientId;
    localStorage.setItem("arena-cid", j.clientId);
  });

  es.addEventListener("debate", (e) => {
    const s = JSON.parse(e.data);
    upsertList(s);
    renderList();
    if (state.current && state.current.id === s.id) syncSummary(s);
  });

  es.addEventListener("message", (e) => {
    const j = JSON.parse(e.data);
    upsertList(j.debate);
    renderList();
    if (state.current && state.current.id === j.id) {
      const d = state.current;
      d.messages = (d.messages || []).filter((m) => !(m.side === j.message.side && m.round === j.message.round));
      d.messages.push(j.message);
      d.hpA = j.hpA;
      d.hpB = j.hpB;
      d.round = j.debate.round;
      d.nextSide = j.debate.nextSide;
      d.status = j.debate.status;
      d.phase = j.debate.phase;
      finalizeMessage(j.message);
      syncSummary(j.debate);
      if (j.message.round === 0 && (j.message.side === "p1" || j.message.side === "p2")) {
        pkRevealStance(j.message.side, j.message.stance, false);
      }
    }
  });

  es.addEventListener("delta", (e) => {
    const j = JSON.parse(e.data);
    if (state.current && state.current.id === j.id) setLiveText(j);
  });

  es.addEventListener("judging", (e) => {
    const j = JSON.parse(e.data);
    if (state.current && state.current.id === j.id) {
      state.current.status = "judging";
      state.current.phase = "judge";
      state.current.nextSide = null;
      renderJudge(state.current);
      syncSummary(detailToSummary(state.current));
    }
  });

  es.addEventListener("verdict", (e) => {
    const j = JSON.parse(e.data);
    upsertList(j.debate);
    renderList();
    if (state.current && state.current.id === j.id) {
      state.current.judgeText = j.judgeText;
      state.current.verdict = j.verdict;
      state.current.status = "finished";
      state.current.phase = j.debate.phase;
      state.current.hpA = j.debate.hpA;
      state.current.hpB = j.debate.hpB;
      renderJudge(state.current);
      syncSummary(j.debate);
      hideJudgeStage();
      if (!state.victoryShown) {
        state.victoryShown = true;
        showVictory(state.current);
      }
    }
  });

  es.addEventListener("config", (e) => {
    const j = JSON.parse(e.data);
    state.fightersReady = j.fightersReady;
    updateBanner();
  });

  es.addEventListener("presence", (e) => {
    state.presence = JSON.parse(e.data);
    updatePresence();
  });

  es.onerror = () => { /* EventSource 自动重连 */ };
}

function updatePresence() {
  $("online-chip").textContent = `👁 ${state.presence.online} 人在线`;
  if (state.current) {
    const n = (state.presence.viewers || {})[state.current.id] || 0;
    $("viewers").textContent = `👁 ${n} 人围观`;
  }
}

function updateBanner() {
  $("ready-banner").classList.toggle("hidden", state.fightersReady);
}

/* ============================================================
 * 胜利动画
 * ============================================================ */
let confettiPieces = [];
let confettiRaf = null;

function showVictory(d) {
  const v = d.verdict || {};
  const winnerName = v.winner === "反方" ? d.b.name : v.winner === "正方" ? d.a.name : "双方";
  if (v.winner === "平局") {
    $("victory-trophy").textContent = "🤝";
    $("victory-title").textContent = "势均力敌 · 平局！";
  } else {
    $("victory-trophy").textContent = "🏆";
    $("victory-title").textContent = `${v.winner} · ${winnerName} 获胜！`;
  }
  $("victory-score").textContent = v.score || "";
  const concl = $("victory-conclusion");
  if (concl) {
    concl.textContent = v.conclusion ? "📌 最终结论：" + v.conclusion : "";
    concl.classList.toggle("hidden", !v.conclusion);
  }
  $("victory-reason").textContent = v.reason || "";
  $("victory-overlay").classList.remove("hidden");
  const color = v.winner === "反方" ? "#fb7185" : v.winner === "正方" ? "#22d3ee" : "#fbbf24";
  startConfetti(color);
}

function hideVictory() {
  $("victory-overlay").classList.add("hidden");
  stopConfetti();
}

function startConfetti(base) {
  stopConfetti();
  const canvas = $("confetti");
  const ctx = canvas.getContext("2d");
  const colors = [base, "#fbbf24", "#a78bfa", "#ffffff", "#34d399"];
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  confettiPieces = [];
  for (let i = 0; i < 160; i++) {
    confettiPieces.push({
      x: Math.random() * canvas.width,
      y: -30 - Math.random() * canvas.height * 0.5,
      vx: (Math.random() - 0.5) * 120,
      vy: 120 + Math.random() * 260,
      rot: Math.random() * Math.PI * 2,
      vr: (Math.random() - 0.5) * 8,
      w: 6 + Math.random() * 7,
      h: 10 + Math.random() * 10,
      color: colors[Math.floor(Math.random() * colors.length)],
      shape: Math.random() < 0.5 ? "rect" : "circle",
    });
  }
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of confettiPieces) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 60 * dt;
      p.vx *= 0.995;
      p.rot += p.vr * dt;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      if (p.shape === "rect") ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      else { ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
      if (p.y > canvas.height + 40) { p.y = -20; p.x = Math.random() * canvas.width; p.vy = 120 + Math.random() * 200; }
    }
    confettiRaf = requestAnimationFrame(frame);
  }
  confettiRaf = requestAnimationFrame(frame);
}

function stopConfetti() {
  if (confettiRaf) cancelAnimationFrame(confettiRaf);
  confettiRaf = null;
  confettiPieces = [];
}

/* ============================================================
 * 战报复制
 * ============================================================ */
function buildReport(d) {
  const lines = [];
  lines.push("⚔️ DUO AI AGENT · 战报");
  lines.push("辩题：" + d.topic);
  lines.push("轮数：" + d.rounds + " 轮（每轮双方各发言一次）");
  lines.push("选手 1：" + d.p1.name + "（" + d.p1.model + "）");
  lines.push("选手 2：" + d.p2.name + "（" + d.p2.model + "）");
  let lastRound = 0;
  let stanceShown = false;
  for (const m of d.messages || []) {
    if (m.round === 0 && !stanceShown) {
      lines.push("");
      lines.push("——— 🎯 站队环节 ———");
      stanceShown = true;
    }
    if (m.round > 0 && m.round !== lastRound) {
      lines.push("");
      lines.push("——— 第 " + m.round + " 轮 ———");
      lastRound = m.round;
    }
    lines.push("");
    lines.push("【" + m.name + " · " + (m.stance || "站队") + "】");
    lines.push(m.text);
  }
  if (d.judgeText) {
    lines.push("");
    lines.push("——— ⚖️ 裁判裁决 ———");
    lines.push(d.judgeText);
  }
  return lines.join("\n");
}

async function copyReport() {
  if (!state.current) return;
  const text = buildReport(state.current);
  try {
    await navigator.clipboard.writeText(text);
    toast("战报已复制到剪贴板", "ok");
  } catch (_) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); toast("战报已复制到剪贴板", "ok"); }
    catch (e2) { toast("复制失败，请手动复制", "err"); }
    ta.remove();
  }
}

/* ============================================================
 * 新辩论弹窗
 * ============================================================ */
async function submitDebate() {
  const topic = $("topic-input").value.trim();
  const rounds = Number($("rounds-range").value);
  if (!topic) { toast("请填写辩题", "warn"); $("topic-input").focus(); return; }
  try {
    const res = await fetch("/api/debates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic, rounds }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || "创建失败");
    $("topic-input").value = "";
    $("char-count").textContent = "0 / 200";
    toast("辩论已创建，两位选手开始站队", "ok");
    openDetail(j.id);
  } catch (e) {
    toast(e.message, "err", 5000);
  }
}

/* ============================================================
 * 初始化
 * ============================================================ */
function bindEvents() {
  $("btn-submit").addEventListener("click", submitDebate);

  $("topic-input").addEventListener("input", () => {
    $("char-count").textContent = $("topic-input").value.length + " / 200";
  });
  $("topic-chips").addEventListener("click", (e) => {
    if (e.target.classList.contains("chip")) $("topic-input").value = e.target.textContent;
    $("char-count").textContent = $("topic-input").value.length + " / 200";
  });
  $("rounds-range").addEventListener("input", () => {
    $("rounds-label").innerHTML = `轮数 <b>${$("rounds-range").value}</b>`;
  });

  $("tabs").addEventListener("click", (e) => {
    if (!e.target.classList.contains("tab")) return;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === e.target));
    state.filter = e.target.dataset.filter;
    renderList();
  });

  $("btn-back").addEventListener("click", () => {
    history.replaceState(null, "", "#/");
    leaveDetail();
  });
  $("btn-copy").addEventListener("click", copyReport);
  $("btn-replay").addEventListener("click", () => {
    if (state.current && state.current.verdict) showVictory(state.current);
  });
  $("victory-close").addEventListener("click", hideVictory);

  window.addEventListener("hashchange", () => {
    if (!location.hash.startsWith("#/d/")) leaveDetail();
  });
}

async function init() {
  bindEvents();
  state.clientId = localStorage.getItem("arena-cid") || "";
  connectSSE();
  try {
    const res = await fetch("/api/state");
    const j = await res.json();
    state.list = j.debates || [];
    state.presence = j.presence || state.presence;
    state.fightersReady = j.fightersReady;
    updateBanner();
    renderList();
    updatePresence();
  } catch (_) {}
  if (location.hash.startsWith("#/d/")) {
    openDetail(location.hash.slice(4));
  }
}

init();
