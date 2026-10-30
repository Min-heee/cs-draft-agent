import { readFileSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { ROOT } from "./config.ts";
import type { DraftRow, InquiryRow, InquiryStatus, Store } from "./db.ts";
import { computeMetrics } from "./metrics.ts";
import { renderXlsx } from "./complaints/excel.ts";
import { reportNotes, SHEET_ERROR_KEY, SHEET_WRITTEN_KEY } from "./complaints/job.ts";
import { computeReport, inPeriod, kstDate, renderCsv } from "./complaints/report.ts";
import type { DailyReportScheduler } from "./complaints/scheduler.ts";
import { productNamesKey, type ComplaintStore } from "./complaints/store.ts";
import type { Classifier } from "./complaints/types.ts";
import { answersWithComment } from "./cafe24/types.ts";
import { SyncError, type Pipeline } from "./pipeline.ts";
import {
  complaintsPage,
  COMPLAINT_PERIODS,
  detailPage,
  errorPage,
  inboxBody,
  inboxPage,
  itemLabel,
  KINDS,
  metricsPage,
  notificationLink,
  notificationsPage,
  TABS,
  watchLine,
  type InboxTab,
  type KindFilter,
  type PageContext,
} from "./views.ts";
import type { Watcher } from "./watcher.ts";

export interface AppDeps {
  store: Store;
  pipeline: Pipeline;
  modeLabel: string;
  baselineMinutes: number | null;
  /** 자동 확인. 없으면 "지금 확인"을 눌렀을 때만 가져온다(시험). */
  watcher?: Watcher;
  /** 불만 사유 리포트 탭. 없으면 탭이 "꺼져 있음"을 보여 준다. */
  complaints?: ComplaintsDeps;
}

export interface ComplaintsDeps {
  store: ComplaintStore;
  classifier: Classifier;
  scheduler: DailyReportScheduler;
  sourceName: string;
  now: () => Date;
  /** 구글시트에 같이 쓰면 그 주소. 연결하지 않았으면 null */
  sheetUrl?: string | null;
}

const TAB_STATUSES: Record<InboxTab, InquiryStatus[]> = {
  review: ["drafted"],
  human: ["drafted"],
  working: ["new", "drafting"],
  error: ["error"],
  done: ["approved", "rejected"],
};

const ADMIN_JS = readFileSync(path.join(ROOT, "public/admin.js"), "utf8");

/** 같은 drafted 상태라도 담당자 확인이 필요한 초안은 "확인 필요" 탭으로 나눈다. */
function inTab(tab: InboxTab, q: InquiryRow, draft: DraftRow | undefined): boolean {
  if (!TAB_STATUSES[tab].includes(q.status)) return false;
  if (tab === "review") return !draft?.needs_human;
  if (tab === "human") return Boolean(draft?.needs_human);
  return true;
}

const kindOf = (q: InquiryRow): KindFilter => q.kind ?? "qna";

/** "localhost:3000" → "localhost", "[::1]:3000" → "[::1]" */
function hostName(host: string): string {
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0].toLowerCase();
}

