import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { buildTools } from "../src/agent/tools.ts";
import { MockCafe24Client } from "../src/cafe24/mock.ts";
import type { Inquiry } from "../src/cafe24/types.ts";
import { ROOT } from "../src/config.ts";
import type { TraceEntry } from "../src/db.ts";
import { PolicyStore } from "../src/knowledge/policies.ts";
import { loadSizeCharts } from "../src/sizing.ts";

const deps = {
  cafe24: new MockCafe24Client(path.join(ROOT, "data/mock")),
  policies: PolicyStore.fromDir(path.join(ROOT, "data/policies")),
  sizeCharts: loadSizeCharts(path.join(ROOT, "data/size-charts.json")),
};

const inquiry = (member_id: string): Inquiry => ({
  article_no: 1, board_no: 4, product_no: null, order_id: null, member_id,
  writer: "테스트", title: "t", content: "c", created_date: "2026-10-21T00:00:00+09:00",
});

// 도구 배열의 원소 타입은 다섯 도구 입력의 교집합이 되므로, 테스트에서는 입력 타입을 풀어 둔다.
function tool(member: string, name: string, trace: TraceEntry[] = []): { run(input: object): unknown } {
  const found = buildTools(deps, inquiry(member), trace).find((t) => t.name === name);
  assert.ok(found, name);
  return found as unknown as { run(input: object): unknown };
}

test("에이전트에게 주는 도구 목록", () => {
  const names = buildTools(deps, inquiry("x"), []).map((t) => t.name);
  assert.deepEqual(names, ["get_order", "get_product", "recommend_size", "search_policy", "submit_draft"]);
});

test("get_order는 주문 상태와 송장을 요약해 돌려주고 호출을 기록한다", async () => {
  const trace: TraceEntry[] = [];
  const out = JSON.parse(String(await tool("demo_user01", "get_order", trace).run({ order_id: "20261020-0000123" })));
  assert.equal(out.배송상태, "배송 중");
  assert.equal(out.상품[0].송장, "CJ대한통운 689412375501");
  assert.equal(trace.length, 1);
  assert.equal(trace[0].tool, "get_order");
});

test("다른 회원의 주문은 보여 주지 않는다", async () => {
  const trace: TraceEntry[] = [];
  await assert.rejects(() => Promise.resolve(tool("demo_user99", "get_order", trace).run({ order_id: "20261020-0000123" })), /문의 작성자의 주문이 아닙니다/);
  assert.match(trace[0].output, /^오류:/);
});

test("없는 주문번호는 오류로 알린다", async () => {
  await assert.rejects(() => Promise.resolve(tool("demo_user19", "get_order").run({ order_id: "20261001-0009999" })), /찾을 수 없습니다/);
});

test("get_product는 재고를 수량 대신 상태로 알려 준다", async () => {
  const out = JSON.parse(String(await tool("x", "get_product").run({ product_no: 105 })));
  const stock = Object.fromEntries(out.옵션재고.map((o: { 옵션: string; 재고: string }) => [o.옵션, o.재고]));
  assert.equal(stock["사이즈=4XL"], "품절");
  assert.equal(stock["사이즈=2XL"], "재고 있음");
  assert.equal(out.실측표_cm[0].사이즈, "XL");
  assert.equal(out.기본기장_맞는키, undefined); // 상의에는 없다
});

test("get_product는 바지의 기본 기장이 맞는 키 범위를 알려 준다", async () => {
  const out = JSON.parse(String(await tool("x", "get_product").run({ product_no: 102 })));
  assert.equal(out.기본기장_맞는키, "175~182cm");
});

test("recommend_size는 카페24 재고까지 반영한다", async () => {
  const out = JSON.parse(String(await tool("x", "recommend_size").run({ product_no: 105, weight_kg: 115 })));
  assert.equal(out.recommended, "4XL");
  assert.equal(out.inStock["4XL"], false);
});

test("recommend_size는 사이즈 상담 원칙과 첫 사이즈 교환 무료 정책을 함께 돌려준다 (EVAL-CC)", async () => {
  const out = JSON.parse(String(await tool("x", "recommend_size").run({ product_no: 101, weight_kg: 105 })));
  assert.deepEqual(
    out.안내_원칙.map((p: { id: string }) => p.id),
    ["size-guide#상담 원칙", "exchange-return#첫 사이즈 교환 무료"],
  );
  assert.match(out.안내_원칙[0].text, /참고용/);
  assert.match(out.안내_원칙[1].text, /첫 사이즈 교환/);
});

test("search_policy는 섹션 ID를 돌려준다", async () => {
  const out = JSON.parse(String(await tool("x", "search_policy").run({ query: "기장 수선" })));
  assert.equal(out[0].id, "size-guide#기장 수선 서비스");
});
