import { DraftError, type Drafter } from "./agent/drafter.ts";
import { isComment, isReview, PartialListError, type Cafe24Client, type Inquiry } from "./cafe24/types.ts";
import type { ReplyRow, ReviewAction, Store } from "./db.ts";
import { editRatio } from "./textdiff.ts";

/** 알림 문구에 쓰는 글 종류 이름. 예: "문의", "후기 ★2", "댓글" */
export function kindName(q: Pick<Inquiry, "kind" | "rating">): string {
  if (isReview(q)) return q.rating ? `후기 ★${q.rating}` : "후기";
  if (isComment(q)) return "댓글";
  return "문의";
}

/** 알림에 붙일 짧은 제목. 댓글은 글 제목보다 댓글 내용이 더 알아보기 쉽다. */
function headline(q: Pick<Inquiry, "kind" | "title" | "content">): string {
  const text = (isComment(q) ? q.content : q.title).replace(/\s+/g, " ").trim();
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

export interface ReviewInput {
  /** approve는 화면의 답변을 그대로 등록. 초안과 다르면 자동으로 edit_approve로 기록한다. */
  decision: "approve" | "reject";
  answer?: string;
  /** 검토 화면을 연 시각(ms). 검토 시간 측정에 쓴다. */
  openedAt: number;
  rejectReason?: string;
}

/** 새 글 확인이 일부 실패했을 때. 실패하기 전에 가져온 글은 이미 저장했다(added). */
export class SyncError extends Error {
  readonly added: number;
  constructor(message: string, added: number) {
    super(message);
    this.added = added;
  }
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

  /**
   * 카페24에서 미답변 문의, 최근 상품 후기, 고객 댓글을 가져와 새 글만 저장하고 알림을 남긴다. 새로 들어온 수를 돌려준다.
   * 셋 중 하나가 실패해도 가져온 것은 저장하고, 그다음에 실패를 던진다(SyncError).
   */
  async sync(): Promise<number> {
    const isKnown = (key: number) => this.store.getInquiry(key) !== undefined;
    const results = await Promise.allSettled([
      this.cafe24.listUnansweredInquiries(),
      this.cafe24.listNewReviews(),
      this.cafe24.listNewComments(isKnown),
    ]);
    // 일부만 실패한 목록(PartialListError)도 그 전에 찾은 글은 저장한다.
    const fetched = results.flatMap((r) =>
      r.status === "fulfilled" ? r.value : r.reason instanceof PartialListError ? r.reason.partial : [],
    );
    const added = this.store.addInquiries(fetched);
    for (const q of added) {
      this.store.addNotification({ article_no: q.article_no, type: "arrived", message: `새 ${kindName(q)} · ${headline(q)}` });
    }
    const failed = results.flatMap((r) => (r.status === "rejected" ? [r.reason instanceof Error ? r.reason.message : String(r.reason)] : []));
    if (failed.length) throw new SyncError([...new Set(failed)].join(" / "), added.length);
    return added.length;
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
      this.store.addNotification(
        result.needs_human
          ? { article_no: articleNo, type: "needs_human", message: `확인 필요 초안 · ${kindName(inquiry)} · ${headline(inquiry)}` }
          : { article_no: articleNo, type: "drafted", message: `초안 준비 · ${kindName(inquiry)} · ${headline(inquiry)}` },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof DraftError) console.error(`[draft ${articleNo}] ${message}`, error.trace);
      else console.error(`[draft ${articleNo}]`, error);
      this.store.setStatus(articleNo, "error", message);
      this.store.addNotification({ article_no: articleNo, type: "draft_failed", message: `초안 실패 · ${kindName(inquiry)} · ${headline(inquiry)}` });
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
      this.store.addNotification({ article_no: articleNo, type: "posted", message: `등록 완료 · ${kindName(inquiry)} · ${headline(inquiry)}` });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.insertReply({ article_no: articleNo, review_id: reviewId, status: "failed", remote_id: null, error: message });
      this.store.addNotification({ article_no: articleNo, type: "post_failed", message: `등록 실패 · ${kindName(inquiry)} · ${headline(inquiry)}` });
    }
    return this.store.latestReply(articleNo)!;
  }
}
