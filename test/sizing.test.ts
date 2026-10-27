import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { ROOT } from "../src/config.ts";
import { loadSizeCharts, normalizeTopSize, recommendSize } from "../src/sizing.ts";

const charts = loadSizeCharts(path.join(ROOT, "data/size-charts.json"));
const shirt = charts.get(101)!;
const slacks = charts.get(102)!;
const denim = charts.get(104)!;
const cardigan = charts.get(105)!;

test("평소 사이즈 표기를 통일한다", () => {
  assert.equal(normalizeTopSize("XXXL"), "3XL");
  assert.equal(normalizeTopSize("xl"), "XL");
  assert.equal(normalizeTopSize("115"), "3XL");
  assert.equal(normalizeTopSize("3xl"), "3XL");
  assert.equal(normalizeTopSize("특대"), null);
});

test("178cm·105kg·평소 3XL·어깨 넓음 → 셔츠 3XL, 대안 4XL (2XL 아님)", () => {
  const r = recommendSize(shirt, { heightCm: 178, weightKg: 105, usualSize: "3XL", bodyNotes: ["broad_upper"] });
  assert.equal(r.recommended, "3XL");
  assert.equal(r.alternative, "4XL");
  assert.equal(r.confidence, "high");
  assert.equal(r.measurements?.["가슴 단면"], 71);
});

test("120kg는 셔츠 4XL과 5XL 권장 범위에 걸쳐 있어 둘 다 알려 준다", () => {
  const r = recommendSize(shirt, { weightKg: 120 });
  assert.equal(r.recommended, "4XL");
  assert.equal(r.alternative, "5XL");
});

test("허리 40인치·키 170 → 슬랙스 40, 기장이 길 수 있다고 알린다", () => {
  const r = recommendSize(slacks, { heightCm: 170, waistInch: 40 });
  assert.equal(r.recommended, "40");
  assert.equal(r.confidence, "medium");
  assert.ok(r.reasons.some((x) => x.includes("40인치")));
});

test("바지는 키를 기본 기장이 맞는 키 범위와 비교해 기장 안내를 준다 (EVAL-CC 1202)", () => {
  assert.equal(
    recommendSize(slacks, { heightCm: 170, waistInch: 40 }).lengthNote,
    "키 170cm는 기본 기장이 수선 없이 맞는 키(175~182cm)보다 작아 총장 106cm가 길 수 있음",
  );
  assert.match(recommendSize(slacks, { heightCm: 178, waistInch: 40 }).lengthNote!, /안이라 총장 106cm를 수선 없이/);
  assert.match(recommendSize(slacks, { heightCm: 188, waistInch: 40 }).lengthNote!, /커서 총장 106cm가 짧을 수 있음/);
  assert.match(recommendSize(denim, { heightCm: 175, weightKg: 100 }).lengthNote!, /174~181cm\) 안이라 총장 105cm/);
  // 키를 모르거나 상의면 기장 안내를 하지 않는다
  assert.equal(recommendSize(slacks, { waistInch: 40 }).lengthNote, null);
  assert.equal(recommendSize(shirt, { heightCm: 178, weightKg: 105 }).lengthNote, null);
});

test("허리보다 작은 바지는 추천하지 않는다", () => {
  const r = recommendSize(slacks, { waistInch: 41, weightKg: 100 });
  assert.equal(r.recommended, "42");
});

test("허벅지가 굵으면 데님 한 사이즈 큰 것도 제안한다", () => {
  const r = recommendSize(denim, { heightCm: 175, weightKg: 100, bodyNotes: ["thick_thigh"] });
  assert.equal(r.recommended, "38");
  assert.equal(r.alternative, "40");
  assert.ok(r.caveats.some((x) => x.includes("허벅지 단면 37.5cm")));
});

test("추천 사이즈가 품절이면 알린다", () => {
  const r = recommendSize(cardigan, { weightKg: 115 }, (size) => size !== "4XL");
  assert.equal(r.recommended, "4XL");
  assert.equal(r.inStock["4XL"], false);
  assert.ok(r.caveats.some((x) => x.includes("품절")));
});

test("체형 정보가 없으면 추천하지 않고 되물으라고 한다", () => {
  const r = recommendSize(shirt, { heightCm: 180 });
  assert.equal(r.recommended, null);
  assert.equal(r.confidence, "low");
});

test("모든 권장 범위를 크게 벗어나면 확신도 낮음", () => {
  const r = recommendSize(cardigan, { weightKg: 150 });
  assert.equal(r.recommended, "4XL");
  assert.equal(r.confidence, "low");
});
