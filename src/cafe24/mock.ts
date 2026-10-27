import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Cafe24Client, Inquiry, Order, Product, ReplyResult } from "./types.ts";

/** data/mock/*.json을 카페24 API 응답처럼 돌려주는 목업. 데모와 테스트에 쓴다. */
export class MockCafe24Client implements Cafe24Client {
  private readonly articles: (Inquiry & { reply_status: string })[];
  private readonly reviews: Inquiry[];
  private readonly orders: Map<string, Order>;
  private readonly products: Map<number, Product>;
  readonly posted: { article_no: number; content: string }[] = [];

  constructor(dir: string) {
    const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as T;
    this.articles = read<{ articles: (Inquiry & { reply_status: string })[] }>("articles.json").articles;
    this.reviews = existsSync(path.join(dir, "reviews.json"))
      ? read<{ reviews: Inquiry[] }>("reviews.json").reviews.map((r) => ({ ...r, kind: "review" as const }))
      : [];
    this.orders = new Map(read<{ orders: Order[] }>("orders.json").orders.map((o) => [o.order_id, o]));
    this.products = new Map(read<{ products: Product[] }>("products.json").products.map((p) => [p.product_no, p]));
  }

  async listUnansweredInquiries(): Promise<Inquiry[]> {
    return this.articles
      .filter((a) => a.reply_status === "N")
      .map(({ reply_status: _, ...inquiry }) => inquiry);
  }

  async listNewReviews(): Promise<Inquiry[]> {
    return this.reviews;
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
