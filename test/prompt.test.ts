import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSystemPrompt, userMessage } from "../src/agent/prompt.ts";
import type { Inquiry } from "../src/cafe24/types.ts";

const TODAY = new Date("2026-10-21T06:30:00Z");
const base: Inquiry = {
  article_no: 1, board_no: 6, product_no: 35, order_id: null, member_id: null,
  writer: "김*호", title: "제목", content: "내용", created_date: "2026-10-21T10:00:00+09:00",
};

test("문의와 후기는 사용자 메시지에서 글 종류가 다르게 나온다", () => {
  assert.match(userMessage(base, TODAY), /글 종류: 상품 Q&A 문의/);
  const review = userMessage({ ...base, board_no: 4, kind: "review", rating: 2 }, TODAY);
  assert.match(review, /글 종류: 상품 후기 \(별점 2\/5\)/);
  assert.match(review, /댓글 초안/);
});

test("시스템 프롬프트에는 후기 댓글 규칙이 모든 경로에 똑같이 들어간다", () => {
  for (const mode of ["api", "structured", "mcp"] as const) {
    const prompt = buildSystemPrompt(mode);
    assert.match(prompt, /## 상품 후기에 다는 댓글/);
    assert.match(prompt, /후기 게시판의 글은 교환·반품 신청이 아닙니다/);
  }
});
