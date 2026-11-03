import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

async function connect(options: McpOptions, toolDeps = deps) {
  const server = createMcpServer(toolDeps, { now: NOW, ...options });
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
  const { client, call } = await connect({ scope: { inquiry: true, memberId: "demo_user01" } });
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.deepEqual(names, ["get_order", "get_product", "recommend_size", "search_policy"]);

  const own = await call("get_order", { order_id: "20261020-0000123" });
  assert.equal(own.isError, false);
  assert.match(own.text, /배송중/);

  const other = await call("get_order", { order_id: "20261014-0000087" });
  assert.equal(other.isError, true);
  assert.match(other.text, /문의 작성자의 주문이 아닙니다/);
});

test("문의 한 건 모드: 비회원 문의면 주문을 보여 주지 않는다", async () => {
  const { call } = await connect({ scope: { inquiry: true, memberId: null } });
  const result = await call("get_order", { order_id: "20261020-0000123" });
  assert.equal(result.isError, true);
  assert.match(result.text, /비회원 문의라 작성자와 주문을 맞춰 볼 수 없습니다/);
  assert.doesNotMatch(result.text, /배송/);
});

test("직원 모드: 문의와 상관없이 직접 조회하면 회원 제한 없이 주문이 보인다", async () => {
  const { call } = await connect({ scope: { inquiry: false, memberId: null }, store });
  const result = await call("get_order", { order_id: "20261020-0000123" });
  assert.equal(result.isError, false, result.text);
  assert.match(result.text, /배송 중/);
});

test("실행 파일: CS_SCOPE=inquiry에 회원 ID가 비어 있으면 비회원 문의로 보고, 범위 변수가 없으면 직원 모드다", async () => {
  // ClaudeCodeDrafter가 넘기는 환경 변수 그대로 src/mcp/main.ts를 띄운다.
  async function getOrder(scope: Record<string, string>) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(ROOT, "src/mcp/main.ts")],
      env: { PATH: process.env.PATH ?? "", CAFE24_MODE: "mock", DB_FILE: path.join(dir, "main.db"), ...scope },
      stderr: "ignore",
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: "get_order", arguments: { order_id: "20261020-0000123" } });
      return { text: (result.content as { text: string }[]).map((c) => c.text).join(""), isError: result.isError === true };
    } finally {
      await client.close();
    }
  }
  const guest = await getOrder({ CS_SCOPE: "inquiry", CS_MEMBER_ID: "" });
  assert.equal(guest.isError, true);
  assert.match(guest.text, /비회원 문의라/);
  const member = await getOrder({ CS_SCOPE: "inquiry", CS_MEMBER_ID: "demo_user01" });
  assert.equal(member.isError, false, member.text);
  const other = await getOrder({ CS_SCOPE: "inquiry", CS_MEMBER_ID: "demo_user99" });
  assert.match(other.text, /문의 작성자의 주문이 아닙니다/);
  const staff = await getOrder({});
  assert.equal(staff.isError, false, staff.text);
});

test("입력 스키마는 MCP에서도 검증된다", async () => {
  const { call } = await connect({ scope: { inquiry: false, memberId: null } });
  const bad = await call("get_product", { product_no: "백일" });
  assert.equal(bad.isError, true);
});

test("직원 모드: 새 문의 목록을 보고 초안을 저장하면 검토 대기로 바뀐다", async () => {
  const { client, call } = await connect({ scope: { inquiry: false, memberId: null }, store, reviewUrl: "http://localhost:3000" });
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
  const { call } = await connect({ scope: { inquiry: false, memberId: null }, store });
  // 1201 작성자(demo_user11)가 아닌 demo_user01의 주문을 근거로 씀
  const saved = await call("save_draft", { article_no: 1201, ...draft });
  assert.equal(saved.isError, false);
  const stored = store.latestDraft(1201)!;
  assert.equal(stored.needs_human, true);
  assert.ok(stored.human_reasons.some((r) => r.includes("다른 회원의 주문")));
});

