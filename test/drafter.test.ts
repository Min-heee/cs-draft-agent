import Anthropic from "@anthropic-ai/sdk";
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { ClaudeDrafter, DraftError } from "../src/agent/drafter.ts";
import { MockCafe24Client } from "../src/cafe24/mock.ts";
import type { Inquiry } from "../src/cafe24/types.ts";
import { ROOT } from "../src/config.ts";
import { PolicyStore } from "../src/knowledge/policies.ts";
import { loadSizeCharts } from "../src/sizing.ts";

// 실제 API를 부르지 않고, 미리 정해 둔 Messages API 응답을 돌려주는 fetch로 에이전트 루프를 검증한다.

const deps = {
  cafe24: new MockCafe24Client(path.join(ROOT, "data/mock")),
  policies: PolicyStore.fromDir(path.join(ROOT, "data/policies")),
  sizeCharts: loadSizeCharts(path.join(ROOT, "data/size-charts.json")),
};

const inquiry: Inquiry = {
  article_no: 1203, board_no: 4, product_no: 102, order_id: "20261020-0000123", member_id: "demo_user01",
  writer: "이*민", title: "배송 언제 되나요", content: "어제 오전에 주문했는데 언제 받을 수 있나요?",
  created_date: "2026-10-21T08:12:00+09:00",
};

const message = (content: unknown[], stop_reason: string) => ({
  id: `msg_${Math.random().toString(36).slice(2)}`,
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
});

const draftInput = {
  category: "배송",
  answer: "안녕하세요, 고객님. 주문하신 슬랙스는 어제 출고되어 배송중이며 보통 1~2영업일 안에 도착합니다.\n데모몰 CS팀 드림",
  confidence: "high",
  needs_human: false,
  human_reasons: [],
  sources: ["order:20261020-0000123", "shipping#택배사와 도착 시간"],
  internal_note: "",
};

function fakeClient(responses: unknown[]) {
  const requests: { headers: Headers; body: Record<string, unknown> }[] = [];
  const client = new Anthropic({
    apiKey: "test-key",
    maxRetries: 0,
    fetch: async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      const next = responses.shift();
      if (!next) throw new Error("응답이 더 없습니다");
      return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  return { client, requests };
}

test("도구로 주문을 확인하고 submit_draft에서 멈춘다 (추가 호출 없음)", async () => {
  const { client, requests } = fakeClient([
    message([{ type: "tool_use", id: "toolu_1", name: "get_order", input: { order_id: "20261020-0000123" } }], "tool_use"),
    message([{ type: "tool_use", id: "toolu_2", name: "submit_draft", input: draftInput }], "tool_use"),
  ]);
  const drafter = new ClaudeDrafter(deps, { model: "claude-opus-5-5", effort: "medium", client, now: () => new Date("2026-10-21T03:00:00Z") });
  const result = await drafter.draft(inquiry);

  assert.equal(requests.length, 2);
  assert.equal(result.category, "배송");
  assert.equal(result.needs_human, false);
  assert.deepEqual(result.trace.map((t) => t.tool), ["get_order", "submit_draft"]);
  assert.equal(result.input_tokens, 200);
  assert.equal(result.cache_read_tokens, 2000);

  const first = requests[0];
  assert.equal(first.body.model, "claude-opus-5-5");
  assert.equal(first.body.fallbacks, "default");
  assert.deepEqual(first.body.output_config, { effort: "medium" });
  assert.match(first.headers.get("anthropic-beta") ?? "", /server-side-fallback-2026-07-01/);
  assert.deepEqual((first.body.tools as { name: string }[]).map((t) => t.name), ["get_order", "get_product", "recommend_size", "search_policy", "submit_draft"]);
  assert.match(JSON.stringify(first.body.messages), /2026년 10월 21일/);

  // 두 번째 요청에는 주문 조회 결과가 tool_result로 들어간다.
  const toolResult = JSON.stringify((requests[1].body.messages as unknown[]).at(-1));
  assert.match(toolResult, /689412375501/);
});

test("submit_draft 없이 끝나면 오류로 남긴다", async () => {
  const { client } = fakeClient([message([{ type: "text", text: "답변입니다." }], "end_turn")]);
  const drafter = new ClaudeDrafter(deps, { model: "claude-opus-5-5", effort: "medium", client });
  await assert.rejects(() => drafter.draft(inquiry), (e: unknown) => e instanceof DraftError && /제출되지 않았습니다/.test(e.message));
});

test("거절(refusal)이면 직접 답하라고 알린다", async () => {
  const { client } = fakeClient([message([], "refusal")]);
  const drafter = new ClaudeDrafter(deps, { model: "claude-opus-5-5", effort: "medium", client });
  await assert.rejects(() => drafter.draft(inquiry), /거절했습니다/);
});

test("코드 안전 규칙은 Claude 초안에도 적용된다", async () => {
  const risky = { ...draftInput, answer: "10월 23일에 도착합니다. 데모몰 CS팀 드림", sources: ["order:20261020-0000123"] };
  const { client } = fakeClient([message([{ type: "tool_use", id: "toolu_1", name: "submit_draft", input: risky }], "tool_use")]);
  const drafter = new ClaudeDrafter(deps, { model: "claude-opus-5-5", effort: "medium", client, now: () => new Date("2026-10-21T03:00:00Z") });
  const result = await drafter.draft(inquiry);
  assert.equal(result.needs_human, true);
  assert.ok(result.human_reasons.some((r) => r.includes("날짜")));
});
