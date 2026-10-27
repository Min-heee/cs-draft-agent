import { DatabaseSync } from "node:sqlite";
import type { Inquiry } from "./cafe24/types.ts";

export type InquiryStatus = "new" | "drafting" | "drafted" | "approved" | "rejected" | "error";
export type ReviewAction = "approve" | "edit_approve" | "reject";

export interface InquiryRow extends Inquiry {
  status: InquiryStatus;
  error: string | null;
  synced_at: string;
}

export interface DraftRow {
  id: number;
  article_no: number;
  category: string;
  answer: string;
  confidence: "high" | "medium" | "low";
  needs_human: boolean;
  human_reasons: string[];
  sources: string[];
  internal_note: string;
  trace: TraceEntry[];
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  latency_ms: number;
  created_at: string;
}

export interface TraceEntry {
  tool: string;
  input: unknown;
  output: string;
}

export interface ReviewRow {
  id: number;
  article_no: number;
  draft_id: number;
  action: ReviewAction;
  final_answer: string | null;
  edit_ratio: number | null;
  review_seconds: number;
  reject_reason: string | null;
  created_at: string;
}

export interface ReplyRow {
  id: number;
  article_no: number;
  review_id: number;
  status: "posted" | "failed";
  remote_id: string | null;
  error: string | null;
  created_at: string;
}

