import { DraftError, type Drafter } from "./agent/drafter.ts";
import type { Cafe24Client } from "./cafe24/types.ts";
import type { ReplyRow, ReviewAction, Store } from "./db.ts";
import { editRatio } from "./textdiff.ts";

export interface ReviewInput {
  /** approve는 화면의 답변을 그대로 등록. 초안과 다르면 자동으로 edit_approve로 기록한다. */
  decision: "approve" | "reject";
  answer?: string;
  /** 검토 화면을 연 시각(ms). 검토 시간 측정에 쓴다. */
  openedAt: number;
  rejectReason?: string;
}

export class Pipeline {
  private readonly store: Store;
  private readonly cafe24: Cafe24Client;
  private readonly drafter: Drafter;
  private readonly concurrency: number;
  private running: Promise<void> | null = null;

  constructor(store: Store, cafe24: Cafe24Client, drafter: Drafter, concurrency = 3) {
    this.store = store;
    this.cafe24 = cafe24;
    this.drafter = drafter;
    this.concurrency = concurrency;
  }

  /** 카페24에서 미답변 문의와 최근 상품 후기를 가져와 새 글만 저장한다. */
  async sync(): Promise<number> {
    const [inquiries, reviews] = await Promise.all([this.cafe24.listUnansweredInquiries(), this.cafe24.listNewReviews()]);
    return this.store.addInquiries([...inquiries, ...reviews]);
  }

  /** new 상태 문의를 모두 초안으로 만든다. 이미 돌고 있으면 그 작업을 기다린다. */
  draftPending(): Promise<void> {
    this.running ??= this.runPending().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  get isDrafting(): boolean {
    return this.running !== null;
  }

  private async runPending(): Promise<void> {
    const queue = this.store.listInquiries(["new"]).map((q) => q.article_no);
    const worker = async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) await this.draftOne(next);
    };
    await Promise.all(Array.from({ length: this.concurrency }, worker));
  }

  async draftOne(articleNo: number): Promise<void> {
    const inquiry = this.store.getInquiry(articleNo);
    if (!inquiry) throw new Error(`문의 ${articleNo}가 없습니다.`);
    this.store.setStatus(articleNo, "drafting");
    try {
      const result = await this.drafter.draft(inquiry);
      this.store.insertDraft({ ...result, article_no: articleNo });
      this.store.setStatus(articleNo, "drafted");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof DraftError) console.error(`[draft ${articleNo}] ${message}`, error.trace);
      else console.error(`[draft ${articleNo}]`, error);
      this.store.setStatus(articleNo, "error", message);
    }
  }

  /** 검토 결과를 기록하고, 승인이면 카페24에 답글을 등록한다. */
  async review(articleNo: number, input: ReviewInput): Promise<{ action: ReviewAction; reply: ReplyRow | null }> {
    const inquiry = this.store.getInquiry(articleNo);
    if (!inquiry) throw new Error(`문의 ${articleNo}가 없습니다.`);
    if (inquiry.status !== "drafted") throw new Error(`검토할 수 없는 상태입니다: ${inquiry.status}`);
    const draft = this.store.latestDraft(articleNo);
    if (!draft) throw new Error(`문의 ${articleNo}의 초안이 없습니다.`);

    const reviewSeconds = Math.max(0, (Date.now() - input.openedAt) / 1000);
    if (input.decision === "reject") {
      this.store.insertReview({
        article_no: articleNo,
        draft_id: draft.id,
        action: "reject",
        final_answer: null,
        edit_ratio: null,
        review_seconds: reviewSeconds,
        reject_reason: input.rejectReason?.trim() || null,
      });
      this.store.setStatus(articleNo, "rejected");
      return { action: "reject", reply: null };
    }

    const finalAnswer = (input.answer ?? draft.answer).trim();
    if (!finalAnswer) throw new Error("빈 답변은 등록할 수 없습니다.");
    const ratio = editRatio(draft.answer, finalAnswer);
    const action: ReviewAction = ratio === 0 ? "approve" : "edit_approve";
    const reviewId = this.store.insertReview({
      article_no: articleNo,
      draft_id: draft.id,
      action,
      final_answer: finalAnswer,
      edit_ratio: ratio,
      review_seconds: reviewSeconds,
      reject_reason: null,
    });
    this.store.setStatus(articleNo, "approved");
    return { action, reply: await this.postReply(articleNo, reviewId, finalAnswer) };
  }

  /** 등록에 실패한 승인 답변을 다시 등록한다. */
  async retryReply(articleNo: number): Promise<ReplyRow> {
    const review = this.store.latestReview(articleNo);
    if (!review?.final_answer) throw new Error(`문의 ${articleNo}에 승인된 답변이 없습니다.`);
    if (this.store.latestReply(articleNo)?.status === "posted") throw new Error("이미 등록된 답변입니다.");
    return this.postReply(articleNo, review.id, review.final_answer);
  }

  private async postReply(articleNo: number, reviewId: number, content: string): Promise<ReplyRow> {
    const inquiry = this.store.getInquiry(articleNo)!;
    try {
      const { remote_id } = await this.cafe24.postReply(inquiry, content);
      this.store.insertReply({ article_no: articleNo, review_id: reviewId, status: "posted", remote_id, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.insertReply({ article_no: articleNo, review_id: reviewId, status: "failed", remote_id: null, error: message });
    }
    return this.store.latestReply(articleNo)!;
  }
}
