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
    history: [], // compact per-question recap, appended on reveal
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
          if (!Array.isArray(s.history)) s.history = [];
          s.history.push({
            round: s.round,
            questionText: s.questionText,
            answer: ans,
            note: q ? q.note || null : null,
            winners: results.filter((r: any) => r.outcome === "closest" || r.outcome === "correct").map((r: any) => r.name),
          });
          break;
        }
        case "undoReveal": {
          // Roll balances back to their pre-reveal values and return to "locked"
          // so the host can re-enter a corrected answer and re-score.
          if (s.phase !== "revealed" || !s.lastResult) return;
          for (const r of s.lastResult.results || []) {
            if (s.balances[r.id] != null) s.balances[r.id] = (r.balance || 0) - (r.delta || 0);
          }
          if (Array.isArray(s.history)) s.history.pop();
          s.lastResult = null;
          s.phase = "locked";
          break;
        }
        case "renameTeam": {
          const teamId = String(intent.teamId || "");
          const name = (intent.name || "").trim().slice(0, 40);
          if (!s.teams[teamId] || !name) return;
          s.teams[teamId].name = name;
          break;
        }
        case "removeTeam": {
          const teamId = String(intent.teamId || "");
          if (!s.teams[teamId]) return;
          delete s.teams[teamId];
          delete s.balances[teamId];
          delete s.subs[teamId];
          this.evictTeam(teamId);
          break;
        }
        case "next":
          s.phase = "setup";
          s.lastResult = null;
          break;
        case "end":
          s.phase = "ended";
          await this.clearTimer();
          // Auto-clean the room a while after it ends so storage doesn't linger.
          await this.ctx.storage.setAlarm(Date.now() + 6 * 3600 * 1000);
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

  // The DO alarm does double duty: it auto-locks an expired question timer,
  // and it cleans up the room some hours after the game ends.
  async alarm(): Promise<void> {
    const s = this.state;
    if (!s) return;
    if (s.phase === "open" && s.deadline) {
      s.phase = "locked";
      s.deadline = null;
      await this.persist();
      this.broadcast();
      return;
    }
    if (s.phase === "ended") {
      this.state = null;
      await this.ctx.storage.deleteAll();
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.close(1000, "room closed"); } catch { /* socket closing */ }
      }
    }
  }

  async clearTimer(): Promise<void> {
    if (this.state) this.state.deadline = null;
    await this.ctx.storage.deleteAlarm();
  }

  // Close out a removed team's sockets with a message so their client stops.
  evictTeam(teamId: string): void {
    for (const ws of this.ctx.getWebSockets()) {
      const sess = ws.deserializeAttachment() as any;
      if (sess && sess.role === "player" && sess.teamId === teamId) {
        try {
          ws.send(JSON.stringify({ type: "error", message: "The host removed your team from the game." }));
          ws.close(4001, "removed");
        } catch { /* socket closing */ }
      }
    }
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
      history: s.history || [],
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
