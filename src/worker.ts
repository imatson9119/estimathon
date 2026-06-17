import { DurableObject } from "cloudflare:workers";
import { scaleMode } from "./shared.js";
import { BANK, findQ, scoreRound } from "./bank.js";

export interface Env {
  ROOMS: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/room\/([^/]+)\/ws$/);
    if (m) {
      const code = m[1].toUpperCase();
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }
    // run_worker_first only routes /room/* here; anything else defers to static assets.
    return env.ASSETS.fetch(request);
  },
};

function freshState(code: string): any {
  return {
    code,
    phase: "lobby", // lobby | setup | open | locked | revealed | ended
    round: 1,
    questionIndex: 0,
    questionText: "",
    questionId: null,
    deadline: null, // epoch ms when the open-question timer auto-locks, or null
    hostToken: null,
    teams: {}, // id -> { name }
    balances: {}, // id -> number
    usedIds: [],
    subs: {}, // id -> submission (current question only)
    lastResult: null,
  };
}

export class Room extends DurableObject {
  state: any = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get("state")) || null;
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const url = new URL(request.url);
    const role = url.searchParams.get("role") === "host" ? "host" : "player";
    const name = url.searchParams.get("name") || "";
    const token = url.searchParams.get("token") || "";
    const code = (url.pathname.split("/")[2] || "").toUpperCase();

    const existed = !!this.state;
    if (!this.state) {
      if (role !== "host") return this.reject("No game found with that code.");
      this.state = freshState(code);
      this.state.hostToken = crypto.randomUUID();
      await this.persist();
    }

    let sess: any;
    if (role === "host") {
      const ok = (!existed) || (token && token === this.state.hostToken);
      if (!ok) return this.reject("This game already has a host — resume from the original device or link.");
      sess = { role: "host" };
    } else {
      const id = norm(name);
      if (!id) return this.reject("Enter a team name.");
      if (this.state.phase !== "lobby" && !this.state.teams[id]) {
        return this.reject("That game already started — rejoin with your exact team name.");
      }
      if (!this.state.teams[id]) {
        this.state.teams[id] = { name: name.trim() };
        if (this.state.phase !== "lobby" && this.state.balances[id] == null) this.state.balances[id] = 1;
        await this.persist();
      }
      sess = { role: "player", teamId: id };
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(sess);
    server.send(JSON.stringify(this.payloadFor(sess)));
    if (sess.role === "player") this.broadcast(); // update host's lobby/lock counts

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;
    let intent: any;
    try {
      intent = JSON.parse(raw);
    } catch {
      return;
    }
    const sess = (ws.deserializeAttachment() as any) || {};
    const s = this.state;
    if (!s) return;

    if (sess.role === "player") {
      if (intent.type === "submit" && s.phase === "open" && sess.teamId) {
        s.subs[sess.teamId] = intent.submission;
      } else {
        return;
      }
    } else if (sess.role === "host") {
      switch (intent.type) {
        case "start":
          if (s.phase !== "lobby") return;
          for (const id of Object.keys(s.teams)) if (s.balances[id] == null) s.balances[id] = 1;
          s.phase = "setup";
          break;
        case "abandon":
          if (s.phase !== "lobby" || Object.keys(s.teams).length) return;
          this.state = null;
          await this.ctx.storage.delete("state");
          for (const socket of this.ctx.getWebSockets()) {
            try {
              socket.close(1000, "abandoned");
            } catch {
              /* socket closing */
            }
          }
          return;
        case "setRound":
          if ([1, 2, 3].includes(intent.round)) s.round = intent.round;
          break;
        case "setBalance": {
          const teamId = String(intent.teamId || "");
          if (!s.teams[teamId]) return;
          const balance = Number(intent.balance);
          if (!Number.isSafeInteger(balance) || balance < 1) return;
          const previous = s.balances[teamId] ?? 1;
          s.balances[teamId] = balance;
          if (s.lastResult && Array.isArray(s.lastResult.results)) {
            s.lastResult.results = s.lastResult.results.map((r: any) =>
              r.id === teamId ? { ...r, balance, delta: (r.delta || 0) + (balance - previous) } : r
            );
          }
          break;
        }
        case "open": {
          const text = (intent.questionText || "").trim();
          if (!text) return;
          s.phase = "open";
          s.questionIndex += 1;
          s.questionText = text;
          s.questionId = intent.questionId || null;
          s.subs = {};
          s.lastResult = null;
          await this.clearTimer();
          if (s.questionId && !s.usedIds.includes(s.questionId)) s.usedIds.push(s.questionId);
          break;
        }
        case "timer": {
          if (s.phase !== "open") return;
          const seconds = Math.floor(Number(intent.seconds));
          if (!Number.isFinite(seconds) || seconds <= 0) return;
          s.deadline = Date.now() + Math.min(3600, seconds) * 1000;
          await this.ctx.storage.setAlarm(s.deadline);
          break;
        }
        case "stopTimer":
          await this.clearTimer();
          break;
        case "lock":
          if (s.phase === "open") s.phase = "locked";
          await this.clearTimer();
          break;
        case "reveal": {
          const q = s.questionId ? findQ(s.round, s.questionId) : null;
          let ans: any;
          if (s.round === 1) {
            ans = q && q.answer ? q.answer : intent.answer;
            if (ans !== "yes" && ans !== "no") return;
          } else {
            ans = q && q.answer != null ? Number(q.answer) : Number(intent.answer);
            if (!Number.isFinite(ans)) return;
          }
          const { balances, results } = scoreRound(s.round, s.teams, s.balances, s.subs, ans);
          s.balances = balances;
          s.lastResult = { answer: ans, note: q ? q.note || null : null, questionText: s.questionText, round: s.round, results };
          s.phase = "revealed";
          break;
        }
        case "next":
          s.phase = "setup";
          s.lastResult = null;
          break;
        case "end":
          s.phase = "ended";
          break;
        default:
          return;
      }
    } else {
      return;
    }

    await this.persist();
    this.broadcast();
  }

  // Fires when the open-question timer expires: auto-lock so no one keeps editing.
  async alarm(): Promise<void> {
    const s = this.state;
    if (!s || s.phase !== "open" || !s.deadline) return;
    s.phase = "locked";
    s.deadline = null;
    await this.persist();
    this.broadcast();
  }

  async clearTimer(): Promise<void> {
    if (this.state) this.state.deadline = null;
    await this.ctx.storage.deleteAlarm();
  }

  // ---- helpers ----
  reject(message: string): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    server.send(JSON.stringify({ type: "error", message }));
    server.close(4001, "rejected");
    return new Response(null, { status: 101, webSocket: client });
  }

  async persist(): Promise<void> {
    await this.ctx.storage.put("state", this.state);
  }

  publicState(): any {
    const s = this.state;
    const q = s.questionId ? findQ(s.round, s.questionId) : null;
    return {
      code: s.code,
      phase: s.phase,
      round: s.round,
      questionIndex: s.questionIndex,
      questionText: s.questionText,
      questionId: s.questionId,
      deadline: s.deadline ?? null,
      teams: s.teams,
      balances: s.balances,
      usedIds: s.usedIds,
      submittedIds: Object.keys(s.subs || {}),
      currentMode: scaleMode(s.round, q ? q.answer : null),
      lastResult: s.lastResult,
    };
  }

  payloadFor(sess: any): any {
    const s = this.state;
    const you: any = { role: sess.role, teamId: sess.teamId || null };
    const out: any = { type: "state", state: this.publicState(), you };
    if (sess.role === "host") {
      you.token = s.hostToken;
      out.bank = (BANK[s.round] || []).map((q: any) => ({
        id: q.id,
        text: q.text,
        live: q.answer == null,
        mode: scaleMode(s.round, q.answer),
      }));
    }
    you.mySubmission = sess.teamId ? s.subs[sess.teamId] || null : null;
    return out;
  }

  broadcast(): void {
    for (const ws of this.ctx.getWebSockets()) {
      const sess = ws.deserializeAttachment() as any;
      if (!sess) continue;
      try {
        ws.send(JSON.stringify(this.payloadFor(sess)));
      } catch {
        /* socket closing */
      }
    }
  }
}

function norm(n: string): string {
  return n.trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
}
