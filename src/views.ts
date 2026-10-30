import { html, raw } from "hono/html";
import { answersWithComment, isComment, isReview, type Inquiry } from "./cafe24/types.ts";
import type { DraftRow, InquiryRow, NotificationRow, ReplyRow, ReviewRow } from "./db.ts";
import { draftCostUsd, type Metrics } from "./metrics.ts";
import type { ComplaintReport } from "./complaints/report.ts";
import type { ReportSchedule } from "./complaints/scheduler.ts";
import type { WatchStatus } from "./watcher.ts";

// 관리자 화면은 서버에서 HTML로 그린다. html`` 은 끼워 넣는 값을 자동으로 이스케이프한다.
// 새 알림·개수·자동 확인 상태는 /static/admin.js가 몇 초마다 /api/live로 받아 화면에 반영한다.

type Html = ReturnType<typeof html>;

export type InboxTab = "review" | "human" | "working" | "error" | "done";

export const TABS: { key: InboxTab; label: string }[] = [
  { key: "review", label: "검토 대기" },
  { key: "human", label: "확인 필요" },
  { key: "working", label: "초안 만드는 중" },
  { key: "error", label: "오류" },
  { key: "done", label: "처리 완료" },
];

export type KindFilter = "all" | "qna" | "review" | "comment";

export const KINDS: { key: KindFilter; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "qna", label: "문의" },
  { key: "review", label: "후기" },
  { key: "comment", label: "댓글" },
];

/** 사이드바·종 모양 알림처럼 모든 화면에 들어가는 것 */
export interface NavState {
  dbId: string;
  counts: Record<InboxTab, number>;
  unread: number;
  lastNotificationId: number;
  recent: NotificationRow[];
  watch: WatchStatus | null;
  drafting: boolean;
}

export interface PageContext {
  modeLabel: string;
  flash?: string | null;
  nav: NavState;
}

/** 화면이 어디인지. admin.js가 body의 data-* 로 읽는다. */
interface PageInfo {
  page: "inbox" | "detail" | "metrics" | "notifications" | "complaints" | "error";
  tab?: InboxTab;
  item?: number;
  status?: string;
}

