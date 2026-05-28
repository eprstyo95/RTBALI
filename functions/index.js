"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const vision = require("@google-cloud/vision");

admin.initializeApp();

const db = admin.firestore();
const bucket = admin.storage().bucket(process.env.RTBALI_STORAGE_BUCKET || undefined);
const visionClient = new vision.ImageAnnotatorClient();

const TRIP_ID = process.env.RTBALI_TRIP_ID || "rtbali";
const LINK_CODE = process.env.RTBALI_LINK_CODE || "";
const SYNC_KEY = process.env.RTBALI_SYNC_KEY || "";
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const ALLOWED_CHAT_ID = process.env.RTBALI_ALLOWED_CHAT_ID || "";

const CATEGORY_ALIASES = {
  meal: "Food & Drinks",
  food: "Food & Drinks",
  makan: "Food & Drinks",
  lunch: "Food & Drinks",
  dinner: "Food & Drinks",
  breakfast: "Food & Drinks",
  fuel: "Fuel/Diesel",
  diesel: "Fuel/Diesel",
  toll: "Toll/e-Money",
  ferry: "Ferry",
  hotel: "Hotel",
  parking: "Parking",
  parkir: "Parking",
  activity: "Activity/Tickets",
  ticket: "Activity/Tickets"
};

function tripRef(tripId = TRIP_ID) {
  return db.collection("trips").doc(tripId);
}

function nowField() {
  return admin.firestore.FieldValue.serverTimestamp();
}

function id(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function rupiah(value) {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function toPlain(value) {
  if (!value) return value;
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(toPlain);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toPlain(item)]));
  }
  return value;
}

function clean(text) {
  return String(text || "").trim();
}

function num(text) {
  const parsed = Number(String(text || "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeMemberName(value) {
  const text = clean(value).toUpperCase();
  if (["TJ", "EK"].includes(text)) return text;
  if (["P3", "PERSON3", "PERSON 3", "3"].includes(text)) return "P3";
  if (["P4", "PERSON4", "PERSON 4", "4"].includes(text)) return "P4";
  return text || "UNMAPPED";
}

async function sendTelegram(chatId, text, extra = {}) {
  if (!TELEGRAM_TOKEN) {
    logger.warn("TELEGRAM_BOT_TOKEN not configured");
    return null;
  }
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra
    })
  });
  if (!response.ok) {
    const body = await response.text();
    logger.error("Telegram sendMessage failed", body);
  }
  return response;
}

