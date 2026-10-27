import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Cafe24ApiClient } from "../src/cafe24/api.ts";

// 실제 카페24 응답 모양(bh044, 2026-10-27)을 흉내 낸 가짜 fetch로 클라이언트를 시험한다.
function client(responses: Record<string, unknown> | ((url: URL) => unknown), extra: { staffWriters?: string[]; token?: object } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "cafe24-api-"));
  const tokenFile = path.join(dir, "token.json");
  writeFileSync(tokenFile, JSON.stringify(extra.token ?? { access_token: "t", expires_at: "2999-01-01T00:00:00.000", refresh_token: "r", refresh_token_expires_at: "2999-01-01T00:00:00.000" }));
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
    if (typeof responses === "function") {
      const out = responses(url);
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out ?? {}), { status: 200 });
    }
    const key = Object.keys(responses).find((k) => url.pathname.endsWith(k));
    return new Response(JSON.stringify(key ? responses[key] : {}), { status: 200 });
  }) as typeof fetch;
  const c = new Cafe24ApiClient({ mallId: "test", clientId: "id", clientSecret: "s", boardNo: 6, reviewBoardNo: 4, tokenFile, replyWriter: "CS팀", clientIp: "127.0.0.1", staffWriters: extra.staffWriters });
  return { c, calls, bodies, tokenFile, done: () => { globalThis.fetch = original; rmSync(dir, { recursive: true, force: true }); } };
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

const comment = (no: number, articleNo: number, writer: string, content: string, parent: number | null = null) => ({
  shop_no: 1, board_no: 6, article_no: articleNo, comment_no: no, content, writer, member_id: "", created_date: "2026-10-27T15:10:00+09:00",
  client_ip: "1.2.3.4", rating: 0, secret: "F", parent_comment_no: parent, input_channel: "P", attach_file_urls: null,
});

// 원글 2 ← 우리 답글 29. 고객이 답글 29에 댓글 1을 달았고 우리가 댓글 2로 답했다. 고객이 댓글 3을 새로 달았다.
function commentBoard(url: URL) {
  if (url.pathname.endsWith("/boards/6/comments")) {
    return {
      comments: [
        comment(1, 29, "김*호", "그럼 4XL은요?"),
        comment(2, 29, "CS팀", "4XL도 있습니다.", 1),
        comment(3, 29, "김*호", "어깨가 넓은데 괜찮을까요?"),
      ],
    };
  }
  if (url.pathname.endsWith("/boards/4/comments")) return { comments: [] };
  if (url.pathname.endsWith("/boards/6/articles")) {
    const no = Number(url.searchParams.get("article_no"));
    if (no === 29) return { articles: [{ ...article(29, 2), writer: "CS팀", title: "RE: 사이즈 문의드려요", content: "안녕하세요, 고객님.<br>\n3XL을 권해 드립니다." }] };
    if (no === 2) return { articles: [{ ...article(2), title: "사이즈 문의드려요", content: "키 178에 105kg입니다.", order_id: "" }] };
  }
  return {};
}

test("고객 댓글: 답한 댓글과 우리 댓글은 빼고, 댓글이 달린 답글과 원글을 흐름에 넣는다", async () => {
  const { c, done } = client(commentBoard);
  try {
    const list = await c.listNewComments();
    assert.deepEqual(list.map((q) => q.comment_no), [3]);
    const [q] = list;
    assert.equal(q.kind, "comment");
    assert.equal(q.article_no, 6_000_000_003);
    assert.equal(q.parent_article_no, 29);
    assert.equal(q.title, "사이즈 문의드려요");
    assert.equal(q.product_no, 35);
    assert.equal(q.order_id, null);
    assert.equal(q.member_id, null);
    assert.equal(
      q.thread,
      "원글 · 김*호 · 사이즈 문의드려요\n키 178에 105kg입니다.\n\n답글 · CS팀 · RE: 사이즈 문의드려요\n안녕하세요, 고객님.\n3XL을 권해 드립니다.\n\n댓글 · 김*호\n그럼 4XL은요?\n\n댓글 · CS팀\n4XL도 있습니다.",
    );
  } finally {
    done();
  }
});