// 코드에 적힌 고정 문자열이라 이스케이프하지 않고 넣는다(raw). 이스케이프하면 > 와 따옴표가 든 규칙이 깨진다.
const CSS = `
:root {
  --bg: #f6f6f4; --surface: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --line: #e3e2dd;
  --accent: #1f5f4a; --accent-text: #ffffff; --accent-soft: #e4efe9;
  --warn: #8a5a00; --warn-soft: #fbf1dc; --danger: #a33a2c; --danger-soft: #f8e5e1;
  --info: #2f5d8a; --info-soft: #e3ecf5;
  --chip: #efeeea; --shadow: 0 12px 32px rgba(29, 29, 27, .14);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161615; --surface: #1f1f1d; --text: #ecebe6; --muted: #a09f98; --line: #34332f;
    --accent: #6cc3a0; --accent-text: #0f1f18; --accent-soft: #1d3329;
    --warn: #e7b65c; --warn-soft: #3a2f17; --danger: #ee8a7b; --danger-soft: #3d221d;
    --info: #8bb8e8; --info-soft: #1c2a38;
    --chip: #2a2a27; --shadow: 0 12px 32px rgba(0, 0, 0, .5);
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", sans-serif; }
a { color: inherit; }
button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); color: var(--text); cursor: pointer; }
button:hover { border-color: var(--muted); }
button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); font-weight: 600; }
button.danger { color: var(--danger); }
button.link { border: 0; background: none; padding: 2px 4px; color: var(--muted); font-size: 13px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.shell { display: grid; grid-template-columns: 236px minmax(0, 1fr); min-height: 100vh; }
.side { position: sticky; top: 0; height: 100vh; overflow-y: auto; background: var(--surface); border-right: 1px solid var(--line);
  padding: 16px 12px; display: flex; flex-direction: column; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 700; text-decoration: none; padding: 4px 8px 12px; }
.logo { width: 28px; height: 28px; border-radius: 8px; background: var(--accent); color: var(--accent-text);
  display: grid; place-items: center; font-size: 12px; font-weight: 800; letter-spacing: -.02em; }
.side nav { display: flex; flex-direction: column; gap: 2px; }
.nav-label { font-size: 12px; color: var(--muted); padding: 14px 10px 4px; }
.side nav a { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 8px;
  text-decoration: none; color: var(--text); }
.side nav a:hover { background: var(--bg); }
.side nav a.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.count { font-size: 12px; font-variant-numeric: tabular-nums; color: var(--muted); min-width: 22px; text-align: center;
  border-radius: 999px; padding: 0 6px; }
.count.hot:not([data-zero]) { background: var(--accent); color: var(--accent-text); font-weight: 700; }
.count.warn:not([data-zero]) { background: var(--warn-soft); color: var(--warn); font-weight: 700; }
.count.danger:not([data-zero]) { background: var(--danger-soft); color: var(--danger); font-weight: 700; }
.side-foot { margin-top: auto; font-size: 12px; color: var(--muted); padding: 16px 10px 4px; line-height: 1.5; }

.top { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 12px; padding: 12px 28px;
  background: var(--bg); border-bottom: 1px solid var(--line); }
.page-title { font-size: 18px; margin: 0; }
.top-right { margin-left: auto; display: flex; align-items: center; gap: 10px; position: relative; }
.top-right form { margin: 0; }
.top-right button { white-space: nowrap; }
.watch { font-size: 13px; color: var(--muted); display: flex; align-items: center; gap: 7px; }
.watch .pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }
.watch.checking .pulse { animation: pulse 1s ease-in-out infinite; }
.watch.error { color: var(--danger); }
.watch.error .pulse { background: var(--danger); }
.watch.off .pulse { background: var(--muted); }
@keyframes pulse { 50% { opacity: .25; } }
.bell { position: relative; width: 38px; height: 38px; padding: 0; display: grid; place-items: center; }
.badge { position: absolute; top: -5px; right: -5px; min-width: 18px; height: 18px; border-radius: 999px; background: var(--danger);
  color: #fff; font-size: 11px; line-height: 18px; padding: 0 5px; font-weight: 700; font-variant-numeric: tabular-nums; }
.badge[data-zero] { display: none; }
.bell-panel { position: absolute; top: 46px; right: 0; width: 380px; max-height: 72vh; overflow: auto; background: var(--surface);
  border: 1px solid var(--line); border-radius: 12px; box-shadow: var(--shadow); padding: 8px; z-index: 10; }
.bell-panel[hidden] { display: none; }
.panel-head { display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; }
.panel-tools { display: flex; align-items: center; gap: 10px; padding: 4px 10px 8px; font-size: 13px; color: var(--muted);
  border-bottom: 1px solid var(--line); margin-bottom: 4px; flex-wrap: wrap; }
.panel-tools label { display: flex; align-items: center; gap: 4px; }
.panel-foot { display: block; text-align: center; padding: 8px; font-size: 13px; color: var(--muted); }
.feed { list-style: none; margin: 0; padding: 0; }
.feed a { display: grid; grid-template-columns: 10px minmax(0, 1fr) auto; gap: 10px; align-items: start; padding: 9px 10px;
  border-radius: 8px; text-decoration: none; }
.feed a:hover { background: var(--bg); }
.feed .unread .n-text { font-weight: 600; }
.feed .read .n-text { color: var(--muted); }
.feed .empty-feed { padding: 24px 10px; text-align: center; color: var(--muted); font-size: 14px; }
.n-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 8px; background: var(--info); }
.type-drafted .n-dot, .type-posted .n-dot { background: var(--accent); }
.type-needs_human .n-dot, .type-complaint_rise .n-dot { background: var(--warn); }
.type-draft_failed .n-dot, .type-post_failed .n-dot, .type-sync_failed .n-dot { background: var(--danger); }
.n-text { word-break: keep-all; overflow-wrap: anywhere; }
.feed time { font-size: 12px; color: var(--muted); white-space: nowrap; margin-top: 2px; }

.toasts { position: fixed; right: 20px; bottom: 20px; display: flex; flex-direction: column; gap: 8px; z-index: 20; width: min(360px, calc(100vw - 32px)); }
.toast { display: grid; grid-template-columns: 10px minmax(0, 1fr); gap: 10px; align-items: start; background: var(--surface);
  border: 1px solid var(--line); border-radius: 10px; box-shadow: var(--shadow); padding: 12px 14px; text-decoration: none;
  animation: toast-in .2s ease-out; }
.toast .n-text { font-weight: 600; }
.toast small { display: block; color: var(--muted); font-weight: 400; }
@keyframes toast-in { from { transform: translateY(8px); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .toast, .watch.checking .pulse { animation: none; } }

main { padding: 24px 28px 56px; max-width: 1240px; }
.flash { background: var(--accent-soft); border: 1px solid var(--line); padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; }
.toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
.seg { display: inline-flex; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 3px; }
.seg a { padding: 4px 12px; border-radius: 7px; text-decoration: none; color: var(--muted); font-size: 14px; }
.seg a.on { background: var(--text); color: var(--bg); }
.seg .n { font-variant-numeric: tabular-nums; margin-left: 4px; opacity: .8; }
.table { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.table > * + * { border-top: 1px solid var(--line); }
.tr { display: grid; grid-template-columns: 104px minmax(0, 1fr) 96px 120px 116px; gap: 14px; align-items: center;
  padding: 12px 16px; text-decoration: none; }
.thead { color: var(--muted); font-size: 12px; padding-top: 8px; padding-bottom: 8px; }
a.tr:hover { background: var(--bg); }
.tr .title { font-weight: 600; display: flex; align-items: center; gap: 6px; min-width: 0; }
.tr .title span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tr .snippet { color: var(--muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; display: block; }
.new-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--danger); flex: none; }
.c-who, .c-time { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.empty { color: var(--muted); text-align: center; padding: 56px 16px; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

.chip { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--chip); margin-right: 4px; white-space: nowrap; }
.chip.warn, .chip.kind-review { background: var(--warn-soft); color: var(--warn); }
.chip.danger { background: var(--danger-soft); color: var(--danger); }
.chip.ok { background: var(--accent-soft); color: var(--accent); }
.chip.kind-comment, .chip.info { background: var(--info-soft); color: var(--info); }
.spin { display: inline-block; width: 10px; height: 10px; border: 2px solid currentColor; border-right-color: transparent;
  border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -1px; margin-right: 4px; }
@keyframes spin { to { transform: rotate(360deg); } }

.card { background: var(--surface); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px; }
.crumb { margin: 0 0 14px; font-size: 13px; color: var(--muted); }
.crumb a { text-decoration: none; }
.detail { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: 20px; align-items: start; }
.stack { display: flex; flex-direction: column; gap: 16px; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 0 0 10px; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
.inquiry-body { white-space: pre-wrap; margin: 12px 0 0; }
.thread { white-space: pre-wrap; font-size: 14px; color: var(--muted); max-height: 340px; overflow: auto; margin: 0; }
.pre { white-space: pre-wrap; }
.notice { border-radius: 8px; padding: 12px 14px; }
.notice.warn { background: var(--warn-soft); color: var(--warn); }
.notice.danger { background: var(--danger-soft); color: var(--danger); }
.notice ul { margin: 6px 0 0; padding-left: 18px; }
textarea { width: 100%; min-height: 300px; padding: 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font: inherit; resize: vertical; }
input[type=text] { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font: inherit; }
.actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; align-items: center; }
details { border-top: 1px solid var(--line); padding: 8px 0; }
details:first-of-type { border-top: 0; }
summary { cursor: pointer; }
pre { white-space: pre-wrap; word-break: break-all; background: var(--bg); padding: 10px; border-radius: 6px; font-size: 12px; margin: 6px 0 0; }
.complaint-product { border-top: 1px solid var(--line); padding: 10px 0; }
.complaint-product:first-of-type { border-top: 0; }
.complaint-product h3 { font-size: 15px; margin: 0 0 4px; }
.complaint-product ol { margin: 0 0 6px; padding-left: 20px; }
.complaint-product blockquote { margin: 4px 0; padding: 4px 10px; border-left: 3px solid var(--line); font-size: 14px; overflow-wrap: anywhere; }
.notice { margin-bottom: 16px; overflow-wrap: anywhere; }
.checks li { margin: 6px 0; overflow-wrap: anywhere; }
.kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; margin-bottom: 20px; }
.kpi .label { color: var(--muted); font-size: 13px; }
.kpi .value { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; margin: 2px 0; }
.kpi .help { color: var(--muted); font-size: 12px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; font-size: 13px; }
.reject-form { margin-top: 14px; padding-top: 14px; border-top: 1px dashed var(--line); }

@media (max-width: 900px) {
  .shell { grid-template-columns: 1fr; }
  .side { position: static; height: auto; flex-direction: row; align-items: center; overflow-x: auto; padding: 8px 12px;
    border-right: 0; border-bottom: 1px solid var(--line); gap: 8px; }
  .side nav { flex-direction: row; }
  .nav-label, .side-foot { display: none; }
  .brand { padding: 4px; }
  .brand .brand-name { display: none; }
  .side nav a { white-space: nowrap; }
  .top { padding: 10px 16px; flex-wrap: wrap; }
  .top-right { margin-left: 0; width: 100%; }
  .watch { margin-right: auto; }
  .bell-panel { position: fixed; left: 12px; right: 12px; width: auto; top: 112px; }
  main { padding: 16px; }
  .tr { grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; }
  .thead { display: none; }
  .c-kind { grid-column: 1 / -1; }
  .c-who { display: none; }
  .c-time { grid-column: 1 / -1; }
  .detail { grid-template-columns: 1fr; }
}
`;

