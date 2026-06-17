import { useState, useEffect, useRef, useCallback } from "react";
import qrcode from "qrcode-generator";
import {
  MAGS, fmt, fmtBig, scaleMode, MODE_BADGE, ROUND_META, OUTCOME, genCode,
} from "../shared.js";

const joinUrl = (code) => `${location.origin}/?code=${encodeURIComponent(code)}`;
function qrDataUrl(text) {
  try {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createDataURL(6, 16);
  } catch {
    return null;
  }
}

const SESSION_KEY = "estimathon:session";
const saveSession = (s) => { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch {} };
const loadSession = () => { try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; } };
const clearSession = () => { try { localStorage.removeItem(SESSION_KEY); } catch {} };
const magIndex = (word) => Math.max(0, MAGS.findIndex((m) => m.word === word));

const TIMER_PRESETS = [
  { secs: 30, label: "0:30" },
  { secs: 60, label: "1:00" },
  { secs: 120, label: "2:00" },
];

const pct = (n) => `${Math.max(0, Math.min(100, n)).toFixed(2)}%`;

function buildGuessScale(lr) {
  if (lr.round === 1 || lr.answer == null || !Number.isFinite(Number(lr.answer))) return null;
  const mode = scaleMode(lr.round, lr.answer);
  const logMode = mode === "ratio";
  const canPlot = (value) => Number.isFinite(Number(value)) && (!logMode || Number(value) > 0);
  const toScale = (value) => logMode ? Math.log10(Number(value)) : Number(value);
  const fromScale = (value) => logMode ? Math.pow(10, value) : value;
  const players = lr.results
    .filter((r) => r.guess != null && canPlot(r.guess))
    .map((r) => ({ ...r, scaled: toScale(r.guess) }));
  if (!players.length || !canPlot(lr.answer)) return null;

  const answerScaled = toScale(lr.answer);
  const scaledValues = [...players.map((p) => p.scaled), answerScaled];
  const rawValues = [...players.map((p) => Number(p.guess)), Number(lr.answer)];
  let min = Math.min(...scaledValues);
  let max = Math.max(...scaledValues);
  if (min === max) {
    const pad = logMode ? 0.5 : Math.max(1, Math.abs(min) * 0.1);
    min -= pad;
    max += pad;
  }
  const buffer = (max - min) * 0.1;
  min -= buffer;
  max += buffer;
  if (!logMode && rawValues.every((value) => value >= 0)) min = Math.max(0, min);
  const position = (scaled) => ((scaled - min) / (max - min)) * 100;

  const lanes = [];
  const placedPlayers = players
    .sort((a, b) => position(a.scaled) - position(b.scaled))
    .map((player) => {
      const pos = position(player.scaled);
      let lane = lanes.findIndex((lastPos) => pos - lastPos >= 18);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(pos);
      } else {
        lanes[lane] = pos;
      }
      return { ...player, pos, lane };
    });

  return {
    answerPos: position(answerScaled),
    minLabel: fmtBig(fromScale(min)),
    maxLabel: fmtBig(fromScale(max)),
    players: placedPlayers,
    lanes: Math.max(1, lanes.length),
    mode,
  };
}

// ---------- WebSocket room hook ----------
function useRoom() {
  const [room, setRoom] = useState(null);
  const [me, setMe] = useState(null);
  const [bank, setBank] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | connecting | open | closed
  const [error, setError] = useState("");
  const wsRef = useRef(null);
  const paramsRef = useRef(null);
  const retryRef = useRef(0);
  const stopRef = useRef(false);

  const openSocket = useCallback(() => {
    const p = paramsRef.current;
    if (!p) return;
    setStatus("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const qs = new URLSearchParams({ role: p.role });
    if (p.name) qs.set("name", p.name);
    if (p.token) qs.set("token", p.token);
    const ws = new WebSocket(`${proto}://${location.host}/room/${p.code}/ws?${qs.toString()}`);
    wsRef.current = ws;
    ws.onopen = () => { retryRef.current = 0; setStatus("open"); };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === "error") {
        // Let the caller transparently recover (e.g. host hit a room-code clash).
        const p = paramsRef.current;
        if (p && typeof p.onConflict === "function") {
          const next = p.onConflict(msg.message || "");
          if (next) {
            try { ws.close(); } catch {}
            paramsRef.current = next;
            openSocket();
            return;
          }
        }
        stopRef.current = true;
        clearSession();
        setError(msg.message || "Connection rejected.");
        try { ws.close(); } catch {}
        return;
      }
      if (msg.type === "state") {
        setRoom(msg.state);
        setMe(msg.you);
        if (msg.bank) setBank(msg.bank);
        if (msg.you.role === "host" && msg.you.token) {
          saveSession({ role: "host", code: msg.state.code, token: msg.you.token });
        } else if (msg.you.role === "player") {
          saveSession({ role: "player", code: msg.state.code, name: p.name });
        }
      }
    };
    ws.onclose = () => {
      setStatus("closed");
      if (stopRef.current) return;
      const n = Math.min(retryRef.current++, 6);
      setTimeout(openSocket, Math.min(8000, 400 * Math.pow(1.7, n)));
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }, []);

  const connect = useCallback((params) => {
    stopRef.current = false;
    retryRef.current = 0;
    paramsRef.current = params;
    setError("");
    openSocket();
  }, [openSocket]);

  const send = useCallback((intent) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(intent));
  }, []);

  const leave = useCallback(() => {
    stopRef.current = true;
    clearSession();
    try { wsRef.current && wsRef.current.close(); } catch {}
    setRoom(null); setMe(null); setBank([]); setStatus("idle"); setError("");
    paramsRef.current = null;
  }, []);

  return { room, me, bank, status, error, setError, connect, send, leave };
}

