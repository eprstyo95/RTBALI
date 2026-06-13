"use strict";

// Keep module-load side effects (admin storage bucket, project id) happy offline.
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || "rtbali-test";
process.env.GOOGLE_CLOUD_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || "rtbali-test";
process.env.RTBALI_STORAGE_BUCKET = process.env.RTBALI_STORAGE_BUCKET || "rtbali-test.appspot.com";

const test = require("node:test");
const assert = require("node:assert/strict");

const { _internal } = require("../index.js");
const {
  num, splitUnits, shares, calcFromBillItems, expenseTotal,
  parseOcrLineItems, normalizeMemberName, ASSIGN
} = _internal;

test("num parses Indonesian thousands, currency, and junk", () => {
  assert.equal(num("Rp 1.500.000"), 1500000);
  assert.equal(num("36,000"), 36000);
  assert.equal(num("1234"), 1234);
  assert.equal(num(1500.5), 1500.5);
  assert.equal(num(""), 0);
  assert.equal(num("abc"), 0);
  assert.equal(num(null), 0);
});

test("normalizeMemberName maps aliases", () => {
  assert.equal(normalizeMemberName("tj"), "TJ");
  assert.equal(normalizeMemberName("Eko"), "TJ");
  assert.equal(normalizeMemberName("e"), "EK");
  assert.equal(normalizeMemberName("zzz"), "");
});

test("splitUnits defaults and overrides", () => {
  assert.deepEqual(splitUnits(), { TJ: 2.5, EK: 2.5, total: 5 });
  assert.deepEqual(splitUnits({ tjSplitUnits: 3, ekSplitUnits: 1 }), { TJ: 3, EK: 1, total: 4 });
});

test("shares: shared-by-units splits proportionally", () => {
  const s = shares({ amount: 100000, split: "Shared by Units", billSplitMode: "Off" });
  assert.equal(Math.round(s.TJ), 50000);
  assert.equal(Math.round(s.EK), 50000);
});

test("shares: TJ only / EK only / 50-50", () => {
  assert.deepEqual(shares({ amount: 100000, split: "TJ only" }), { TJ: 100000, EK: 0 });
  assert.deepEqual(shares({ amount: 100000, split: "EK only" }), { TJ: 0, EK: 100000 });
  assert.deepEqual(shares({ amount: 100000, split: "Equal 50/50" }), { TJ: 50000, EK: 50000 });
});

test("shares: custom TJ/EK passes through", () => {
  const s = shares({ billSplitMode: "Custom TJ/EK", customTJAmount: 150000, customEKAmount: 90000 });
  assert.deepEqual(s, { TJ: 150000, EK: 90000 });
});

test("shares: meal/order split spreads shared + tax proportionally", () => {
  const s = shares({
    billSplitMode: "Meal/order split",
    foodTJAmount: 120000, foodEKAmount: 80000, foodSharedAmount: 50000,
    taxServiceAmount: 30000, billIncludesTaxService: "Yes"
  });
  assert.equal(Math.round(s.TJ), 162400);
  assert.equal(Math.round(s.EK), 117600);
  assert.equal(Math.round(s.TJ + s.EK), 280000); // total conserved
});

test("shares: meal/order split honours billIncludesTaxService=No", () => {
  const s = shares({
    billSplitMode: "Meal/order split",
    foodTJAmount: 100000, foodEKAmount: 100000, foodSharedAmount: 0,
    taxServiceAmount: 30000, billIncludesTaxService: "No"
  });
  assert.equal(Math.round(s.TJ + s.EK), 200000);
});

test("calcFromBillItems buckets by assignment", () => {
  const out = calcFromBillItems({
    billItems: [
      { amount: 100, assign: ASSIGN.TJ },
      { amount: 200, assign: ASSIGN.EK },
      { amount: 300, assign: ASSIGN.BOTH },
      { amount: 50 } // unassigned -> shared
    ],
    billTax: 40
  });
  assert.equal(out.foodTJAmount, 100);
  assert.equal(out.foodEKAmount, 200);
  assert.equal(out.foodSharedAmount, 350);
  assert.equal(out.taxServiceAmount, 40);
  assert.equal(out.billSplitMode, "Meal/order split");
});

test("expenseTotal across modes", () => {
  assert.equal(expenseTotal({ amount: 75000 }), 75000);
  assert.equal(expenseTotal({ billSplitMode: "Custom TJ/EK", customTJAmount: 150000, customEKAmount: 90000 }), 240000);
  assert.equal(expenseTotal({
    billSplitMode: "Meal/order split",
    foodTJAmount: 100000, foodEKAmount: 50000, foodSharedAmount: 20000,
    taxServiceAmount: 10000, billIncludesTaxService: "Yes"
  }), 180000);
});

test("parseOcrLineItems extracts items, tax, total and reconciles", () => {
  const receipt = [
    "WARUNG TEST",
    "1 NASI GORENG 36.000",
    "2 ES TEH 16.000",
    "SUBTOTAL 52.000",
    "PB1 5.200",
    "TOTAL 57.200"
  ].join("\n");
  const r = parseOcrLineItems(receipt);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].name, "NASI GORENG");
  assert.equal(r.items[0].amount, 36000);
  assert.equal(r.items[1].qty, 2);
  assert.equal(r.taxAmount, 5200);
  assert.equal(r.total, 57200);
  assert.equal(r.itemsSum, 52000);
  assert.equal(r.reconciled, true);
});

test("parseOcrLineItems flags a misread amount (reconcile fails)", () => {
  const receipt = ["CAFE", "1 KOPI 2026", "TOTAL 25.000"].join("\n");
  const r = parseOcrLineItems(receipt);
  assert.equal(r.reconciled, false);
});