const BELL_ICON = html`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>`;

const shortTime = (iso: string) =>
  new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

const clockTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit" });

const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);

/** 알림을 누르면 갈 곳 */
export function notificationLink(n: Pick<NotificationRow, "article_no" | "type">): string {
  if (n.type === "complaint_rise") return "/complaints";
  return n.article_no === null ? "/notifications" : `/inquiries/${n.article_no}`;
}

/** 자동 확인 상태 한 줄. 화면과 /api/live가 같이 쓴다. */
export function watchLine(watch: WatchStatus | null, drafting: boolean): { text: string; tone: "ok" | "checking" | "error" | "off" } {
  const draftingText = drafting ? " · 초안 만드는 중" : "";
  if (!watch || watch.intervalSeconds === 0) return { text: `자동 확인 꺼짐${draftingText}`, tone: "off" };
  if (watch.checking) return { text: `새 글 확인 중…${draftingText}`, tone: "checking" };
  if (watch.lastError) return { text: `확인 실패 · ${watch.lastError}`, tone: "error" };
  const every = watch.intervalSeconds % 60 === 0 ? `${watch.intervalSeconds / 60}분마다` : `${watch.intervalSeconds}초마다`;
  const last = watch.lastCheckedAt ? ` · ${clockTime(watch.lastCheckedAt)} 확인` : "";
  return { text: `자동 확인 ${every}${last}${draftingText}`, tone: drafting ? "checking" : "ok" };
}

function feedItem(n: NotificationRow) {
  return html`<li class="${n.read_at ? "read" : "unread"} type-${n.type}"><a href="${notificationLink(n)}">
  <span class="n-dot" aria-hidden="true"></span><span class="n-text">${n.message}</span><time>${shortTime(n.created_at)}</time></a></li>`;
}