// ---------- small components ----------
const RoundBadge = ({ round }) => (
  <span className={`round-badge ${ROUND_META[round].badge}`}>{ROUND_META[round].tag}</span>
);
function ModeBadge({ mode }) {
  if (!mode || !MODE_BADGE[mode]) return null;
  const m = MODE_BADGE[mode];
  return (
    <span className={`mode-badge mode-${mode}`}>
      <span className="mode-glyph">{m.glyph}</span>{m.label}
    </span>
  );
}
function SubmissionProgress({ room, compact = false }) {
  const ids = Object.keys(room.teams);
  const total = ids.length;
  if (!total) return null;
  const answered = room.submittedIds.length;
  const remaining = total - answered;
  return (
    <div className="sub-progress">
      <div className="sub-progress-head">
        <span className="mono"><b>{answered}</b>/{total} locked in</span>
        <span className={`sub-progress-status small ${remaining ? "" : "done"}`} aria-live="polite">
          {remaining ? `waiting on ${remaining}` : "everyone's in"}
        </span>
      </div>
      <div className="sub-bar" role="progressbar" aria-valuenow={answered} aria-valuemin={0} aria-valuemax={total}>
        <div className="sub-bar-fill" style={{ width: pct(total ? (answered / total) * 100 : 0) }} />
      </div>
      {!compact && (
        <div className="lobby-teams">
          {ids.map((id) => {
            const inHand = room.submittedIds.includes(id);
            return (
              <span className={`team-chip ${inHand ? "in" : ""}`} key={id}>
                {room.teams[id].name}{inHand ? " ✓" : ""}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
function Countdown({ deadline, compact = false }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return undefined;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [deadline]);
  if (!deadline) return null;
  const secs = Math.max(0, Math.ceil((deadline - now) / 1000));
  const mm = Math.floor(secs / 60);
  const ss = secs % 60;
  const done = secs === 0;
  return (
    <div className={`countdown ${compact ? "compact" : ""} ${done ? "done" : secs <= 10 ? "urgent" : ""}`}
      role="timer" aria-label={done ? "Time's up" : `${secs} seconds left`}>
      <span className="countdown-time mono">{done ? "Time's up" : `${mm}:${String(ss).padStart(2, "0")}`}</span>
    </div>
  );
}
function ConfirmModal({ confirm, onCancel }) {
  if (!confirm) return null;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-text">{confirm.text}</div>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel}>{confirm.cancelLabel || "Cancel"}</button>
          <button className="btn btn-primary" onClick={() => { confirm.onYes(); onCancel(); }}>
            {confirm.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
function Shell({ children, wide }) {
  return (
    <div className="est-root">
      <div className="stars" />
      <div className={`wrap ${wide ? "wide" : ""}`}>{children}</div>
    </div>
  );
}

export default function App() {
  const { room, me, bank, status, error, setError, connect, send, leave } = useRoom();
  const [mode, setMode] = useState("landing"); // landing | game
  const [role, setRole] = useState(null);

  // landing inputs (prefill code from a shared ?code= link)
  const [joinCode, setJoinCode] = useState(() => {
    try { return (new URLSearchParams(location.search).get("code") || "").toUpperCase().slice(0, 4); }
    catch { return ""; }
  });
  const [joinName, setJoinName] = useState("");
  const [copied, setCopied] = useState(false);

  // host compose / reveal
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState("");
  const [answerInput, setAnswerInput] = useState("");
  const [answerYN, setAnswerYN] = useState("");
  const [balanceDrafts, setBalanceDrafts] = useState({});
  const [balanceErr, setBalanceErr] = useState("");
  const [nameDrafts, setNameDrafts] = useState({});
  const [confirm, setConfirm] = useState(null); // { text, confirmLabel, onYes } | null

  // player input
  const [yn, setYn] = useState("");
  const [guessBase, setGuessBase] = useState("");
  const [guessMag, setGuessMag] = useState(0);
  const [wager, setWager] = useState("");
  const [editing, setEditing] = useState(false);
  const [localErr, setLocalErr] = useState("");

  // auto-resume a saved session on first load
  useEffect(() => {
    const s = loadSession();
    if (!s) return;
    setRole(s.role);
    setMode("game");
    connect(s);
  }, [connect]);

  // reset player inputs on new question
  useEffect(() => {
    setYn(""); setGuessBase(""); setGuessMag(0); setWager(""); setEditing(false);
  }, [room?.round, room?.questionIndex]);

  // celebratory haptic on your own reveal (mobile); win = upbeat, loss = single buzz
  useEffect(() => {
    if (role !== "player" || room?.phase !== "revealed" || !me?.teamId) return;
    const r = room.lastResult?.results.find((x) => x.id === me.teamId);
    const cls = r ? OUTCOME[r.outcome]?.cls : null;
    const pattern = cls === "win" ? [25, 40, 25] : cls === "loss" ? [90] : null;
    if (pattern && typeof navigator !== "undefined" && navigator.vibrate) navigator.vibrate(pattern);
  }, [room?.phase, room?.questionIndex, role, me?.teamId]);

  function hostNew() {
    let attempts = 0;
    // If the random code collides with a live room, silently try a new one.
    const mk = () => ({
      role: "host",
      code: genCode(),
      onConflict: (m) => (/already has a host/i.test(m) && attempts++ < 8 ? mk() : null),
    });
    setRole("host");
    setMode("game");
    connect(mk());
  }
  function join() {
    const code = joinCode.trim().toUpperCase();
    if (code.length < 4) return setError("Enter the 4-letter room code.");
    if (!joinName.trim()) return setError("Enter a team name.");
    setRole("player");
    setMode("game");
    connect({ role: "player", code, name: joinName.trim() });
  }
  function quit() { leave(); setRole(null); setMode("landing"); }
  function backToJoin() {
    if (role === "host" && room?.phase === "lobby" && Object.keys(room.teams).length === 0) {
      send({ type: "abandon" });
    }
    quit();
  }
  function updateBalanceDraft(teamId, value) {
    setBalanceDrafts((drafts) => ({ ...drafts, [teamId]: value }));
    setBalanceErr("");
  }
  function saveBalance(teamId, currentBalance) {
    const raw = String(balanceDrafts[teamId] ?? currentBalance ?? 1).trim();
    const parsed = Number(raw);
    const next = Math.floor(parsed);
    if (raw === "" || !Number.isFinite(parsed) || parsed !== next || !Number.isSafeInteger(next) || next < 1) {
      setBalanceErr("Enter a whole-dollar balance of at least $1.");
      return;
    }
    send({ type: "setBalance", teamId, balance: next });
    setBalanceDrafts((drafts) => {
      const copy = { ...drafts };
      delete copy[teamId];
      return copy;
    });
    setBalanceErr("");
  }
  function saveName(teamId) {
    const raw = String(nameDrafts[teamId] ?? "").trim();
    if (!raw) return;
    send({ type: "renameTeam", teamId, name: raw });
    setNameDrafts((drafts) => {
      const copy = { ...drafts };
      delete copy[teamId];
      return copy;
    });
  }

  // ----- LANDING -----
  if (mode === "landing") {
    return (
      <Shell>
        <div className="hero">
          <div className="kicker mono">a wagering game of estimation</div>
          <h1 className="wordmark">Estimathon</h1>
          <p className="tagline">Guess the closest, dodge the wildest miss, and bet your bankroll on how sure you are.</p>
          <div className="cta">
            <div className="join-row">
              <input className="input mono code-in" placeholder="CODE" maxLength={4} aria-label="Room code"
                autoCapitalize="characters" autoComplete="off"
                value={joinCode} onChange={(e) => setJoinCode(e.target.value.toUpperCase())} />
              <input className="input" placeholder="Team name" value={joinName} aria-label="Team name"
                onChange={(e) => setJoinName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && join()} />
              <button className="btn btn-primary" onClick={join}>Join</button>
            </div>
            <button className="btn btn-ghost sm host-secondary" onClick={hostNew}>Host a game</button>
            {error && <div className="err">{error}</div>}
          </div>
          <div className="rules-mini">
            <span>Everyone starts at <b className="mono">$1</b>.</span>
            <span><b>R1 (Yes/No):</b> a correct answer adds <b className="mono">$5</b>.</span>
            <span><b>R2:</b> closest doubles their wager · furthest loses it all.</span>
            <span><b>R3:</b> closest triples · furthest loses half (rounded up).</span>
            <span>You can't be wiped out — balance floors at <b className="mono">$1</b>.</span>
          </div>
        </div>
      </Shell>
    );
  }

  const connecting = !room || status !== "open";
  const ConnBanner = () =>
    status !== "open" ? <div className="conn" role="status" aria-live="polite">{status === "connecting" ? "Connecting…" : "Reconnecting…"}</div> : null;

  if (!room) {
    return (
      <Shell>
        <ConnBanner />
        <div className="panel center wait">
          <div className="orbit" />
          <div className="wait-text">{error ? error : "Connecting…"}</div>
          {(error || role === "host") && (
            <button className="btn btn-ghost" onClick={backToJoin}>
              {role === "host" ? "Back to join" : "Back"}
            </button>
          )}
        </div>
      </Shell>
    );
  }

  const Leaderboard = ({ editable = false }) => {
    const rows = Object.keys(room.teams)
      .map((id) => ({ id, name: room.teams[id].name, balance: room.balances[id] ?? 1 }))
      .sort((a, b) => b.balance - a.balance);
    return (
      <div className="panel lb">
        <div className="lb-title">Standings</div>
        {rows.map((t, i) => (
          <div className={`lb-row ${editable ? "with-edit" : ""} ${i === 0 ? "lead" : ""} ${me && t.id === me.teamId ? "you" : ""}`} key={t.id}>
            <span className="lb-rank">{i + 1}</span>
            <span className="lb-name">{t.name}</span>
            <span className="lb-bal mono">${fmt(t.balance)}</span>
            {editable && (
              <div className="team-admin">
                <div className="admin-line">
                  <input className="input" aria-label={`Rename ${t.name}`} placeholder="Team name"
                    value={nameDrafts[t.id] ?? t.name}
                    onChange={(e) => setNameDrafts((d) => ({ ...d, [t.id]: e.target.value }))}
                    onKeyDown={(e) => e.key === "Enter" && saveName(t.id)} />
                  <button className="btn btn-ghost sm" onClick={() => saveName(t.id)}>Rename</button>
                </div>
                <div className="admin-line">
                  <span className="mono admin-dollar">$</span>
                  <input className="input mono" inputMode="numeric" aria-label={`Balance for ${t.name}`}
                    value={balanceDrafts[t.id] ?? String(t.balance)}
                    onChange={(e) => updateBalanceDraft(t.id, e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveBalance(t.id, t.balance)} />
                  <button className="btn btn-ghost sm" onClick={() => saveBalance(t.id, t.balance)}>Set</button>
                  <button className="btn btn-ghost sm danger" aria-label={`Remove ${t.name}`}
                    onClick={() => setConfirm({
                      text: `Remove ${t.name} from the game? They'll be disconnected and their balance is gone.`,
                      confirmLabel: "Remove team", onYes: () => send({ type: "removeTeam", teamId: t.id }),
                    })}>Remove</button>
                </div>
              </div>
            )}
          </div>
        ))}
        {!rows.length && <div className="muted small">No teams yet.</div>}
        {editable && balanceErr && <div className="err">{balanceErr}</div>}
      </div>
    );
  };

  // Collapsible standings so players can check the board between questions.
  const StandingsPeek = ({ open = false }) => {
    const rows = Object.keys(room.teams)
      .map((id) => ({ id, name: room.teams[id].name, balance: room.balances[id] ?? 1 }))
      .sort((a, b) => b.balance - a.balance);
    if (!rows.length) return null;
    const myRank = me ? rows.findIndex((t) => t.id === me.teamId) + 1 : 0;
    return (
      <details className="panel standings-peek" open={open}>
        <summary>
          <span className="lb-title">Standings</span>
          {myRank > 0 && <span className="peek-rank mono">you're #{myRank} of {rows.length}</span>}
        </summary>
        <div className="peek-list">
          {rows.map((t, i) => (
            <div className={`lb-row ${i === 0 ? "lead" : ""} ${me && t.id === me.teamId ? "you" : ""}`} key={t.id}>
              <span className="lb-rank">{i + 1}</span>
              <span className="lb-name">{t.name}{me && t.id === me.teamId ? " (you)" : ""}</span>
              <span className="lb-bal mono">${fmt(t.balance)}</span>
            </div>
          ))}
        </div>
      </details>
    );
  };

  const Results = ({ lr }) => {
    const sorted = [...lr.results].sort(
      lr.round === 1 ? (a, b) => b.delta - a.delta : (a, b) => (a.dist ?? Infinity) - (b.dist ?? Infinity)
    );
    const guessScale = buildGuessScale(lr);
    return (
      <div className="panel">
        <div className="reveal-answer">
          <span className="muted small">Answer</span>
          <span className="answer-num mono">
            {lr.round === 1 ? (lr.answer === "yes" ? "Yes" : "No") : fmt(lr.answer)}
          </span>
          {lr.round !== 1 && Math.abs(lr.answer) >= 1e6 && <span className="answer-sem">{fmtBig(lr.answer)}</span>}
          <ModeBadge mode={scaleMode(lr.round, lr.answer)} />
          {lr.note && <span className="answer-note">{lr.note}</span>}
        </div>
        {guessScale && (
          <div className={`guess-scale ${guessScale.mode === "ratio" ? "log" : "linear"}`} style={{ "--lanes": guessScale.lanes }}>
            <div className="scale-head">
              <span>Guess scale</span>
              <span>{guessScale.mode === "ratio" ? "Logarithmic" : "Linear"}</span>
            </div>
            <div className="scale-track" aria-label={`${guessScale.mode === "ratio" ? "Logarithmic" : "Linear"} scale of player guesses against the actual answer`}>
              <div className="scale-line" />
              <div className="actual-marker" style={{ left: pct(guessScale.answerPos) }}>
                <span className="actual-dot" />
                <span className="actual-label mono">Actual</span>
              </div>
              {guessScale.players.map((p) => (
                <div className={`player-marker ${OUTCOME[p.outcome].cls} ${p.pos < 12 ? "edge-left" : p.pos > 88 ? "edge-right" : ""}`}
                  key={p.id} style={{ left: pct(p.pos), "--lane": p.lane }} title={`${p.name}: ${fmt(p.guess)}`}>
                  <span className="player-dot" />
                  <span className="player-label">{p.name}</span>
                </div>
              ))}
            </div>
            <div className="scale-axis mono">
              <span>{guessScale.minLabel}</span>
              <span>{guessScale.maxLabel}</span>
            </div>
          </div>
        )}
        <div className="res-list">
          {sorted.map((r) => (
            <div className={`res-row ${OUTCOME[r.outcome].cls}`} key={r.id}>
              <div className="res-main">
                <span className="res-name">{r.name}</span>
                <span className={`tag ${OUTCOME[r.outcome].cls}`}>{OUTCOME[r.outcome].label}</span>
              </div>
              <div className="res-meta mono">
                {lr.round === 1
                  ? r.yn ? `answered ${r.yn === "yes" ? "Yes" : "No"}` : "no answer"
                  : `guess ${r.guess != null ? fmt(r.guess) : "—"} · wager $${fmt(r.wager || 0)}`}
              </div>
              <div className="res-delta mono">
                <span className={r.delta > 0 ? "up" : r.delta < 0 ? "down" : "flat"}>
                  {r.delta > 0 ? "+" : ""}{r.delta === 0 ? "±0" : `$${fmt(r.delta)}`}
                </span>
                <span className="arrow">→</span>
                <span className="newbal">${fmt(r.balance)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const FinalScreen = () => {
    const rows = Object.keys(room.teams)
      .map((id) => ({ id, name: room.teams[id].name, balance: room.balances[id] ?? 1 }))
      .sort((a, b) => b.balance - a.balance);
    return (
      <div className="panel center final">
        <div className="kicker mono">final standings</div>
        {rows[0] && <div className="winner">🏆 {rows[0].name}</div>}
        <div className="final-list">
          {rows.map((t, i) => (
            <div className={`lb-row ${i === 0 ? "lead" : ""} ${me && t.id === me.teamId ? "you" : ""}`} key={t.id}>
              <span className="lb-rank">{i + 1}</span>
              <span className="lb-name">{t.name}{me && t.id === me.teamId ? " (you)" : ""}</span>
              <span className="lb-bal mono">${fmt(t.balance)}</span>
            </div>
          ))}
        </div>
        {Array.isArray(room.history) && room.history.length > 0 && (
          <details className="recap">
            <summary><span className="lb-title">Game recap</span><span className="muted small">{room.history.length} questions</span></summary>
            <div className="recap-list">
              {room.history.map((h, i) => (
                <div className="recap-row" key={i}>
                  <div className="recap-q">
                    <span className={`round-badge ${ROUND_META[h.round].badge}`}>R{h.round}</span>
                    <span className="recap-qtext">{h.questionText}</span>
                  </div>
                  <div className="recap-meta mono">
                    <span className="muted">answer</span>{" "}
                    {h.round === 1 ? (h.answer === "yes" ? "Yes" : "No") : fmt(h.answer)}
                    {h.winners && h.winners.length > 0 && (
                      <span className="recap-win"> · {h.round === 1 ? "✓" : "🎯"} {h.winners.join(", ")}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </details>
        )}
        <button className="btn btn-ghost" onClick={quit}>New game</button>
      </div>
    );
  };

  // ----- HOST -----
  if (role === "host") {
    const liveCurrent = bank.find((b) => b.id === room.questionId);
    const presetCurrent = room.questionId && liveCurrent && !liveCurrent.live;
    const teamIds = Object.keys(room.teams);
    return (
      <Shell wide>
        <ConnBanner />
        <div className="topbar">
          <span className="wordmark sm">Estimathon</span>
          <div className="topbar-right">
            <span className={`round-badge ${ROUND_META[room.round].badge}`}>Round {room.round}</span>
            <span className="code-chip mono">{room.code}</span>
          </div>
        </div>
        <div className="grid">
          <div className="col-main">
            {room.phase === "lobby" && (
              <div className="panel">
                <div className="join-big">
                  <span className="muted small">Room code — players join with this</span>
                  <div className="bigcode mono">{room.code}</div>
                </div>
                <div className="join-share">
                  {qrDataUrl(joinUrl(room.code)) && (
                    <img className="join-qr" src={qrDataUrl(joinUrl(room.code))} alt={`QR code to join room ${room.code}`} width="160" height="160" />
                  )}
                  <div className="join-share-side">
                    <span className="muted small">Scan to join, or share the link:</span>
                    <button className="btn btn-ghost sm" onClick={() => {
                      const url = joinUrl(room.code);
                      const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1600); };
                      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(url).then(done).catch(done);
                      else done();
                    }}>{copied ? "Link copied ✓" : "Copy invite link"}</button>
                  </div>
                </div>
                <div className="lobby-teams">
                  {teamIds.map((id) => (<span className="team-chip in" key={id}>{room.teams[id].name}</span>))}
                  {!teamIds.length && <span className="muted small">Waiting for teams to join…</span>}
                </div>
                <button className="btn btn-primary wide" disabled={!teamIds.length} onClick={() => send({ type: "start" })}>
                  Start game ({teamIds.length} {teamIds.length === 1 ? "team" : "teams"})
                </button>
                {!teamIds.length && (
                  <button className="btn btn-ghost sm lobby-back" onClick={backToJoin}>
                    Back to join a game
                  </button>
                )}
              </div>
            )}

            {room.phase === "setup" && (
              <div className="panel">
                <div className="panel-head">
                  <span className="step">Question {room.questionIndex + 1}</span>
                  <RoundBadge round={room.round} />
                </div>
                <div className="qbank">
                  {bank.map((bq) => {
                    const used = (room.usedIds || []).includes(bq.id);
                    return (
                      <button key={bq.id} className={`qcard ${selectedId === bq.id ? "sel" : ""} ${used ? "used" : ""}`}
                        onClick={() => { setSelectedId(bq.id); setDraft(bq.text); }}>
                        <span className="qcard-text">{bq.text}</span>
                        <span className="qcard-tags">
                          {used && <span className="qtag done">used ✓</span>}
                          {bq.live && <span className="qtag live">live</span>}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <details className="custom-q">
                  <summary>Or write a custom question</summary>
                  <textarea className="input" rows={2} placeholder="Type a question…"
                    value={selectedId ? "" : draft}
                    onChange={(e) => { setSelectedId(""); setDraft(e.target.value); }} />
                </details>
                <button className="btn btn-primary wide" disabled={!draft.trim()}
                  onClick={() => { send({ type: "open", questionId: selectedId || null, questionText: draft }); setSelectedId(""); setDraft(""); }}>
                  Open question to players
                </button>
                <div className="row-between">
                  <div className="round-toggle">
                    {[1, 2, 3].map((r) => (
                      <button key={r} className={room.round === r ? "on" : ""} onClick={() => { send({ type: "setRound", round: r }); setSelectedId(""); setDraft(""); }}>R{r}</button>
                    ))}
                  </div>
                  <button className="btn btn-ghost sm" onClick={() => setConfirm({
                    text: "End the game for everyone? This jumps straight to the final standings and can't be undone.",
                    confirmLabel: "End game", onYes: () => send({ type: "end" }),
                  })}>End game</button>
                </div>
              </div>
            )}

            {room.phase === "open" && (
              <div className="panel">
                <div className="panel-head">
                  <span className="step">Question {room.questionIndex}</span>
                  <div className="badge-row"><RoundBadge round={room.round} /><ModeBadge mode={room.currentMode} /></div>
                </div>
                <div className="qtext">{room.questionText}</div>
                <Countdown deadline={room.deadline} />
                <div className="timer-controls">
                  <span className="muted small">Timer</span>
                  {TIMER_PRESETS.map((t) => (
                    <button key={t.secs} className="timer-btn" onClick={() => send({ type: "timer", seconds: t.secs })}>
                      {t.label}
                    </button>
                  ))}
                  {room.deadline && (
                    <button className="timer-btn off" onClick={() => send({ type: "stopTimer" })}>Stop</button>
                  )}
                </div>
                <SubmissionProgress room={room} />
                <button className="btn btn-primary wide" onClick={() => send({ type: "lock" })}>Lock submissions</button>
              </div>
            )}

            {room.phase === "locked" && (
              <div className="panel">
                <div className="panel-head">
                  <span className="step">Question {room.questionIndex}</span>
                  <div className="badge-row"><RoundBadge round={room.round} /><ModeBadge mode={room.currentMode} /></div>
                </div>
                <div className="qtext">{room.questionText}</div>
                {room.round === 1 && !presetCurrent && (
                  <>
                    <span className="muted small">Set the correct answer</span>
                    <div className="yn-row">
                      <button className={`yn-btn ${answerYN === "yes" ? "on yes" : ""}`} onClick={() => setAnswerYN("yes")}>Yes</button>
                      <button className={`yn-btn ${answerYN === "no" ? "on no" : ""}`} onClick={() => setAnswerYN("no")}>No</button>
                    </div>
                  </>
                )}
                {room.round !== 1 && !presetCurrent && (
                  <>
                    <span className="muted small">Enter the actual answer</span>
                    <input className="input mono" placeholder="a number" value={answerInput}
                      onChange={(e) => setAnswerInput(e.target.value)} />
                  </>
                )}
                {presetCurrent && <div className="muted small">Answer is preset — hit reveal when the room is ready.</div>}
                <button className="btn btn-primary wide"
                  onClick={() => {
                    const intent = { type: "reveal" };
                    if (room.round === 1 && !presetCurrent) intent.answer = answerYN;
                    if (room.round !== 1 && !presetCurrent) intent.answer = answerInput;
                    send(intent);
                    setAnswerInput(""); setAnswerYN("");
                  }}>
                  Reveal &amp; score
                </button>
              </div>
            )}

            {room.phase === "revealed" && room.lastResult && (
              <>
                <div className="qtext-sm">{room.lastResult.questionText}</div>
                <Results lr={room.lastResult} />
                <button className="link-btn" onClick={() => send({ type: "undoReveal" })}>
                  ↩ Undo reveal — fix the answer &amp; re-score
                </button>
                <div className="row-between">
                  <button className="btn btn-primary" onClick={() => send({ type: "next" })}>Next question</button>
                  <div className="round-toggle">
                    {[1, 2, 3].map((r) => (
                      <button key={r} className={room.round === r ? "on" : ""} onClick={() => send({ type: "setRound", round: r })}>R{r}</button>
                    ))}
                  </div>
                  <button className="btn btn-ghost sm" onClick={() => setConfirm({
                    text: "End the game for everyone? This jumps straight to the final standings and can't be undone.",
                    confirmLabel: "End game", onYes: () => send({ type: "end" }),
                  })}>End game</button>
                </div>
              </>
            )}

            {room.phase === "ended" && <FinalScreen />}
          </div>
          <div className="col-side"><Leaderboard editable /></div>
        </div>
        <ConfirmModal confirm={confirm} onCancel={() => setConfirm(null)} />
      </Shell>
    );
  }

  // ----- PLAYER -----
  const bal = me && me.teamId ? room.balances[me.teamId] ?? 1 : 1;
  const myName = me && me.teamId && room.teams[me.teamId] ? room.teams[me.teamId].name : joinName;
  const mineResult = room.lastResult ? room.lastResult.results.find((r) => me && r.id === me.teamId) : null;
  const submitted = !!(me && me.mySubmission);
  const preview = guessBase ? fmt(Number(guessBase) * (MAGS[guessMag]?.value || 1)) : "—";

  function startEdit() {
    const s = me.mySubmission;
    if (s) {
      if (room.round === 1) setYn(s.yn || "");
      else { setGuessBase(String(s.guessBase ?? "")); setGuessMag(magIndex(s.guessMag || "")); setWager(String(s.wager ?? "")); }
    }
    setEditing(true);
  }
  function submit() {
    if (room.round === 1) {
      if (yn !== "yes" && yn !== "no") return setLocalErr("Pick Yes or No.");
      send({ type: "submit", submission: { yn } });
    } else {
      const b = Number(guessBase), w = Math.floor(Number(wager)), mag = MAGS[guessMag] || MAGS[0];
      if (guessBase === "" || !Number.isFinite(b) || b < 1 || b >= 1000) return setLocalErr("Guess must be 1–999 — use the magnitude buttons for big numbers.");
      if (wager === "" || !Number.isFinite(w) || w < 0) return setLocalErr("Wager must be 0 or more.");
      if (w > bal) return setLocalErr(`You only have $${bal} to wager.`);
      send({ type: "submit", submission: { guess: b * mag.value, guessBase: b, guessMag: mag.word, wager: w } });
    }
    setEditing(false); setLocalErr("");
  }

  return (
    <Shell>
      <ConnBanner />
      <div className="player-top">
        <span className="team-tag">{myName}</span>
        <span className="bal-chip mono">${fmt(bal)}</span>
      </div>

      {(room.phase === "lobby" || room.phase === "setup") && (
        <>
          <div className="panel center wait">
            <div className="orbit" />
            <div className="wait-text">{room.phase === "lobby" ? "You're in. Waiting for the host to start…" : "Get ready — next question incoming…"}</div>
          </div>
          {room.phase === "setup" && <StandingsPeek open />}
        </>
      )}

      {room.phase === "open" && (
        submitted && !editing ? (
          <>
          <div className="panel center wait">
            <div className="locked-check">✓</div>
            <div className="wait-text">Locked in</div>
            <Countdown deadline={room.deadline} />
            <div className="muted mono">
              {room.round === 1
                ? `answered ${me.mySubmission.yn === "yes" ? "Yes" : "No"}`
                : `guess ${fmt(me.mySubmission.guess)} · wager $${fmt(me.mySubmission.wager)}`}
            </div>
            <button className="btn btn-ghost" onClick={startEdit}>Change my answer</button>
            <div className="muted small">You can edit until the host locks submissions.</div>
            <SubmissionProgress room={room} />
          </div>
          <StandingsPeek />
          </>
        ) : (
          <div className="panel">
            <div className="panel-head">
              <div className="badge-row"><RoundBadge round={room.round} /><ModeBadge mode={room.currentMode} /></div>
              {submitted && <span className="tag mid">editing</span>}
            </div>
            <div className="qtext">{room.questionText}</div>
            <Countdown deadline={room.deadline} compact />
            {room.round === 1 ? (
              <div className="yn-row big">
                <button className={`yn-btn ${yn === "yes" ? "on yes" : ""}`} onClick={() => setYn("yes")}>Yes</button>
                <button className={`yn-btn ${yn === "no" ? "on no" : ""}`} onClick={() => setYn("no")}>No</button>
              </div>
            ) : (
              <>
                <label className="lbl">Your guess</label>
                <input className="input mono" inputMode="decimal" placeholder="1–999"
                  value={guessBase} onChange={(e) => setGuessBase(e.target.value)} />
                <div className="mag-stepper">
                  <button type="button" onClick={() => setGuessMag((m) => Math.max(0, m - 1))} disabled={guessMag === 0}>−</button>
                  <div className="mag-label">{MAGS[guessMag].word || "ones"}</div>
                  <button type="button" onClick={() => setGuessMag((m) => Math.min(MAGS.length - 1, m + 1))} disabled={guessMag === MAGS.length - 1}>+</button>
                </div>
                <div className="guess-preview mono">= {preview}</div>
                <label className="lbl">Wager <span className="muted">($0–{bal})</span></label>
                <input className="input mono" inputMode="numeric" placeholder="0"
                  value={wager} onChange={(e) => setWager(e.target.value)} />
                <div className="wager-quick">
                  <button onClick={() => setWager(String(bal))}>All in (${bal})</button>
                  <button onClick={() => setWager(String(Math.floor(bal / 2)))}>Half</button>
                  <button onClick={() => setWager("0")}>Skip ($0)</button>
                </div>
              </>
            )}
            <button className="btn btn-primary wide" disabled={room.round === 1 ? !yn : !guessBase} onClick={submit}>
              {submitted ? "Update answer" : "Lock it in"}
            </button>
            {submitted && <button className="link-btn" onClick={() => setEditing(false)}>Cancel — keep my locked answer</button>}
            {localErr && <div className="err">{localErr}</div>}
            <SubmissionProgress room={room} compact />
            {room.round !== 1 && <StandingsPeek />}
          </div>
        )
      )}

      {room.phase === "locked" && (
        <>
          <div className="panel center wait">
            <div className="wait-text">Locked. Waiting for the reveal…</div>
            <SubmissionProgress room={room} />
          </div>
          <StandingsPeek />
        </>
      )}

      {room.phase === "revealed" && room.lastResult && (
        <>
          {mineResult && (
            <div className={`panel my-result ${OUTCOME[mineResult.outcome].cls}`}>
              <span className={`tag ${OUTCOME[mineResult.outcome].cls}`}>{OUTCOME[mineResult.outcome].label}</span>
              <div className="my-answer mono">
                {room.lastResult.round === 1
                  ? `answer: ${room.lastResult.answer === "yes" ? "Yes" : "No"}`
                  : `answer: ${fmt(room.lastResult.answer)}`}
              </div>
              <ModeBadge mode={scaleMode(room.lastResult.round, room.lastResult.answer)} />
              <div className="my-delta mono">
                <span className={mineResult.delta > 0 ? "up" : mineResult.delta < 0 ? "down" : "flat"}>
                  {mineResult.delta > 0 ? "+" : ""}{mineResult.delta === 0 ? "±0" : `$${fmt(mineResult.delta)}`}
                </span>
                <span className="arrow">→</span>
                <span className="newbal">${fmt(mineResult.balance)}</span>
              </div>
            </div>
          )}
          {room.lastResult.note && <div className="panel note-panel">{room.lastResult.note}</div>}
          <Leaderboard />
        </>
      )}

      {room.phase === "ended" && <FinalScreen />}
    </Shell>
  );
}
