import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { commentInquiry } from "./comments.ts";
import type { BoardComment, Cafe24Client, Inquiry, Order, Product, ReplyResult } from "./types.ts";

export interface MockOptions {
  /**
   * 시연용. 0보다 크면 불러올 때마다 글을 이만큼씩만 더 내놓는다(작성 순서대로).
   * 자동 확인과 알림이 한 건씩 들어오는 모습을 목업으로 보여 줄 때 쓴다. 0이면 처음부터 모두 내놓는다.
   */
  drip?: number;
}

/** data/mock/*.json을 카페24 API 응답처럼 돌려주는 목업. 데모와 테스트에 쓴다. */
export class MockCafe24Client implements Cafe24Client {
  private readonly articles: (Inquiry & { reply_status: string })[];
  private readonly reviews: Inquiry[];
  private readonly comments: BoardComment[];
  private readonly orders: Map<string, Order>;
  private readonly products: Map<number, Product>;
  private readonly drip: number;
  /** 작성 순서. drip일 때 몇 번째 글까지 내놓을지 정한다. */
  private readonly order = new Map<string, number>();
  /** 목록마다 불린 횟수. 한 번 불러올 때 목록 셋이 한 번씩 불리므로 각자 센다. */
  private readonly calls = { qna: 0, review: 0, comment: 0 };
  readonly posted: { article_no: number; content: string }[] = [];

  constructor(dir: string, options: MockOptions = {}) {
    const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as T;
    const exists = (file: string) => existsSync(path.join(dir, file));
    this.articles = read<{ articles: (Inquiry & { reply_status: string })[] }>("articles.json").articles;
    this.reviews = exists("reviews.json")
      ? read<{ reviews: Inquiry[] }>("reviews.json").reviews.map((r) => ({ ...r, kind: "review" as const }))
      : [];
    this.comments = exists("comments.json") ? read<{ comments: BoardComment[] }>("comments.json").comments : [];
    this.orders = new Map(read<{ orders: Order[] }>("orders.json").orders.map((o) => [o.order_id, o]));
    this.products = new Map(read<{ products: Product[] }>("products.json").products.map((p) => [p.product_no, p]));
    this.drip = Math.max(0, options.drip ?? 0);
    const all = [
      ...this.articles.map((a) => ({ id: `qna:${a.article_no}`, at: a.created_date })),
      ...this.reviews.map((r) => ({ id: `review:${r.article_no}`, at: r.created_date })),
      ...this.comments.map((c) => ({ id: `comment:${c.comment_no}`, at: c.created_date })),
    ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    all.forEach((item, i) => this.order.set(item.id, i));
  }

  private visible(list: keyof MockCafe24Client["calls"], id: string): boolean {
    return !this.drip || (this.order.get(id) ?? 0) < this.drip * this.calls[list];
  }

  async listUnansweredInquiries(): Promise<Inquiry[]> {
    this.calls.qna++;
    return this.articles
      .filter((a) => a.reply_status === "N" && this.visible("qna", `qna:${a.article_no}`))
      .map(({ reply_status: _, ...inquiry }) => inquiry);
  }

  async listNewReviews(): Promise<Inquiry[]> {
    this.calls.review++;
    return this.reviews.filter((r) => this.visible("review", `review:${r.article_no}`));
  }

  async listNewComments(isKnown: (key: number) => boolean = () => false): Promise<Inquiry[]> {
    this.calls.comment++;
    const articles = [...this.articles, ...this.reviews];
    return this.comments
      .filter((c) => this.visible("comment", `comment:${c.comment_no}`))
      .map((c) => commentInquiry(c, articles.find((a) => a.article_no === c.article_no) ?? null, null, this.comments))
      .filter((q) => !isKnown(q.article_no));
  }

  async getOrder(orderId: string): Promise<Order | null> {
    return this.orders.get(orderId) ?? null;
  }

  async getProduct(productNo: number): Promise<Product | null> {
    return this.products.get(productNo) ?? null;
  }

  async postReply(inquiry: Inquiry, content: string): Promise<ReplyResult> {
    this.posted.push({ article_no: inquiry.article_no, content });
    return { remote_id: `mock-${inquiry.article_no}-${this.posted.length}` };
  }
}