async function getMemberByTelegram(tripId, user) {
  if (!user?.id) return null;
  const snap = await tripRef(tripId).collection("members").doc(String(user.id)).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function linkMember(tripId, user, chatId, memberName) {
  const member = normalizeMemberName(memberName);
  const data = {
    telegramUserId: String(user.id),
    telegramUsername: user.username || "",
    displayName: [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || String(user.id),
    member,
    chatId: String(chatId),
    updatedAt: nowField(),
    createdAt: nowField()
  };
  await tripRef(tripId).collection("members").doc(String(user.id)).set(data, { merge: true });
  await tripRef(tripId).set({
    title: "RTBALI",
    updatedAt: nowField(),
    createdAt: nowField()
  }, { merge: true });
  return data;
}

function parseExpenseText(text, member) {
  const raw = clean(text);
  const parts = raw.split(/\s+/);
  const lower = parts.map((p) => p.toLowerCase());
  const command = lower[0]?.replace(/^\//, "");
  const categoryWord = lower[1] && !/^\d/.test(lower[1]) ? lower[1] : lower[0];
  const category = CATEGORY_ALIASES[categoryWord] || "Other";
  const amount = num(raw.match(/(?:^|\s)(?:rp\s*)?([\d.,]{4,})(?:\s|$)/i)?.[1]);
  const paidMatch = raw.match(/\b(?:paid|payer|bayar|by)\s+([a-z0-9_]+)/i);
  const splitMatch = raw.match(/\bsplit\s+([a-z0-9/_ -]+)/i);
  const payer = normalizeMemberName(paidMatch?.[1] || member?.member || "TBD");
  const splitRaw = clean(splitMatch?.[1]).toLowerCase();
  let split = "Shared by Units";
  let billSplitMode = "Off";
  if (splitRaw.includes("order") || splitRaw.includes("meal")) {
    split = "Custom";
    billSplitMode = "Meal/order split";
  } else if (splitRaw.includes("50")) split = "Equal 50/50";
  else if (splitRaw.includes("tj")) split = "TJ only";
  else if (splitRaw.includes("ek")) split = "EK only";
  else if (splitRaw.includes("custom")) {
    split = "Custom";
    billSplitMode = "Custom TJ/EK";
  }

  const description = raw
    .replace(/^\/?(expense|exp|meal|food|makan)\s*/i, "")
    .replace(/\b(?:paid|payer|bayar|by)\s+[a-z0-9_]+/i, "")
    .replace(/\bsplit\s+[a-z0-9/_ -]+/i, "")
    .trim() || `${category} ${rupiah(amount)}`;

  return {
    id: id("tg-exp"),
    date: todayIso(),
    place: "",
    category,
    description,
    vendor: "",
    payer,
    payment: "Cash",
    amount,
    split,
    billSplitMode,
    billIncludesTaxService: "Yes",
    foodTJAmount: 0,
    foodEKAmount: 0,
    foodSharedAmount: 0,
    taxServiceAmount: 0,
    customTJAmount: 0,
    customEKAmount: 0,
    notes: raw,
    source: "telegram",
    status: command === "draft" ? "draft" : "confirmed",
    createdByTelegramUserId: member?.telegramUserId || "",
    createdByMember: member?.member || "",
    createdAt: nowField(),
    updatedAt: nowField()
  };
}

function shares(expense, members) {
  const amount = Number(expense.amount || 0);
  const labels = members.length ? members : ["TJ", "EK", "P3", "P4"];
  if (!amount) return Object.fromEntries(labels.map((name) => [name, 0]));
  if (expense.split === "TJ only") return { TJ: amount, EK: 0, P3: 0, P4: 0 };
  if (expense.split === "EK only") return { TJ: 0, EK: amount, P3: 0, P4: 0 };
  const each = amount / labels.length;
  return Object.fromEntries(labels.map((name) => [name, each]));
}

async function settlement(tripId) {
  const [expenseSnap, memberSnap] = await Promise.all([
    tripRef(tripId).collection("expenses").where("status", "==", "confirmed").get(),
    tripRef(tripId).collection("members").get()
  ]);
  const members = memberSnap.docs.map((doc) => doc.data().member).filter(Boolean);
  const paid = {};
  const owes = {};
  let total = 0;
  for (const name of members) {
    paid[name] = 0;
    owes[name] = 0;
  }
  expenseSnap.forEach((doc) => {
    const exp = doc.data();
    const amount = Number(exp.amount || 0);
    total += amount;
    paid[exp.payer] = (paid[exp.payer] || 0) + amount;
    const expShares = shares(exp, members);
    for (const [name, value] of Object.entries(expShares)) owes[name] = (owes[name] || 0) + value;
  });
  const net = {};
  for (const name of new Set([...Object.keys(paid), ...Object.keys(owes)])) {
    net[name] = (paid[name] || 0) - (owes[name] || 0);
  }
  return { total, paid, owes, net, members };
}

function settlementText(summary) {
  const lines = [`Total confirmed: <b>${rupiah(summary.total)}</b>`];
  for (const name of Object.keys(summary.net).sort()) {
    const value = Math.round(summary.net[name] || 0);
    lines.push(`${name}: ${value >= 0 ? "overpaid" : "owes"} ${rupiah(Math.abs(value))}`);
  }
  return lines.join("\n");
}

async function saveExpense(tripId, expense) {
  await tripRef(tripId).collection("expenses").doc(expense.id).set(expense, { merge: true });
  await tripRef(tripId).set({ updatedAt: nowField() }, { merge: true });
  return expense;
}

async function downloadTelegramFile(fileId) {
  const metaResponse = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile?file_id=${fileId}`);
  const meta = await metaResponse.json();
  if (!meta.ok) throw new Error("Telegram getFile failed");
  const fileResponse = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${meta.result.file_path}`);
  if (!fileResponse.ok) throw new Error("Telegram file download failed");
  return {
    path: meta.result.file_path,
    buffer: Buffer.from(await fileResponse.arrayBuffer())
  };
}

async function ocrImage(buffer) {
  try {
    const [result] = await visionClient.textDetection({ image: { content: buffer } });
    return result.fullTextAnnotation?.text || "";
  } catch (error) {
    logger.warn("OCR failed", error.message);
    return "";
  }
}

function parseOcrExpense(ocrText, member) {
  const lines = clean(ocrText).split(/\n+/).map(clean).filter(Boolean);
  const candidates = lines
    .map((line) => num(line.match(/(?:rp\s*)?([\d.,]{4,})/i)?.[1]))
    .filter((value) => value > 0);
  const amount = Math.max(0, ...candidates);
  const vendor = lines[0] || "Receipt";
  return {
    id: id("ocr-exp"),
    date: todayIso(),
    place: "",
    category: "Food & Drinks",
    description: vendor,
    vendor,
    payer: member?.member || "TBD",
    payment: "Cash",
    amount,
    split: "Shared by Units",
    billSplitMode: "Off",
    billIncludesTaxService: "Yes",
    notes: "OCR draft. Review before confirm.",
    source: "ocr",
    status: "draft",
    createdByTelegramUserId: member?.telegramUserId || "",
    createdByMember: member?.member || "",
    createdAt: nowField(),
    updatedAt: nowField()
  };
}

async function handlePhoto(tripId, message, member) {
  const photos = message.photo || [];
  const largest = photos[photos.length - 1];
  if (!largest) return "No photo found.";
  const file = await downloadTelegramFile(largest.file_id);
  const receiptId = id("receipt");
  const objectPath = `trips/${tripId}/receipts/${receiptId}.jpg`;
  await bucket.file(objectPath).save(file.buffer, {
    metadata: { contentType: "image/jpeg" },
    resumable: false
  });
  const ocrText = await ocrImage(file.buffer);
  const draft = parseOcrExpense(ocrText, member);
  draft.receiptId = receiptId;
  await tripRef(tripId).collection("receipts").doc(receiptId).set({
    id: receiptId,
    telegramFileId: largest.file_id,
    storagePath: objectPath,
    ocrText,
    parsedExpenseId: draft.id,
    status: "draft",
    createdByTelegramUserId: member?.telegramUserId || "",
    createdAt: nowField(),
    updatedAt: nowField()
  });
  await saveExpense(tripId, draft);
  return [
    "Receipt OCR draft saved.",
    `Draft id: <code>${draft.id}</code>`,
    `Vendor: ${draft.vendor}`,
    `Amount guess: <b>${rupiah(draft.amount)}</b>`,
    `OCR: ${ocrText ? "text detected" : "no text detected"}`,
    `Confirm with: <code>/confirm ${draft.id}</code>`
  ].join("\n");
}

async function saveReceiptDraftFromBuffer(tripId, buffer, metadata = {}) {
  const receiptId = id("receipt");
  const objectPath = `trips/${tripId}/receipts/${receiptId}.jpg`;
  await bucket.file(objectPath).save(buffer, {
    metadata: { contentType: metadata.contentType || "image/jpeg" },
    resumable: false
  });
  const ocrText = await ocrImage(buffer);
  const draft = parseOcrExpense(ocrText, metadata.member || null);
  draft.receiptId = receiptId;
  draft.source = metadata.source || "web-ocr";
  await tripRef(tripId).collection("receipts").doc(receiptId).set({
    id: receiptId,
    storagePath: objectPath,
    ocrText,
    parsedExpenseId: draft.id,
    status: "draft",
    source: draft.source,
    createdAt: nowField(),
    updatedAt: nowField()
  });
  await saveExpense(tripId, draft);
  return { receiptId, expense: toPlain({ ...draft, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }), ocrText };
}

async function handleCommand(tripId, message) {
  const chatId = message.chat.id;
  if (ALLOWED_CHAT_ID && String(chatId) !== String(ALLOWED_CHAT_ID)) {
    return "This bot is locked to a different group.";
  }
  const text = clean(message.text || message.caption || "");
  const user = message.from || {};
  const member = await getMemberByTelegram(tripId, user);
  const [commandRaw, ...args] = text.split(/\s+/);
  const command = commandRaw.toLowerCase();

  if (command === "/start" || command === "/help") {
    return [
      "<b>RTBALI expense bot</b>",
      "/link CODE TJ|EK|P3|P4",
      "/expense meal 220000 paid TJ split 50/50",
      "/meal 220000 paid EK split order",
      "Send a receipt photo for OCR draft.",
      "/confirm EXPENSE_ID",
      "/saldo",
      "/who"
    ].join("\n");
  }

  if (command === "/link") {
    const [code, name] = args;
    if (!LINK_CODE || code !== LINK_CODE) return "Wrong or missing link code.";
    const linked = await linkMember(tripId, user, chatId, name);
    return `Linked ${linked.displayName} as <b>${linked.member}</b>.`;
  }

  if (command === "/who") {
    const snap = await tripRef(tripId).collection("members").get();
    if (snap.empty) return "No members linked yet.";
    return snap.docs.map((doc) => {
      const data = doc.data();
      return `${data.member}: ${data.displayName || data.telegramUsername || doc.id}`;
    }).join("\n");
  }

  if (command === "/saldo" || command === "/settlement") {
    return settlementText(await settlement(tripId));
  }

  if (command === "/confirm") {
    const expenseId = args[0];
    if (!expenseId) return "Use /confirm EXPENSE_ID";
    await tripRef(tripId).collection("expenses").doc(expenseId).set({
      status: "confirmed",
      confirmedAt: nowField(),
      updatedAt: nowField()
    }, { merge: true });
    return `Confirmed <code>${expenseId}</code>.`;
  }

  if (command === "/expense" || command === "/exp" || command === "/meal" || command === "/food" || command === "/makan") {
    const exp = parseExpenseText(text, member);
    await saveExpense(tripId, exp);
    return [
      `Saved <b>${exp.category}</b> expense.`,
      `Amount: <b>${rupiah(exp.amount)}</b>`,
      `Payer: ${exp.payer}`,
      `Split: ${exp.billSplitMode !== "Off" ? exp.billSplitMode : exp.split}`,
      `ID: <code>${exp.id}</code>`
    ].join("\n");
  }

  if (message.photo) return handlePhoto(tripId, message, member);

  return "I did not understand that yet. Use /help.";
}

exports.telegramWebhook = onRequest({ region: "asia-southeast2", timeoutSeconds: 60, memory: "512MiB" }, async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).send("Method not allowed");
    if (WEBHOOK_SECRET && req.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
      return res.status(401).send("Bad webhook secret");
    }
    const update = req.body || {};
    const message = update.message || update.edited_message;
    if (!message?.chat?.id) return res.json({ ok: true });
    const text = await handleCommand(TRIP_ID, message);
    if (text) await sendTelegram(message.chat.id, text);
    return res.json({ ok: true });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

function cors(req, res) {
  res.set("access-control-allow-origin", "*");
  res.set("access-control-allow-headers", "content-type,x-rtbali-sync-key");
  res.set("access-control-allow-methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
}

function requireSync(req, res) {
  if (!SYNC_KEY) return true;
  if (req.get("x-rtbali-sync-key") === SYNC_KEY) return true;
  res.status(401).json({ error: "Bad sync key" });
  return false;
}

async function exportDb(tripId) {
  const [trip, expenses, members, receipts] = await Promise.all([
    tripRef(tripId).get(),
    tripRef(tripId).collection("expenses").orderBy("createdAt", "desc").limit(500).get(),
    tripRef(tripId).collection("members").get(),
    tripRef(tripId).collection("receipts").orderBy("createdAt", "desc").limit(200).get()
  ]);
  return {
    ...toPlain(trip.data()?.db || {}),
    firebase: {
      trip: toPlain(trip.data() || {}),
      members: members.docs.map((doc) => ({ id: doc.id, ...toPlain(doc.data()) })),
      receipts: receipts.docs.map((doc) => ({ id: doc.id, ...toPlain(doc.data()) }))
    },
    expenses: expenses.docs.map((doc) => ({ id: doc.id, ...toPlain(doc.data()) }))
  };
}

exports.api = onRequest({ region: "asia-southeast2", timeoutSeconds: 60, memory: "512MiB" }, async (req, res) => {
  try {
    if (cors(req, res)) return;
    if (!requireSync(req, res)) return;
    const tripId = clean(req.query.tripId) || TRIP_ID;
    const path = req.path.replace(/^\/+/, "");

    if (req.method === "GET" && path === "expenses") {
      const snap = await tripRef(tripId).collection("expenses").orderBy("createdAt", "desc").limit(500).get();
      return res.json({ expenses: snap.docs.map((doc) => ({ id: doc.id, ...toPlain(doc.data()) })) });
    }

    if (req.method === "GET" && path === "settlement") {
      return res.json(await settlement(tripId));
    }

    if (req.method === "GET" && path === "export") {
      return res.json({ db: await exportDb(tripId) });
    }

    if (req.method === "POST" && path === "import") {
      const payload = req.body || {};
      const importedDb = payload.db || payload;
      if (!importedDb || !Array.isArray(importedDb.expenses)) {
        return res.status(400).json({ error: "Expected RTBALI db with expenses array" });
      }
      await tripRef(tripId).set({ db: importedDb, updatedAt: nowField(), createdAt: nowField() }, { merge: true });
      const batch = db.batch();
      importedDb.expenses.forEach((expense) => {
        const expenseId = expense.id || id("web-exp");
        batch.set(tripRef(tripId).collection("expenses").doc(expenseId), {
          ...expense,
          id: expenseId,
          source: expense.source || "web",
          status: expense.status || "confirmed",
          createdAt: expense.createdAt || nowField(),
          updatedAt: nowField()
        }, { merge: true });
      });
      await batch.commit();
      return res.json({ ok: true, importedExpenses: importedDb.expenses.length });
    }

    if (req.method === "POST" && path === "receipt") {
      const { dataUrl, base64, mimeType } = req.body || {};
      const raw = dataUrl ? String(dataUrl).split(",").pop() : base64;
      if (!raw) return res.status(400).json({ error: "Expected dataUrl or base64 image" });
      const buffer = Buffer.from(raw, "base64");
      const result = await saveReceiptDraftFromBuffer(tripId, buffer, {
        contentType: mimeType || String(dataUrl || "").match(/^data:([^;]+)/)?.[1] || "image/jpeg",
        source: "web-ocr"
      });
      return res.json(result);
    }

    return res.status(404).json({ error: "Unknown API path" });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ error: error.message });
  }
});
