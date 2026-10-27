import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { FakeDrafter } from "../src/agent/drafter.ts";
import { MockCafe24Client } from "../src/cafe24/mock.ts";
import { commentKey } from "../src/cafe24/types.ts";
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

// 목업은 상품 Q&A 문의 16건, 상품 후기 11건, 고객 댓글 3건이다.
const ALL = 30;
const COMMENT = commentKey(4, 1); // 후기 1301에 다른 고객이 단 사이즈 질문

test("불러오기는 새 문의만 넣는다", async () => {
  assert.equal(await pipeline.sync(), ALL);
  assert.equal(await pipeline.sync(), 0);
});

test("상품 후기는 종류와 별점이 함께 저장되고, 승인하면 댓글로 등록된다", async () => {
  await pipeline.sync();
  const review = store.getInquiry(1302)!;
  assert.equal(review.kind, "review");
  assert.equal(review.rating, 2);
  assert.equal(store.getInquiry(1201)!.kind, "qna");
  await pipeline.draftPending();
  const result = await pipeline.review(1302, { decision: "approve", openedAt: Date.now() - 10_000 });
  assert.equal(result.reply?.status, "posted");
  assert.equal(cafe24.posted.at(-1)!.article_no, 1302);
});

test("후기 칸이 없던 예전 DB도 열면 칸이 더해진다", () => {
  const file = path.join(dir, "old.db");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE inquiries (article_no INTEGER PRIMARY KEY, board_no INTEGER NOT NULL, product_no INTEGER,
    order_id TEXT, member_id TEXT, writer TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
    created_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', error TEXT, synced_at TEXT NOT NULL)`);
  old.exec(`INSERT INTO inquiries VALUES (1, 6, NULL, NULL, NULL, 'a', 't', 'c', '2026-10-21', 'new', NULL, '2026-10-21')`);
  old.close();
  const migrated = new Store(file);
  assert.equal(migrated.getInquiry(1)!.kind, "qna");
  migrated.addInquiries([{ article_no: 2, board_no: 4, product_no: null, order_id: null, member_id: null,
    writer: "b", title: "t", content: "c", created_date: "2026-10-21", kind: "review", rating: 5 }]);
  assert.equal(migrated.getInquiry(2)!.rating, 5);
  migrated.addInquiries([{ article_no: commentKey(4, 9), board_no: 4, product_no: null, order_id: null, member_id: null,
    writer: "c", title: "t", content: "댓글", created_date: "2026-10-21", kind: "comment", comment_no: 9, parent_article_no: 2, thread: "원글" }]);
  assert.equal(migrated.getInquiry(commentKey(4, 9))!.thread, "원글");
  assert.equal(migrated.addNotification({ article_no: 2, type: "arrived", message: "새 후기" }), 1);
  migrated.close();
});

test("고객 댓글은 댓글이 달린 글과 함께 저장되고, 승인하면 그 댓글 아래로 등록된다", async () => {
  await pipeline.sync();
  const q = store.getInquiry(COMMENT)!;
  assert.equal(q.kind, "comment");
  assert.equal(q.parent_article_no, 1301);
  assert.equal(q.comment_no, 1);
  assert.equal(q.product_no, 104); // 댓글이 달린 후기의 상품
  assert.match(q.thread!, /원글 · 덩치\* · 허벅지 편해요/);
  assert.equal(q.title, "허벅지 편해요");
  await pipeline.draftPending();
  const result = await pipeline.review(COMMENT, { decision: "approve", openedAt: Date.now() });
  assert.equal(result.reply?.status, "posted");
  assert.equal(cafe24.posted.at(-1)!.article_no, COMMENT);
  // 다시 불러와도 같은 댓글은 새로 들어오지 않는다.
  assert.equal(await pipeline.sync(), 0);
});

test("알림: 새 글, 초안 준비, 확인 필요, 등록 완료가 차례로 남는다", async () => {
  await pipeline.sync();
  const arrived = store.notificationsAfter(0, 100);
  assert.equal(arrived.length, ALL);
  assert.ok(arrived.every((n) => n.type === "arrived"));
  assert.ok(arrived.some((n) => n.message.startsWith("새 후기 ★2 · ")));
  assert.ok(arrived.some((n) => n.message.startsWith("새 댓글 · 저도 175에 105kg")));

  const last = store.lastNotificationId();
  await pipeline.draftPending();
  const drafted = store.notificationsAfter(last, 100);
  assert.equal(drafted.length, ALL);
  assert.deepEqual(drafted.filter((n) => n.type === "needs_human").map((n) => n.article_no), [1207]);

  await pipeline.review(1203, { decision: "approve", openedAt: Date.now() });
  assert.equal(store.recentNotifications(1)[0].type, "posted");
  // 글 하나에 알림이 셋(새 글·초안 준비·등록 완료) 있어도 읽지 않은 글은 하나로 센다.
  assert.equal(store.unreadCount(), ALL);
  store.markNotificationsRead(1203);
  assert.equal(store.unreadCount(), ALL - 1);
  assert.ok(!store.unreadArticles().has(1203));
  store.addNotification({ article_no: null, type: "sync_failed", message: "새 글 확인 실패 · 401" });
  store.addNotification({ article_no: null, type: "sync_failed", message: "새 글 확인 실패 · 500" });
  assert.equal(store.unreadCount(), ALL + 1);
  store.markNotificationsRead();
  assert.equal(store.unreadCount(), 0);
});

test("셋 중 하나가 실패해도 가져온 글은 저장하고, 실패를 SyncError로 알린다", async () => {
  cafe24.listNewComments = async () => {
    throw new Error("카페24 API 503: Service Unavailable");
  };
  const { SyncError } = await import("../src/pipeline.ts");
  await assert.rejects(() => pipeline.sync(), (e: unknown) => e instanceof SyncError && e.added === 27 && /503/.test(e.message));
  assert.equal(store.countByStatus().new, 27);
  assert.ok(store.getInquiry(1201) && store.getInquiry(1301) && !store.getInquiry(COMMENT));
});

test("댓글 목록이 일부만 실패하면 그 전에 찾은 댓글도 저장한다", async () => {
  const { PartialListError } = await import("../src/cafe24/types.ts");
  const comments = await cafe24.listNewComments();
  cafe24.listNewComments = async () => {
    throw new PartialListError("게시판 4 댓글: 500", comments.slice(0, 1));
  };
  await assert.rejects(() => pipeline.sync(), /게시판 4 댓글: 500/);
  assert.equal(store.countByStatus().new, 28); // 문의 16 + 후기 11 + 댓글 1
  assert.ok(store.getInquiry(COMMENT));
});

test("화면: DB를 새로 만들어 알림 번호가 줄면 /api/live가 처음부터 다시 준다", async () => {
  await pipeline.sync();
  const app = createApp({ store, pipeline, modeLabel: "테스트", baselineMinutes: null });
  const live = (await (await app.request("/api/live?after=999")).json()) as { reset: boolean; lastId: number; notifications: unknown[] };
  assert.equal(live.reset, true);
  assert.equal(live.notifications.length, ALL);
  assert.equal(live.lastId, ALL);
  const normal = (await (await app.request(`/api/live?after=${ALL}&db=${store.dbId}`)).json()) as { reset: boolean; notifications: unknown[] };
  assert.equal(normal.reset, false);
  assert.equal(normal.notifications.length, 0);
  // 번호가 같아도 DB가 바뀌었으면 처음부터 다시 준다.
  const other = (await (await app.request(`/api/live?after=${ALL}&db=old-db`)).json()) as { reset: boolean; dbId: string; notifications: unknown[] };
  assert.equal(other.reset, true);
  assert.equal(other.dbId, store.dbId);
  assert.equal(other.notifications.length, ALL);
});

test("목업 시연 모드(MOCK_DRIP)는 확인할 때마다 작성 순서대로 조금씩 내놓는다", async () => {
  pipeline = new Pipeline(store, new MockCafe24Client(path.join(ROOT, "data/mock"), { drip: 2 }), goodDraft, 3);
  assert.equal(await pipeline.sync(), 2);
  assert.ok(store.getInquiry(1201) && store.getInquiry(1202)); // 가장 먼저 쓴 두 문의
  assert.equal(await pipeline.sync(), 2);
  let total = 4;
  for (let added = await pipeline.sync(); added > 0; added = await pipeline.sync()) total += added;
  assert.equal(total, ALL);
});

test("초안을 만들고, 그대로 승인하면 카페24에 등록된다", async () => {
  await pipeline.sync();
  await pipeline.draftPending();
  assert.equal(store.countByStatus().drafted, ALL);

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
  assert.equal(store.countByStatus().error, ALL);
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
  assert.ok(Math.abs(m.humanFlagRate! - 1 / ALL) < 1e-9);
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
  assert.ok(inbox.includes(".table > * + *") && inbox.includes('"Apple SD Gothic Neo"')); // CSS는 그대로 들어간다
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

test("화면: 고객 댓글은 댓글이 달린 글을 함께 보여 주고, 종류로 거를 수 있다", async () => {
  await pipeline.sync();
  await pipeline.draftPending();
  const app = createApp({ store, pipeline, modeLabel: "테스트", baselineMinutes: null });
  const page = await (await app.request(`/inquiries/${COMMENT}`)).text();
  assert.ok(page.includes("댓글이 달린 글"));
  assert.ok(page.includes("#1301 글에 달린 댓글"));
  assert.ok(page.includes("승인하고 댓글 등록"));
  const comments = await (await app.request("/inbox?tab=review&kind=comment")).text();
  assert.equal(comments.match(/role="listitem"/g)?.length, 3);
  assert.equal(comments.match(/chip kind-comment/g)?.length, 3);
  assert.ok(!comments.includes("chip kind-review"));
});

test("화면: /api/live는 새 알림만 주고, 글을 열면 그 글의 알림이 읽음이 된다", async () => {
  await pipeline.sync();
  const app = createApp({ store, pipeline, modeLabel: "테스트", baselineMinutes: null });
  const first = (await (await app.request("/api/live?after=0")).json()) as {
    lastId: number; notifications: { article_no: number; link: string }[]; unread: number; counts: Record<string, number>;
    watch: { text: string; tone: string };
  };
  assert.equal(first.notifications.length, ALL);
  assert.equal(first.unread, ALL);
  assert.equal(first.counts.working, ALL);
  assert.equal(first.watch.tone, "off");
  assert.ok(first.notifications.some((n) => n.link === `/inquiries/${COMMENT}`));

  const again = (await (await app.request(`/api/live?after=${first.lastId}`)).json()) as { lastId: number; notifications: unknown[] };
  assert.equal(again.notifications.length, 0);
  assert.equal(again.lastId, first.lastId);

  await app.request("/inquiries/1201");
  const after = (await (await app.request(`/api/live?after=${first.lastId}`)).json()) as { unread: number };
  assert.equal(after.unread, ALL - 1);

  const res = await app.request("/notifications/read", { method: "POST", headers: { Accept: "application/json" } });
  assert.equal(res.status, 200);
  assert.equal(store.unreadCount(), 0);
});

test("화면: 목록 조각, 알림 화면, 화면 스크립트가 뜬다", async () => {
  await pipeline.sync();
  const app = createApp({ store, pipeline, modeLabel: "테스트", baselineMinutes: null });
  const fragment = await (await app.request("/inbox?tab=working&fragment=1")).text();
  assert.ok(!fragment.includes("<html"));
  assert.ok(fragment.includes(`전체<span class="n">${ALL}</span>`)); // 종류별 개수도 같이 새로 받는다
  assert.equal(fragment.match(/role="listitem"/g)?.length, ALL);
  assert.ok(fragment.includes('class="new-dot"'));
  const notifications = await app.request("/notifications");
  assert.equal(notifications.status, 200);
  assert.ok((await notifications.text()).includes("새 후기 ★2"));
  const js = await app.request("/static/admin.js");
  assert.match(js.headers.get("Content-Type")!, /javascript/);
  assert.ok((await js.text()).includes("/api/live"));
});

test("화면: 상품 후기에는 별점 칩과 '승인하고 댓글 등록' 버튼이 보인다", async () => {
  await pipeline.sync();
  await pipeline.draftPending();
  const app = createApp({ store, pipeline, modeLabel: "테스트", baselineMinutes: null });
  const inbox = await (await app.request("/inbox")).text();
  assert.ok(inbox.includes("후기 ★★"));
  const page = await (await app.request("/inquiries/1302")).text();
  assert.ok(page.includes("승인하고 댓글 등록"));
  assert.ok(!(await (await app.request("/inquiries/1201")).text()).includes("댓글 등록"));
});
