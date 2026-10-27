import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { commentInquiry, type ThreadArticle } from "./comments.ts";
import {
  commentKey,
  isComment,
  PartialListError,
  isReview,
  type BoardComment,
  type Cafe24Client,
  type Inquiry,
  type Order,
  type Product,
  type ReplyResult,
  type Variant,
} from "./types.ts";

// 카페24 Admin REST API 클라이언트.
// 테스트 쇼핑몰 bh044에 연결해 확인했다(2026-10-27). 실제 응답이 문서와 달랐던 점은 docs/LIVE-BH044.md에 있다.
//
// 필요한 권한(scope): mall.read_community, mall.write_community, mall.read_order, mall.read_product

const API_VERSION = "2026-09-01";

export interface Cafe24ApiConfig {
  mallId: string;
  clientId: string;
  clientSecret: string;
  /** 상품 Q&A 게시판 번호 (GET /admin/boards 에서 board_type 5 중 이름으로 확인) */
  boardNo: number;
  /** 상품 후기 게시판 번호. 없으면 후기는 가져오지 않는다. */
  reviewBoardNo?: number;
  /** 액세스·리프레시 토큰을 저장하는 파일. 리프레시 토큰은 한 번만 쓸 수 있어서 갱신할 때마다 새 값을 저장해야 한다. */
  tokenFile: string;
  replyWriter: string;
  /**
   * 카페24 관리자 화면에서 직원이 댓글을 달 때 쓰는 이름들(replyWriter 말고 더 있으면).
   * 이 이름으로 단 댓글은 고객 댓글로 가져오지 않고, 그 아래 고객 댓글은 답한 것으로 본다.
   */
  staffWriters?: string[];
  /** 답글 등록 API가 요구하는 작성자 IP */
  clientIp: string;
}

interface TokenSet {
  access_token: string;
  expires_at: string;
  refresh_token: string;
  refresh_token_expires_at: string;
}

/**
 * 게시판 글 본문은 HTML이라 줄바꿈이 사라진다(bh044에서 답글이 한 문단으로 붙어 보임, 2026-10-27).
 * 특수문자를 이스케이프한 뒤 줄바꿈을 <br>로 바꾼다. 댓글은 카페24가 줄바꿈을 직접 <br>로 바꾸므로 그대로 보낸다.
 */
export function toArticleHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, "<br>\n");
}

export class Cafe24ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`카페24 API ${status}: ${message}`);
    this.status = status;
  }
}

/** 한 번 확인할 때 앞선 글을 새로 읽어 올 고객 댓글 수. 나머지는 다음 확인 때 가져온다(호출 한도). */
const NEW_COMMENTS_PER_CHECK = 20;

export class Cafe24ApiClient implements Cafe24Client {
  private readonly config: Cafe24ApiConfig;
  private readonly base: string;
  private readonly staff: Set<string>;
  /** 갱신 중인 토큰. 동시에 온 요청이 1회용 리프레시 토큰을 한 번만 쓰도록 같이 기다린다. */
  private refreshing: Promise<string> | null = null;

  constructor(config: Cafe24ApiConfig) {
    this.config = config;
    this.base = `https://${config.mallId}.cafe24api.com/api/v2`;
    this.staff = new Set([config.replyWriter, ...(config.staffWriters ?? [])]);
  }

  async listUnansweredInquiries(): Promise<Inquiry[]> {
    // reply_status는 API로 단 답글을 반영하지 않는다(답글을 달아도 원글이 null로 남는다, bh044에서 확인 2026-10-27).
    // 그래서 같은 목록 안에 답글(parent_article_no)이 달린 원글을 답한 것으로 본다.
    const data = await this.request<{ articles: (Inquiry & { parent_article_no: number | null })[] }>(
      "GET",
      `/admin/boards/${this.config.boardNo}/articles`,
      { query: { limit: "100" } },
    );
    const answered = new Set(data.articles.map((a) => a.parent_article_no).filter((n): n is number => Boolean(n)));
    return data.articles
      .filter((a) => !a.parent_article_no && !answered.has(a.article_no))
      .map((a) => ({
        article_no: a.article_no,
        board_no: a.board_no,
        product_no: a.product_no || null,
        order_id: a.order_id || null,
        member_id: a.member_id || null,
        writer: a.writer,
        title: a.title,
        content: a.content,
        created_date: a.created_date,
      }));
  }

  async listNewReviews(): Promise<Inquiry[]> {
    if (!this.config.reviewBoardNo) return [];
    const data = await this.request<{
      articles: (Inquiry & { parent_article_no: number | null; rating: number | null })[];
    }>("GET", `/admin/boards/${this.config.reviewBoardNo}/articles`, { query: { limit: "100" } });
    return data.articles
      .filter((a) => !a.parent_article_no)
      .map((a) => ({
        article_no: a.article_no,
        board_no: a.board_no,
        product_no: a.product_no || null,
        order_id: a.order_id || null,
        member_id: a.member_id || null,
        writer: a.writer,
        title: a.title,
        content: a.content,
        created_date: a.created_date,
        kind: "review" as const,
        rating: a.rating ?? null,
      }));
  }