test("직원 모드: 근거 형식이 달라도, 답변에만 나와도 다른 회원의 주문을 잡는다 (2차 평가)", async () => {
  const { call } = await connect({ scope: { inquiry: false, memberId: null }, store });
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

test("직원 모드: 비회원 문의에 주문을 근거로 쓴 초안은 담당자 확인으로 넘긴다", async () => {
  store.addInquiries([
    { article_no: 1290, board_no: 4, product_no: 102, order_id: null, member_id: null, writer: "비회원",
      title: "배송 문의", content: "주문번호 20261020-0000123 언제 오나요?", created_date: "2026-10-21T09:00:00+09:00" },
  ]);
  const { call } = await connect({ scope: { inquiry: false, memberId: null }, store });
  const saved = await call("save_draft", { article_no: 1290, ...draft });
  assert.equal(saved.isError, false, saved.text);
  const stored = store.latestDraft(1290)!;
  assert.equal(stored.needs_human, true);
  assert.ok(stored.human_reasons.some((r) => r.includes("비회원 문의") && r.includes("20261020-0000123")));
});

test("직원 모드: 비회원 문의에 주문번호가 있으면 초안에서 주문번호를 빼도 담당자 확인으로 넘긴다", async () => {
  store.addInquiries([
    { article_no: 1291, board_no: 4, product_no: 102, order_id: null, member_id: null, writer: "비회원",
      title: "배송 문의", content: "주문번호 20261020-0000123 언제 오나요?", created_date: "2026-10-21T09:00:00+09:00" },
    { article_no: 1292, board_no: 4, product_no: 102, order_id: "20261020-0000123", member_id: null, writer: "비회원",
      title: "배송 문의", content: "언제 오나요?", created_date: "2026-10-21T09:00:00+09:00" },
    { article_no: 1293, board_no: 4, product_no: 102, order_id: null, member_id: null, writer: "비회원",
      title: "세탁 문의", content: "건조기 써도 되나요?", created_date: "2026-10-21T09:00:00+09:00" },
  ]);
  const { call } = await connect({ scope: { inquiry: false, memberId: null }, store });
  // 주문 조회 결과(배송 중)만 쓰고 주문번호는 뺀 초안
  const noOrderId = { ...draft, sources: ["shipping#택배사와 도착 시간"] };
  for (const article_no of [1291, 1292]) {
    await call("save_draft", { article_no, ...noOrderId });
    const stored = store.latestDraft(article_no)!;
    assert.equal(stored.needs_human, true, String(article_no));
    assert.ok(stored.human_reasons.some((r) => r.includes("비회원 문의에 주문번호가 있음(20261020-0000123)")), String(article_no));
  }
  // 주문번호가 없는 비회원 문의는 그대로 둔다
  await call("save_draft", { article_no: 1293, ...noOrderId });
  assert.equal(store.latestDraft(1293)!.needs_human, false);
});

test("직원 모드: 회원 문의라도 회원 ID가 비어 있는 주문(비회원 주문)을 근거로 쓰면 담당자 확인으로 넘긴다", async () => {
  const order = (await deps.cafe24.getOrder("20261020-0000123"))!;
  const cafe24 = Object.assign(Object.create(deps.cafe24), { getOrder: async () => ({ ...order, member_id: "" }) });
  const { call } = await connect({ scope: { inquiry: false, memberId: null }, store }, { ...deps, cafe24 });
  await call("save_draft", { article_no: 1203, ...draft });
  const stored = store.latestDraft(1203)!;
  assert.equal(stored.needs_human, true);
  assert.ok(stored.human_reasons.some((r) => r.includes("회원 ID가 없는 주문(비회원 주문)") && r.includes("20261020-0000123")));
});

test("직원 모드: 날짜 규칙 같은 코드 안전장치도 똑같이 적용된다", async () => {
  const { call } = await connect({ scope: { inquiry: false, memberId: null }, store });
  await call("save_draft", { article_no: 1206, ...draft, answer: "10월 25일에 재입고됩니다.", sources: ["restock-and-misc#재입고"] });
  assert.ok(store.latestDraft(1206)!.human_reasons.some((r) => r.includes("2026-10-25")));
});

test("직원 모드: 이미 처리한 문의에는 초안을 저장하지 않는다", async () => {
  store.setStatus(1205, "approved");
  const { call } = await connect({ scope: { inquiry: false, memberId: null }, store });
  const saved = await call("save_draft", { article_no: 1205, ...draft });
  assert.equal(saved.isError, true);
});

test("draft_replies 프롬프트에 작업 순서와 오늘 날짜가 들어 있다", async () => {
  const { client } = await connect({ scope: { inquiry: false, memberId: null }, store });
  const prompt = await client.getPrompt({ name: "draft_replies", arguments: {} });
  const text = (prompt.messages[0].content as { text: string }).text;
  assert.match(text, /save_draft/);
  assert.match(text, /2026년 10월 21일/);
  assert.doesNotMatch(text, /submit_draft/);
});