test("고객 댓글: 이미 문의함에 있는 댓글은 앞선 글을 다시 읽지 않는다", async () => {
  const { c, calls, done } = client(commentBoard);
  try {
    assert.deepEqual(await c.listNewComments(() => true), []);
    assert.ok(!calls.some((u) => u.includes("/articles")));
  } finally {
    done();
  }
});

test("고객 댓글에 답할 때는 댓글이 달린 글의 댓글 API에 parent_comment_no를 넣는다", async () => {
  const { c, calls, bodies, done } = client({ "/articles/29/comments": { comment: [{ comment_no: 4 }] } });
  try {
    const q = { ...article(6_000_000_003), kind: "comment" as const, comment_no: 3, parent_article_no: 29 };
    assert.equal((await c.postReply(q, "괜찮습니다.")).remote_id, "comment:4");
    assert.ok(calls.some((u) => u.startsWith("/api/v2/admin/boards/6/articles/29/comments")));
    const request = (bodies.at(-1) as { request: Record<string, unknown> }).request;
    assert.equal(request.parent_comment_no, 3);
    assert.equal(request.content, "괜찮습니다.");
    await assert.rejects(() => c.postReply({ ...q, parent_article_no: null }, "x"), /댓글이 달린 글 번호/);
  } finally {
    done();
  }
});

test("글 본문 HTML을 흐름용 텍스트로 바꾼다", async () => {
  const { articleText } = await import("../src/cafe24/comments.ts");
  assert.equal(articleText("<p>안녕하세요<br>\n3XL &lt;추천&gt; &amp; 4XL</p><p>둘째&nbsp;줄</p>"), "안녕하세요\n3XL <추천> & 4XL\n둘째 줄");
});

test("고객 댓글: 원글 주문번호는 원글을 쓴 회원 본인의 댓글에만 붙는다", async () => {
  const { commentInquiry } = await import("../src/cafe24/comments.ts");
  const root = { article_no: 3, writer: "덩치*", title: "허벅지 편해요", content: "좋아요", product_no: 104, order_id: "20261020-0000123", member_id: "demo_user01" };
  const c = (member: string) => ({ ...comment(1, 3, "누구", "저도 맞을까요?"), board_no: 4, member_id: member });
  assert.equal(commentInquiry(c("demo_user01"), root, null, []).order_id, "20261020-0000123");
  assert.equal(commentInquiry(c("demo_user99"), root, null, []).order_id, null); // 다른 회원
  assert.equal(commentInquiry(c(""), root, null, []).order_id, null); // 비회원
  assert.equal(commentInquiry(c(""), root, null, []).product_no, 104); // 상품은 그대로
});

test("고객 댓글: 직원 이름(CAFE24_STAFF_WRITERS)으로 단 댓글은 가져오지 않고, 그 아래 고객 댓글은 답한 것으로 본다", async () => {
  const board = (url: URL) =>
    url.pathname.endsWith("/boards/6/comments")
      ? { comments: [comment(5, 2, "김*호", "질문"), comment(6, 2, "운영자", "답", 5), comment(7, 2, "운영자", "공지성 댓글")] }
      : url.pathname.endsWith("/boards/6/articles") ? { articles: [article(2)] } : { comments: [] };
  const plain = client(board);
  try {
    assert.deepEqual((await plain.c.listNewComments()).map((q) => q.comment_no), [5, 6, 7]);
  } finally {
    plain.done();
  }
  const staff = client(board, { staffWriters: ["운영자"] });
  try {
    assert.deepEqual(await staff.c.listNewComments(), []);
  } finally {
    staff.done();
  }
});

