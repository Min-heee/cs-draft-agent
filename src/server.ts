import { Hono } from "hono";
import type { DraftRow, InquiryRow, InquiryStatus, Store } from "./db.ts";
import { computeMetrics } from "./metrics.ts";
import type { Pipeline } from "./pipeline.ts";
import { detailPage, errorPage, inboxPage, metricsPage, TABS, type InboxTab, type PageContext } from "./views.ts";

export interface AppDeps {
  store: Store;
  pipeline: Pipeline;
  modeLabel: string;
  baselineMinutes: number | null;
}

const TAB_STATUSES: Record<InboxTab, InquiryStatus[]> = {
  review: ["drafted"],
  human: ["drafted"],
  working: ["new", "drafting"],
  error: ["error"],
  done: ["approved", "rejected"],
};

/** 같은 drafted 상태라도 담당자 확인이 필요한 초안은 "확인 필요" 탭으로 나눈다. */
function inTab(tab: InboxTab, q: InquiryRow, draft: DraftRow | undefined): boolean {
  if (!TAB_STATUSES[tab].includes(q.status)) return false;
  if (tab === "review") return !draft?.needs_human;
  if (tab === "human") return Boolean(draft?.needs_human);
  return true;
}

export function createApp(deps: AppDeps): Hono {
  const { store, pipeline } = deps;
  const app = new Hono();
  const ctx = (flash?: string | null): PageContext => ({ modeLabel: deps.modeLabel, flash });

  function rowsFor(tab: InboxTab) {
    const drafts = store.latestDrafts();
    return store
      .listInquiries(TAB_STATUSES[tab])
      .map((inquiry) => ({ inquiry, draft: drafts.get(inquiry.article_no) }))
      .filter(({ inquiry, draft }) => inTab(tab, inquiry, draft));
  }

  app.get("/", (c) => c.redirect("/inbox"));

  app.get("/inbox", (c) => {
    const tab = (TABS.find((t) => t.key === c.req.query("tab"))?.key ?? "review") as InboxTab;
    const counts = Object.fromEntries(TABS.map((t) => [t.key, rowsFor(t.key).length])) as Record<InboxTab, number>;
    const rows = rowsFor(tab).map((r) => ({ ...r, review: tab === "done" ? store.latestReview(r.inquiry.article_no) : undefined }));
    return c.html(inboxPage(ctx(c.req.query("msg")), tab, counts, rows, pipeline.isDrafting));
  });

  app.post("/sync", async (c) => {
    const added = await pipeline.sync();
    void pipeline.draftPending();
    const msg = added ? `새 문의 ${added}건을 불러왔습니다. 초안을 만드는 중입니다.` : "새 문의가 없습니다.";
    return c.redirect(`/inbox?tab=${added ? "working" : "review"}&msg=${encodeURIComponent(msg)}`);
  });

  app.get("/inquiries/:no", (c) => {
    const no = Number(c.req.param("no"));
    const q = store.getInquiry(no);
    if (!q) return c.html(errorPage(ctx(), `문의 #${no}가 없습니다.`), 404);
    const page = detailPage(ctx(c.req.query("msg")), q, store.latestDraft(no), store.latestReview(no), store.latestReply(no), Date.now());
    return c.html(page);
  });

  app.post("/inquiries/:no/review", async (c) => {
    const no = Number(c.req.param("no"));
    const form = await c.req.parseBody();
    const decision = form.decision === "reject" ? "reject" : "approve";
    const result = await pipeline.review(no, {
      decision,
      answer: typeof form.answer === "string" ? form.answer : undefined,
      openedAt: Number(form.opened_at) || Date.now(),
      rejectReason: typeof form.reject_reason === "string" ? form.reject_reason : undefined,
    });
    const msg =
      result.action === "reject"
        ? `#${no} 반려했습니다.`
        : result.reply?.status === "posted"
          ? `#${no} 답변을 등록했습니다.`
          : `#${no} 승인은 기록했지만 카페24 등록에 실패했습니다. 처리 완료 탭에서 다시 등록해 주세요.`;
    // 같은 줄에 있던 다음 문의로 바로 넘어간다.
    const next = rowsFor("review")[0] ?? rowsFor("human")[0];
    const target = next ? `/inquiries/${next.inquiry.article_no}` : "/inbox";
    return c.redirect(`${target}?msg=${encodeURIComponent(msg)}`);
  });

  app.post("/inquiries/:no/redraft", (c) => {
    const no = Number(c.req.param("no"));
    const q = store.getInquiry(no);
    if (!q || !["drafted", "error"].includes(q.status)) {
      return c.html(errorPage(ctx(), "검토 전이거나 오류 난 문의만 다시 만들 수 있습니다."), 400);
    }
    store.setStatus(no, "new");
    void pipeline.draftPending();
    return c.redirect(`/inbox?tab=working&msg=${encodeURIComponent(`#${no} 초안을 다시 만드는 중입니다.`)}`);
  });

  app.post("/inquiries/:no/retry-reply", async (c) => {
    const no = Number(c.req.param("no"));
    const reply = await pipeline.retryReply(no);
    const msg = reply.status === "posted" ? "카페24에 등록했습니다." : `다시 실패했습니다: ${reply.error}`;
    return c.redirect(`/inquiries/${no}?msg=${encodeURIComponent(msg)}`);
  });

  app.get("/metrics", (c) => c.html(metricsPage(ctx(), computeMetrics(store, deps.baselineMinutes))));

  app.get("/health", (c) => c.json({ ok: true, drafting: pipeline.isDrafting, counts: store.countByStatus() }));

  app.onError((error, c) => {
    console.error(error);
    return c.html(errorPage(ctx(), error.message), 500);
  });

  return app;
}
