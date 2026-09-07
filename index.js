const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
const { getCard, hasBingo } = require("./cartela");

const serviceAccountJson = Buffer.from(
  process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || "",
  "base64"
).toString("utf8");

if (!serviceAccountJson) {
  console.error("FIREBASE_SERVICE_ACCOUNT_BASE64 is not set. See README.md.");
  process.exit(1);}

const parsedServiceAccount = JSON.parse(serviceAccountJson);
console.log("SERVICE ACCOUNT project_id:", parsedServiceAccount.project_id);
console.log("DATABASE_URL env:", process.env.FIREBASE_DATABASE_URL);

admin.initializeApp({
  credential: admin.credential.cert(parsedServiceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});



const db = admin.database();
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const HOUSE_CUT = 0.2;
const CALL_INTERVAL_MS = 3000;

const app = express();
app.use(cors());
app.use(express.json());

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!idToken) return res.status(401).json({ error: "Missing Authorization header" });
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.uid = decoded.uid;
    next();
  } catch (e) {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

app.post("/verify-telegram-login", async (req, res) => {
  try {
    const { initData } = req.body;
    if (!initData) return res.status(400).json({ error: "initData required" });
    if (!TELEGRAM_BOT_TOKEN) return res.status(500).json({ error: "Bot token not configured" });

    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");

    const dataCheckString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");

    const secretKey = crypto.createHmac("sha256", "WebAppData").update(TELEGRAM_BOT_TOKEN).digest();
    const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

    if (computedHash !== hash) {
      return res.status(403).json({ error: "Invalid Telegram signature" });
    }

    const authDate = Number(params.get("auth_date") || 0);
    const ageSeconds = Date.now() / 1000 - authDate;
    if (ageSeconds > 300) {
      return res.status(403).json({ error: "initData expired, reopen the app" });
    }

    const user = JSON.parse(params.get("user"));
    const uid = `tg_${user.id}`;

    const userRef = db.ref(`users/${uid}`);
    const snapshot = await userRef.once("value");
    if (!snapshot.exists()) {
      await userRef.set({
        balance: 0,
        referrals: 0,
        cards: 0,
        name: user.first_name || "Player",
        telegramId: user.id,
        createdAt: admin.database.ServerValue.TIMESTAMP,
      });
    }

    const customToken = await admin.auth().createCustomToken(uid);
    res.json({ customToken, uid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/join-room", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { stake, cartelaNumber } = req.body;
    if (!Number.isInteger(stake) || stake <= 0) {
      return res.status(400).json({ error: "bad stake" });
    }
    if (!Number.isInteger(cartelaNumber) || cartelaNumber < 1 || cartelaNumber > 100) {
      return res.status(400).json({ error: "bad cartela number" });
    }

    const roomId = `stake_${stake}_open`;
    const roomRef = db.ref(`rooms/${roomId}`);
    const balanceRef = db.ref(`users/${uid}/balance`);
console.log("join-room: uid=", uid, "stake=", stake, "cartela=", cartelaNumber);await balanceRef.once("value");
    const balanceResult = await balanceRef.transaction((current) => {
      console.log("current balance value:", current, typeof current);
      current = current || 0;
      if (current < stake) return;
      return current - stake;
    });
    console.log("transaction committed?", balanceResult.committed);
    if (!balanceResult.committed) {
      return res.status(412).json({ error: "Insufficient balance" });
    }
    
    

    const joinResult = await roomRef.transaction((room) => {
      room = room || { stake, state: "waiting", players: {}, taken: {} };
      if (room.state !== "waiting") return;
      if (room.taken && room.taken[cartelaNumber]) return;
      room.players = room.players || {};
      room.taken = room.taken || {};
      room.players[uid] = { cartelaNumber, joinedAt: Date.now() };
      room.taken[cartelaNumber] = true;
      return room;
    });

    if (!joinResult.committed) {
      await balanceRef.transaction((current) => (current || 0) + stake);
      return res.status(412).json({ error: "Could not join room (cartela taken or room started)" });
    }

    const room = joinResult.snapshot.val();
    const playerCount = Object.keys(room.players).length;

    if (playerCount >= 2 && room.state === "waiting") {
      await roomRef.child("state").set("running");
      await roomRef.child("startedAt").set(admin.database.ServerValue.TIMESTAMP);
      await roomRef.child("calledNumbers").set({});
    }

    res.json({ roomId, playerCount, yourCard: getCard(cartelaNumber) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post("/claim-bingo", requireAuth, async (req, res) => {
  try {
    const uid = req.uid;
    const { roomId } = req.body;
    const roomRef = db.ref(`rooms/${roomId}`);
    const roomSnap = await roomRef.once("value");
    const room = roomSnap.val();
    if (!room) return res.status(404).json({ error: "Room not found" });
    if (room.state !== "running") return res.status(412).json({ error: "Room not active" });

    const player = room.players?.[uid];
    if (!player) return res.status(403).json({ error: "You are not in this room" });

    const calledSet = new Set(Object.keys(room.calledNumbers || {}).map(Number));
    const win = hasBingo(player.cartelaNumber, calledSet);
    if (!win) return res.status(412).json({ error: "No BINGO on your card yet" });

    const playerCount = Object.keys(room.players).length;
    const gross = room.stake * playerCount;
    const prize = Math.floor(gross * (1 - HOUSE_CUT));

    await roomRef.child("state").set("finished");
    await roomRef.child("winner").set(uid);
    await roomRef.child("prize").set(prize);
    await db.ref(`users/${uid}/balance`).transaction((current) => (current || 0) + prize);

    res.json({ won: true, prize });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

async function advanceAllRooms() {
  try {
    const roomsSnap = await db.ref("rooms").orderByChild("state").equalTo("running").once("value");
    const rooms = roomsSnap.val() || {};

    for (const [roomId, room] of Object.entries(rooms)) {
      const called = Object.keys(room.calledNumbers || {}).map(Number);
      const remaining = [];
      for (let n = 1; n <= 75; n++) if (!called.includes(n)) remaining.push(n);
      if (remaining.length === 0) {
        await db.ref(`rooms/${roomId}/state`).set("finished");
        continue;
      }
      const next = remaining[Math.floor(Math.random() * remaining.length)];
      await db.ref(`rooms/${roomId}/calledNumbers/${next}`).set(true);
      await db.ref(`rooms/${roomId}/lastCalled`).set(next);
    }
  } catch (e) {
    console.error("advanceAllRooms error:", e);
  }
}
setInterval(advanceAllRooms, CALL_INTERVAL_MS);

app.get("/", (req, res) => res.send("World Bingo backend is running."));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