export type NewDraft = Omit<DraftRow, "id" | "created_at">;
export type NewReview = Omit<ReviewRow, "id" | "created_at">;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inquiries (
  article_no   INTEGER PRIMARY KEY,
  board_no     INTEGER NOT NULL,
  product_no   INTEGER,
  order_id     TEXT,
  member_id    TEXT,
  writer       TEXT NOT NULL,
  title        TEXT NOT NULL,
  content      TEXT NOT NULL,
  created_date TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'qna',
  rating       INTEGER,
  status       TEXT NOT NULL DEFAULT 'new',
  error        TEXT,
  synced_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS drafts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  article_no         INTEGER NOT NULL REFERENCES inquiries(article_no),
  category           TEXT NOT NULL,
  answer             TEXT NOT NULL,
  confidence         TEXT NOT NULL,
  needs_human        INTEGER NOT NULL,
  human_reasons      TEXT NOT NULL,
  sources            TEXT NOT NULL,
  internal_note      TEXT NOT NULL,
  trace              TEXT NOT NULL,
  model              TEXT NOT NULL,
  input_tokens       INTEGER NOT NULL,
  output_tokens      INTEGER NOT NULL,
  cache_read_tokens  INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  latency_ms         INTEGER NOT NULL,
  created_at         TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  article_no     INTEGER NOT NULL REFERENCES inquiries(article_no),
  draft_id       INTEGER NOT NULL REFERENCES drafts(id),
  action         TEXT NOT NULL,
  final_answer   TEXT,
  edit_ratio     REAL,
  review_seconds REAL NOT NULL,
  reject_reason  TEXT,
  created_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS replies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  article_no INTEGER NOT NULL REFERENCES inquiries(article_no),
  review_id  INTEGER NOT NULL REFERENCES reviews(id),
  status     TEXT NOT NULL,
  remote_id  TEXT,
  error      TEXT,
  created_at TEXT NOT NULL
);
`;

const now = () => new Date().toISOString();

type Row = Record<string, unknown>;

function toDraft(row: Row): DraftRow {
  return {
    ...(row as unknown as DraftRow),
    needs_human: row.needs_human === 1,
    human_reasons: JSON.parse(row.human_reasons as string),
    sources: JSON.parse(row.sources as string),
    trace: JSON.parse(row.trace as string),
  };
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    // 상품 후기를 받기 전에 만든 DB에는 kind·rating 칸이 없다.
    const columns = new Set(this.db.prepare("PRAGMA table_info(inquiries)").all().map((c) => c.name as string));
    if (!columns.has("kind")) this.db.exec("ALTER TABLE inquiries ADD COLUMN kind TEXT NOT NULL DEFAULT 'qna'");
    if (!columns.has("rating")) this.db.exec("ALTER TABLE inquiries ADD COLUMN rating INTEGER");
  }

  /** 새 문의만 넣는다. 이미 있는 문의는 상태를 건드리지 않는다. 새로 들어온 수를 돌려준다. */
  addInquiries(inquiries: Inquiry[]): number {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO inquiries
        (article_no, board_no, product_no, order_id, member_id, writer, title, content, created_date, kind, rating, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let added = 0;
    for (const q of inquiries) {
      const result = insert.run(
        q.article_no, q.board_no, q.product_no, q.order_id, q.member_id,
        q.writer, q.title, q.content, q.created_date, q.kind ?? "qna", q.rating ?? null, now(),
      );
      added += Number(result.changes);
    }
    return added;
  }

  getInquiry(articleNo: number): InquiryRow | undefined {
    return this.db.prepare("SELECT * FROM inquiries WHERE article_no = ?").get(articleNo) as InquiryRow | undefined;
  }

  listInquiries(statuses: InquiryStatus[]): InquiryRow[] {
    const marks = statuses.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT * FROM inquiries WHERE status IN (${marks}) ORDER BY created_date DESC`)
      .all(...statuses) as unknown as InquiryRow[];
  }

  countByStatus(): Record<InquiryStatus, number> {
    const counts: Record<InquiryStatus, number> = { new: 0, drafting: 0, drafted: 0, approved: 0, rejected: 0, error: 0 };
    for (const row of this.db.prepare("SELECT status, COUNT(*) AS n FROM inquiries GROUP BY status").all()) {
      counts[row.status as InquiryStatus] = Number(row.n);
    }
    return counts;
  }

  setStatus(articleNo: number, status: InquiryStatus, error: string | null = null): void {
    this.db.prepare("UPDATE inquiries SET status = ?, error = ? WHERE article_no = ?").run(status, error, articleNo);
  }

  /** drafting 상태로 멈춘 문의(서버가 중간에 꺼진 경우)를 다시 new로 돌린다. */
  resetStuckDrafting(): void {
    this.db.prepare("UPDATE inquiries SET status = 'new' WHERE status = 'drafting'").run();
  }

  insertDraft(d: NewDraft): number {
    const result = this.db
      .prepare(`
        INSERT INTO drafts (article_no, category, answer, confidence, needs_human, human_reasons, sources,
          internal_note, trace, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          latency_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        d.article_no, d.category, d.answer, d.confidence, d.needs_human ? 1 : 0,
        JSON.stringify(d.human_reasons), JSON.stringify(d.sources), d.internal_note, JSON.stringify(d.trace),
        d.model, d.input_tokens, d.output_tokens, d.cache_read_tokens, d.cache_write_tokens, d.latency_ms, now(),
      );
    return Number(result.lastInsertRowid);
  }

  latestDraft(articleNo: number): DraftRow | undefined {
    const row = this.db
      .prepare("SELECT * FROM drafts WHERE article_no = ? ORDER BY id DESC LIMIT 1")
      .get(articleNo) as Row | undefined;
    return row ? toDraft(row) : undefined;
  }

  latestDrafts(): Map<number, DraftRow> {
    const rows = this.db
      .prepare("SELECT * FROM drafts WHERE id IN (SELECT MAX(id) FROM drafts GROUP BY article_no)")
      .all() as Row[];
    return new Map(rows.map((r) => [Number(r.article_no), toDraft(r)]));
  }

  allDrafts(): DraftRow[] {
    return (this.db.prepare("SELECT * FROM drafts ORDER BY id").all() as Row[]).map(toDraft);
  }

  insertReview(r: NewReview): number {
    const result = this.db
      .prepare(`
        INSERT INTO reviews (article_no, draft_id, action, final_answer, edit_ratio, review_seconds, reject_reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.article_no, r.draft_id, r.action, r.final_answer, r.edit_ratio, r.review_seconds, r.reject_reason, now());
    return Number(result.lastInsertRowid);
  }

  latestReview(articleNo: number): ReviewRow | undefined {
    return this.db
      .prepare("SELECT * FROM reviews WHERE article_no = ? ORDER BY id DESC LIMIT 1")
      .get(articleNo) as ReviewRow | undefined;
  }

  allReviews(): ReviewRow[] {
    return this.db.prepare("SELECT * FROM reviews ORDER BY id").all() as unknown as ReviewRow[];
  }

  insertReply(r: Omit<ReplyRow, "id" | "created_at">): number {
    const result = this.db
      .prepare("INSERT INTO replies (article_no, review_id, status, remote_id, error, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(r.article_no, r.review_id, r.status, r.remote_id, r.error, now());
    return Number(result.lastInsertRowid);
  }

  latestReply(articleNo: number): ReplyRow | undefined {
    return this.db
      .prepare("SELECT * FROM replies WHERE article_no = ? ORDER BY id DESC LIMIT 1")
      .get(articleNo) as ReplyRow | undefined;
  }

  close(): void {
    this.db.close();
  }
}