function allowedHostNames(env: NodeJS.ProcessEnv = process.env): Set<string> | null {
  const extra = (env.ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const local = !env.HOST || ["127.0.0.1", "localhost", "::1"].includes(env.HOST);
  if (!local && extra.length === 0) return null;
  return new Set(["localhost", "127.0.0.1", "[::1]", ...extra]);
}

export function createApp(deps: AppDeps): Hono {
  const { store, pipeline, watcher, complaints } = deps;
  const app = new Hono();

  function rowsFor(tab: InboxTab, drafts = store.latestDrafts()) {
    return store
      .listInquiries(TAB_STATUSES[tab])
      .map((inquiry) => ({ inquiry, draft: drafts.get(inquiry.article_no) }))
      .filter(({ inquiry, draft }) => inTab(tab, inquiry, draft));
  }

  function tabCounts(): Record<InboxTab, number> {
    const drafts = store.latestDrafts();
    return Object.fromEntries(TABS.map((t) => [t.key, rowsFor(t.key, drafts).length])) as Record<InboxTab, number>;
  }

  const ctx = (flash?: string | null): PageContext => ({
    modeLabel: deps.modeLabel,
    flash,
    nav: {
      dbId: store.dbId,
      counts: tabCounts(),
      unread: store.unreadCount(),
      lastNotificationId: store.lastNotificationId(),
      recent: store.recentNotifications(15),
      watch: watcher?.status ?? null,
      drafting: pipeline.isDrafting,
    },
  });

  function inboxRows(tab: InboxTab, kind: KindFilter) {
    const all = rowsFor(tab).map((r) => ({ ...r, review: tab === "done" ? store.latestReview(r.inquiry.article_no) : undefined }));
    const kindCounts = Object.fromEntries(
      KINDS.map((k) => [k.key, k.key === "all" ? all.length : all.filter((r) => kindOf(r.inquiry) === k.key).length]),
    ) as Record<KindFilter, number>;
    const rows = kind === "all" ? all : all.filter((r) => kindOf(r.inquiry) === kind);
    return { rows, kindCounts };
  }

  // 다른 사이트가 이 화면으로 폼을 보내지 못하게 한다(승인·등록·리포트 만들기는 모두 POST).
  // 브라우저는 POST에 Origin·Sec-Fetch-Site를 붙인다. 둘 다 없는 요청(명령줄, 시험)은 그대로 둔다.
  // 이 컴퓨터에서만 여는 화면이라, 다른 이름(DNS를 127.0.0.1로 돌린 남의 사이트)으로 온 요청은 받지 않는다.
  // HOST=0.0.0.0으로 다른 기기에 열 때는 ALLOWED_HOSTS에 쓸 이름을 쉼표로 적는다(비우면 검사하지 않음).
  const allowedHosts = allowedHostNames();
  app.use("*", async (c, next) => {
    const hostHeader = c.req.header("Host");
    if (allowedHosts && hostHeader && !allowedHosts.has(hostName(hostHeader))) {
      return c.text("이 주소로는 열 수 없습니다.", 403);
    }
    if (c.req.method === "POST") {
      const site = c.req.header("Sec-Fetch-Site");
      const origin = c.req.header("Origin");
      const host = c.req.header("Host");
      const crossOrigin = origin !== undefined && origin !== "null" && host !== undefined && new URL(origin).host !== host;
      if (site === "cross-site" || crossOrigin) return c.text("다른 사이트에서 보낸 요청은 받지 않습니다.", 403);
    }
    await next();
  });

  app.get("/", (c) => c.redirect("/inbox"));

  app.get("/static/admin.js", (c) => c.body(ADMIN_JS, 200, { "Content-Type": "text/javascript; charset=utf-8" }));

  app.get("/inbox", (c) => {
    const tab = (TABS.find((t) => t.key === c.req.query("tab"))?.key ?? "review") as InboxTab;
    const kind = (KINDS.find((k) => k.key === c.req.query("kind"))?.key ?? "all") as KindFilter;
    const { rows, kindCounts } = inboxRows(tab, kind);
    // 새 알림이 오면 화면이 목록 부분만 다시 받아 간다.
    if (c.req.query("fragment") === "1") return c.html(inboxBody(tab, kind, kindCounts, rows, store.unreadArticles()));
    return c.html(inboxPage(ctx(c.req.query("msg")), tab, kind, kindCounts, rows, store.unreadArticles()));
  });

  app.post("/sync", async (c) => {
    let added: number;
    let error: string | null = null;
    if (watcher) {
      ({ added, error } = await watcher.checkNow());
    } else {
      try {
        added = await pipeline.sync();
      } catch (e) {
        if (!(e instanceof SyncError)) throw e;
        ({ added, message: error } = e);
      }
      void pipeline.draftPending();
    }
    const msg = error
      ? added
        ? `새 글 ${added}건을 불러왔지만 일부를 확인하지 못했습니다: ${error}`
        : `새 글을 확인하지 못했습니다: ${error}`
      : added
        ? `새 글 ${added}건을 불러왔습니다. 초안을 만드는 중입니다.`
        : "새 글이 없습니다.";
    return c.redirect(`/inbox?tab=${added ? "working" : "review"}&msg=${encodeURIComponent(msg)}`);
  });

  /** 화면이 몇 초마다 부른다. after보다 새 알림, 읽지 않은 수, 탭별 개수, 자동 확인 상태. */
  app.get("/api/live", (c) => {
    const after = Math.max(0, Number(c.req.query("after")) || 0);
    // 화면이 본 DB와 지금 DB가 다르면(새로 만듦) 알림 번호가 처음부터 다시 시작한다. 처음부터 다시 준다.
    const db = c.req.query("db");
    const reset = (db !== undefined && db !== store.dbId) || after > store.lastNotificationId();
    const notifications = store.notificationsAfter(reset ? 0 : after).map((n) => ({ ...n, link: notificationLink(n) }));
    return c.json({
      reset,
      dbId: store.dbId,
      lastId: notifications.at(-1)?.id ?? store.lastNotificationId(),
      notifications,
      unread: store.unreadCount(),
      counts: tabCounts(),
      drafting: pipeline.isDrafting,
      watch: watchLine(watcher?.status ?? null, pipeline.isDrafting),
      complaintsRunning: complaints?.scheduler.status.running ?? false,
    });
  });

  app.get("/notifications", (c) => c.html(notificationsPage(ctx(c.req.query("msg")), store.recentNotifications(100))));

  app.post("/notifications/read", (c) => {
    store.markNotificationsRead();
    // 화면의 "모두 읽음"은 fetch로, 알림 화면의 버튼은 폼으로 부른다.
    if (c.req.header("Accept")?.includes("application/json")) return c.json({ ok: true });
    return c.redirect("/notifications");
  });

  app.get("/inquiries/:no", (c) => {
    const no = Number(c.req.param("no"));
    const q = store.getInquiry(no);
    if (!q) return c.html(errorPage(ctx(), `문의 #${no}가 없습니다.`), 404);
    store.markNotificationsRead(no);
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
    const q = store.getInquiry(no)!;
    const label = itemLabel(q);
    // 직접 누른 등록이라 "등록 완료" 알림은 읽은 것으로 둔다(화면 알림으로만 보인다). 실패 알림은 남긴다.
    if (result.reply?.status === "posted") store.markNotificationsRead(no);
    const msg =
      result.action === "reject"
        ? `${label} 반려했습니다.`
        : result.reply?.status === "posted"
          ? answersWithComment(q)
            ? `${label}에 댓글을 등록했습니다.`
            : `${label} 답변을 등록했습니다.`
          : `${label} 승인은 기록했지만 카페24 등록에 실패했습니다. 처리 완료 탭에서 다시 등록해 주세요.`;
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
    return c.redirect(`/inbox?tab=working&msg=${encodeURIComponent(`${itemLabel(q)} 초안을 다시 만드는 중입니다.`)}`);
  });

  app.post("/inquiries/:no/retry-reply", async (c) => {
    const no = Number(c.req.param("no"));
    const reply = await pipeline.retryReply(no);
    const msg = reply.status === "posted" ? "카페24에 등록했습니다." : `다시 실패했습니다: ${reply.error}`;
    return c.redirect(`/inquiries/${no}?msg=${encodeURIComponent(msg)}`);
  });

  /** 기간 선택(7·30·전체)으로 리포트를 계산한다. 저장된 분류 결과만 쓰고 LLM이나 카페24는 부르지 않는다. */
  function complaintReport(period: string | undefined) {
    const deps = complaints!;
    const p = COMPLAINT_PERIODS.find((x) => x.key === period) ?? COMPLAINT_PERIODS[0];
    const names = new Map<number, string>(JSON.parse(deps.store.getMeta(productNamesKey(deps.sourceName)) ?? "[]"));
    // 리포트 파일과 같은 범위: 지금 출처의 마지막 실행에서 본 글
    const rows = deps.store.labeled(deps.classifier, deps.sourceName);
    const now = deps.now();
    const report = computeReport(rows, { now, days: p.days, productNames: names });
    return { period: p, report, total: rows.length, rows: inPeriod(rows, now, p.days), names };
  }

  app.get("/complaints", (c) => {
    if (!complaints) return c.html(errorPage(ctx(), "불만 사유 리포트가 이 실행에서 꺼져 있습니다."), 404);
    const { period, report, total } = complaintReport(c.req.query("days"));
    return c.html(
      complaintsPage(ctx(c.req.query("msg")), {
        period: period.key,
        report,
        totalLabeled: total,
        schedule: complaints.scheduler.status,
        classifierLabel: complaints.classifier === "rules+llm" ? "규칙 + Claude Code(구독) + 코드 검사" : "규칙만",
        sourceName: complaints.sourceName,
        sheet: complaints.sheetUrl
          ? {
              url: complaints.sheetUrl,
              writtenAt: complaints.store.getMeta(SHEET_WRITTEN_KEY),
              error: JSON.parse(complaints.store.getMeta(SHEET_ERROR_KEY) || "null") as { at: string; message: string } | null,
            }
          : null,
      }),
    );
  });

  app.get("/complaints.csv", (c) => {
    if (!complaints) return c.text("불만 사유 리포트가 꺼져 있습니다.", 404);
    const { period, report } = complaintReport(c.req.query("days"));
    const file = `complaints-${kstDate(complaints.now())}-${period.key === "all" ? "all" : `${period.key}d`}.csv`;
    return c.body(renderCsv([report]), 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file}"`,
    });
  });

  app.get("/complaints.xlsx", (c) => {
    if (!complaints) return c.text("불만 사유 리포트가 꺼져 있습니다.", 404);
    const { period, report, rows, names } = complaintReport(c.req.query("days"));
    const file = `complaints-${kstDate(complaints.now())}-${period.key === "all" ? "all" : `${period.key}d`}.xlsx`;
    const xlsx = renderXlsx({
      reports: [report],
      posts: rows,
      productNames: names,
      source: complaints.sourceName,
      notes: reportNotes(complaints.sourceName, complaints.classifier),
    });
    return c.body(new Uint8Array(xlsx), 200, {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${file}"`,
    });
  });

  app.post("/complaints/run", async (c) => {
    if (!complaints) return c.html(errorPage(ctx(), "불만 사유 리포트가 이 실행에서 꺼져 있습니다."), 404);
    const form = await c.req.parseBody();
    const days = COMPLAINT_PERIODS.find((p) => p.key === form.days)?.key ?? "7";
    // 새 글이 많으면 분류에 시간이 걸려 기다리지 않고 돌려보낸다. '만드는 중'은 화면이 상태로 보여 주고,
    // 끝나면 admin.js가 /api/live로 알아채 다시 읽는다(주소에 문구를 남기지 않는다).
    void complaints.scheduler.runNow();
    return c.redirect(`/complaints${days === "7" ? "" : `?days=${days}`}`);
  });

  app.get("/metrics", (c) => c.html(metricsPage(ctx(), computeMetrics(store, deps.baselineMinutes))));

  app.get("/health", (c) =>
    c.json({ ok: true, drafting: pipeline.isDrafting, counts: store.countByStatus(), watch: watcher?.status ?? null }),
  );

  app.onError((error, c) => {
    console.error(error);
    return c.html(errorPage(ctx(), error.message), 500);
  });

  return app;
}
