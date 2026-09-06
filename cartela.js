const COLUMN_RANGES = {
  B: [1, 15],
  I: [16, 30],
  N: [31, 45],
  G: [46, 60],
  O: [61, 75],
};

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const SEED_BASE = 20240101;

function getCard(cartelaNumber) {
  const rng = mulberry32(SEED_BASE + cartelaNumber);
  const card = {};
  for (const col of Object.keys(COLUMN_RANGES)) {
    const [low, high] = COLUMN_RANGES[col];
    const pool = [];
    for (let n = low; n <= high; n++) pool.push(n);
    card[col] = shuffle(pool, rng).slice(0, 5);
  }
  card.N[2] = "FREE";
  return card;
}

function hasBingo(cartelaNumber, calledSet) {
  const card = getCard(cartelaNumber);
  const cols = ["B", "I", "N", "G", "O"];
  const isMarked = (col, val) => val === "FREE" || calledSet.has(val);

  for (let r = 0; r < 5; r++) {
    if (cols.every((c) => isMarked(c, card[c][r]))) return true;
  }
  for (const c of cols) {
    if (card[c].every((v) => isMarked(c, v))) return true;
  }
  if (cols.every((c, i) => isMarked(c, card[c][i]))) return true;
  if (cols.every((c, i) => isMarked(c, card[c][4 - i]))) return true;
  const corners = [
    [cols[0], card[cols[0]][0]],
    [cols[0], card[cols[0]][4]],
    [cols[4], card[cols[4]][0]],
    [cols[4], card[cols[4]][4]],
  ];
  if (corners.every(([c, v]) => isMarked(c, v))) return true;

  return false;
}

module.exports = { getCard, hasBingo };
