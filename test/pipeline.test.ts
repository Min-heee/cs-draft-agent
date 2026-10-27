import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { FakeDrafter } from "../src/agent/drafter.ts";
import { MockCafe24Client } from "../src/cafe24/mock.ts";
import { ROOT } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { computeMetrics } from "../src/metrics.ts";
import { Pipeline } from "../src/pipeline.ts";
import { createApp } from "../src/server.ts";

let dir: string;
let store: Store;
let cafe24: MockCafe24Client;
let pipeline: Pipeline;

const goodDraft = new FakeDrafter((q) => ({
  category: "배송",
  answer: `안녕하세요, 고객님. ${q.title} 문의에 답변드립니다.\n데모몰 CS팀 드림`,
  confidence: "high",
  needs_human: q.article_no === 1207,
  human_reasons: q.article_no === 1207 ? ["불량 주장"] : [],
  sources: ["shipping#출고 시간"],
  internal_note: "",
}));

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "cs-draft-"));
  store = new Store(path.join(dir, "test.db"));
  cafe24 = new MockCafe24Client(path.join(ROOT, "data/mock"));
  pipeline = new Pipeline(store, cafe24, goodDraft, 3);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("불러오기는 새 문의만 넣는다", async () => {
  assert.equal(await pipeline.sync(), 16);
  assert.equal(await pipeline.sync(), 0);
});

test("초안을 만들고, 그대로 승인하면 카페24에 등록된다", async () => {
  await pipeline.sync();
  await pipeline.draftPending();
  assert.equal(store.countByStatus().drafted, 16);

  const result = await pipeline.review(1203, { decision: "approve", openedAt: Date.now() - 30_000 });
  assert.equal(result.action, "approve");
  assert.equal(result.reply?.status, "posted");
  assert.equal(cafe24.posted[0].article_no, 1203);
  const review = store.latestReview(1203)!;
  assert.equal(review.edit_ratio, 0);
  assert.ok(review.review_seconds >= 29 && review.review_seconds < 60);
});

test("고쳐서 승인하면 수정 후 승인과 수정률이 남는다", async () => {
  await pipeline.sync();
  await pipeline.draftPending();
  const draft = store.latestDraft(1205)!;
  const edited = draft.answer.replace("답변드립니다", "자세히 답변드립니다");
  const result = await pipeline.review(1205, { decision: "approve", answer: edited, openedAt: Date.now() });
  assert.equal(result.action, "edit_approve");
  assert.ok(store.latestReview(1205)!.edit_ratio! > 0);
  assert.equal(cafe24.posted[0].content, edited.trim());
});

test("반려하면 아무것도 등록하지 않는다", async () => {
  await pipeline.sync();
  await pipeline.draftPending();
  await pipeline.review(1207, { decision: "reject", openedAt: Date.now(), rejectReason: "사진 받고 직접 처리" });
  assert.equal(store.getInquiry(1207)!.status, "rejected");
  assert.equal(cafe24.posted.length, 0);
  await assert.rejects(() => pipeline.review(1207, { decision: "approve", openedAt: Date.now() }), /검토할 수 없는 상태/);
});

test("카페24 등록이 실패해도 승인은 남고, 다시 등록할 수 있다", async () => {
  await pipeline.sync();
  await pipeline.draftPending();
  const original = cafe24.postReply.bind(cafe24);
  cafe24.postReply = async () => {
    throw new Error("카페24 API 503: Service Unavailable");
  };
  const result = await pipeline.review(1203, { decision: "approve", openedAt: Date.now() });
  assert.equal(result.reply?.status, "failed");
  assert.equal(store.getInquiry(1203)!.status, "approved");

  cafe24.postReply = original;
  assert.equal((await pipeline.retryReply(1203)).status, "posted");
  await assert.rejects(() => pipeline.retryReply(1203), /이미 등록된/);
});

test("초안 작성이 실패하면 오류 상태와 이유가 남는다", async () => {
  pipeline = new Pipeline(store, cafe24, { draft: async () => Promise.reject(new Error("rate limited")) }, 2);
  await pipeline.sync();
  await pipeline.draftPending();
  assert.equal(store.countByStatus().error, 16);
  assert.equal(store.getInquiry(1201)!.error, "rate limited");
});

test("지표: 승인률, 수정률, 확인 필요 비율", async () => {
  await pipeline.sync();
  await pipeline.draftPending();
  await pipeline.review(1201, { decision: "approve", openedAt: Date.now() - 20_000 });
  await pipeline.review(1202, { decision: "approve", answer: "완전히 새로 쓴 답변", openedAt: Date.now() - 40_000 });
  await pipeline.review(1207, { decision: "reject", openedAt: Date.now() - 60_000 });
  const m = computeMetrics(store, 4);
  assert.equal(m.reviewed, 3);
  assert.equal(m.approvedAsIs, 1);
  assert.equal(m.editedApproved, 1);
  assert.equal(m.rejected, 1);
  assert.ok(Math.abs(m.asIsRate! - 1 / 3) < 1e-9);
  assert.ok(m.medianReviewSeconds! >= 39 && m.medianReviewSeconds! < 45);
  assert.ok(Math.abs(m.humanFlagRate! - 1 / 16) < 1e-9);
  assert.ok(m.savedMinutes! > 0);
});

test("화면: 문의함과 검토 화면이 뜨고, 고객 글의 HTML은 이스케이프된다", async () => {
  store.addInquiries([
    {
      article_no: 9001, board_no: 4, product_no: null, order_id: null, member_id: "x",
      writer: "공격자", title: "<script>alert(1)</script>", content: "<img src=x onerror=alert(1)>",
      created_date: "2026-10-21T12:00:00+09:00",
    },
  ]);
  await pipeline.draftPending();
  const app = createApp({ store, pipeline, modeLabel: "테스트", baselineMinutes: null });

  const inbox = await (await app.request("/inbox")).text();
  assert.ok(inbox.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!inbox.includes("<script>alert(1)"));

  const detail = await app.request("/inquiries/9001");
  assert.equal(detail.status, 200);
  const page = await detail.text();
  assert.ok(page.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(page.includes("승인하고 등록"));

  const form = new URLSearchParams({ decision: "approve", opened_at: String(Date.now()) });
  const res = await app.request("/inquiries/9001/review", {
    method: "POST",
    body: form,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  assert.equal(res.status, 302);
  assert.equal(store.getInquiry(9001)!.status, "approved");

  const metrics = await app.request("/metrics");
  assert.equal(metrics.status, 200);
});
