import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Cafe24ApiClient } from "../src/cafe24/api.ts";

// 실제 카페24 응답 모양(bh044, 2026-10-27)을 흉내 낸 가짜 fetch로 클라이언트를 시험한다.
function client(responses: Record<string, unknown>) {
  const dir = mkdtempSync(path.join(tmpdir(), "cafe24-api-"));
  const tokenFile = path.join(dir, "token.json");
  writeFileSync(tokenFile, JSON.stringify({ access_token: "t", expires_at: "2999-01-01T00:00:00.000", refresh_token: "r", refresh_token_expires_at: "2999-01-01T00:00:00.000" }));
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const key = Object.keys(responses).find((k) => url.pathname.endsWith(k));
    return new Response(JSON.stringify(key ? responses[key] : {}), { status: 200 });
  }) as typeof fetch;
  const c = new Cafe24ApiClient({ mallId: "test", clientId: "id", clientSecret: "s", boardNo: 6, reviewBoardNo: 4, tokenFile, replyWriter: "CS팀", clientIp: "127.0.0.1" });
  return { c, calls, done: () => { globalThis.fetch = original; rmSync(dir, { recursive: true, force: true }); } };
}

const article = (no: number, parent: number | null = null) => ({
  article_no: no, parent_article_no: parent, board_no: 6, product_no: 35, order_id: null, member_id: null,
  writer: "김*호", title: `글 ${no}`, content: "내용", created_date: "2026-10-27T14:45:39+09:00", reply_status: null, rating: null,
});

test("답글이 달린 원글은 미답변에서 뺀다 (reply_status가 바뀌지 않아도)", async () => {
  const { c, done } = client({ "/boards/6/articles": { articles: [article(2), article(4), article(29, 2)] } });
  try {
    const list = await c.listUnansweredInquiries();
    assert.deepEqual(list.map((a) => a.article_no), [4]);
  } finally {
    done();
  }
});

test("없는 주문번호는 200 {order:{}}로 와도 null, 옵션 없는 상품은 options를 빈 배열로", async () => {
  const { c, done } = client({
    "/orders/20261021-0000150": { order: {} },
    "/products/35/variants": { variants: [{ variant_code: "A", options: null, selling: "T", quantity: 0, use_inventory: "F" }] },
    "/products/35": { product: { product_no: 35, product_name: "셔츠", price: "54000.00", selling: "T" } },
  });
  try {
    assert.equal(await c.getOrder("20261021-0000150"), null);
    const product = await c.getProduct(35);
    assert.deepEqual(product!.variants[0].options, []);
    assert.equal(product!.variants[0].use_inventory, "F");
  } finally {
    done();
  }
});

test("후기에는 댓글 API로, 문의에는 답글로 등록한다", async () => {
  const { c, calls, done } = client({
    "/articles/3/comments": { comment: [{ comment_no: 1 }] },
    "/boards/6/articles": { articles: [{ article_no: 29 }] },
  });
  try {
    const review = { ...article(3), board_no: 4, kind: "review" as const, rating: 5 };
    assert.equal((await c.postReply(review, "감사합니다")).remote_id, "comment:1");
    assert.equal((await c.postReply(article(2), "답변")).remote_id, "29");
    assert.ok(calls.some((u) => u.includes("/boards/4/articles/3/comments")));
  } finally {
    done();
  }
});

test("답글 본문은 HTML로 바꿔 줄바꿈을 지키고 특수문자는 이스케이프한다", async () => {
  const { toArticleHtml } = await import("../src/cafe24/api.ts");
  assert.equal(toArticleHtml("안녕하세요, 고객님.\n3XL <추천> & 4XL"), "안녕하세요, 고객님.<br>\n3XL &lt;추천&gt; &amp; 4XL");
});
