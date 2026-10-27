import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { MockCafe24Client } from "../src/cafe24/mock.ts";
import { ROOT } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { PolicyStore } from "../src/knowledge/policies.ts";
import { createMcpServer, type McpOptions } from "../src/mcp/server.ts";
import { loadSizeCharts } from "../src/sizing.ts";

const deps = {
  cafe24: new MockCafe24Client(path.join(ROOT, "data/mock")),
  policies: PolicyStore.fromDir(path.join(ROOT, "data/policies")),
  sizeCharts: loadSizeCharts(path.join(ROOT, "data/size-charts.json")),
};
const NOW = () => new Date("2026-10-21T03:00:00Z");

let dir: string;
let store: Store;

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "cs-mcp-"));
  store = new Store(path.join(dir, "test.db"));
  store.addInquiries(await deps.cafe24.listUnansweredInquiries());
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function connect(options: McpOptions) {
  const server = createMcpServer(deps, { now: NOW, ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { text: string }[]).map((c) => c.text).join("");
    return { text, isError: result.isError === true };
  };
  return { client, call };
}

const draft = {
  category: "배송",
  answer: "안녕하세요, 고객님.\n주문하신 슬랙스는 배송 중이며 보통 1~2영업일 안에 도착합니다.\n데모몰 CS팀 드림",
  confidence: "high",
  needs_human: false,
  human_reasons: [],
  sources: ["order:20261020-0000123", "shipping#택배사와 도착 시간"],
  internal_note: "",
};

test("문의 한 건 모드: 읽기 도구 4개만 보이고 그 회원의 주문만 조회된다", async () => {
  const { client, call } = await connect({ scope: { memberId: "demo_user01" } });
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(names, ["get_order", "get_product", "recommend_size", "search_policy"]);

  const own = await call("get_order", { order_id: "20261020-0000123" });
  assert.equal(own.isError, false);
  assert.match(own.text, /배송중/);

  const other = await call("get_order", { order_id: "20261014-0000087" });
  assert.equal(other.isError, true);
  assert.match(other.text, /문의 작성자의 주문이 아닙니다/);
});

test("입력 스키마는 MCP에서도 검증된다", async () => {
  const { call } = await connect({ scope: { memberId: null } });
  const bad = await call("get_product", { product_no: "백일" });
  assert.equal(bad.isError, true);
});

test("직원 모드: 새 문의 목록을 보고 초안을 저장하면 검토 대기로 바뀐다", async () => {
  const { client, call } = await connect({ scope: { memberId: null }, store, reviewUrl: "http://localhost:3000" });
  assert.ok((await client.listTools()).tools.some((t) => t.name === "save_draft"));

  const list = JSON.parse((await call("list_inquiries", {})).text);
  assert.equal(list.length, 16);

  const inquiry = JSON.parse((await call("get_inquiry", { article_no: 1203 })).text);
  assert.equal(inquiry.title, "배송 언제 되나요");
  assert.equal(inquiry.member_id, undefined); // 회원 ID는 모델에게 보여 주지 않는다

  const saved = await call("save_draft", { article_no: 1203, ...draft });
  assert.equal(saved.isError, false, saved.text);
  assert.match(saved.text, /localhost:3000\/inquiries\/1203/);
  assert.equal(store.getInquiry(1203)!.status, "drafted");
  const stored = store.latestDraft(1203)!;
  assert.equal(stored.model, "mcp:test-client");
  assert.equal(stored.needs_human, false);
});

test("직원 모드: 다른 회원의 주문을 근거로 쓴 초안은 담당자 확인으로 넘긴다", async () => {
  const { call } = await connect({ scope: { memberId: null }, store });
  // 1201 작성자(demo_user11)가 아닌 demo_user01의 주문을 근거로 씀
  const saved = await call("save_draft", { article_no: 1201, ...draft });
  assert.equal(saved.isError, false);
  const stored = store.latestDraft(1201)!;
  assert.equal(stored.needs_human, true);
  assert.ok(stored.human_reasons.some((r) => r.includes("다른 회원의 주문")));
});

test("직원 모드: 근거 형식이 달라도, 답변에만 나와도 다른 회원의 주문을 잡는다 (2차 평가)", async () => {
  const { call } = await connect({ scope: { memberId: null }, store });
  await call("save_draft", { article_no: 1202, ...draft, sources: ["get_order:20261020-0000123", "policy:shipping#합배송"] });
  assert.ok(store.latestDraft(1202)!.human_reasons.some((r) => r.includes("다른 회원의 주문") && r.includes("20261020-0000123")));

  await call("save_draft", {
    article_no: 1205,
    ...draft,
    answer: "안녕하세요, 고객님.\n주문(20261014-0000087)은 배송완료 상태입니다.\n데모몰 CS팀 드림",
    sources: ["product-care#면 티셔츠 수축"],
  });
  assert.ok(store.latestDraft(1205)!.human_reasons.some((r) => r.includes("20261014-0000087")));

  // 자기 주문은 형식이 달라도 통과
  await call("save_draft", { article_no: 1203, ...draft, sources: ["get_order:20261020-0000123"] });
  assert.equal(store.latestDraft(1203)!.needs_human, false);
});

test("직원 모드: 날짜 규칙 같은 코드 안전장치도 똑같이 적용된다", async () => {
  const { call } = await connect({ scope: { memberId: null }, store });
  await call("save_draft", { article_no: 1206, ...draft, answer: "10월 25일에 재입고됩니다.", sources: ["restock-and-misc#재입고"] });
  assert.ok(store.latestDraft(1206)!.human_reasons.some((r) => r.includes("2026-10-25")));
});

test("직원 모드: 이미 처리한 문의에는 초안을 저장하지 않는다", async () => {
  store.setStatus(1205, "approved");
  const { call } = await connect({ scope: { memberId: null }, store });
  const saved = await call("save_draft", { article_no: 1205, ...draft });
  assert.equal(saved.isError, true);
});

test("draft_replies 프롬프트에 작업 순서와 오늘 날짜가 들어 있다", async () => {
  const { client } = await connect({ scope: { memberId: null }, store });
  const prompt = await client.getPrompt({ name: "draft_replies", arguments: {} });
  const text = (prompt.messages[0].content as { text: string }).text;
  assert.match(text, /save_draft/);
  assert.match(text, /2026년 10월 21일/);
  assert.doesNotMatch(text, /submit_draft/);
});
