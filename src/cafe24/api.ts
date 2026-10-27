import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Cafe24Client, Inquiry, Order, Product, ReplyResult, Variant } from "./types.ts";

// 카페24 Admin REST API 클라이언트.
// 아직 실제 쇼핑몰에 연결해 검증하지 않았다. 카페24 무료몰과 개발자센터 앱을 만든 뒤
// README의 "실제 카페24 연결" 순서대로 확인해야 한다. 문서 확인 날짜: 2026-10-21.
//
// 필요한 권한(scope): mall.read_community, mall.write_community, mall.read_order, mall.read_product

const API_VERSION = "2026-09-01";

export interface Cafe24ApiConfig {
  mallId: string;
  clientId: string;
  clientSecret: string;
  /** 상품 Q&A 게시판 번호 (GET /admin/boards 에서 board_type 5 중 이름으로 확인) */
  boardNo: number;
  /** 액세스·리프레시 토큰을 저장하는 파일. 리프레시 토큰은 한 번만 쓸 수 있어서 갱신할 때마다 새 값을 저장해야 한다. */
  tokenFile: string;
  replyWriter: string;
  /** 답글 등록 API가 요구하는 작성자 IP */
  clientIp: string;
}

interface TokenSet {
  access_token: string;
  expires_at: string;
  refresh_token: string;
  refresh_token_expires_at: string;
}

export class Cafe24ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`카페24 API ${status}: ${message}`);
    this.status = status;
  }
}

export class Cafe24ApiClient implements Cafe24Client {
  private readonly config: Cafe24ApiConfig;
  private readonly base: string;

  constructor(config: Cafe24ApiConfig) {
    this.config = config;
    this.base = `https://${config.mallId}.cafe24api.com/api/v2`;
  }

  async listUnansweredInquiries(): Promise<Inquiry[]> {
    const data = await this.request<{ articles: (Inquiry & { parent_article_no: number | null })[] }>(
      "GET",
      `/admin/boards/${this.config.boardNo}/articles`,
      { query: { reply_status: "N", limit: "100" } },
    );
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
      }));
  }

  async getOrder(orderId: string): Promise<Order | null> {
    try {
      const data = await this.request<{ order: Order }>("GET", `/admin/orders/${encodeURIComponent(orderId)}`, {
        query: { embed: "items" },
      });
      return data.order;
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
        variants: variants.map((v) => ({ ...v, quantity: v.inventories?.quantity ?? v.quantity })),
      };
    } catch (error) {
      if (error instanceof Cafe24ApiError && error.status === 404) return null;
      throw error;
    }
  }

  async postReply(inquiry: Inquiry, content: string): Promise<ReplyResult> {
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
              content,
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

  private async accessToken(): Promise<string> {
    const { tokenFile } = this.config;
    if (!existsSync(tokenFile)) {
      throw new Error(`카페24 토큰 파일이 없습니다: ${tokenFile}. README의 "실제 카페24 연결"을 참고하세요.`);
    }
    const tokens = JSON.parse(readFileSync(tokenFile, "utf8")) as TokenSet;
    // 만료 5분 전부터 미리 갱신한다. (액세스 토큰 2시간, 리프레시 토큰 14일)
    if (Date.parse(tokens.expires_at) - Date.now() > 5 * 60_000) return tokens.access_token;

    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const response = await fetch(`${this.base}/oauth/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { error_description?: string } | null;
      throw new Cafe24ApiError(response.status, `토큰 갱신 실패: ${body?.error_description ?? response.statusText}`);
    }
    const fresh = (await response.json()) as TokenSet;
    writeFileSync(tokenFile, JSON.stringify(fresh, null, 2));
    return fresh.access_token;
  }
}
