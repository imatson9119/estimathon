// SERVER ONLY. Imported by the Worker, never by the client bundle, so answers
// never reach the browser until reveal.
import { proxDist } from "./shared.js";

export const BANK = {
  1: [
    { id: "r1-hair", text: "If every human hair was laid end to end, would it reach Pluto?", answer: "yes", note: "Yes — it would actually reach 50–80× farther than Pluto." },
    { id: "r1-pets", text: "Are there more dogs than cats in the US?", answer: "yes", note: "Yes — about 87.3M dogs vs 76.3M cats." },
    { id: "r1-gallon", text: "Is a gallon of water more than ten pounds?", answer: "no", note: "No — a US gallon of water weighs about 8.3 lbs." },
    { id: "r1-pacific", text: "Is the Pacific Ocean larger than all the land on Earth combined?", answer: "yes", note: "Yes — the Pacific covers 155M+ km² (NOAA), more than all continents combined." },
    { id: "r1-elon", text: "Does Elon Musk have more followers than Donald Trump on X?", answer: "yes", note: "Yes — over double (≈240M vs ≈115M)." },
    { id: "r1-colorado", text: "Would Colorado's population outnumber everyone who voted third-party in 2024?", answer: "yes", note: "Yes — ≈2.9M voted third party vs ≈6M Coloradans." },
    { id: "r1-apples", text: "Does the US import more apples than oranges (by weight)?", answer: "no", note: "No — the US imports more oranges than apples by weight." },
    { id: "r1-ed", text: "If you stacked every Ed Sheeran concertgoer (no repeats) head to toe, would they reach the Moon?", answer: "no", note: "No — even at 6 ft each, the stack falls well short of the Moon." },
  ],
  2: [
    { id: "r2-battery", text: "Average battery percentage of everyone in this room?", answer: null },
    { id: "r2-cousins", text: "How many cousins do we all have, combined?", answer: null },
    { id: "r2-apps", text: "Smallest number of apps installed on a phone in the room?", answer: null },
    { id: "r2-steps", text: "Steps from the middle of the living room to the street?", answer: null },
    { id: "r2-forks", text: "How many forks are in the silverware drawer?", answer: null },
    { id: "r2-green", text: "What percentage of US cars are colored green?", answer: 4 },
    { id: "r2-bball", text: "Circumference of a standard men's size 7 basketball, in inches?", answer: 29.5 },
    { id: "r2-dropper", text: "How many drops from a standard medical dropper to fill a gallon?", answer: 75700 },
    { id: "r2-texas", text: "How many times could Texas fit into Russia?", answer: 24.43 },
    { id: "r2-dfw", text: "How many flights take off from DFW daily?", answer: 1018 },
  ],
  3: [
    { id: "r3-iss", text: "Seconds to hit the ground falling from ISS height (with air resistance, no rotational velocity)?", answer: 574 },
    { id: "r3-moon", text: "Surface area of the Moon, in square miles?", answer: 14600000 },
    { id: "r3-sand", text: "How many grains of sand are on Earth?", answer: 7.5e18 },
    { id: "r3-plumbers", text: "How many plumbers were in the state of Texas in 2024?", answer: 504500 },
    { id: "r3-precip", text: "Precipitation the world receives in a year, in US gallons?", answer: 130e15 },
    { id: "r3-sea", text: "How many US gallons would it take to raise the sea level by one inch?", answer: 2.43e15 },
    { id: "r3-tweets", text: "How many tweets are posted per day?", answer: 550e6 },
    { id: "r3-taylor", text: "What is Taylor Swift's current net worth, in USD?", answer: 2e9 },
    { id: "r3-texted", text: "How many words have Emma and I texted each other?", answer: 223702 },
    { id: "r3-lake", text: "How many gallons of water are in Lake Grapevine?", answer: 59e9 },
  ],
};

export const findQ = (round, id) => (BANK[round] || []).find((q) => q.id === id) || null;

// Round 1: +$5 for a correct yes/no. Rounds 2/3: closest/furthest wager scoring with a $1 floor.
export function scoreRound(round, teams, balances, subs, answer) {
  const newBal = { ...balances };
  const ids = Object.keys(teams);

  if (round === 1) {
    const results = ids.map((id) => {
      const s = subs[id];
      const yn = s && s.yn ? s.yn : null;
      const start = newBal[id] ?? 1;
      let outcome = "satout", delta = 0;
      if (yn != null) {
        const correct = yn === answer;
        outcome = correct ? "correct" : "wrong";
        delta = correct ? 5 : 0;
      }
      newBal[id] = start + delta;
      return { id, name: teams[id].name, yn, outcome, delta, balance: newBal[id] };
    });
    return { balances: newBal, results };
  }

  const entries = ids.map((id) => {
    const s = subs[id];
    const wager = s ? Math.max(0, Math.floor(Number(s.wager) || 0)) : 0;
    const guess = s && s.guess != null && Number.isFinite(Number(s.guess)) ? Number(s.guess) : null;
    const valid = wager > 0 && guess != null;
    return { id, name: teams[id].name, guess, wager, dist: valid ? proxDist(guess, answer) : null };
  });
  const wagering = entries.filter((e) => e.dist != null);
  let minD = null, maxD = null;
  if (wagering.length) {
    minD = Math.min(...wagering.map((e) => e.dist));
    maxD = Math.max(...wagering.map((e) => e.dist));
  }
  const results = entries.map((e) => {
    const start = newBal[e.id] ?? 1;
    let outcome = "satout", payout = 0;
    if (e.dist != null) {
      const isClosest = e.dist === minD;
      const isFurthest = e.dist === maxD;
      const allTie = minD === maxD;
      if (isClosest || allTie) {
        outcome = "closest";
        payout = round === 2 ? e.wager * 2 : e.wager * 3;
      } else if (isFurthest) {
        outcome = "furthest";
        payout = round === 2 ? 0 : e.wager - Math.ceil(e.wager / 2);
      } else {
        outcome = "middle";
        payout = e.wager;
      }
      const nb = Math.max(1, start - e.wager + payout);
      newBal[e.id] = nb;
      return { ...e, outcome, payout, delta: nb - start, balance: nb };
    }
    return { ...e, outcome, payout: 0, delta: 0, balance: start };
  });
  return { balances: newBal, results };
}
