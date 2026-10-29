import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { Cafe24Get } from "../cafe24/api.ts";
import { articleText } from "../cafe24/comments.ts";
import type { BoardComment, Inquiry, Product } from "../cafe24/types.ts";
import type { ComplaintPost } from "./types.ts";

// 리포트가 읽는 고객 글. 문의함(답할 글)과 달리 답이 달렸는지와 상관없이 고객 글을 모두 센다.
// 우리가 쓴 글(답글, 직원 이름의 글·댓글)은 세지 않는다.

export interface ComplaintSource {
  readonly name: string;
  listPosts(): Promise<ComplaintPost[]>;
  /** 상품 번호 → 이름. 못 읽으면 빈 맵(리포트는 "상품 35"처럼 번호로 쓴다). */
  productNames(productNos: number[]): Promise<Map<number, string>>;
}

export interface Cafe24ReaderConfig {
  qnaBoardNo: number;
  reviewBoardNo?: number;
  /** 직원이 쓰는 이름(답글 작성자 "CS팀" 등). 이 이름의 글·댓글은 세지 않는다. */
  staffWriters: string[];
  /** 한 게시판에서 읽을 최대 쪽 수(쪽당 100건). 넘으면 경고하고 멈춘다. */
  maxPages?: number;
}

type ApiArticle = Inquiry & { parent_article_no?: number | null; rating?: number | null };

const PAGE = 100;

/** 카페24가 숫자를 문자열로 줄 수도 있어 숫자로 맞춘다. 0·빈 값은 null. */
const num = (v: unknown): number | null => (Number(v) > 0 ? Number(v) : null);

/** 카페24에서 GET만 해서 고객 글을 읽는다. 쓰기 함수는 받지 않는다(Cafe24ApiClient.readOnly()). */
export class Cafe24ComplaintSource implements ComplaintSource {
  readonly name = "cafe24";
  private readonly get: Cafe24Get;
  private readonly config: Cafe24ReaderConfig;
  private readonly staff: Set<string>;

  constructor(get: Cafe24Get, config: Cafe24ReaderConfig) {
    this.get = get;
    this.config = config;
    this.staff = new Set(config.staffWriters);
  }

  private async pages<T>(pathname: string, field: string): Promise<T[]> {
    const all: T[] = [];
    const max = this.config.maxPages ?? 20;
    for (let page = 0; page < max; page++) {
      const data = await this.get<Record<string, T[]>>(pathname, { limit: String(PAGE), offset: String(page * PAGE) });
      const rows = data[field] ?? [];
      all.push(...rows);
      if (rows.length < PAGE) return all;
    }
    console.warn(`[complaints] ${pathname}: ${max * PAGE}건까지만 읽었습니다.`);
    return all;
  }

  async listPosts(): Promise<ComplaintPost[]> {
    const boards: [number, "qna" | "review"][] = [[this.config.qnaBoardNo, "qna"]];
    if (this.config.reviewBoardNo) boards.push([this.config.reviewBoardNo, "review"]);
    const posts: ComplaintPost[] = [];
    for (const [boardNo, kind] of boards) {
      const articles = await this.pages<ApiArticle>(`/admin/boards/${boardNo}/articles`, "articles");
      const productOf = new Map(articles.map((a) => [a.article_no, num(a.product_no)]));
      for (const a of articles) {
        // 답글(parent_article_no)과 직원이 쓴 글은 고객 글이 아니다.
        if (a.parent_article_no || this.staff.has(a.writer)) continue;
        posts.push({
          key: `a:${boardNo}:${a.article_no}`,
          kind,
          board_no: boardNo,
          article_no: a.article_no,
          comment_no: null,
          product_no: num(a.product_no),
          rating: kind === "review" ? num(a.rating) : null,
          // 게시판 글 본문은 HTML이다(<p>, <br>, &nbsp;). 근거 확인과 인용을 위해 글자로 바꾼다.
          title: articleText(a.title ?? ""),
          content: articleText(a.content ?? ""),
          writer: a.writer ?? "",
          created_date: a.created_date,
        });
      }
      const comments = await this.pages<BoardComment>(`/admin/boards/${boardNo}/comments`, "comments");
      for (const c of comments) {
        if (this.staff.has(c.writer)) continue;
        posts.push({
          key: `c:${boardNo}:${c.comment_no}`,
          kind: "comment",
          board_no: boardNo,
          article_no: c.article_no,
          comment_no: c.comment_no,
          product_no: productOf.get(c.article_no) ?? null,
          rating: null,
          title: "",
          content: articleText(c.content ?? ""),
          writer: c.writer ?? "",
          created_date: c.created_date,
        });
      }
    }
    return posts;
  }

