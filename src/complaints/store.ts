import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Classification, Classifier, ComplaintPost } from "./types.ts";

// 불만 사유 분류 결과를 앱 DB에 둔다. 글마다 한 번만 분류한다:
// 같은 글(키)이라도 본문이 바뀌면(해시가 다르면) 다시 분류하고, 그대로면 지난 결과를 쓴다.
// 그래서 매일 리포트를 다시 만들어도 LLM이 같은 글을 다르게 읽어 순위가 흔들리지 않는다.
//
// 출처(cafe24·mock·시험 파일)마다 따로 세고, 마지막 실행에서 본 글만 센다(지운 글, 다른 출처 글은 빠진다).
// 리포트 파일·관리자 화면·알림이 같은 범위를 쓰도록 scope로 묻는다.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS complaint_posts (
  key          TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  board_no     INTEGER,
  article_no   INTEGER,
  comment_no   INTEGER,
  product_no   INTEGER,
  rating       INTEGER,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  writer       TEXT NOT NULL,
  created_date TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  seen_at      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS complaint_labels (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  post_key      TEXT NOT NULL REFERENCES complaint_posts(key),
  content_hash  TEXT NOT NULL,
  classifier    TEXT NOT NULL,
  reasons       TEXT NOT NULL,
  confidence    TEXT NOT NULL,
  needs_check   INTEGER NOT NULL,
  check_reasons TEXT NOT NULL,
  injection     INTEGER NOT NULL,
  model         TEXT,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  latency_ms    INTEGER NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS complaint_labels_post ON complaint_labels (post_key, classifier, content_hash);
`;

/** 마지막 리포트 때 읽은 상품 이름(번호 → 이름). 관리자 화면이 카페24를 다시 부르지 않고 이름을 쓴다. 출처마다 따로 둔다. */
export const productNamesKey = (source: string) => `complaints_product_names:${source}`;
const lastRunKey = (source: string) => `complaints_run:${source}`;

export function contentHash(post: Pick<ComplaintPost, "title" | "content" | "rating" | "product_no">): string {
  return createHash("sha256").update(JSON.stringify([post.title, post.content, post.rating, post.product_no])).digest("hex").slice(0, 16);
}

export interface LabeledPost {
  post: ComplaintPost;
  label: Classification;
}

/** 아직 분류하지 않은 글. 저장할 때 같은 해시를 쓰도록 함께 돌려준다(DB를 거치며 값의 타입이 바뀌어도 어긋나지 않게). */
export interface PendingPost {
  post: ComplaintPost;
  hash: string;
}

type Row = Record<string, unknown>;

function toPost(row: Row): ComplaintPost {
  return {
    key: String(row.key),
    kind: row.kind as ComplaintPost["kind"],
    board_no: (row.board_no as number | null) ?? null,
    article_no: (row.article_no as number | null) ?? null,
    comment_no: (row.comment_no as number | null) ?? null,
    product_no: (row.product_no as number | null) ?? null,
    rating: (row.rating as number | null) ?? null,
    title: String(row.title),
    content: String(row.content),
    writer: "",
    created_date: String(row.created_date),
  };
}

function toLabel(row: Row): Classification {
  return {
    reasons: JSON.parse(row.reasons as string),
    confidence: row.confidence as Classification["confidence"],
    needs_check: row.needs_check === 1,
    check_reasons: JSON.parse(row.check_reasons as string),
    injection: row.injection === 1,
    classifier: row.classifier as Classifier,
    fallback: row.fallback === 1,
    model: (row.model as string | null) ?? null,
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
    latency_ms: Number(row.latency_ms),
  };
}

export class ComplaintStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(SCHEMA);
    // 처음 만든 표에는 출처·실행 번호·대신 채움 칸이 없었다.
    const columns = (table: string) => new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name as string));
    const posts = columns("complaint_posts");
    if (!posts.has("source")) this.db.exec("ALTER TABLE complaint_posts ADD COLUMN source TEXT NOT NULL DEFAULT ''");
    if (!posts.has("seen_run")) this.db.exec("ALTER TABLE complaint_posts ADD COLUMN seen_run TEXT NOT NULL DEFAULT ''");
    if (!columns("complaint_labels").has("fallback")) {
      this.db.exec("ALTER TABLE complaint_labels ADD COLUMN fallback INTEGER NOT NULL DEFAULT 0");
    }
  }

  /**
   * 한 번 실행에서 읽은 글을 넣거나 바뀐 본문으로 고친다. 이 출처의 '마지막 실행'을 이번 실행으로 바꾼다.
   * 작성자 이름은 저장하지 않는다(직원 글 거르기는 읽을 때 끝났다).
   */
  upsertPosts(posts: ComplaintPost[], source: string, runId: string = new Date().toISOString()): { added: number; changed: number } {
    const get = this.db.prepare("SELECT content_hash FROM complaint_posts WHERE key = ?");
    const upsert = this.db.prepare(`
      INSERT INTO complaint_posts (key, kind, board_no, article_no, comment_no, product_no, rating, title, content, writer,
        created_date, content_hash, seen_at, source, seen_run)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET kind = excluded.kind, board_no = excluded.board_no, article_no = excluded.article_no,
        comment_no = excluded.comment_no, product_no = excluded.product_no, rating = excluded.rating, title = excluded.title,
        content = excluded.content, writer = '', created_date = excluded.created_date,
        content_hash = excluded.content_hash, seen_at = excluded.seen_at, source = excluded.source, seen_run = excluded.seen_run`);
    let added = 0;
    let changed = 0;
    const now = new Date().toISOString();
    for (const p of posts) {
      const hash = contentHash(p);
      const before = get.get(p.key) as Row | undefined;
      if (!before) added++;
      else if (before.content_hash !== hash) changed++;
      upsert.run(p.key, p.kind, p.board_no, p.article_no, p.comment_no, p.product_no, p.rating, p.title, p.content,
        p.created_date, hash, now, source, runId);
    }
    this.setMeta(lastRunKey(source), runId);
    return { added, changed };
  }

  /** 이 출처의 마지막 실행에서 본 글 조건(SQL 조각과 값) */
  private scope(source: string): [string, string[]] {
    return ["p.source = ? AND p.seen_run = ?", [source, this.getMeta(lastRunKey(source)) ?? ""]];
  }

  /**
   * 지금 본문으로 이 분류 방식의 결과가 아직 없는 글(마지막 실행에서 본 글만).
   * LLM이 실패해 규칙으로 대신 채운 결과(fallback)만 있는 글도 다시 고른다.
   */
  unlabeled(classifier: Classifier, source: string): PendingPost[] {
    const [where, params] = this.scope(source);
    const rows = this.db
      .prepare(`
        SELECT p.* FROM complaint_posts p
        WHERE ${where} AND NOT EXISTS (SELECT 1 FROM complaint_labels l
          WHERE l.post_key = p.key AND l.classifier = ? AND l.content_hash = p.content_hash AND l.fallback = 0)
        ORDER BY p.created_date`)
      .all(...params, classifier) as Row[];
    return rows.map((row) => ({ post: toPost(row), hash: String(row.content_hash) }));
  }

  saveLabel({ post, hash }: PendingPost, label: Classification): void {
    this.db
      .prepare(`
        INSERT INTO complaint_labels (post_key, content_hash, classifier, reasons, confidence, needs_check, check_reasons,
          injection, fallback, model, input_tokens, output_tokens, latency_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(post.key, hash, label.classifier, JSON.stringify(label.reasons), label.confidence, label.needs_check ? 1 : 0,
        JSON.stringify(label.check_reasons), label.injection ? 1 : 0, label.fallback ? 1 : 0, label.model, label.input_tokens,
        label.output_tokens, label.latency_ms, new Date().toISOString());
  }

  /** 마지막 실행에서 본 글마다 지금 본문의 가장 새 결과(이 분류 방식). 결과가 없는 글은 빠진다. */
  labeled(classifier: Classifier, source: string): LabeledPost[] {
    const [where, params] = this.scope(source);
    const rows = this.db
      .prepare(`
        SELECT p.*, l.reasons, l.confidence, l.needs_check, l.check_reasons, l.injection, l.classifier, l.fallback, l.model,
          l.input_tokens, l.output_tokens, l.latency_ms
        FROM complaint_posts p
        JOIN complaint_labels l ON l.id = (
          SELECT MAX(id) FROM complaint_labels WHERE post_key = p.key AND classifier = ? AND content_hash = p.content_hash)
        WHERE ${where}
        ORDER BY p.created_date`)
      .all(classifier, ...params) as Row[];
    return rows.map((row) => ({ post: toPost(row), label: toLabel(row) }));
  }

  /** 하루 한 번 만드는 리포트를 오늘 이미 만들었는지 등을 기억한다(앱 DB의 meta 표). */
  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }
}