  async listNewComments(isKnown: (key: number) => boolean = () => false): Promise<Inquiry[]> {
    const found: Inquiry[] = [];
    const failed: string[] = [];
    let budget = NEW_COMMENTS_PER_CHECK;
    for (const boardNo of [this.config.boardNo, this.config.reviewBoardNo]) {
      if (!boardNo) continue;
      let comments: BoardComment[];
      try {
        ({ comments } = await this.request<{ comments: BoardComment[] }>("GET", `/admin/boards/${boardNo}/comments`, {
          query: { limit: "100" },
        }));
      } catch (error) {
        // 한 게시판이 실패해도 다른 게시판에서 찾은 댓글은 넘긴다.
        failed.push(`게시판 ${boardNo} 댓글: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      // 고객 댓글에는 그 댓글 아래(parent_comment_no)에 답한다. 그렇게 단 직원 댓글이 있으면 답한 것으로 본다.
      const ours = (c: BoardComment) => this.staff.has(c.writer);
      const answered = new Set(comments.filter(ours).map((c) => c.parent_comment_no).filter((n): n is number => Boolean(n)));
      const fresh = comments.filter((c) => !ours(c) && !answered.has(c.comment_no) && !isKnown(commentKey(boardNo, c.comment_no)));
      // 같은 글에 댓글이 여럿이면 앞선 글을 한 번만 읽는다.
      const articles = new Map<number, Promise<ThreadArticle | null>>();
      const findArticle = (no: number) => {
        if (!articles.has(no)) articles.set(no, this.findArticle(boardNo, no));
        return articles.get(no)!;
      };
      for (const c of fresh) {
        if (budget-- <= 0) {
          console.warn(`[comments] 새 고객 댓글이 많아 ${NEW_COMMENTS_PER_CHECK}건만 가져왔습니다. 나머지는 다음 확인 때 가져옵니다.`);
          break;
        }
        try {
          const article = await findArticle(c.article_no);
          const original = article?.parent_article_no ? await findArticle(article.parent_article_no) : null;
          found.push(commentInquiry({ ...c, board_no: boardNo }, article, original, comments));
        } catch (error) {
          // 앞선 글을 못 읽은 댓글은 이번에는 건너뛴다. 저장하지 않았으니 다음 확인 때 다시 시도한다.
          console.error(`[comments] 게시판 ${boardNo} 댓글 ${c.comment_no}의 앞선 글을 읽지 못했습니다:`, error);
        }
      }
      if (budget < 0) break;
    }
    if (failed.length) throw new PartialListError(failed.join(" / "), found);
    return found;
  }

  /** 글 한 건을 읽는 API는 없어서(404 No API found) 목록을 글 번호로 거른다 (bh044에서 확인, 2026-10-27). */
  private async findArticle(boardNo: number, articleNo: number): Promise<ThreadArticle | null> {
    const { articles } = await this.request<{ articles: ThreadArticle[] }>("GET", `/admin/boards/${boardNo}/articles`, {
      query: { article_no: String(articleNo) },
    });
    return articles.find((a) => a.article_no === articleNo) ?? null;
  }

  async getOrder(orderId: string): Promise<Order | null> {
    try {
      const { order } = await this.request<{ order: Partial<Order> }>("GET", `/admin/orders/${encodeURIComponent(orderId)}`, {
        query: { embed: "items" },
      });
      // 없는 주문번호도 404가 아니라 200 {"order":{}}로 온다 (bh044에서 확인, 2026-10-27).
      if (!order.order_id) return null;
      return { ...(order as Order), items: order.items ?? [] };
    } catch (error) {
      if (error instanceof Cafe24ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async getProduct(productNo: number): Promise<Product | null> {
    try {
      const { product } = await this.request<{ product: Omit<Product, "variants"> }>("GET", `/admin/products/${productNo}`);
      const { variants } = await this.request<{ variants: (Variant & { inventories?: { quantity: number } })[] }>(
        "GET",
        `/admin/products/${productNo}/variants`,
        { query: { embed: "inventories" } },
      );
      return {
        ...product,
        // 옵션이 없는 상품은 options가 null로 온다 (bh044 샘플 상품에서 확인, 2026-10-27).
        variants: variants.map((v) => ({ ...v, options: v.options ?? [], quantity: v.inventories?.quantity ?? v.quantity })),
      };
    } catch (error) {
      if (error instanceof Cafe24ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async postReply(inquiry: Inquiry, content: string): Promise<ReplyResult> {
    if (isComment(inquiry)) {
      if (!inquiry.parent_article_no || !inquiry.comment_no) throw new Error("댓글이 달린 글 번호나 댓글 번호가 없습니다.");
      return this.postComment(inquiry.board_no, inquiry.parent_article_no, content, inquiry.comment_no);
    }
    if (isReview(inquiry)) return this.postComment(inquiry.board_no, inquiry.article_no, content);
    // 원글에 답글(reply_article_no)로 등록한다. 쇼핑몰 게시판 설정에 따라 댓글
    // (POST .../articles/{article_no}/comments)이 공식 답변일 수도 있으니 연결 후 확인할 것.
    const data = await this.request<{ articles: { article_no: number }[] }>(
      "POST",
      `/admin/boards/${inquiry.board_no}/articles`,
      {
        body: {
          shop_no: 1,
          requests: [
            {
              writer: this.config.replyWriter,
              title: `RE: ${inquiry.title}`.slice(0, 256),
              content: toArticleHtml(content),
              client_ip: this.config.clientIp,
              reply_article_no: inquiry.article_no,
              product_no: inquiry.product_no ?? undefined,
            },
          ],
        },
      },
    );
    return { remote_id: String(data.articles[0].article_no) };
  }

  /**
   * 상품 후기와 고객 댓글에는 댓글로 단다. 후기 댓글은 bh044에서 등록해 확인했다(2026-10-27).
   * 고객 댓글 아래에 다는 댓글(parent_comment_no)은 아직 실제로 등록해 보지 않았다.
   * 문서상 댓글 등록에는 비밀번호가 필요해서, 쓰지 않는 임의 값을 넣는다(관리자는 비밀번호 없이 지울 수 있다).
   */
  private async postComment(boardNo: number, articleNo: number, content: string, parentCommentNo?: number): Promise<ReplyResult> {
    const data = await this.request<{ comment?: { comment_no: number }[] | { comment_no: number } }>(
      "POST",
      `/admin/boards/${boardNo}/articles/${articleNo}/comments`,
      {
        body: {
          shop_no: 1,
          request: {
            writer: this.config.replyWriter,
            content,
            password: randomBytes(9).toString("base64url"),
            client_ip: this.config.clientIp,
            ...(parentCommentNo ? { parent_comment_no: parentCommentNo } : {}),
          },
        },
      },
    );
    const comment = Array.isArray(data.comment) ? data.comment[0] : data.comment;
    return { remote_id: `comment:${comment?.comment_no ?? "?"}` };
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    options: { query?: Record<string, string>; body?: unknown } = {},
    retried = false,
  ): Promise<T> {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        "Content-Type": "application/json",
        "X-Cafe24-Api-Version": API_VERSION,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    // 호출 한도(초당 2회씩 비워지는 40칸 버킷)를 넘으면 429. 한 번만 잠깐 쉬고 다시 시도한다.
    if (response.status === 429 && !retried) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return this.request<T>(method, path, options, true);
    }
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Cafe24ApiError(response.status, body?.error?.message ?? response.statusText);
    }
    return (await response.json()) as T;
  }

  private readTokens(): TokenSet {
    const { tokenFile } = this.config;
    if (!existsSync(tokenFile)) {
      throw new Error(`카페24 토큰 파일이 없습니다: ${tokenFile}. README의 "실제 카페24 연결"을 참고하세요.`);
    }
    return JSON.parse(readFileSync(tokenFile, "utf8")) as TokenSet;
  }

  /** 만료 5분 전부터는 갱신이 필요하다고 본다. (액세스 토큰 2시간, 리프레시 토큰 14일) */
  private static fresh(tokens: TokenSet): boolean {
    return Date.parse(tokens.expires_at) - Date.now() > 5 * 60_000;
  }

  private async accessToken(): Promise<string> {
    const tokens = this.readTokens();
    if (Cafe24ApiClient.fresh(tokens)) return tokens.access_token;
    // 새 글 확인은 목록 셋을 동시에 부른다. 리프레시 토큰은 한 번만 쓸 수 있어서 갱신은 한 번만 하고 같이 기다린다.
    this.refreshing ??= this.refresh(tokens).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async refresh(stale: TokenSet): Promise<string> {
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const response = await fetch(`${this.base}/oauth/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: stale.refresh_token }),
    });
    if (!response.ok) {
      // 초안을 만드는 MCP 서버(다른 프로세스)가 같은 파일로 먼저 갱신했으면 파일에 새 토큰이 있다.
      // 그쪽이 아직 파일에 쓰기 전일 수 있어 2초 동안 몇 번 다시 읽는다.
      for (let i = 0; i < 5; i++) {
        const current = this.readTokens();
        if (current.refresh_token !== stale.refresh_token && Cafe24ApiClient.fresh(current)) return current.access_token;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      const body = (await response.json().catch(() => null)) as { error_description?: string } | null;
      throw new Cafe24ApiError(response.status, `토큰 갱신 실패: ${body?.error_description ?? response.statusText}`);
    }
    const fresh = (await response.json()) as TokenSet;
    // 쓰는 도중에 다른 프로세스가 반쯤 쓴 파일을 읽지 않게 임시 파일에 쓰고 바꿔 넣는다.
    const temp = `${this.config.tokenFile}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(fresh, null, 2), { mode: 0o600 });
    renameSync(temp, this.config.tokenFile);
    return fresh.access_token;
  }
}
