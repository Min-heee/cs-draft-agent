import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { buildTools } from "../src/agent/tools.ts";
import { MockCafe24Client } from "../src/cafe24/mock.ts";
import type { Cafe24Client, Inquiry } from "../src/cafe24/types.ts";
import { ROOT } from "../src/config.ts";
import type { TraceEntry } from "../src/db.ts";
import { PolicyStore } from "../src/knowledge/policies.ts";
import { loadSizeCharts } from "../src/sizing.ts";

const deps = {
  cafe24: new MockCafe24Client(path.join(ROOT, "data/mock")),
  policies: PolicyStore.fromDir(path.join(ROOT, "data/policies")),
  sizeCharts: loadSizeCharts(path.join(ROOT, "data/size-charts.json")),
};

const inquiry = (member_id: string | null): Inquiry => ({
  article_no: 1, board_no: 4, product_no: null, order_id: null, member_id,
  writer: "테스트", title: "t", content: "c", created_date: "2026-10-21T00:00:00+09:00",
});

// 도구 배열의 원소 타입은 다섯 도구 입력의 교집합이 되므로, 테스트에서는 입력 타입을 풀어 둔다.
function tool(member: string | null, name: string, trace: TraceEntry[] = []): { run(input: object): unknown } {
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

test("비회원 문의에서는 주문을 보여 주지 않는다 (작성자와 주문을 맞춰 볼 수 없음)", async () => {
  const trace: TraceEntry[] = [];
  await assert.rejects(
    () => Promise.resolve(tool(null, "get_order", trace).run({ order_id: "20261020-0000123" })),
    /비회원 문의라 작성자와 주문을 맞춰 볼 수 없습니다/,
  );
  assert.match(trace[0].output, /^오류:/);
  assert.doesNotMatch(trace[0].output, /배송/); // 주문 내용이 기록에도 남지 않는다
});

test("주문 조회 범위: 직원 모드는 제한 없음, 문의 범위는 그 회원의 주문만", async () => {
  const { createToolHandlers } = await import("../src/agent/tools.ts");
  const ORDER = { order_id: "20261020-0000123" }; // demo_user01의 주문
  // 직원 모드 MCP: 회원 ID가 없어도 보인다(저장할 때 save_draft가 확인한다)
  const staff = createToolHandlers(deps, { inquiry: false, memberId: null });
  assert.equal(JSON.parse(await staff.get_order(ORDER)).배송상태, "배송 중");
  // 문의 범위: 같은 회원이면 보이고, 다른 회원이나 비회원이면 거절한다
  const own = createToolHandlers(deps, { inquiry: true, memberId: "demo_user01" });
  assert.equal(JSON.parse(await own.get_order(ORDER)).배송상태, "배송 중");
  await assert.rejects(createToolHandlers(deps, { inquiry: true, memberId: "demo_user99" }).get_order(ORDER), /문의 작성자의 주문이 아닙니다/);
  await assert.rejects(createToolHandlers(deps, { inquiry: true, memberId: null }).get_order(ORDER), /비회원 문의라/);
});

test("문의 범위: 회원 문의라도 회원 ID가 비어 있는 주문(비회원 주문)은 보여 주지 않는다", async () => {
  const { createToolHandlers } = await import("../src/agent/tools.ts");
  const ORDER = { order_id: "20261020-0000123" };
  const order = (await deps.cafe24.getOrder(ORDER.order_id))!;
  // 목업 주문은 모두 회원 주문이라, 같은 주문의 회원 ID만 비운 카페24를 쓴다(실제 API는 빈 문자열일 수도 있다).
  for (const member_id of [null, ""]) {
    const cafe24: Cafe24Client = Object.assign(Object.create(deps.cafe24), { getOrder: async () => ({ ...order, member_id }) });
    const trace: TraceEntry[] = [];
    const guestOrder = buildTools({ ...deps, cafe24 }, inquiry("demo_user01"), trace).find((t) => t.name === "get_order");
    await assert.rejects(
      () => Promise.resolve((guestOrder as unknown as { run(input: object): unknown }).run(ORDER)),
      /회원 ID가 없는 주문\(비회원 주문\)이라 문의 작성자의 주문인지 맞춰 볼 수 없습니다/,
    );
    assert.doesNotMatch(trace[0].output, /배송/);
    // 직원 모드는 그대로 보인다
    const staff = createToolHandlers({ ...deps, cafe24 }, { inquiry: false, memberId: null });
    assert.equal(JSON.parse(await staff.get_order(ORDER)).배송상태, "배송 중");
  }
});

test("초안 기록에서 문의 범위 때문에 거절된 주문 조회를 찾는다", async () => {
  const { refusedOrderReasons } = await import("../src/agent/tools.ts");
  const ORDER = { order_id: "20261020-0000123" };
  const trace: TraceEntry[] = [];
  await assert.rejects(() => Promise.resolve(tool(null, "get_order", trace).run(ORDER)));
  await assert.rejects(() => Promise.resolve(tool("demo_user99", "get_order", trace).run(ORDER)));
  await tool("demo_user01", "get_order", trace).run(ORDER); // 자기 주문은 거절이 아니다
  await assert.rejects(() => Promise.resolve(tool("demo_user01", "get_order", trace).run({ order_id: "20261001-0009999" }))); // 없는 주문도 아니다
  assert.deepEqual(refusedOrderReasons(trace), [
    "[자동] 주문 조회가 거절됨(비회원 문의, 20261020-0000123): 작성자의 주문인지 직접 확인할 것",
    "[자동] 주문 조회가 거절됨(다른 회원의 주문, 20261020-0000123): 작성자의 주문인지 직접 확인할 것",
  ]);
  // claude -p 경로에서 "오류:"가 붙지 않고 문구만 와도 찾는다
  assert.equal(refusedOrderReasons([{ tool: "get_order", input: ORDER, output: trace[0].output.replace(/^오류: /, "") }]).length, 1);
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

test("사이즈 옵션이 없고 재고를 세지 않는 상품: 품절로 보지 않고, 사이즈별 재고는 모른다고 적는다 (bh044 샘플 상품)", async () => {
  const { createToolHandlers } = await import("../src/agent/tools.ts");
  const product = {
    product_no: 35, product_name: "릴렉스 무지 오버핏 셔츠", price: "54000.00", selling: "T" as const, sold_out: "F" as const,
    summary_description: "", product_material: "",
    variants: [{ variant_code: "P00000BJ000A", options: [], selling: "T" as const, quantity: 0, use_inventory: "F" as const }],
  };
  const cafe24: Cafe24Client = {
    listUnansweredInquiries: async () => [],
    listNewReviews: async () => [],
    listNewComments: async () => [],
    getProduct: async () => product,
    getOrder: async () => null,
    postReply: async () => ({ remote_id: "x" }),
  };
  const h = createToolHandlers({ ...deps, cafe24 }, { inquiry: false, memberId: null });
  const summary = JSON.parse(await h.get_product({ product_no: 35 }));
  assert.equal(summary.옵션재고[0].재고, "판매중(재고 수량을 관리하지 않는 상품)");
  assert.match(summary.옵션재고[0].옵션, /옵션 없음/);
  // 35번에는 101번 실측표를 복사해 두었다
  const rec = JSON.parse(await h.recommend_size({ product_no: 35, height_cm: 178, weight_kg: 105, usual_size: "3XL" }));
  assert.equal(rec.recommended, "3XL");
  assert.match(rec.inStock, /사이즈별 재고 정보 없음/);
  await assert.rejects(h.get_order({ order_id: "20261021-0000150" }), /찾을 수 없습니다/);
});
