// QuizBattle online: "who knows whom better" duel. Each player writes 5 questions about
// themselves; then each guesses the opponent's answers with a per-question timer.
// One Durable Object per room; an e-mail invitation brings in the second player.
import { DurableObject } from "cloudflare:workers";

const QUESTION_COUNT = 5;
const TIME_LIMITS = [10, 7]; // allowed seconds per answer, chosen by the host
const GRACE_MS = 600; // network slack after the visible timer hits 0
const ROOM_TTL_MS = 7 * 24 * 3600 * 1000;
const LANGS = ["ru", "en", "pt"];

const NAME_RE = /^[\p{L}\p{N} _'-]{1,20}$/u; // no dots/slashes: names cannot carry links into the e-mail
const EMAIL_RE = /^[^\s@<>()",;]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

const randomId = (bytes) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

// Returns a clean question set or null. Text is shown only to the invited opponent, via textContent.
function parseQuestions(input) {
  if (!Array.isArray(input) || input.length !== QUESTION_COUNT) return null;
  const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);
  const out = [];
  for (const q of input) {
    const text = clean(q?.text, 120);
    const answers = Array.isArray(q?.answers) ? q.answers.slice(0, 4).map((a) => clean(a, 40)) : [];
    const correct = Number(q?.correct);
    if (!text || answers.length !== 4 || answers.some((a) => !a)) return null;
    if (!Number.isInteger(correct) || correct < 0 || correct > 3) return null;
    out.push({ text, answers, correct });
  }
  return out;
}

function cors(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = env.ALLOWED_ORIGINS.split(",").includes(origin);
  return allowed
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" }
    : null;
}

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = cors(request, env);

    if (request.method === "OPTIONS") return new Response(null, { status: corsHeaders ? 204 : 403, headers: corsHeaders || {} });
    if (url.pathname === "/") return new Response("QuizBattle API", { status: 200 });
    if (!corsHeaders) return json({ error: "origin" }, 403, {});

    if (url.pathname === "/api/invite" && request.method === "POST") return handleInvite(request, env, corsHeaders);

    const m = url.pathname.match(/^\/api\/room\/([a-f0-9]{24})\/ws$/);
    if (m && request.headers.get("Upgrade") === "websocket") {
      return env.ROOMS.getByName(m[1]).fetch(request);
    }
    return json({ error: "not_found" }, 404, corsHeaders);
  },
};