export function layout(title: string, info: PageInfo, ctx: PageContext, body: Html) {
  const { nav } = ctx;
  const watch = watchLine(nav.watch, nav.drafting);
  const navLink = (href: string, label: string, on: boolean, count?: Html | string) =>
    html`<a href="${href}" class="${on ? "on" : ""}"${on ? html` aria-current="page"` : ""}><span>${label}</span>${count ?? ""}</a>`;
  const tone: Partial<Record<(typeof TABS)[number]["key"], string>> = { review: "hot", human: "warn", error: "danger" };
  const countEl = (key: string, n: number, cls = "") =>
    html`<span class="count ${cls}" data-count="${key}"${n === 0 ? html` data-zero` : ""}>${n}</span>`;
  return html`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · CS 관리자</title>
<style>${raw(CSS)}</style>
</head>
<body data-page="${info.page}" data-tab="${info.tab ?? ""}" data-item="${info.item ?? ""}" data-status="${info.status ?? ""}"
  data-last-id="${nav.lastNotificationId}" data-db="${nav.dbId}" data-signature="${JSON.stringify([nav.counts, nav.unread])}"
  data-title="${title} · CS 관리자">
<div class="shell">
<aside class="side">
  <a class="brand" href="/inbox"><span class="logo">CS</span><span class="brand-name">CS 관리자</span></a>
  <nav aria-label="메뉴">
    <div class="nav-label">문의함</div>
    ${TABS.map((t) => navLink(`/inbox?tab=${t.key}`, t.label, info.page === "inbox" && info.tab === t.key, countEl(t.key, nav.counts[t.key], tone[t.key])))}
    <div class="nav-label">관리</div>
    ${navLink("/notifications", "알림", info.page === "notifications", countEl("unread", nav.unread, "danger"))}
    ${navLink("/complaints", "불만 사유", info.page === "complaints")}
    ${navLink("/metrics", "지표", info.page === "metrics")}
  </nav>
  <div class="side-foot">${ctx.modeLabel}</div>
</aside>
<div class="content">
  <header class="top">
    <h1 class="page-title">${title}</h1>
    <div class="top-right">
      <div class="watch ${watch.tone}" id="watch" role="status"><span class="pulse" aria-hidden="true"></span><span id="watch-text">${watch.text}</span></div>
      <form method="post" action="/sync"><button type="submit">지금 확인</button></form>
      <button class="bell" id="bell" type="button" aria-label="알림" aria-expanded="false" aria-controls="bell-panel">
        ${BELL_ICON}<span class="badge" data-count="unread"${nav.unread === 0 ? html` data-zero` : ""}>${nav.unread}</span>
      </button>
      <div class="bell-panel" id="bell-panel" role="region" aria-label="알림 목록" hidden>
        <div class="panel-head"><strong>알림</strong><button class="link" id="mark-all" type="button">모두 읽음</button></div>
        <div class="panel-tools">
          <button class="link" id="os-enable" type="button" hidden>맥 알림 켜기</button>
          <span id="os-state"></span>
          <label><input type="checkbox" id="sound"> 소리</label>
          <span id="sound-hint" hidden>소리를 들으려면 화면을 한 번 눌러 주세요</span>
        </div>
        <ul class="feed" id="feed">
          ${nav.recent.length ? nav.recent.map(feedItem) : html`<li class="empty-feed">아직 알림이 없습니다.</li>`}
        </ul>
        <a class="panel-foot" href="/notifications">알림 전체 보기</a>
      </div>
    </div>
  </header>
  <main>
  ${ctx.flash ? html`<div class="flash" role="status">${ctx.flash}</div>` : ""}
  ${body}
  </main>
</div>
</div>
<div class="toasts" id="toasts" aria-live="polite"></div>
<script src="/static/admin.js" defer></script>
</body>
</html>`;
}

/** 글 종류 칩: 문의 / 후기 ★★★ / 댓글 */
export function kindChip(q: Pick<Inquiry, "kind" | "rating">) {
  if (isReview(q)) return html`<span class="chip kind-review">후기 ${"★".repeat(q.rating ?? 0) || "별점 없음"}</span>`;
  if (isComment(q)) return html`<span class="chip kind-comment">댓글</span>`;
  return html`<span class="chip">문의</span>`;
}

/**
 * 화면에 보이는 글 번호. 고객 댓글은 문의함 안에서 만든 번호 대신 어느 글에 달린 댓글인지 보여 준다.
 * 카페24 댓글 번호는 게시판 전체에서 매기는 번호라 "몇 번째 댓글"로 읽히지 않게 붙이지 않는다.
 */
export function itemLabel(q: Pick<Inquiry, "kind" | "article_no" | "parent_article_no">): string {
  return isComment(q) ? `#${q.parent_article_no} 글에 달린 댓글` : `#${q.article_no}`;
}

function confidenceChip(confidence: DraftRow["confidence"]) {
  const label = { high: "확신 높음", medium: "확신 보통", low: "확신 낮음" }[confidence];
  const tone = { high: "ok", medium: "", low: "warn" }[confidence];
  return html`<span class="chip ${tone}">${label}</span>`;
}

function statusChip(q: InquiryRow, draft: DraftRow | undefined, review: ReviewRow | undefined) {
  if (q.status === "drafting" || q.status === "new") return html`<span class="chip info"><span class="spin" aria-hidden="true"></span>초안 만드는 중</span>`;
  if (q.status === "error") return html`<span class="chip danger">오류</span>`;
  if (q.status === "approved") {
    return review?.action === "edit_approve"
      ? html`<span class="chip ok">수정 후 승인</span>`
      : html`<span class="chip ok">그대로 승인</span>`;
  }
  if (q.status === "rejected") return html`<span class="chip">반려</span>`;
  if (draft?.needs_human) return html`<span class="chip warn">확인 필요</span>`;
  return draft ? confidenceChip(draft.confidence) : "";
}

