import { commentKey, type BoardComment, type Inquiry } from "./types.ts";

// 고객 댓글을 문의함에 넣을 한 건(kind=comment)으로 바꾼다. 실제 API와 목업이 같이 쓴다.

/** 댓글이 달린 글. 답글이면 parent_article_no에 원글 번호가 있다. */
export type ThreadArticle = Pick<Inquiry, "article_no" | "writer" | "title" | "content" | "product_no" | "order_id" | "member_id"> & {
  parent_article_no?: number | null;
};

const THREAD_LIMIT = 4000;

/** 게시판 글 본문(HTML)을 흐름에 넣을 텍스트로 바꾼다. 답글은 줄바꿈을 <br>로 바꿔 올렸다(toArticleHtml). */
export function articleText(html: string): string {
  return html
    .replace(/<br\s*\/?>\s*/gi, "\n")
    .replace(/<\/p>\s*/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * @param article 댓글이 달린 글 (못 찾았으면 null)
 * @param original article이 답글일 때 그 원글
 * @param all 같은 게시판의 댓글 목록. 같은 글에 먼저 달린 댓글을 흐름에 넣는다.
 */
export function commentInquiry(
  comment: BoardComment,
  article: ThreadArticle | null,
  original: ThreadArticle | null,
  all: BoardComment[],
): Inquiry {
  const earlier = all
    .filter((c) => c.article_no === comment.article_no && c.comment_no < comment.comment_no)
    .sort((a, b) => a.comment_no - b.comment_no);
  const thread = [
    original ? `원글 · ${original.writer} · ${original.title}\n${articleText(original.content)}` : null,
    article ? `${original ? "답글" : "원글"} · ${article.writer} · ${article.title}\n${articleText(article.content)}` : null,
    ...earlier.map((c) => `댓글 · ${c.writer}\n${c.content}`),
  ]
    .filter(Boolean)
    .join("\n\n");
  const root = original ?? article;
  // 원글의 주문번호는 원글을 쓴 회원 본인이 단 댓글일 때만 물려받는다. 다른 고객(비회원 포함)이 남의 후기에
  // 단 댓글에 원글 주문번호를 넘기면, 회원 확인 없이 남의 주문을 조회해 공개 댓글에 쓸 수 있다.
  const sameMember = Boolean(comment.member_id) && comment.member_id === root?.member_id;
  return {
    article_no: commentKey(comment.board_no, comment.comment_no),
    board_no: comment.board_no,
    product_no: root?.product_no || null,
    order_id: sameMember ? root?.order_id || null : null,
    member_id: comment.member_id || null,
    writer: comment.writer,
    title: root?.title ?? `글 #${comment.article_no}의 댓글`,
    content: comment.content,
    created_date: comment.created_date,
    kind: "comment",
    rating: null,
    comment_no: comment.comment_no,
    parent_article_no: comment.article_no,
    // 앞쪽(원글)이 가장 중요하니 넘치면 뒤를 자른다.
    thread: thread ? thread.slice(0, THREAD_LIMIT) : null,
  };
}