async function handleInvite(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400, corsHeaders); }
  if (body.website) return json({ error: "bad_request" }, 400, corsHeaders); // honeypot

  const hostName = String(body.hostName || "").trim();
  const friendName = String(body.friendName || "").trim();
  const hostEmail = String(body.hostEmail || "").trim().toLowerCase();
  const friendEmail = String(body.friendEmail || "").trim().toLowerCase();
  const timeLimit = TIME_LIMITS.includes(body.timeLimit) ? body.timeLimit : TIME_LIMITS[0];
  const lang = LANGS.includes(body.lang) ? body.lang : "ru";
  const questions = parseQuestions(body.questions);

  if (!NAME_RE.test(hostName) || !NAME_RE.test(friendName)) return json({ error: "bad_name" }, 400, corsHeaders);
  if (!EMAIL_RE.test(hostEmail) || !EMAIL_RE.test(friendEmail)) return json({ error: "bad_email" }, 400, corsHeaders);
  if (hostEmail === friendEmail) return json({ error: "same_email" }, 400, corsHeaders);
  if (!questions) return json({ error: "bad_questions" }, 400, corsHeaders);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const quota = await env.QUOTA.getByName("global").take(ip, friendEmail, {
    day: Number(env.INVITES_PER_DAY), ipHour: Number(env.INVITES_PER_IP_HOUR), toDay: Number(env.INVITES_PER_RECIPIENT_DAY),
  });
  if (!quota.ok) return json({ error: "rate_limited" }, 429, corsHeaders);

  const roomId = randomId(12);
  const hostToken = randomId(16);
  const guestToken = randomId(16);
  const room = env.ROOMS.getByName(roomId);
  await room.init({ names: [hostName, friendName], tokens: [hostToken, guestToken], timeLimit, hostQuestions: questions });

  const link = `${env.GAME_URL}?room=${roomId}&t=${guestToken}&lang=${lang}`;
  try {
    await env.EMAIL.send({ ...inviteEmail(lang, hostName, friendName, link, timeLimit), to: friendEmail, from: { email: env.MAIL_FROM, name: "QuizBattle" }, replyTo: hostEmail });
  } catch (e) {
    console.error("invite send failed", e.code, e.message);
    await room.destroy();
    return json({ error: "email_failed" }, 502, corsHeaders);
  }
  return json({ room: roomId, token: hostToken, link }, 200, corsHeaders);
}

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function inviteEmail(lang, host, friend, link, sec) {
  const t = {
    ru: {
      subject: `${host} вызывает тебя на дуэль в QuizBattle ⚔️`,
      hi: `Привет, ${friend}!`,
      body: `${host} придумал(а) ${QUESTION_COUNT} вопросов о себе и вызывает тебя на дуэль «Кто кого лучше знает?». Открой ссылку и придумай ${QUESTION_COUNT} вопросов о себе: их будет угадывать ${host}, а ты угадываешь ответы на вопросы соперника. Каждый угадывает ответы соперника, на ответ — ${sec} секунд.`,
      cta: "Принять вызов 🚀",
      note: "Ссылка действует 7 дней. Если ты не знаешь отправителя, просто проигнорируй это письмо.",
    },
    en: {
      subject: `${host} challenges you to a QuizBattle duel ⚔️`,
      hi: `Hi ${friend}!`,
      body: `${host} wrote ${QUESTION_COUNT} questions about themselves and challenges you to a "Who knows whom better?" duel. Open the link, write ${QUESTION_COUNT} questions about yourself for ${host}, and the battle begins! Each of you guesses the other's answers, ${sec} seconds per answer.`,
      cta: "Accept the challenge 🚀",
      note: "The link is valid for 7 days. If you don't know the sender, just ignore this e-mail.",
    },
    pt: {
      subject: `${host} desafia-te para um duelo no QuizBattle ⚔️`,
      hi: `Olá, ${friend}!`,
      body: `${host} escreveu ${QUESTION_COUNT} perguntas sobre si e desafia-te para o duelo «Quem conhece melhor quem?». Abre o link, escreve ${QUESTION_COUNT} perguntas sobre ti para ${host} e começa o duelo! Cada um adivinha as respostas do outro, ${sec} segundos por resposta.`,
      cta: "Aceitar o desafio 🚀",
      note: "O link é válido durante 7 dias. Se não conheces o remetente, ignora este e-mail.",
    },
  }[lang];
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#17134b;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#ffffff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px;background:#29216e;border-radius:24px;padding:28px" cellpadding="0" cellspacing="0"><tr><td>
<div style="font-size:26px;font-weight:900">⚡ Quiz<span style="color:#ffd447">Battle</span></div>
<h1 style="font-size:24px;margin:20px 0 10px">${esc(t.hi)}</h1>
<p style="font-size:16px;line-height:1.6;color:#e5e1ff">${esc(t.body)}</p>
<p style="margin:26px 0"><a href="${link}" style="display:inline-block;background:#ffd447;color:#24184d;font-weight:900;text-decoration:none;padding:15px 24px;border-radius:16px">${esc(t.cta)}</a></p>
<p style="font-size:13px;line-height:1.5;color:#c8c1f4">${esc(t.note)}<br><a href="${link}" style="color:#c8c1f4;word-break:break-all">${link}</a></p>
</td></tr></table></td></tr></table></body></html>`;
  const text = `${t.hi}\n\n${t.body}\n\n${t.cta}: ${link}\n\n${t.note}`;
  return { subject: t.subject, html, text };
}

// One instance ("global"): counts invites per day, per sender IP per hour, per recipient per day.
export class InviteQuota extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, exp INTEGER NOT NULL)");
  }
  take(ip, recipient, limits) {
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const hour = new Date(now).toISOString().slice(0, 13);
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM hits WHERE exp < ?", now);
    const checks = [
      [`day:${day}`, limits.day, 86400e3],
      [`ip:${ip}:${hour}`, limits.ipHour, 3600e3],
      [`to:${recipient}:${day}`, limits.toDay, 86400e3],
    ];
    for (const [k, max] of checks) {
      const row = sql.exec("SELECT n FROM hits WHERE k = ?", k).toArray()[0];
      if (row && row.n >= max) return { ok: false };
    }
    for (const [k, , ttl] of checks) {
      sql.exec("INSERT INTO hits (k, n, exp) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1", k, now + ttl);
    }
    return { ok: true };
  }
}

// One instance per room. p0 = host, p1 = invited friend; player i answers sets[1 - i].
// play[i].phase: idle → question → reveal → question … → done.
export class GameRoom extends DurableObject {
  async init({ names, tokens, timeLimit, hostQuestions }) {
    const idle = () => ({ phase: "idle", q: 0, deadline: 0, picks: [] });
    const s = { v: 2, names, tokens, timeLimit, sets: [hostQuestions, null], play: [idle(), idle()], expires: Date.now() + ROOM_TTL_MS };
    await this.ctx.storage.put("s", s);
    await this.ctx.storage.setAlarm(s.expires);
  }

  async destroy() {
    for (const ws of this.ctx.getWebSockets()) ws.close(4000, "room closed");
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async fetch(request) {
    const s = await this.ctx.storage.get("s");
    const token = new URL(request.url).searchParams.get("t");
    const player = s?.v === 2 ? s.tokens.indexOf(token) : -1;
    if (player === -1 || Date.now() > s.expires) return new Response("room not found", { status: 404 });

    // A player reconnecting (refresh, flaky network) replaces their old socket.
    for (const old of this.ctx.getWebSockets(`p${player}`)) old.close(4001, "replaced");
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [`p${player}`]);
    this.broadcast(s);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const me = this.ctx.getTags(ws)[0] === "p0" ? 0 : 1;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.t === "ping") { ws.send(JSON.stringify({ type: "pong" })); return; }
    const s = await this.ctx.storage.get("s");
    if (!s) return;
    const p = s.play[me];

    if (msg.t === "questions" && !s.sets[me]) {
      const set = parseQuestions(msg.questions);
      if (!set) { ws.send(JSON.stringify({ type: "error", error: "bad_questions" })); return; }
      s.sets[me] = set;
    } else if (msg.t === "start" && s.sets[0] && s.sets[1] && p.phase === "idle") {
      this.startQuestion(s, me, 0);
    } else if (msg.t === "answer" && p.phase === "question" && msg.q === p.q) {
      const choice = Number(msg.choice);
      const late = Date.now() > p.deadline;
      this.reveal(p, !late && Number.isInteger(choice) && choice >= 0 && choice <= 3 ? choice : -1);
    } else if (msg.t === "next" && p.phase === "reveal") {
      if (p.q + 1 < QUESTION_COUNT) this.startQuestion(s, me, p.q + 1);
      else p.phase = "done";
    } else {
      return;
    }
    await this.save(s);
  }

  async webSocketClose(ws) {
    const s = await this.ctx.storage.get("s");
    if (s) this.broadcast(s, ws);
  }

  async alarm() {
    const s = await this.ctx.storage.get("s");
    if (!s) return;
    const now = Date.now();
    if (now >= s.expires) return this.destroy();
    for (const p of s.play) if (p.phase === "question" && now >= p.deadline) this.reveal(p, -1); // time is up
    await this.save(s);
  }

  startQuestion(s, i, q) {
    Object.assign(s.play[i], { phase: "question", q, deadline: Date.now() + s.timeLimit * 1000 + GRACE_MS });
  }

  reveal(p, pick) {
    p.picks[p.q] = pick;
    p.phase = "reveal";
  }

  async save(s) {
    s.expires = Math.max(s.expires, Date.now() + 24 * 3600e3);
    await this.ctx.storage.put("s", s);
    const deadlines = s.play.filter((p) => p.phase === "question").map((p) => p.deadline);
    await this.ctx.storage.setAlarm(Math.min(s.expires, ...deadlines));
    this.broadcast(s);
  }

  // Each player sees the opponent's questions one at a time; correct answers only after answering.
  broadcast(s, closing) {
    const sockets = this.ctx.getWebSockets().filter((ws) => ws !== closing);
    const connected = [0, 1].map((i) => sockets.some((ws) => this.ctx.getTags(ws)[0] === `p${i}`));
    const score = (i) => s.play[i].picks.filter((pick, k) => pick === s.sets[1 - i][k].correct).length;
    const bothDone = s.play.every((p) => p.phase === "done");
    for (const ws of sockets) {
      const me = this.ctx.getTags(ws)[0] === "p0" ? 0 : 1;
      const opp = 1 - me;
      const p = s.play[me];
      const q = p.phase === "question" || p.phase === "reveal" ? s.sets[opp][p.q] : null;
      const view = {
        type: "state", you: me, names: s.names, connected, limit: s.timeLimit, total: QUESTION_COUNT,
        submitted: s.sets.map(Boolean),
        me: {
          phase: p.phase, q: p.q, score: s.sets[opp] ? score(me) : 0,
          remaining: p.phase === "question" ? Math.max(0, p.deadline - GRACE_MS - Date.now()) : 0,
          question: q && { text: q.text, answers: q.answers },
          pick: p.phase === "reveal" ? p.picks[p.q] : null,
          correct: p.phase === "reveal" ? q.correct : null,
        },
        opp: { phase: s.play[opp].phase, q: s.play[opp].q, answered: s.play[opp].picks.length, score: s.sets[me] ? score(opp) : 0 },
        // Full review once both players are finished: how each guessed the other's questions.
        review: bothDone ? { theirQuestions: s.sets[opp].map((x, k) => ({ ...x, pick: s.play[me].picks[k] })), myQuestions: s.sets[me].map((x, k) => ({ ...x, pick: s.play[opp].picks[k] })) } : null,
      };
      try { ws.send(JSON.stringify(view)); } catch {}
    }
  }
}
