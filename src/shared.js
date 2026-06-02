// Shared, answer-free helpers used by BOTH the client bundle and the Worker.
// Anything secret (the answer key, scoring) lives in bank.js, which the client never imports.

export const RATIO_MIN = 1000;

export const MAGS = [
  { word: "", value: 1 },
  { word: "thousand", value: 1e3 },
  { word: "million", value: 1e6 },
  { word: "billion", value: 1e9 },
  { word: "trillion", value: 1e12 },
  { word: "quadrillion", value: 1e15 },
  { word: "quintillion", value: 1e18 },
  { word: "sextillion", value: 1e21 },
  { word: "septillion", value: 1e24 },
  { word: "octillion", value: 1e27 },
  { word: "nonillion", value: 1e30 },
];

export const fmt = (n) =>
  n == null || Number.isNaN(n) ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 4 });

const MAG_ABBREVIATIONS = {
  thousand: "K",
  million: "M",
  billion: "B",
  trillion: "T",
  quadrillion: "Qa",
  quintillion: "Qi",
  sextillion: "Sx",
  septillion: "Sp",
  octillion: "O",
  nonillion: "N",
};

const fmtSig = (n) =>
  n.toLocaleString("en-US", { maximumSignificantDigits: 3 });

export function fmtBig(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs < 1e3) return fmtSig(n);

  let magIndex = 0;
  for (let i = 0; i < MAGS.length; i += 1) {
    if (abs >= MAGS[i].value) magIndex = i;
  }

  // If significant-digit rounding would show 1000 of the current unit,
  // promote to the next magnitude instead (e.g. 999,500 -> 1M).
  const roundedAtMagnitude = (index) => Number((n / MAGS[index].value).toPrecision(3));
  while (
    magIndex < MAGS.length - 1 &&
    Math.abs(roundedAtMagnitude(magIndex)) >= 1000
  ) {
    magIndex += 1;
  }

  const mag = MAGS[magIndex];
  return `${fmtSig(n / mag.value)}${MAG_ABBREVIATIONS[mag.word] || mag.word}`;
}

// scale-aware proximity: absolute for small answers, orders of magnitude for big ones
export function proxDist(guess, answer) {
  if (Math.abs(answer) >= RATIO_MIN && guess > 0 && answer > 0) {
    return Math.abs(Math.log10(guess) - Math.log10(answer));
  }
  return Math.abs(guess - answer);
}

// "live" = answer set at reveal; null = round 1 (yes/no, no proximity)
export function scaleMode(round, answer) {
  if (round === 1) return null;
  if (answer == null) return "live";
  return Math.abs(answer) >= RATIO_MIN ? "ratio" : "absolute";
}

export const MODE_BADGE = {
  absolute: { glyph: "Δ", label: "closest by value" },
  ratio: { glyph: "×10ⁿ", label: "closest by magnitude" },
  live: { glyph: "~", label: "scale set at reveal" },
};

export const ROUND_META = {
  1: { tag: "Round 1 · Yes/No · +$5", badge: "r1" },
  2: { tag: "Round 2 · Wager ×2 / lose all", badge: "r2" },
  3: { tag: "Round 3 · Wager ×3 / lose half", badge: "r3" },
};

export const OUTCOME = {
  closest: { label: "Closest", cls: "win" },
  furthest: { label: "Furthest", cls: "loss" },
  middle: { label: "Middle", cls: "mid" },
  correct: { label: "Correct", cls: "win" },
  wrong: { label: "Wrong", cls: "loss" },
  satout: { label: "No answer", cls: "out" },
};

const ALPHA = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const genCode = () =>
  Array.from({ length: 4 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join("");
export const normId = (n) => n.trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 40);