test("고객 댓글: 앞선 글을 못 읽은 댓글만 건너뛰고, 같은 글은 한 번만 읽는다", async () => {
  const { c, calls, done } = client((url) => {
    if (url.pathname.endsWith("/boards/6/comments")) {
      return { comments: [comment(1, 2, "a", "첫 질문"), comment(2, 2, "b", "둘째 질문"), comment(3, 8, "c", "셋째 질문")] };
    }
    if (url.pathname.endsWith("/boards/4/comments")) return { comments: [] };
    if (url.searchParams.get("article_no") === "8") return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 503 });
    return { articles: [article(Number(url.searchParams.get("article_no")))] };
  });
  const original = console.error;
  console.error = () => {};
  try {
    assert.deepEqual((await c.listNewComments()).map((q) => q.comment_no), [1, 2]);
    assert.equal(calls.filter((u) => u.includes("article_no=2")).length, 1);
  } finally {
    console.error = original;
    done();
  }
});

test("토큰 갱신: 동시에 온 요청이 1회용 리프레시 토큰을 한 번만 쓴다", async () => {
  let refreshes = 0;
  const { c, tokenFile, done } = client(
    (url) => {
      if (url.pathname.endsWith("/oauth/token")) {
        refreshes++;
        return { access_token: "t2", expires_at: "2999-01-01T00:00:00.000", refresh_token: "r2", refresh_token_expires_at: "2999-01-01T00:00:00.000" };
      }
      return url.pathname.endsWith("/comments") ? { comments: [] } : { articles: [] };
    },
    { token: { access_token: "t1", expires_at: "2000-01-01T00:00:00.000", refresh_token: "r1", refresh_token_expires_at: "2999-01-01T00:00:00.000" } },
  );
  try {
    await Promise.all([c.listUnansweredInquiries(), c.listNewReviews(), c.listNewComments()]);
    assert.equal(refreshes, 1);
    assert.equal(JSON.parse(readFileSync(tokenFile, "utf8")).refresh_token, "r2");
  } finally {
    done();
  }
});

test("토큰 갱신: 다른 프로세스가 먼저 갱신해 실패하면 파일의 새 토큰을 쓴다", async () => {
  let tokenFileRef = "";
  const { c, tokenFile, done } = client(
    (url) => {
      if (url.pathname.endsWith("/oauth/token")) {
        // 다른 프로세스가 방금 r1을 써서 r2로 바꿔 둔 상황
        writeFileSync(tokenFileRef, JSON.stringify({ access_token: "t2", expires_at: "2999-01-01T00:00:00.000", refresh_token: "r2", refresh_token_expires_at: "2999-01-01T00:00:00.000" }));
        return new Response(JSON.stringify({ error_description: "Invalid refresh_token" }), { status: 400 });
      }
      return { articles: [] };
    },
    { token: { access_token: "t1", expires_at: "2000-01-01T00:00:00.000", refresh_token: "r1", refresh_token_expires_at: "2999-01-01T00:00:00.000" } },
  );
  tokenFileRef = tokenFile;
  try {
    assert.deepEqual(await c.listUnansweredInquiries(), []);
  } finally {
    done();
  }
});

test("고객 댓글: 한 게시판의 댓글 목록이 실패해도 다른 게시판에서 찾은 댓글은 넘긴다", async () => {
  const { PartialListError } = await import("../src/cafe24/types.ts");
  const { c, done } = client((url) => {
    if (url.pathname.endsWith("/boards/6/comments")) return { comments: [comment(1, 2, "김*호", "질문")] };
    if (url.pathname.endsWith("/boards/4/comments")) return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 500 });
    return { articles: [article(2)] };
  });
  try {
    await assert.rejects(
      () => c.listNewComments(),
      (e: unknown) => e instanceof PartialListError && e.partial.length === 1 && e.partial[0].comment_no === 1 && /게시판 4 댓글/.test(e.message),
    );
  } finally {
    done();
  }
});