export interface InboxRow {
  inquiry: InquiryRow;
  draft?: DraftRow;
  review?: ReviewRow;
}

const EMPTY_TEXT: Record<InboxTab, string> = {
  review: "검토할 초안이 없습니다. 새 글이 들어오면 초안을 만들어 여기에 올리고 알림을 띄웁니다.",
  human: "담당자 확인이 필요한 초안이 없습니다.",
  working: "만들고 있는 초안이 없습니다.",
  error: "오류 난 글이 없습니다.",
  done: "아직 처리한 글이 없습니다.",
};

/** 문의함 목록 */
function inboxList(tab: InboxTab, rows: InboxRow[], unread: Set<number>) {
  if (rows.length === 0) return html`<div class="card empty">${EMPTY_TEXT[tab]}</div>`;
  return html`<div class="table" role="list">
  <div class="tr thead" aria-hidden="true"><span>종류</span><span>제목 · 내용</span><span>작성자</span><span>상태</span><span>받은 시각</span></div>
  ${rows.map(
    ({ inquiry: q, draft, review }) => html`<div role="listitem"><a class="tr" href="/inquiries/${q.article_no}">
    <span class="c-kind">${kindChip(q)}${draft ? html`<span class="chip">${draft.category}</span>` : ""}</span>
    <span class="c-main">
      <span class="title">${unread.has(q.article_no) ? html`<i class="new-dot" title="새 알림"></i><span class="sr-only">새 알림 있음.</span>` : ""}<span>${q.title}</span></span>
      <span class="snippet">${q.status === "error" ? q.error : q.content}</span>
    </span>
    <span class="c-who">${q.writer}</span>
    <span class="c-state">${statusChip(q, draft, review)}</span>
    <span class="c-time">${shortTime(q.created_date)}</span>
  </a></div>`,
  )}
</div>`;
}

/** 종류 거르기와 목록. 새 알림이 오면 admin.js가 이 부분만 다시 받아 바꿔 끼운다(종류별 개수도 같이 바뀐다). */
export function inboxBody(tab: InboxTab, kind: KindFilter, kindCounts: Record<KindFilter, number>, rows: InboxRow[], unread: Set<number>) {
  return html`
<div class="toolbar">
  <nav class="seg" aria-label="글 종류">
    ${KINDS.map(
      (k) => html`<a href="/inbox?tab=${tab}${k.key === "all" ? "" : `&kind=${k.key}`}" class="${k.key === kind ? "on" : ""}">${k.label}<span class="n">${kindCounts[k.key]}</span></a>`,
    )}
  </nav>
  ${tab === "working" && rows.length ? html`<span class="muted small">초안이 준비되면 알림이 뜨고 검토 대기로 옮겨집니다.</span>` : ""}
</div>
${inboxList(tab, rows, unread)}`;
}

export function inboxPage(
  ctx: PageContext,
  tab: InboxTab,
  kind: KindFilter,
  kindCounts: Record<KindFilter, number>,
  rows: InboxRow[],
  unread: Set<number>,
) {
  const label = TABS.find((t) => t.key === tab)!.label;
  const body = html`<div id="list">${inboxBody(tab, kind, kindCounts, rows, unread)}</div>`;
  return layout(label, { page: "inbox", tab }, ctx, body);
}

