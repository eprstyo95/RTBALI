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
const ACCOUNT_MEMBERS = ["TJ", "EK"];
const DEFAULT_SPLIT_UNITS = { TJ: 2.5, EK: 2.5 };

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

function htmlEscape(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(text) {
  if (typeof text === "number") return Number.isFinite(text) ? text : 0;
  const cleaned = String(text || "").replace(/[^\d.,-]/g, "");
  const normalized = /[.,]/.test(cleaned)
    ? cleaned.replace(/[.,]/g, "")
    : cleaned;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeMemberName(value) {
  const text = clean(value).toUpperCase();
  if (["TJ", "T", "EKO"].includes(text)) return "TJ";
  if (["EK", "E"].includes(text)) return "EK";
  return "";
}

function memberLabels() {
  return [...ACCOUNT_MEMBERS];
}

function splitUnits(settings = {}) {
  const tj = num(settings.tjSplitUnits) || DEFAULT_SPLIT_UNITS.TJ;
  const ek = num(settings.ekSplitUnits) || DEFAULT_SPLIT_UNITS.EK;
  return { TJ: tj, EK: ek, total: tj + ek };
}

function pickNumber(raw, keys) {
  const keyPattern = keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = String(raw || "").match(new RegExp(`\\b(?:${keyPattern})\\s*(?:[:=])?\\s*(?:rp\\s*)?([\\d.,]+)`, "i"));
  return match ? num(match[1]) : 0;
}

function pickText(raw, keys) {
  const stopWords = [
    "paid", "payer", "bayar", "by", "split", "date", "tgl", "place", "route", "vendor", "merchant",
    "desc", "description", "note", "notes", "payment", "pay", "tjfood", "tjorder", "tjordered",
    "ekfood", "ekorder", "ekordered", "shared", "sharedfood", "tax", "service", "taxservice",
    "customtj", "customek", "tjshare", "ekshare", "amount", "total"
  ];
  const keyPattern = keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const stopPattern = stopWords.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const match = String(raw || "").match(new RegExp(`\\b(?:${keyPattern})\\s*(?:[:=])?\\s+(.+?)(?=\\s+(?:${stopPattern})\\b|$)`, "i"));
  return clean(match?.[1]).replace(/^["']|["']$/g, "");
}

function pickDate(raw) {
  return String(raw || "").match(/\b(?:date|tgl)\s*(?:[:=])?\s*(\d{4}-\d{2}-\d{2})\b/i)?.[1] || todayIso();
}

function expenseTotal(expense) {
  if (expense.billSplitMode === "Custom TJ/EK") {
    const custom = num(expense.customTJAmount) + num(expense.customEKAmount);
    return custom || num(expense.amount);
  }
  if (expense.billSplitMode === "Meal/order split") {
    const food = num(expense.foodTJAmount) + num(expense.foodEKAmount) + num(expense.foodSharedAmount);
    const taxes = expense.billIncludesTaxService === "No" ? 0 : num(expense.taxServiceAmount);
    return food + taxes || num(expense.amount);
  }
  return num(expense.amount);
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

async function editTelegramMessage(chatId, messageId, text, extra = {}) {
  if (!TELEGRAM_TOKEN || !chatId || !messageId) {
    logger.warn("editTelegramMessage: missing params", { chatId, messageId });
    return { ok: false, error: "missing params" };
  }
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageText`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra
    })
  });
  const json = await response.json().catch(() => ({}));
  if (!json.ok) {
    logger.error("editMessageText failed", { description: json.description, chatId, messageId });
  }
  return json;
}

async function sendTelegramCapture(chatId, text, extra = {}) {
  const response = await sendTelegram(chatId, text, extra);
  if (!response) return null;
  try { const j = await response.json(); return j?.result?.message_id || null; } catch (_) { return null; }
}

async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!TELEGRAM_TOKEN || !callbackQueryId) return null;
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text
    })
  });
  if (!response.ok) {
    const body = await response.text();
    logger.error("Telegram answerCallbackQuery failed", body);
  }
  return response;
}

function helpText() {
  return [
    "<b>RTBALI expense bot</b>",
    "Use /menu for quick actions.",
    "",
    "<b>Add expense (guided wizard)</b>",
    "Type the command — the bot will ask the rest step by step.",
    "<code>/meal</code>  or  <code>/food 220000</code>",
    "<code>/expense fuel 500000</code>",
    "<code>/expense hotel paid TJ</code>",
    "For <b>Food &amp; Drinks</b>: the wizard asks TJ food, EK food, shared dishes, and tax/service separately.",
    "Tap <b>Confirm &amp; save</b> at the end — nothing is saved until you confirm.",
    "<code>/cancel</code> — exit wizard without saving",
    "",
    "<b>Receipt OCR</b>",
    "Send a receipt photo — bot creates a draft and shows edit buttons.",
    "Or use caption <code>/receipt</code> if the bot doesn't respond.",
    "",
    "<b>Member setup</b>",
    "<code>/link CODE TJ|EK</code>",
    "<code>/unlink</code>",
    "",
    "<b>Useful</b>",
    "/saldo  /who"
  ].join("\n");
}

function menuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "💰 Saldo",       callback_data: "menu:saldo" },
        { text: "👥 Who",         callback_data: "menu:who"   }
      ],
      [
        { text: "➕ Add expense", callback_data: "menu:expense" },
        { text: "📷 Receipt OCR", callback_data: "menu:ocr"    }
      ],
      [
        { text: "❓ Help",        callback_data: "menu:help"   },
        { text: "🔓 Unlink me",   callback_data: "menu:unlink" }
      ]
    ]
  };
}

function ocrDraftKeyboard(expenseId) {
  return {
    inline_keyboard: [
      [
        { text: "💳 TJ paid",       callback_data: `exp:p:${expenseId}:TJ`    },
        { text: "💳 EK paid",       callback_data: `exp:p:${expenseId}:EK`    }
      ],
      [
        { text: "⚖️ Shared units",  callback_data: `exp:s:${expenseId}:units` },
        { text: "½ 50/50",          callback_data: `exp:s:${expenseId}:5050`  }
      ],
      [
        { text: "👤 TJ only",       callback_data: `exp:s:${expenseId}:tj`    },
        { text: "👤 EK only",       callback_data: `exp:s:${expenseId}:ek`    }
      ],
      [
        { text: "💵 Cash",          callback_data: `exp:m:${expenseId}:cash`  },
        { text: "📱 QRIS",          callback_data: `exp:m:${expenseId}:qris`  },
        { text: "💳 Card",          callback_data: `exp:m:${expenseId}:card`  }
      ],
      [
        { text: "✅ Confirm",       callback_data: `exp:c:${expenseId}`       }
      ]
    ]
  };
}

// Dismiss any lingering reply keyboard — replaces the old cluttered command keyboards
const REMOVE_KEYBOARD = { remove_keyboard: true };
function ocrCommandKeyboard() { return REMOVE_KEYBOARD; }
function ocrGeneralKeyboard() { return REMOVE_KEYBOARD; }
function ocrMealKeyboard()    { return REMOVE_KEYBOARD; }
// Kept as stubs so existing call sites compile without changes.


function ocrDraftText(draft, ocr = null) {
  const split = draft.billSplitMode !== "Off" ? draft.billSplitMode : draft.split;
  const summary = [
    "<b>Receipt draft saved</b>",
    `${htmlEscape(draft.vendor || draft.description || "Receipt")} · <b>${rupiah(draft.amount)}</b>`,
    `Category: <b>${htmlEscape(draft.category || "Other")}</b>`,
    `Payer: <b>${htmlEscape(draft.payer || "TJ")}</b> · ${htmlEscape(split || "Shared by Units")} · ${htmlEscape(draft.payment || "Cash")}`
  ];
  const details = [
    `Draft id: ${draft.id}`,
    `OCR: ${ocr ? ocrStatusText(ocr) : draft.ocrStatus || "-"}`,
    `TJ food: ${rupiah(draft.foodTJAmount)}`,
    `EK food: ${rupiah(draft.foodEKAmount)}`,
    `Shared food: ${rupiah(draft.foodSharedAmount)}`,
    `Tax/service: ${rupiah(draft.taxServiceAmount)}`,
    "Tap category first. For meals: tap /meal, then tap TJ food/EK food/shared/tax and type the amount.",
    `/set ${draft.id} paid TJ split units payment Cash`,
    `/confirm ${draft.id}`
  ];
  return `${summary.join("\n")}\n<blockquote expandable>${details.map(htmlEscape).join("\n")}</blockquote>`;
}

function telegramResponse(text, extra = {}) {
  return { text, extra };
}

async function getMemberByTelegram(tripId, user) {
  if (!user?.id) return null;
  const snap = await tripRef(tripId).collection("members").doc(String(user.id)).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

async function linkMember(tripId, user, chatId, memberName) {
  const member = normalizeMemberName(memberName);
  if (!member) throw new Error("Link as TJ or EK only.");
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

async function unlinkMember(tripId, user) {
  if (!user?.id) return null;
  const ref = tripRef(tripId).collection("members").doc(String(user.id));
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  await ref.delete();
  await tripRef(tripId).set({ updatedAt: nowField() }, { merge: true });
  return data;
}

function parseExpenseText(text, member) {
  const raw = clean(text);
  const parts = raw.split(/\s+/);
  const lower = parts.map((p) => p.toLowerCase());
  const command = lower[0]?.replace(/^\//, "");
  const detailKeys = new Set([
    "paid", "payer", "bayar", "by", "split", "date", "tgl", "place", "route", "vendor", "merchant",
    "desc", "description", "note", "notes", "payment", "pay", "amount", "total", "tjfood", "ekfood",
    "shared", "sharedfood", "tax", "service", "taxservice", "customtj", "customek", "tjshare", "ekshare"
  ]);
  const categoryWord = lower[1] && !/^\d/.test(lower[1]) && !detailKeys.has(lower[1]) ? lower[1] : command;
  const category = CATEGORY_ALIASES[categoryWord] || "Other";
  const amount = pickNumber(raw, ["amount", "total"]) || num(raw.match(/(?:^|\s)(?:rp\s*)?([\d.,]{4,})(?:\s|$)/i)?.[1]);
  const paidMatch = raw.match(/\b(?:paid|payer|bayar|by)\s+([a-z0-9_]+)/i);
  const splitMatch = raw.match(/\bsplit\s+([a-z0-9/_-]+)/i);
  const payer = normalizeMemberName(paidMatch?.[1]) || member?.member || "TJ";
  const splitRaw = clean(splitMatch?.[1]).toLowerCase();
  let split = "Shared by Units";
  let billSplitMode = "Off";
  if (splitRaw.includes("order") || splitRaw.includes("meal") || /\b(tjfood|ekfood|sharedfood)\b/i.test(raw)) {
    split = "Custom";
    billSplitMode = "Meal/order split";
  } else if (splitRaw.includes("50")) split = "Equal 50/50";
  else if (splitRaw.includes("tj")) split = "TJ only";
  else if (splitRaw.includes("ek")) split = "EK only";
  else if (splitRaw.includes("custom") || /\b(customtj|customek|tjshare|ekshare)\b/i.test(raw)) {
    split = "Custom";
    billSplitMode = "Custom TJ/EK";
  }

  const explicitDescription = pickText(raw, ["desc", "description"]);
  let description = explicitDescription || raw
    .replace(/^\/?(expense|exp|meal|food|makan)\s*/i, "")
    .replace(/\b(?:paid|payer|bayar|by)\s+[a-z0-9_]+/i, "")
    .replace(/\bsplit\s+[a-z0-9/_-]+/i, "")
    .replace(/\b(?:amount|total|tjfood|tjorder|tjordered|ekfood|ekorder|ekordered|shared|sharedfood|tax|service|taxservice|customtj|customek|tjshare|ekshare)\s*(?:[:=])?\s*(?:rp\s*)?[\d.,]+/gi, "")
    .replace(/\b(?:date|tgl|place|route|vendor|merchant|payment|pay|desc|description|note|notes)\s*(?:[:=])?\s+.+?(?=\s+(?:paid|payer|bayar|by|split|amount|total|tjfood|tjorder|tjordered|ekfood|ekorder|ekordered|shared|sharedfood|tax|service|taxservice|customtj|customek|tjshare|ekshare|date|tgl|place|route|vendor|merchant|payment|pay|desc|description|note|notes)\b|$)/gi, "")
    .trim();

  const expense = {
    id: id("tg-exp"),
    date: pickDate(raw),
    place: pickText(raw, ["place", "route"]),
    category,
    description,
    vendor: pickText(raw, ["vendor", "merchant"]),
    payer,
    payment: pickText(raw, ["payment", "pay"]) || "Cash",
    amount,
    split,
    billSplitMode,
    billIncludesTaxService: /\b(?:notax|no-tax|tax\s+no|tax\s*=\s*no|incltax\s+no|incltax\s*=\s*no)\b/i.test(raw) ? "No" : "Yes",
    foodTJAmount: pickNumber(raw, ["tjfood", "tjorder", "tjordered"]),
    foodEKAmount: pickNumber(raw, ["ekfood", "ekorder", "ekordered"]),
    foodSharedAmount: pickNumber(raw, ["sharedfood", "shared"]),
    taxServiceAmount: pickNumber(raw, ["taxservice", "tax", "service"]),
    customTJAmount: pickNumber(raw, ["customtj", "tjshare"]),
    customEKAmount: pickNumber(raw, ["customek", "ekshare"]),
    notes: pickText(raw, ["note", "notes"]) || raw,
    source: "telegram",
    status: command === "draft" ? "draft" : "confirmed",
    createdByTelegramUserId: member?.telegramUserId || "",
    createdByMember: member?.member || "",
    createdAt: nowField(),
    updatedAt: nowField()
  };
  expense.amount = expenseTotal(expense);
  if (!description) {
    description = `${category} ${rupiah(expense.amount)}`;
    expense.description = description;
  }
  return expense;
}

function shares(expense, units = splitUnits()) {
  const amount = expenseTotal(expense);
  if (!amount) return { TJ: 0, EK: 0 };
  if (expense.billSplitMode === "Custom TJ/EK") {
    return {
      TJ: num(expense.customTJAmount),
      EK: num(expense.customEKAmount)
    };
  }
  if (expense.billSplitMode === "Meal/order split") {
    const tjFood = num(expense.foodTJAmount);
    const ekFood = num(expense.foodEKAmount);
    const shared = num(expense.foodSharedAmount);
    const baseTJ = tjFood + shared * (units.TJ / units.total);
    const baseEK = ekFood + shared * (units.EK / units.total);
    const base = baseTJ + baseEK;
    const tax = expense.billIncludesTaxService === "No" ? 0 : num(expense.taxServiceAmount);
    const tjTax = base ? tax * (baseTJ / base) : tax * (units.TJ / units.total);
    return {
      TJ: baseTJ + tjTax,
      EK: baseEK + (tax - tjTax)
    };
  }
  if (expense.split === "TJ only") return { TJ: amount, EK: 0 };
  if (expense.split === "EK only") return { TJ: 0, EK: amount };
  if (expense.split === "Equal 50/50") return { TJ: amount / 2, EK: amount / 2 };
  return {
    TJ: amount * (units.TJ / units.total),
    EK: amount * (units.EK / units.total)
  };
}

async function settlement(tripId) {
  const [tripSnap, expenseSnap] = await Promise.all([
    tripRef(tripId).get(),
    tripRef(tripId).collection("expenses").where("status", "==", "confirmed").get(),
  ]);
  const units = splitUnits(tripSnap.data()?.db?.settings || {});
  const members = memberLabels();
  const paid = {};
  const owes = {};
  let total = 0;
  for (const name of members) {
    paid[name] = 0;
    owes[name] = 0;
  }
  expenseSnap.forEach((doc) => {
    const exp = doc.data();
    const amount = expenseTotal(exp);
    total += amount;
    const payer = ACCOUNT_MEMBERS.includes(exp.payer) ? exp.payer : "TJ";
    paid[payer] = (paid[payer] || 0) + amount;
    const expShares = shares(exp, units);
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

async function findLatestDraftExpense(tripId, member) {
  let query = tripRef(tripId).collection("expenses")
    .where("status", "==", "draft");
  if (member?.telegramUserId) {
    query = query.where("createdByTelegramUserId", "==", member.telegramUserId);
  }
  query = query.orderBy("createdAt", "desc").limit(10);
  const snap = await query.get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function confirmExpense(tripId, expenseId, member) {
  const requestedId = clean(expenseId);
  if (/^EXPENSE_ID$/i.test(requestedId)) {
    return {
      ok: false,
      message: "That is only a placeholder. Send a receipt photo first, then use the real draft ID, or just type <code>/confirm</code>."
    };
  }

  const draft = requestedId
    ? null
    : await findLatestDraftExpense(tripId, member);
  const idToConfirm = requestedId || draft?.id;
  if (!idToConfirm) {
    return {
      ok: false,
      message: "No draft expense found. Send a receipt photo first, then confirm the draft."
    };
  }

  const ref = tripRef(tripId).collection("expenses").doc(idToConfirm);
  const snap = await ref.get();
  if (!snap.exists) {
    return {
      ok: false,
      message: `No expense found for <code>${idToConfirm}</code>. Check the draft ID from the OCR message.`
    };
  }

  const expense = snap.data();
  if (expense.status === "confirmed") {
    return {
      ok: true,
      message: `Already confirmed <code>${idToConfirm}</code>.`
    };
  }

  await ref.set({
    status: "confirmed",
    confirmedAt: nowField(),
    confirmedByTelegramUserId: member?.telegramUserId || "",
    updatedAt: nowField()
  }, { merge: true });

  if (expense.receiptId) {
    await tripRef(tripId).collection("receipts").doc(expense.receiptId).set({
      status: "confirmed",
      confirmedExpenseId: idToConfirm,
      updatedAt: nowField()
    }, { merge: true });
  }

  return {
    ok: true,
    message: [
      `Confirmed <code>${idToConfirm}</code>.`,
      `${expense.vendor || expense.description || "Expense"}: <b>${rupiah(expenseTotal(expense))}</b>`
    ].join("\n")
  };
}

function splitUpdate(value) {
  const normalized = clean(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (["5050", "50", "equal"].includes(normalized)) return { split: "Equal 50/50", billSplitMode: "Off" };
  if (["tj", "tjonly"].includes(normalized)) return { split: "TJ only", billSplitMode: "Off" };
  if (["ek", "ekonly"].includes(normalized)) return { split: "EK only", billSplitMode: "Off" };
  return { split: "Shared by Units", billSplitMode: "Off" };
}

function paymentUpdate(value) {
  const normalized = clean(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized === "qris") return "QRIS";
  if (["card", "debit", "credit", "debitcredit"].includes(normalized)) return "Debit/Credit";
  if (["transfer", "tf"].includes(normalized)) return "Transfer";
  if (["emoney", "etoll"].includes(normalized)) return "e-Money";
  return "Cash";
}

async function updateDraft(tripId, expenseId, patch) {
  const ref = tripRef(tripId).collection("expenses").doc(expenseId);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (data.status === "confirmed") return { id: snap.id, ...data, alreadyConfirmed: true };
  const merged = { ...data, ...patch };
  const shouldRecalculate = [
    "foodTJAmount",
    "foodEKAmount",
    "foodSharedAmount",
    "taxServiceAmount",
    "customTJAmount",
    "customEKAmount",
    "billSplitMode",
    "billIncludesTaxService"
  ].some((key) => Object.prototype.hasOwnProperty.call(patch, key));
  if (shouldRecalculate) patch.amount = expenseTotal(merged);
  await ref.set({ ...patch, updatedAt: nowField() }, { merge: true });
  const updated = await ref.get();
  return { id: updated.id, ...updated.data() };
}

async function updateDraftFromCallback(tripId, expenseId, patch) {
  return updateDraft(tripId, expenseId, patch);
}

function parseSetPatch(args) {
  const patch = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = clean(args[i]).toLowerCase();
    const value = clean(args[i + 1]);
    if (!value) continue;
    if (["paid", "payer", "by", "bayar"].includes(key)) {
      const payer = normalizeMemberName(value);
      if (payer) patch.payer = payer;
      i += 1;
    } else if (key === "split") {
      Object.assign(patch, splitUpdate(value));
      i += 1;
    } else if (["payment", "pay", "method"].includes(key)) {
      patch.payment = paymentUpdate(value);
      i += 1;
    }
  }
  return patch;
}

function categoryUpdate(value) {
  const normalized = clean(value).toLowerCase();
  return CATEGORY_ALIASES[normalized] || {
    food: "Food & Drinks",
    fuel: "Fuel/Diesel",
    toll: "Toll/e-Money",
    ferry: "Ferry",
    hotel: "Hotel",
    parking: "Parking",
    other: "Other"
  }[normalized] || "Other";
}

function mealAmountPatch(field, amount) {
  const base = {
    category: "Food & Drinks",
    split: "Custom",
    billSplitMode: "Meal/order split",
    billIncludesTaxService: "Yes"
  };
  if (field === "tjfood") return { ...base, foodTJAmount: amount };
  if (field === "ekfood") return { ...base, foodEKAmount: amount };
  if (field === "shared") return { ...base, foodSharedAmount: amount };
  if (field === "tax") return { ...base, taxServiceAmount: amount };
  return base;
}

function pendingRef(tripId, user) {
  return tripRef(tripId).collection("telegramStates").doc(String(user?.id || "unknown"));
}

async function setPendingAmount(tripId, user, field, expenseId) {
  await pendingRef(tripId, user).set({
    type: "mealAmount",
    field,
    expenseId,
    updatedAt: nowField()
  }, { merge: true });
}

// ============================================================
// EXPENSE SESSION — one draft message, edited in place on every command
// Reply keyboard (user liked this). No new messages until confirm.
// ============================================================

const CATEGORY_KEY_MAP = {
  food:"Food & Drinks", fuel:"Fuel/Diesel", toll:"Toll/e-Money",
  ferry:"Ferry", hotel:"Hotel", parking:"Parking",
  activity:"Activity/Tickets", needs:"Necessities", other:"Other"
};

// ── session keyboard (clean reply keyboard, two modes) ──────────────────────
function sessionKeyboard(draft) {
  const isMeal = draft.billSplitMode === "Meal/order split";
  if (isMeal) {
    return {
      keyboard: [
        [{ text: "/tjfood" },        { text: "/ekfood" }],
        [{ text: "/shared" },        { text: "/tax" }],
        [{ text: "/set paid TJ" },   { text: "/set paid EK" }],
        [{ text: "/confirm" },       { text: "/cancel" }]
      ],
      resize_keyboard: true, one_time_keyboard: false,
      input_field_placeholder: "Tap above or type amount"
    };
  }
  return {
    keyboard: [
      [{ text: "/cat Food" },  { text: "/cat Fuel" },  { text: "/cat Toll" }],
      [{ text: "/cat Ferry" }, { text: "/cat Hotel" }, { text: "/cat Other" }],
      [{ text: "/set paid TJ" },          { text: "/set paid EK" }],
      [{ text: "/set split units" },      { text: "/set split 50/50" }],
      [{ text: "/set payment QRIS" },     { text: "/set payment Cash" }],
      [{ text: "/confirm" },              { text: "/cancel" }]
    ],
    resize_keyboard: true, one_time_keyboard: false,
    input_field_placeholder: "Choose category, payer, split…"
  };
}

// ── session draft text ──────────────────────────────────────────────────────
function sessionText(draft, prompt = "") {
  const isMeal = draft.billSplitMode === "Meal/order split";
  const lines  = ["<b>📝 Draft expense</b>"];
  if (draft.category) lines.push(`Category: <b>${htmlEscape(draft.category)}</b>`);
  if (num(draft.amount)) lines.push(`Amount: <b>${rupiah(draft.amount)}</b>`);
  if (draft.vendor)   lines.push(`At: ${htmlEscape(draft.vendor)}`);
  if (draft.payer)    lines.push(`Payer: <b>${draft.payer}</b>`);
  if (isMeal) {
    const parts = [];
    if (num(draft.foodTJAmount))     parts.push(`TJ ${rupiah(draft.foodTJAmount)}`);
    if (num(draft.foodEKAmount))     parts.push(`EK ${rupiah(draft.foodEKAmount)}`);
    if (num(draft.foodSharedAmount)) parts.push(`shared ${rupiah(draft.foodSharedAmount)}`);
    if (num(draft.taxServiceAmount)) parts.push(`tax ${rupiah(draft.taxServiceAmount)}`);
    if (parts.length) lines.push(`Split: ${parts.join("  ·  ")}`);
    const s = shares(draft);
    if (s.TJ || s.EK) lines.push(`→ TJ <b>${rupiah(Math.round(s.TJ))}</b>   EK <b>${rupiah(Math.round(s.EK))}</b>`);
  } else {
    if (draft.split && draft.split !== "Shared by Units") lines.push(`Split: ${draft.split}`);
    if (draft.payment && draft.payment !== "Cash")        lines.push(`Via: ${draft.payment}`);
  }
  if (prompt) lines.push(`\n${prompt}`);
  return lines.join("\n");
}

// ── session state ────────────────────────────────────────────────────────────
async function getSession(tripId, user) {
  if (!user?.id) return null;
  const snap = await pendingRef(tripId, user).get();
  if (!snap.exists) return null;
  const d = snap.data();
  return (d.type === "session") ? d : null;
}

async function setSession(tripId, user, expenseId, draftMsgId, chatId) {
  await pendingRef(tripId, user).set({
    type: "session", expenseId,
    draftMsgId: draftMsgId || null,
    chatId: String(chatId || ""),
    updatedAt: nowField()
  }, { merge: false });
}

async function clearSession(tripId, user) {
  await pendingRef(tripId, user).delete();
}

// Edit the one draft message in-place (no new message)
async function refreshSessionMsg(tripId, user, draft, prompt = "") {
  const sess = await getSession(tripId, user);
  if (!sess?.draftMsgId || !sess?.chatId) return;
  await editTelegramMessage(Number(sess.chatId), sess.draftMsgId,
    sessionText(draft, prompt), { reply_markup: sessionKeyboard(draft) });
}

// ── start an expense (text command or OCR) ───────────────────────────────────
async function startExpense(tripId, user, member, chatId, initialData) {
  const isMeal = initialData.category === "Food & Drinks";
  const draft = {
    id: id("tg-exp"),
    date: initialData.date || todayIso(),
    category: initialData.category || "",
    description: initialData.description || "",
    place: initialData.place || "", vendor: initialData.vendor || "",
    amount: initialData.amount || 0,
    payer: initialData.payer || member?.member || "TJ",
    payment: "Cash",
    split: isMeal ? "Custom" : "Shared by Units",
    billSplitMode: isMeal ? "Meal/order split" : "Off",
    billIncludesTaxService: "Yes",
    foodTJAmount: 0, foodEKAmount: 0, foodSharedAmount: 0, taxServiceAmount: 0,
    customTJAmount: 0, customEKAmount: 0, notes: "",
    source: "telegram", status: "draft",
    createdByTelegramUserId: String(user?.id || ""),
    createdByMember: member?.member || "",
    createdAt: nowField(), updatedAt: nowField()
  };
  await saveExpense(tripId, draft);
  const msgId = await sendTelegramCapture(chatId, sessionText(draft),
    { reply_markup: sessionKeyboard(draft) });
  await setSession(tripId, user, draft.id, msgId, chatId);
  return "";
}

// ── command handlers (all edit the session message instead of sending new) ───

async function consumePendingAmount(tripId, user, chatId, text, member) {
  if (!user?.id || text.startsWith("/")) return null;
  const ref = pendingRef(tripId, user);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const state = snap.data();
  if (state.type !== "mealAmount") return null;
  const amount = num(text);
  if (!amount) return telegramResponse("Type the amount as digits, e.g. <code>150000</code>.", {
    reply_markup: { force_reply: true, input_field_placeholder: "150000" }
  });
  await ref.delete();
  const expenseId = state.expenseId || (await findLatestDraftExpense(tripId, member))?.id;
  if (!expenseId) return "No draft found. Use /meal to start.";
  const updated = await updateDraft(tripId, expenseId, mealAmountPatch(state.field, amount));
  if (!updated) return "Draft not found.";
  await refreshSessionMsg(tripId, user, updated);
  return "";
}

async function setCategoryDraft(tripId, args, member, user) {
  const category = categoryUpdate(args.join(" ") || "Other");
  const draft = await findLatestDraftExpense(tripId, member);
  if (!draft) return "No draft. Use /meal or /expense first.";
  const patch = { category };
  if (category === "Food & Drinks") {
    patch.split = "Custom"; patch.billSplitMode = "Meal/order split";
  } else {
    patch.billSplitMode = "Off";
    if (draft.split === "Custom") patch.split = "Shared by Units";
  }
  const updated = await updateDraft(tripId, draft.id, patch);
  await refreshSessionMsg(tripId, user, updated);
  return "";
}

async function enableMealSplit(tripId, member, user) {
  const draft = await findLatestDraftExpense(tripId, member);
  if (!draft) return "No draft. Use /meal or /expense first.";
  const updated = await updateDraft(tripId, draft.id, {
    category: "Food & Drinks", split: "Custom",
    billSplitMode: "Meal/order split", billIncludesTaxService: "Yes"
  });
  await refreshSessionMsg(tripId, user, updated);
  return "";
}

async function promptMealAmount(tripId, user, member, field, args) {
  const draft = await findLatestDraftExpense(tripId, member);
  if (!draft) return "No draft. Use /meal or /expense first.";
  const typedAmount = num(args[0]);
  if (typedAmount) {
    const updated = await updateDraft(tripId, draft.id, mealAmountPatch(field, typedAmount));
    await refreshSessionMsg(tripId, user, updated);
    return "";
  }
  await setPendingAmount(tripId, user, field, draft.id);
  const label = { tjfood:"TJ food", ekfood:"EK food", shared:"shared food", tax:"tax/service" }[field];
  // Update draft message to show what we're waiting for
  await refreshSessionMsg(tripId, user, draft, `⏳ Type amount for <b>${label}</b>:`);
  return "";
}

async function setDraftExpense(tripId, args, member, user) {
  let expenseId = args[0] && /^ocr-exp-|^tg-exp-|^web-exp-/i.test(args[0]) ? args[0] : "";
  const setArgs = expenseId ? args.slice(1) : args;
  const patch = parseSetPatch(setArgs);
  if (!Object.keys(patch).length) return "Use <code>/set paid TJ split 50/50 payment QRIS</code>";
  if (!expenseId) expenseId = (await findLatestDraftExpense(tripId, member))?.id || "";
  if (!expenseId) return "No draft. Use /meal or /expense first.";
  const updated = await updateDraft(tripId, expenseId, patch);
  if (!updated) return "Draft not found.";
  if (updated.alreadyConfirmed) return "Already confirmed.";
  await refreshSessionMsg(tripId, user, updated);
  return "";
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
    const [documentResult] = await visionClient.documentTextDetection({ image: { content: buffer } });
    const documentText = documentResult.fullTextAnnotation?.text || "";
    if (documentText) {
      return { text: documentText, status: "detected", engine: "documentTextDetection" };
    }

    const [textResult] = await visionClient.textDetection({ image: { content: buffer } });
    const text = textResult.fullTextAnnotation?.text || "";
    return {
      text,
      status: text ? "detected" : "empty",
      engine: "textDetection"
    };
  } catch (error) {
    logger.error("OCR failed", {
      message: error.message,
      code: error.code,
      details: error.details
    });
    return {
      text: "",
      status: "failed",
      engine: "google-cloud-vision",
      error: error.message || "Unknown OCR error"
    };
  }
}

function ocrStatusText(ocr) {
  if (ocr.status === "detected") return `text detected by ${ocr.engine}`;
  if (ocr.status === "failed") return `failed (${ocr.error || "check Cloud Function logs"})`;
  return "no text detected";
}

function parseOcrExpense(ocrText, member) {
  const lines = clean(ocrText).split(/\n+/).map(clean).filter(Boolean);
  const totalLine = [...lines].reverse().find((line) => /\b(?:grand\s*)?total\b|jumlah|tagihan|amount\s*due/i.test(line));
  const totalAmount = num(totalLine?.match(/(?:rp\.?\s*)?([\d.,]{4,})/i)?.[1]);
  const candidates = lines.flatMap((line) => {
    const matches = [...line.matchAll(/(?:rp\.?\s*)?([\d.,]{4,})/gi)];
    return matches.map((match) => num(match[1])).filter((value) => value > 0);
  });
  const amount = totalAmount || Math.max(0, ...candidates);
  const vendor = lines[0] || "Receipt";
  return {
    id: id("ocr-exp"),
    date: todayIso(),
    place: "",
    category: "Food & Drinks",
    description: vendor,
    vendor,
    payer: member?.member || "TJ",
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

async function handlePhoto(tripId, message, member, user, chatId) {
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
  const ocr = await ocrImage(file.buffer);
  const ocrText = ocr.text;
  const draft = parseOcrExpense(ocrText, member);
  draft.receiptId = receiptId;
  draft.ocrStatus = ocr.status;
  draft.ocrEngine = ocr.engine;
  await tripRef(tripId).collection("receipts").doc(receiptId).set({
    id: receiptId,
    telegramFileId: largest.file_id,
    storagePath: objectPath,
    ocrText,
    ocrStatus: ocr.status,
    ocrEngine: ocr.engine,
    ocrError: ocr.error || "",
    parsedExpenseId: draft.id,
    status: "draft",
    createdByTelegramUserId: member?.telegramUserId || "",
    createdAt: nowField(),
    updatedAt: nowField()
  });
  await saveExpense(tripId, draft);
  if (chatId && user?.id) {
    const msgId = await sendTelegramCapture(chatId, sessionText(draft),
      { reply_markup: sessionKeyboard(draft) });
    await setSession(tripId, user, draft.id, msgId, chatId);
    return "";
  }
  return telegramResponse(ocrDraftText(draft, ocr), { reply_markup: ocrCommandKeyboard() });
}

async function saveReceiptDraftFromBuffer(tripId, buffer, metadata = {}) {
  const receiptId = id("receipt");
  const objectPath = `trips/${tripId}/receipts/${receiptId}.jpg`;
  await bucket.file(objectPath).save(buffer, {
    metadata: { contentType: metadata.contentType || "image/jpeg" },
    resumable: false
  });
  const ocr = await ocrImage(buffer);
  const ocrText = ocr.text;
  const draft = parseOcrExpense(ocrText, metadata.member || null);
  draft.receiptId = receiptId;
  draft.source = metadata.source || "web-ocr";
  draft.ocrStatus = ocr.status;
  draft.ocrEngine = ocr.engine;
  await tripRef(tripId).collection("receipts").doc(receiptId).set({
    id: receiptId,
    storagePath: objectPath,
    ocrText,
    ocrStatus: ocr.status,
    ocrEngine: ocr.engine,
    ocrError: ocr.error || "",
    parsedExpenseId: draft.id,
    status: "draft",
    source: draft.source,
    createdAt: nowField(),
    updatedAt: nowField()
  });
  await saveExpense(tripId, draft);
  return {
    receiptId,
    expense: toPlain({ ...draft, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }),
    ocrText,
    ocrStatus: ocr.status,
    ocrEngine: ocr.engine,
    ocrError: ocr.error || ""
  };
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
  const command = commandRaw.toLowerCase().replace(/@[\w_]+$/, "");
  const pendingResult = await consumePendingAmount(tripId, user, chatId, text, member);
  if (pendingResult !== null) return pendingResult || "";

  if (command === "/start" || command === "/help") {
    return helpText();
  }

  if (command === "/menu") {
    await sendTelegram(chatId, "<b>RTBALI menu</b>", { reply_markup: menuKeyboard() });
    return "";
  }

  if (command === "/link") {
    const [code, name] = args;
    if (!LINK_CODE || code !== LINK_CODE) return "Wrong or missing link code.";
    if (!normalizeMemberName(name)) return "Use <code>/link CODE TJ</code> or <code>/link CODE EK</code>. Multiple Telegram accounts can link to the same TJ/EK account.";
    const linked = await linkMember(tripId, user, chatId, name);
    return `Linked ${linked.displayName} as <b>${linked.member}</b>.`;
  }

  if (command === "/unlink") {
    const unlinked = await unlinkMember(tripId, user);
    if (!unlinked) return "You are not linked yet.";
    return `Unlinked <b>${unlinked.member}</b> for ${unlinked.displayName || unlinked.telegramUsername || user.id}.`;
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
    const result = await confirmExpense(tripId, args[0], member);
    const sess = await getSession(tripId, user);
    if (result.ok && sess?.draftMsgId && sess?.chatId) {
      await editTelegramMessage(Number(sess.chatId), sess.draftMsgId,
        `✅ ${result.message}`, { reply_markup: { remove_keyboard: true } });
      await clearSession(tripId, user);
      return "";
    }
    return telegramResponse(result.message, result.ok ? { reply_markup: { remove_keyboard: true } } : {});
  }

  if (command === "/cancel") {
    const sess = await getSession(tripId, user);
    if (sess?.draftMsgId && sess?.chatId) {
      await editTelegramMessage(Number(sess.chatId), sess.draftMsgId,
        "❌ Expense cancelled.", { reply_markup: { remove_keyboard: true } });
      await clearSession(tripId, user);
      return "";
    }
    await pendingRef(tripId, user).delete();
    return "Cancelled.";
  }

  if (command === "/set" || command === "/editdraft") {
    return setDraftExpense(tripId, args, member, user);
  }

  if (command === "/cat" || command === "/category") {
    return setCategoryDraft(tripId, args, member, user);
  }

  if (command === "/meal" && !text.match(/\d{3,}/)) {
    return enableMealSplit(tripId, member, user);
  }

  if (command === "/tjfood" || command === "/ekfood" || command === "/shared" || command === "/tax") {
    return promptMealAmount(tripId, user, member, command.slice(1), args);
  }

  if (command === "/notax") {
    const draft = await findLatestDraftExpense(tripId, member);
    if (!draft) return "No draft. Use /meal or /expense first.";
    const updated = await updateDraft(tripId, draft.id, { billIncludesTaxService: "No", taxServiceAmount: 0 });
    await refreshSessionMsg(tripId, user, updated);
    return "";
  }

  if (command === "/hidekeys" || command === "/hidekeyboard") {
    return telegramResponse("Keyboard hidden.", { reply_markup: { remove_keyboard: true } });
  }

  if (command === "/receipt") {
    if (message.photo) return handlePhoto(tripId, message, member, user, chatId);
    return "Send a receipt photo with caption <code>/receipt</code>.";
  }

  if (command === "/expense" || command === "/exp" || command === "/meal" || command === "/food" || command === "/makan") {
    const parsed = parseExpenseText(text, member);
    return startExpense(tripId, user, member, chatId, parsed);
  }

  if (message.photo) return handlePhoto(tripId, message, member, user, chatId);

  return "I did not understand that yet. Use /help.";
}

async function handleCallback(tripId, callbackQuery) {
  const data = callbackQuery.data || "";
  const message = callbackQuery.message || {};
  const chatId = message.chat?.id;
  const messageId = message.message_id;
  const user = callbackQuery.from || {};
  logger.info(`Telegram callback received data=${data} chat=${String(chatId || "")} message=${messageId || ""} from=${user.id || ""}`);
  if (!chatId) return;
  if (ALLOWED_CHAT_ID && String(chatId) !== String(ALLOWED_CHAT_ID)) {
    await answerCallbackQuery(callbackQuery.id, "This bot is locked to a different group.");
    return;
  }

  if (data.startsWith("exp:")) {
    const [, action, expenseId, value] = data.split(":");
    if (!expenseId) return;

    if (action === "c") {
      await answerCallbackQuery(callbackQuery.id, "Confirming...");
      const member = await getMemberByTelegram(tripId, user);
      const result = await confirmExpense(tripId, expenseId, member);
      const editResponse = await editTelegramMessage(chatId, messageId, result.message);
      if (!editResponse?.ok) await sendTelegram(chatId, result.message);
      return;
    }

    let patch = null;
    if (action === "p") {
      patch = { payer: normalizeMemberName(value) };
    } else if (action === "s") {
      patch = splitUpdate(value);
    } else if (action === "m") {
      patch = { payment: paymentUpdate(value) };
    }

    if (!patch) {
      await answerCallbackQuery(callbackQuery.id, "Unknown action");
      await sendTelegram(chatId, "Unknown draft action.");
      return;
    }

    const draft = await updateDraftFromCallback(tripId, expenseId, patch);
    if (!draft) {
      await answerCallbackQuery(callbackQuery.id, "Draft not found");
      await sendTelegram(chatId, `No expense found for <code>${expenseId}</code>.`);
      return;
    }
    if (draft.alreadyConfirmed) {
      await answerCallbackQuery(callbackQuery.id, "Already confirmed");
      await sendTelegram(chatId, `Already confirmed <code>${expenseId}</code>.`);
      return;
    }
    const label = action === "p"
      ? `Payer set to ${draft.payer}.`
      : action === "s"
        ? `Split set to ${draft.split}.`
        : `Payment set to ${draft.payment}.`;
    await answerCallbackQuery(callbackQuery.id, label);
    const text = ocrDraftText(draft);
    const editResponse = await editTelegramMessage(chatId, messageId, text, { reply_markup: ocrDraftKeyboard(expenseId) });
    if (!editResponse?.ok) {
      await sendTelegram(chatId, `${label}\n\n${text}`, { reply_markup: ocrDraftKeyboard(expenseId) });
    }
    return;
  }

  await answerCallbackQuery(callbackQuery.id, "OK");

  if (data === "menu:help") {
    await sendTelegram(chatId, helpText(), { reply_markup: menuKeyboard() });
    return;
  }
  if (data === "menu:saldo") {
    await sendTelegram(chatId, settlementText(await settlement(tripId)), { reply_markup: menuKeyboard() });
    return;
  }
  if (data === "menu:who") {
    const snap = await tripRef(tripId).collection("members").get();
    const text = snap.empty
      ? "No members linked yet."
      : snap.docs.map((doc) => {
        const member = doc.data();
        return `${member.member}: ${member.displayName || member.telegramUsername || doc.id}`;
      }).join("\n");
    await sendTelegram(chatId, text, { reply_markup: menuKeyboard() });
    return;
  }
  if (data === "menu:expense") {
    await sendTelegram(chatId, [
      "<b>Add expense examples</b>",
      "<code>/expense meal 220000 paid TJ split 50/50</code>",
      "<code>/expense fuel 500000 paid EK split equal</code>",
      "",
      "<b>Detailed meal split</b>",
      "<code>/meal paid TJ split order tjfood 120000 ekfood 80000 shared 50000 tax 30000 place Warung Apple</code>",
      "",
      "<b>Custom final shares</b>",
      "<code>/expense food paid EK split custom customtj 150000 customek 90000 vendor La Luna</code>",
      "",
      "Optional keys: date 2026-06-14, place, vendor, payment, desc, note, notax."
    ].join("\n"), { reply_markup: menuKeyboard() });
    return;
  }
  if (data === "menu:ocr") {
    await sendTelegram(chatId, [
      "<b>Receipt OCR</b>",
      "Send a receipt photo to this group.",
      "If the bot does not respond, send the photo again with caption <code>/receipt</code>.",
      "The bot creates a draft expense.",
      "Then confirm it with:",
      "<code>/confirm</code>",
      "or <code>/confirm ocr-exp-...</code> from the OCR draft message."
    ].join("\n"), { reply_markup: menuKeyboard() });
    return;
  }
  if (data === "menu:unlink") {
    const unlinked = await unlinkMember(tripId, user);
    await sendTelegram(chatId, unlinked
      ? `Unlinked <b>${unlinked.member}</b> for ${unlinked.displayName || unlinked.telegramUsername || user.id}.`
      : "You are not linked yet.", { reply_markup: menuKeyboard() });
  }
}

exports.telegramWebhook = onRequest({ region: "asia-southeast2", timeoutSeconds: 60, memory: "512MiB" }, async (req, res) => {
  try {
    if (req.method !== "POST") return res.status(405).send("Method not allowed");
    if (WEBHOOK_SECRET && req.get("x-telegram-bot-api-secret-token") !== WEBHOOK_SECRET) {
      return res.status(401).send("Bad webhook secret");
    }
    const update = req.body || {};
    if (update.callback_query) {
      await handleCallback(TRIP_ID, update.callback_query);
      return res.json({ ok: true });
    }
    const message = update.message || update.edited_message;
    if (!message?.chat?.id) return res.json({ ok: true });
    const result = await handleCommand(TRIP_ID, message);
    if (typeof result === "string" && result) {
      await sendTelegram(message.chat.id, result);
    } else if (result?.text) {
      await sendTelegram(message.chat.id, result.text, result.extra || {});
    }
    return res.json({ ok: true });
  } catch (error) {
    logger.error(error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

function cors(req, res) {
  res.set("access-control-allow-origin", "*");
  res.set("access-control-allow-headers", "content-type,x-rtbali-sync-key");
  res.set("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
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

    if ((req.method === "POST" || req.method === "DELETE") && path === "expense/delete") {
      const expenseId = clean(req.query.id || req.body?.id);
      if (!expenseId) return res.status(400).json({ error: "Missing expense id" });
      const expenseRef = tripRef(tripId).collection("expenses").doc(expenseId);
      const snap = await expenseRef.get();
      const expense = snap.exists ? snap.data() : null;
      await expenseRef.delete();
      if (expense?.receiptId) {
        await tripRef(tripId).collection("receipts").doc(expense.receiptId).set({
          status: "deleted",
          deletedExpenseId: expenseId,
          updatedAt: nowField()
        }, { merge: true });
      }
      await tripRef(tripId).set({ updatedAt: nowField() }, { merge: true });
      return res.json({ ok: true, deletedExpenseId: expenseId, existed: Boolean(expense) });
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
      const importedExpenseIds = new Set();
      importedDb.expenses.forEach((expense) => {
        const expenseId = expense.id || id("web-exp");
        importedExpenseIds.add(expenseId);
        batch.set(tripRef(tripId).collection("expenses").doc(expenseId), {
          ...expense,
          id: expenseId,
          source: expense.source || "web",
          status: expense.status || "confirmed",
          createdAt: expense.createdAt || nowField(),
          updatedAt: nowField()
        }, { merge: true });
      });
      const existingExpenses = await tripRef(tripId).collection("expenses").get();
      let prunedExpenses = 0;
      existingExpenses.forEach((doc) => {
        if (importedExpenseIds.has(doc.id)) return;
        const expense = doc.data();
        batch.delete(doc.ref);
        prunedExpenses += 1;
        if (expense?.receiptId) {
          batch.set(tripRef(tripId).collection("receipts").doc(expense.receiptId), {
            status: "deleted",
            deletedExpenseId: doc.id,
            updatedAt: nowField()
          }, { merge: true });
        }
      });
      await batch.commit();
      return res.json({ ok: true, importedExpenses: importedDb.expenses.length, prunedExpenses });
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
