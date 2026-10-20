// QuizBattle online: invite e-mail + real-time duel rooms (one Durable Object per room).
import { DurableObject } from "cloudflare:workers";

// Correct answer index per question; must match the question order in index.html.
const ANSWERS = { 1: [1, 2, 0, 3, 2], 2: [1, 1, 2, 3] };
const TIME_LIMITS = { 1: 10, 2: 7 }; // seconds per answer
const GRACE_MS = 600; // network slack after the visible timer hits 0
const REVEAL_MS = 3500; // how long the correct answer stays on screen
const ROOM_TTL_MS = 24 * 3600 * 1000;
const LANGS = ["ru", "en", "pt"];

const NAME_RE = /^[\p{L}\p{N} _'-]{1,20}$/u; // no dots/slashes: names cannot carry links into the e-mail
const EMAIL_RE = /^[^\s@<>()",;]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

const randomId = (bytes) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

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
  const level = body.level === 2 ? 2 : 1;
  const lang = LANGS.includes(body.lang) ? body.lang : "ru";

  if (!NAME_RE.test(hostName) || !NAME_RE.test(friendName)) return json({ error: "bad_name" }, 400, corsHeaders);
  if (!EMAIL_RE.test(hostEmail) || !EMAIL_RE.test(friendEmail)) return json({ error: "bad_email" }, 400, corsHeaders);
  if (hostEmail === friendEmail) return json({ error: "same_email" }, 400, corsHeaders);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const quota = await env.QUOTA.getByName("global").take(ip, friendEmail, {
    day: Number(env.INVITES_PER_DAY), ipHour: Number(env.INVITES_PER_IP_HOUR), toDay: Number(env.INVITES_PER_RECIPIENT_DAY),
  });
  if (!quota.ok) return json({ error: "rate_limited" }, 429, corsHeaders);

  const roomId = randomId(12);
  const hostToken = randomId(16);
  const guestToken = randomId(16);
  const room = env.ROOMS.getByName(roomId);
  await room.init({ names: [hostName, friendName], tokens: [hostToken, guestToken], level });

  const link = `${env.GAME_URL}?room=${roomId}&t=${guestToken}&lang=${lang}`;
  try {
    await env.EMAIL.send({ ...inviteEmail(lang, hostName, friendName, link, level), to: friendEmail, from: { email: env.MAIL_FROM, name: "QuizBattle" }, replyTo: hostEmail });
  } catch (e) {
    console.error("invite send failed", e.code, e.message);
    await room.destroy();
    return json({ error: "email_failed" }, 502, corsHeaders);
  }
  return json({ room: roomId, token: hostToken, link }, 200, corsHeaders);
}

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function inviteEmail(lang, host, friend, link, level) {
  const t = {
    ru: {
      subject: `${host} вызывает тебя на дуэль в QuizBattle ⚔️`,
      hi: `Привет, ${friend}!`,
      body: `${host} приглашает тебя сыграть онлайн в QuizBattle — викторину «Насколько хорошо ты знаешь Alex?» (уровень ${level}). Вы будете отвечать на одни и те же вопросы одновременно, каждый со своего устройства. На ответ — ${TIME_LIMITS[level]} секунд!`,
      cta: "Принять вызов 🚀",
      note: "Ссылка действует 24 часа. Если ты не знаешь отправителя, просто проигнорируй это письмо.",
    },
    en: {
      subject: `${host} challenges you to a QuizBattle duel ⚔️`,
      hi: `Hi ${friend}!`,
      body: `${host} invites you to play QuizBattle online — the "How well do you know Alex?" quiz (Level ${level}). You'll both answer the same questions at the same time, each on your own device. You have ${TIME_LIMITS[level]} seconds per answer!`,
      cta: "Accept the challenge 🚀",
      note: "The link is valid for 24 hours. If you don't know the sender, just ignore this e-mail.",
    },
    pt: {
      subject: `${host} desafia-te para um duelo no QuizBattle ⚔️`,
      hi: `Olá, ${friend}!`,
      body: `${host} convida-te a jogar QuizBattle online — o quiz «Quão bem conheces o Alex?» (Nível ${level}). Vão responder às mesmas perguntas ao mesmo tempo, cada um no seu dispositivo. Tens ${TIME_LIMITS[level]} segundos por resposta!`,
      cta: "Aceitar o desafio 🚀",
      note: "O link é válido durante 24 horas. Se não conheces o remetente, ignora este e-mail.",
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

// One instance per game room. Players are p0 (host) and p1 (invited friend).
export class GameRoom extends DurableObject {
  async init({ names, tokens, level }) {
    const s = {
      names, tokens, level, phase: "lobby", ready: [false, false], q: 0, deadline: 0,
      picks: [null, null], scores: [0, 0], rematch: [false, false], expires: Date.now() + ROOM_TTL_MS,
    };
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
    const player = s ? s.tokens.indexOf(token) : -1;
    if (!s || player === -1 || Date.now() > s.expires) return new Response("room not found", { status: 404 });

    // A player reconnecting (refresh, flaky network) replaces their old socket.
    for (const old of this.ctx.getWebSockets(`p${player}`)) old.close(4001, "replaced");
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [`p${player}`]);
    this.broadcast(s);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const player = this.ctx.getTags(ws)[0] === "p0" ? 0 : 1;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const s = await this.ctx.storage.get("s");
    if (!s) return;

    if (msg.t === "ready" && s.phase === "lobby") {
      s.ready[player] = true;
      if (s.ready[0] && s.ready[1]) this.startQuestion(s, 0);
    } else if (msg.t === "answer" && s.phase === "question" && msg.q === s.q && s.picks[player] === null) {
      const choice = Number(msg.choice);
      s.picks[player] = Number.isInteger(choice) && choice >= 0 && choice <= 3 ? choice : -1;
      if (s.picks[0] !== null && s.picks[1] !== null) this.reveal(s);
    } else if (msg.t === "rematch" && s.phase === "done") {
      s.rematch[player] = true;
      if (s.rematch[0] && s.rematch[1]) {
        s.scores = [0, 0];
        s.rematch = [false, false];
        this.startQuestion(s, 0);
      }
    } else if (msg.t === "ping") {
      ws.send(JSON.stringify({ type: "pong" }));
      return;
    } else {
      return;
    }
    s.expires = Math.max(s.expires, Date.now() + 3600e3);
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
    if (s.phase === "question" && now >= s.deadline) {
      s.picks = s.picks.map((p) => (p === null ? -1 : p)); // unanswered = time is up
      this.reveal(s);
    } else if (s.phase === "reveal" && now >= s.deadline) {
      if (s.q + 1 < ANSWERS[s.level].length) this.startQuestion(s, s.q + 1);
      else s.phase = "done";
    } else if (now >= s.expires) {
      return this.destroy();
    }
    await this.save(s);
  }

  startQuestion(s, q) {
    s.phase = "question";
    s.q = q;
    s.picks = [null, null];
    s.deadline = Date.now() + TIME_LIMITS[s.level] * 1000 + GRACE_MS;
  }

  reveal(s) {
    const correct = ANSWERS[s.level][s.q];
    s.picks.forEach((p, i) => { if (p === correct) s.scores[i]++; });
    s.phase = "reveal";
    s.deadline = Date.now() + REVEAL_MS;
  }

  async save(s) {
    await this.ctx.storage.put("s", s);
    await this.ctx.storage.setAlarm(s.phase === "question" || s.phase === "reveal" ? s.deadline : s.expires);
    this.broadcast(s);
  }

  // Each player gets their own view: the opponent's pick stays hidden until the reveal.
  broadcast(s, closing) {
    const sockets = this.ctx.getWebSockets().filter((ws) => ws !== closing);
    const connected = [0, 1].map((i) => sockets.some((ws) => this.ctx.getTags(ws)[0] === `p${i}`));
    const shown = s.phase === "reveal" || s.phase === "done";
    for (const ws of sockets) {
      const you = this.ctx.getTags(ws)[0] === "p0" ? 0 : 1;
      const view = {
        type: "state", you, names: s.names, level: s.level, phase: s.phase, connected, ready: s.ready,
        q: s.q, total: ANSWERS[s.level].length, limit: TIME_LIMITS[s.level],
        remaining: s.phase === "question" ? Math.max(0, s.deadline - GRACE_MS - Date.now()) : 0,
        answered: s.picks.map((p) => p !== null), myPick: s.picks[you], scores: s.scores, rematch: s.rematch,
        reveal: shown ? { picks: s.picks, correct: ANSWERS[s.level][s.q] } : null,
      };
      try { ws.send(JSON.stringify(view)); } catch {}
    }
  }
}