function traceView(draft: DraftRow) {
  const names: Record<string, string> = {
    get_order: "주문 조회",
    get_product: "상품 조회",
    recommend_size: "사이즈 계산",
    search_policy: "정책 검색",
    submit_draft: "초안 제출",
  };
  if (draft.trace.length === 0) return html`<p class="muted small">기록된 도구 호출이 없습니다.</p>`;
  return draft.trace.map(
    (t) => html`<details>
  <summary>${names[t.tool] ?? t.tool} <span class="muted small">${JSON.stringify(t.input)}</span></summary>
  <pre>${prettyJson(t.output)}</pre>
</details>`,
  );
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** 상세 화면에서 돌아갈 목록 */
function backTab(q: InquiryRow, draft: DraftRow | undefined): InboxTab {
  if (q.status === "new" || q.status === "drafting") return "working";
  if (q.status === "error") return "error";
  if (q.status === "approved" || q.status === "rejected") return "done";
  return draft?.needs_human ? "human" : "review";
}

export function detailPage(
  ctx: PageContext,
  q: InquiryRow,
  draft: DraftRow | undefined,
  review: ReviewRow | undefined,
  reply: ReplyRow | undefined,
  openedAt: number,
) {
  const cost = draft ? draftCostUsd(draft) : null;
  const back = backTab(q, draft);
  const left = html`
<div class="stack">
  ${
    isComment(q)
      ? html`<div class="card"><h2>댓글이 달린 글</h2><p class="thread">${q.thread ?? "앞선 글을 불러오지 못했습니다."}</p></div>`
      : ""
  }
  <div class="card">
    <div class="muted small">${itemLabel(q)} · ${q.writer} · ${shortTime(q.created_date)}</div>
    <h1>${isComment(q) ? "고객 댓글" : q.title}</h1>
    <div>
      ${kindChip(q)}
      ${q.product_no ? html`<span class="chip">상품 ${q.product_no}</span>` : ""}
      ${q.order_id ? html`<span class="chip">주문 ${q.order_id}</span>` : ""}
    </div>
    <p class="inquiry-body">${q.content}</p>
  </div>
  ${
    draft?.needs_human
      ? html`<div class="notice warn"><strong>담당자 확인 필요</strong><ul>${draft.human_reasons.map((r) => html`<li>${r}</li>`)}</ul></div>`
      : ""
  }
  ${draft?.internal_note ? html`<div class="card"><h2>내부 메모</h2><div class="pre">${draft.internal_note}</div></div>` : ""}
  ${
    draft
      ? html`<div class="card">
    <h2>근거</h2>
    <div>${draft.sources.length ? draft.sources.map((s) => html`<span class="chip">${s}</span>`) : html`<span class="muted">없음</span>`}</div>
    <h2 style="margin-top:16px">에이전트가 확인한 것</h2>
    ${traceView(draft)}
  </div>`
      : ""
  }
</div>`;

  let right: Html;
  if (q.status === "new" || q.status === "drafting") {
    right = html`<div class="card"><h2><span class="spin" aria-hidden="true"></span>초안 만드는 중</h2><p class="muted">초안이 준비되면 알림이 뜨고 이 화면이 저절로 바뀝니다.</p></div>`;
  } else if (q.status === "error") {
    right = html`<div class="card">
  <div class="notice danger"><strong>초안을 만들지 못했습니다</strong><div>${q.error}</div></div>
  <form method="post" action="/inquiries/${q.article_no}/redraft" class="actions"><button class="primary">다시 만들기</button></form>
</div>`;
  } else if (q.status === "drafted" && draft) {
    right = html`<div class="card">
  <h2>${answersWithComment(q) ? "댓글 초안" : "답변 초안"} <span class="chip">${draft.category}</span>${confidenceChip(draft.confidence)}</h2>
  <form method="post" action="/inquiries/${q.article_no}/review" id="review-form">
    <input type="hidden" name="opened_at" value="${openedAt}">
    <textarea name="answer" aria-label="답변">${draft.answer}</textarea>
    <div class="actions">
      <button class="primary" name="decision" value="approve">${answersWithComment(q) ? "승인하고 댓글 등록" : "승인하고 등록"}</button>
      <span class="muted small">고친 내용은 "수정 후 승인"으로 기록됩니다.</span>
    </div>
  </form>
  <!-- 반려는 따로 둔다. 같은 폼이면 반려 이유 칸에서 Enter를 눌렀을 때 첫 버튼(승인)이 눌린다. -->
  <form method="post" action="/inquiries/${q.article_no}/review" class="reject-form">
    <input type="hidden" name="opened_at" value="${openedAt}">
    <input type="text" name="reject_reason" placeholder="반려 이유 (예: 사진 확인 후 직접 답변)" aria-label="반려 이유">
    <div class="actions"><button class="danger" name="decision" value="reject">반려 (직접 처리)</button></div>
  </form>
  <form method="post" action="/inquiries/${q.article_no}/redraft" class="actions">
    <button>초안 다시 만들기</button>
    <span class="muted small">${draft.model} · ${(draft.latency_ms / 1000).toFixed(1)}초 · 토큰 ${draft.input_tokens + draft.cache_read_tokens + draft.cache_write_tokens}/${draft.output_tokens}${cost !== null ? ` · $${cost.toFixed(4)}` : ""}</span>
  </form>
</div>`;
  } else {
    const label = review?.action === "reject" ? "반려" : review?.action === "edit_approve" ? "수정 후 승인" : "그대로 승인";
    right = html`<div class="card">
  <h2>처리 결과: ${label}</h2>
  ${review?.final_answer ? html`<p class="inquiry-body">${review.final_answer}</p>` : ""}
  ${review?.reject_reason ? html`<p class="muted">반려 이유: ${review.reject_reason}</p>` : ""}
  ${review ? html`<p class="muted small">검토 ${Math.round(review.review_seconds)}초${review.edit_ratio ? ` · 수정률 ${pct(review.edit_ratio)}` : ""}</p>` : ""}
  ${reply?.status === "posted" ? html`<div class="chip ok">카페24 등록 완료 (${reply.remote_id})</div>` : ""}
  ${
    reply?.status === "failed"
      ? html`<div class="notice danger"><strong>카페24 등록 실패</strong><div>${reply.error}</div></div>
  <form method="post" action="/inquiries/${q.article_no}/retry-reply" class="actions"><button class="primary">다시 등록</button></form>`
      : ""
  }
</div>`;
  }

  const backLabel = TABS.find((t) => t.key === back)!.label;
  const body = html`<p class="crumb"><a href="/inbox?tab=${back}">← ${backLabel}</a></p><div class="detail">${left}${right}</div>`;
  return layout(itemLabel(q), { page: "detail", item: q.article_no, status: q.status }, ctx, body);
}

export function notificationsPage(ctx: PageContext, rows: NotificationRow[]) {
  const body = html`
<div class="toolbar">
  <span class="muted small">최근 ${rows.length}건. 글을 열면 그 글의 알림은 읽음이 됩니다.</span>
  <form method="post" action="/notifications/read" style="margin-left:auto"><button type="submit">모두 읽음</button></form>
</div>
<div class="card" style="padding:8px">
  <ul class="feed">${rows.length ? rows.map(feedItem) : html`<li class="empty-feed">아직 알림이 없습니다.</li>`}</ul>
</div>`;
  return layout("알림", { page: "notifications" }, ctx, body);
}

export function metricsPage(ctx: PageContext, m: Metrics) {
  const seconds = (v: number | null) => (v === null ? "–" : v < 60 ? `${Math.round(v)}초` : `${(v / 60).toFixed(1)}분`);
  const kpi = (label: string, value: string, help: string) =>
    html`<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="help">${help}</div></div>`;
  const body = html`
<p class="muted">검토를 마친 ${m.reviewed}건 기준입니다. 숫자는 실제 사용 기록에서만 계산합니다.</p>
<div class="kpis">
  ${kpi("그대로 승인률", pct(m.asIsRate), `수정 없이 승인 ${m.approvedAsIs} · 수정 후 ${m.editedApproved} · 반려 ${m.rejected}`)}
  ${kpi("평균 수정률", pct(m.avgEditRatio), "승인한 답변에서 초안을 고친 비율 (글자 기준)")}
  ${kpi("검토 시간 (중앙값)", seconds(m.medianReviewSeconds), "검토 화면을 연 뒤 결정까지")}
  ${kpi(
    "절감 시간",
    m.savedMinutes === null ? "–" : `${Math.round(m.savedMinutes)}분`,
    m.baselineMinutes === null
      ? "직접 작성 기준 시간(BASELINE_MINUTES_PER_REPLY)을 재서 넣으면 계산됩니다"
      : `직접 작성 ${m.baselineMinutes}분/건 기준`,
  )}
  ${kpi("확인 필요 비율", pct(m.humanFlagRate), "에이전트나 안전 규칙이 담당자에게 넘긴 초안")}
  ${kpi("초안 생성 시간", seconds(m.avgDraftSeconds), "건당 평균")}
  ${kpi("건당 비용", m.avgCostUsd === null ? "–" : `$${m.avgCostUsd.toFixed(3)}`, `누적 $${m.totalCostUsd.toFixed(2)} · 캐시 적중 ${pct(m.cacheHitRate)}`)}
</div>
<div class="card">
  <h2>유형별</h2>
  ${
    m.byCategory.length === 0
      ? html`<p class="muted">아직 초안이 없습니다.</p>`
      : html`<table>
    <thead><tr><th>유형</th><th>초안</th><th>검토</th><th>그대로 승인률</th><th>확인 필요 비율</th></tr></thead>
    <tbody>${m.byCategory.map(
      (c) => html`<tr><td>${c.category}</td><td>${c.drafts}</td><td>${c.reviewed}</td><td>${pct(c.asIsRate)}</td><td>${pct(c.humanFlagRate)}</td></tr>`,
    )}</tbody>
  </table>
  <p class="muted small">최근 50건 이상, 그대로 승인률 95% 이상인 유형이 자동 등록 후보입니다 (설계 문서 8장).</p>`
  }
</div>`;
  return layout("지표", { page: "metrics" }, ctx, body);
}

export type ComplaintPeriod = "7" | "30" | "all";

export const COMPLAINT_PERIODS: { key: ComplaintPeriod; label: string; days: number | null }[] = [
  { key: "7", label: "지난 7일", days: 7 },
  { key: "30", label: "지난 30일", days: 30 },
  { key: "all", label: "전체", days: null },
];

export interface ComplaintsView {
  period: ComplaintPeriod;
  report: ComplaintReport;
  /** 기간과 상관없이 저장된 분류 결과 수. 0이면 아직 한 번도 만들지 않은 것이다. */
  totalLabeled: number;
  schedule: ReportSchedule;
  classifierLabel: string;
  sourceName: string;
  /** 구글시트에 같이 쓰면 주소, 마지막으로 쓴 시각, 마지막 실패 이유 */
  sheet: { url: string; writtenAt: string | null; error: { at: string; message: string } | null } | null;
}

/** 불만 사유 리포트. 순위는 DB에 저장된 분류 결과로 화면을 열 때마다 다시 계산한다(LLM은 부르지 않는다). */
export function complaintsPage(ctx: PageContext, v: ComplaintsView) {
  const { report: r, schedule } = v;
  const kpi = (label: string, value: string | number, help: string) =>
    html`<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="help">${help}</div></div>`;
  const delta = (prev: number | null, count: number) =>
    prev === null ? "" : count > prev ? `+${count - prev}` : count < prev ? `${count - prev}` : "0";
  const when =
    schedule.hour < 0
      ? "자동으로 만들지 않습니다(COMPLAINT_REPORT_HOUR)."
      : `매일 ${schedule.hour}시 이후 처음 확인할 때 만듭니다(앱이 켜져 있을 때).`;
  const body = html`
<div class="toolbar">
  <nav class="seg" aria-label="기간">
    ${COMPLAINT_PERIODS.map((p) => html`<a href="/complaints${p.key === "7" ? "" : `?days=${p.key}`}" class="${p.key === v.period ? "on" : ""}">${p.label}</a>`)}
  </nav>
  <a href="/complaints.xlsx${v.period === "7" ? "" : `?days=${v.period}`}">엑셀 받기</a>
  <a href="/complaints.csv${v.period === "7" ? "" : `?days=${v.period}`}">CSV 받기</a>
  <form method="post" action="/complaints/run" style="margin-left:auto">
    <input type="hidden" name="days" value="${v.period}">
    <button class="primary" type="submit"${schedule.running ? html` disabled` : ""}>${schedule.running ? "만드는 중…" : "지금 만들기"}</button>
  </form>
</div>
<p class="muted small">${when} 마지막 리포트 ${schedule.lastDate ?? "없음"} · 자료 ${v.sourceName} · 분류 ${v.classifierLabel} · ${
    v.sheet
      ? html`구글시트 연결됨(${v.sheet.writtenAt ? `마지막으로 씀 ${shortTime(v.sheet.writtenAt)}` : "아직 안 씀"}) <a href="${v.sheet.url}" target="_blank" rel="noopener">시트 열기</a>`
      : "구글시트 연결 안 됨"
  }</p>
${schedule.running ? html`<div class="notice" role="status">리포트를 만드는 중입니다. 끝나면 화면이 저절로 바뀝니다.</div>` : ""}
${schedule.lastError ? html`<div class="notice danger" role="alert"><strong>리포트를 만들지 못했습니다.</strong> ${schedule.lastError}</div>` : ""}
${
  v.sheet?.error
    ? html`<div class="notice danger" role="alert"><strong>구글시트에 쓰지 못했습니다(${shortTime(v.sheet.error.at)}).</strong> ${v.sheet.error.message} 리포트 파일은 만들어졌고, 다음에 만들 때 다시 씁니다.</div>`
    : ""
}
${
  r.fallback || schedule.lastWarning
    ? html`<div class="notice warn" role="status"><strong>Claude 분류 실패 ${r.fallback}건</strong>은 규칙 결과로 두었고 다음에 만들 때 다시 분류합니다.${schedule.lastWarning ? html` (${schedule.lastWarning})` : ""}</div>`
    : ""
}
<div class="kpis">
  ${kpi("고객 글", r.posts, "이 기간에 올라온 후기·문의·댓글")}
  ${kpi("불만 글", r.complaints, "사유가 하나 이상인 글")}
  ${kpi("불만 아님", r.not_complaints, "칭찬, 구매 전 질문, 요청")}
  ${kpi("확인 필요", r.needs_check, "근거가 원문에 없거나 확신도가 낮거나 글에 지시가 든 글 (아래 목록)")}
</div>
${
  r.rising.length
    ? html`<div class="notice warn" role="status"><strong>늘어난 사유</strong> · ${r.rising.map((x, i) => html`${i ? ", " : ""}${x.label} ${x.previous}→${x.count}건`)}</div>`
    : ""
}
<div class="card">
  <h2>전체 사유 순위</h2>
  ${
    r.overall.length === 0
      ? html`<p class="muted">${
          v.totalLabeled === 0
            ? "아직 분류한 글이 없습니다. '지금 만들기'를 눌러 주세요."
            : r.posts
              ? "이 기간에는 불만 글이 없습니다."
              : "이 기간에 올라온 고객 글이 없습니다. 30일이나 전체를 골라 보세요."
        }</p>`
      : html`<table>
    <thead><tr><th>순위</th><th>사유</th><th>건수</th><th>불만 글 중</th>${r.days === null ? "" : html`<th>지난 기간 대비</th>`}</tr></thead>
    <tbody>${r.overall.map(
      (x, i) => html`<tr><td>${i + 1}</td><td>${x.label}</td><td>${x.count}</td><td>${pct(x.share)}</td>${r.days === null ? "" : html`<td>${delta(x.previous, x.count)}</td>`}</tr>`,
    )}</tbody>
  </table>`
  }
</div>
<div class="card">
  <h2>상품별</h2>
  ${
    r.products.length === 0
      ? html`<p class="muted">없음</p>`
      : r.products.map(
          (p) => html`<section class="complaint-product">
    <h3>${p.name} <span class="muted small">불만 글 ${p.complaints}건</span></h3>
    <ol>${p.reasons.map((x) => html`<li>${x.label} ${x.count}건</li>`)}</ol>
    ${p.quotes.map(
      (q) => html`<blockquote>${q.text}<span class="muted small"> · ${q.kind === "review" ? `후기${q.rating ? ` ★${q.rating}` : ""}` : q.kind === "qna" ? "문의" : "댓글"} · ${q.created_date.slice(0, 10)}</span></blockquote>`,
    )}
  </section>`,
        )
  }
</div>
${
  r.checks.length
    ? html`<details class="card" id="needs-check">
  <summary><strong>확인 필요 글 ${r.checks.length}건</strong> <span class="muted small">순위에는 세고 인용에서는 뺀 글</span></summary>
  <ul class="checks">${r.checks.map(
    (x) => html`<li><span class="chip">${x.product}</span>${x.reasons.length ? x.reasons.join(", ") : "불만 아님"} · <span class="muted small">${x.why.join(" / ")} · ${x.created_date.slice(0, 10)}</span><br>${x.text}</li>`,
  )}</ul>
</details>`
    : ""
}
<p class="muted small">글마다 한 번만 분류해 저장하고, 화면은 저장된 결과로 순위를 다시 셉니다. 확인 필요 글은 순위에 세고 인용에서는 뺍니다. 인용문의 전화번호·주문번호·주소·이메일·계좌번호는 가립니다. 쇼핑몰에는 아무것도 쓰지 않습니다.</p>`;
  return layout("불만 사유", { page: "complaints" }, ctx, body);
}

export function errorPage(ctx: PageContext, message: string) {
  return layout(
    "오류",
    { page: "error" },
    ctx,
    html`<div class="notice danger"><strong>처리하지 못했습니다</strong><div>${message}</div></div><p><a href="/inbox">문의함으로</a></p>`,
  );
}