  async productNames(productNos: number[]): Promise<Map<number, string>> {
    const names = new Map<number, string>();
    const nos = [...new Set(productNos)];
    try {
      for (let i = 0; i < nos.length; i += PAGE) {
        const chunk = nos.slice(i, i + PAGE);
        const { products } = await this.get<{ products: Pick<Product, "product_no" | "product_name">[] }>("/admin/products", {
          product_no: chunk.join(","),
          fields: "product_no,product_name",
          limit: String(PAGE),
        });
        for (const p of products ?? []) names.set(p.product_no, p.product_name);
      }
    } catch (error) {
      console.warn(`[complaints] 상품 이름을 읽지 못해 번호로 씁니다: ${error instanceof Error ? error.message : error}`);
    }
    return names;
  }
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function namesFromMock(dir: string): Map<number, string> {
  const file = path.join(dir, "products.json");
  if (!existsSync(file)) return new Map();
  return new Map(readJson<{ products: Product[] }>(file).products.map((p) => [p.product_no, p.product_name]));
}

/** data/mock/*.json의 고객 글 전부(목업 시연용) */
export class MockComplaintSource implements ComplaintSource {
  readonly name = "mock";
  private readonly dir: string;
  private readonly staff: Set<string>;

  constructor(dir: string, staffWriters: string[] = []) {
    this.dir = dir;
    this.staff = new Set(staffWriters);
  }

  async listPosts(): Promise<ComplaintPost[]> {
    const file = (name: string) => path.join(this.dir, name);
    const articles = readJson<{ articles: Inquiry[] }>(file("articles.json")).articles;
    const reviews = existsSync(file("reviews.json")) ? readJson<{ reviews: Inquiry[] }>(file("reviews.json")).reviews : [];
    const comments = existsSync(file("comments.json")) ? readJson<{ comments: BoardComment[] }>(file("comments.json")).comments : [];
    const productOf = new Map([...articles, ...reviews].map((a) => [`${a.board_no}:${a.article_no}`, a.product_no]));
    const fromArticle = (a: Inquiry, kind: "qna" | "review"): ComplaintPost => ({
      key: `a:${a.board_no}:${a.article_no}`,
      kind,
      board_no: a.board_no,
      article_no: a.article_no,
      comment_no: null,
      product_no: a.product_no ?? null,
      rating: kind === "review" ? (a.rating ?? null) : null,
      title: a.title,
      content: a.content,
      writer: a.writer,
      created_date: a.created_date,
    });
    return [
      ...articles.filter((a) => !this.staff.has(a.writer)).map((a) => fromArticle(a, "qna")),
      ...reviews.filter((a) => !this.staff.has(a.writer)).map((a) => fromArticle(a, "review")),
      ...comments
        .filter((c) => !this.staff.has(c.writer))
        .map((c) => ({
          key: `c:${c.board_no}:${c.comment_no}`,
          kind: "comment" as const,
          board_no: c.board_no,
          article_no: c.article_no,
          comment_no: c.comment_no,
          product_no: productOf.get(`${c.board_no}:${c.article_no}`) ?? null,
          rating: null,
          title: "",
          content: c.content,
          writer: c.writer,
          created_date: c.created_date,
        })),
    ];
  }

  async productNames(): Promise<Map<number, string>> {
    return namesFromMock(this.dir);
  }
}

/** 시험 글 파일(data/complaint-eval/holdout.json 꼴: {"posts":[{id, board, product_no, rating, title, content, created_date, writer}]}) */
export interface FilePost {
  id: string;
  board: "review" | "qna" | "comment";
  product_no: number | null;
  rating: number | null;
  title: string;
  content: string;
  created_date: string;
  writer: string;
  gold?: string[];
}

export function filePostToComplaintPost(p: FilePost): ComplaintPost {
  return {
    key: `f:${p.id}`,
    kind: p.board,
    board_no: null,
    article_no: null,
    comment_no: null,
    product_no: p.product_no ?? null,
    rating: p.board === "review" ? (p.rating ?? null) : null,
    title: p.title ?? "",
    content: p.content ?? "",
    writer: p.writer ?? "",
    created_date: p.created_date,
  };
}

export class FileComplaintSource implements ComplaintSource {
  readonly name: string;
  private readonly file: string;
  private readonly mockDir: string;

  constructor(file: string, mockDir: string) {
    this.file = file;
    this.mockDir = mockDir;
    this.name = `file:${path.basename(file)}`;
  }

  async listPosts(): Promise<ComplaintPost[]> {
    return readJson<{ posts: FilePost[] }>(this.file).posts.map(filePostToComplaintPost);
  }

  async productNames(): Promise<Map<number, string>> {
    return namesFromMock(this.mockDir);
  }
}
