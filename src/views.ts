import { html } from "hono/html";
import type { DraftRow, InquiryRow, ReplyRow, ReviewRow } from "./db.ts";
import { draftCostUsd, type Metrics } from "./metrics.ts";

// 화면은 서버에서 HTML로 그린다. html`` 은 끼워 넣는 값을 자동으로 이스케이프한다.

type Html = ReturnType<typeof html>;

export type InboxTab = "review" | "human" | "working" | "error" | "done";

export const TABS: { key: InboxTab; label: string }[] = [
  { key: "review", label: "검토 대기" },
  { key: "human", label: "확인 필요" },
  { key: "working", label: "생성 중" },
  { key: "error", label: "오류" },
  { key: "done", label: "처리 완료" },
];

export interface PageContext {
  modeLabel: string;
  flash?: string | null;
}

const CSS = `
:root {
  --bg: #f6f6f4; --surface: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --line: #e3e2dd;
  --accent: #1f5f4a; --accent-text: #ffffff; --accent-soft: #e4efe9;
  --warn: #8a5a00; --warn-soft: #fbf1dc; --danger: #a33a2c; --danger-soft: #f8e5e1;
  --chip: #efeeea;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161615; --surface: #1f1f1d; --text: #ecebe6; --muted: #a09f98; --line: #34332f;
    --accent: #6cc3a0; --accent-text: #0f1f18; --accent-soft: #1d3329;
    --warn: #e7b65c; --warn-soft: #3a2f17; --danger: #ee8a7b; --danger-soft: #3d221d;
    --chip: #2a2a27;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", sans-serif; }
a { color: inherit; }
header { display: flex; align-items: center; gap: 20px; padding: 12px 24px; background: var(--surface); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
header .brand { font-weight: 700; text-decoration: none; }
header nav { display: flex; gap: 14px; }
header nav a { text-decoration: none; color: var(--muted); }
header nav a.on { color: var(--text); font-weight: 600; }
header .right { margin-left: auto; display: flex; align-items: center; gap: 12px; }
main { max-width: 1180px; margin: 0 auto; padding: 24px; }
.mode { font-size: 12px; color: var(--muted); background: var(--chip); padding: 3px 8px; border-radius: 999px; }
.flash { background: var(--accent-soft); border: 1px solid var(--line); padding: 10px 14px; border-radius: 8px; margin-bottom: 16px; }
.tabs { display: flex; gap: 6px; margin-bottom: 16px; flex-wrap: wrap; }
.tabs a { text-decoration: none; padding: 6px 12px; border-radius: 999px; background: var(--surface); border: 1px solid var(--line); color: var(--muted); }
.tabs a.on { background: var(--text); color: var(--bg); border-color: var(--text); }
.tabs .n { font-variant-numeric: tabular-nums; margin-left: 4px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; }
.list { display: flex; flex-direction: column; gap: 8px; }
.row { display: grid; grid-template-columns: 64px 1fr auto; gap: 14px; align-items: start; text-decoration: none; }
.row:hover { border-color: var(--muted); }
.row .no { color: var(--muted); font-variant-numeric: tabular-nums; }
.row .title { font-weight: 600; }
.row .snippet { color: var(--muted); overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; }
.row .meta { text-align: right; color: var(--muted); font-size: 13px; white-space: nowrap; }
.chip { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--chip); margin-right: 4px; }
.chip.warn { background: var(--warn-soft); color: var(--warn); }
.chip.danger { background: var(--danger-soft); color: var(--danger); }
.chip.ok { background: var(--accent-soft); color: var(--accent); }
.empty { color: var(--muted); text-align: center; padding: 48px 0; }
.detail { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr); gap: 20px; align-items: start; }
.stack { display: flex; flex-direction: column; gap: 16px; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 15px; margin: 0 0 10px; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
.inquiry-body { white-space: pre-wrap; margin: 12px 0 0; }
.pre { white-space: pre-wrap; }
.notice { border-radius: 8px; padding: 12px 14px; }
.notice.warn { background: var(--warn-soft); color: var(--warn); }
.notice.danger { background: var(--danger-soft); color: var(--danger); }
.notice ul { margin: 6px 0 0; padding-left: 18px; }
textarea { width: 100%; min-height: 300px; padding: 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font: inherit; resize: vertical; }
input[type=text] { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font: inherit; }
.actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; align-items: center; }
button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--line); background: var(--surface); color: var(--text); cursor: pointer; }
button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); font-weight: 600; }
button.danger { color: var(--danger); }
details { border-top: 1px solid var(--line); padding: 8px 0; }
details:first-of-type { border-top: 0; }
summary { cursor: pointer; }
pre { white-space: pre-wrap; word-break: break-all; background: var(--bg); padding: 10px; border-radius: 6px; font-size: 12px; margin: 6px 0 0; }
.kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; margin-bottom: 20px; }
.kpi .label { color: var(--muted); font-size: 13px; }
.kpi .value { font-size: 28px; font-weight: 700; font-variant-numeric: tabular-nums; margin: 2px 0; }
.kpi .help { color: var(--muted); font-size: 12px; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
th { color: var(--muted); font-weight: 500; font-size: 13px; }
.reject-form { margin-top: 14px; padding-top: 14px; border-top: 1px dashed var(--line); }
@media (max-width: 860px) {
  .detail { grid-template-columns: 1fr; }
  main { padding: 16px; }
  .row { grid-template-columns: 1fr; gap: 4px; }
  .row .meta { text-align: left; }
}
`;

export function layout(title: string, active: "inbox" | "metrics", ctx: PageContext, body: Html, refreshSeconds?: number) {
  return html`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refreshSeconds ? html`<meta http-equiv="refresh" content="${refreshSeconds}">` : ""}
<title>${title} · CS 답변 초안</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <a class="brand" href="/inbox">CS 답변 초안</a>
  <nav>
    <a href="/inbox" class="${active === "inbox" ? "on" : ""}">문의함</a>
    <a href="/metrics" class="${active === "metrics" ? "on" : ""}">지표</a>
  </nav>
  <div class="right">
    <span class="mode">${ctx.modeLabel}</span>
    <form method="post" action="/sync"><button class="primary" type="submit">새 문의 불러오기</button></form>
  </div>
</header>
<main>
${ctx.flash ? html`<div class="flash">${ctx.flash}</div>` : ""}
${body}
</main>
</body>
</html>`;
}

const formatDate = (iso: string) =>
  new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);

function confidenceChip(confidence: DraftRow["confidence"]) {
  const label = { high: "확신 높음", medium: "확신 보통", low: "확신 낮음" }[confidence];
  const tone = { high: "ok", medium: "", low: "warn" }[confidence];
  return html`<span class="chip ${tone}">${label}</span>`;
}

function statusChip(q: InquiryRow, draft: DraftRow | undefined, review: ReviewRow | undefined) {
  if (q.status === "drafting" || q.status === "new") return html`<span class="chip">생성 중</span>`;
  if (q.status === "error") return html`<span class="chip danger">오류</span>`;
  if (q.status === "approved") {
    return review?.action === "edit_approve"
      ? html`<span class="chip ok">수정 후 승인</span>`
      : html`<span class="chip ok">그대로 승인</span>`;
  }
  if (q.status === "rejected") return html`<span class="chip">반려</span>`;
  return draft ? confidenceChip(draft.confidence) : "";
}

export function inboxPage(
  ctx: PageContext,
  tab: InboxTab,
  counts: Record<InboxTab, number>,
  rows: { inquiry: InquiryRow; draft?: DraftRow; review?: ReviewRow }[],
  drafting: boolean,
) {
  const body = html`
<div class="tabs">
  ${TABS.map((t) => html`<a href="/inbox?tab=${t.key}" class="${t.key === tab ? "on" : ""}">${t.label}<span class="n">${counts[t.key]}</span></a>`)}
</div>
${drafting ? html`<p class="muted small">초안을 만드는 중입니다. 이 화면은 5초마다 새로고침됩니다.</p>` : ""}
${
  rows.length === 0
    ? html`<div class="card empty">${tab === "review" ? "검토할 초안이 없습니다. 위의 \"새 문의 불러오기\"를 눌러 보세요." : "없습니다."}</div>`
    : html`<div class="list">
  ${rows.map(
    ({ inquiry: q, draft, review }) => html`
  <a class="card row" href="/inquiries/${q.article_no}">
    <div class="no">#${q.article_no}</div>
    <div>
      <div>${draft ? html`<span class="chip">${draft.category}</span>` : ""}<span class="title">${q.title}</span></div>
      <div class="snippet">${q.status === "error" ? q.error : q.content}</div>
    </div>
    <div class="meta">${statusChip(q, draft, review)}<br>${q.writer} · ${formatDate(q.created_date)}</div>
  </a>`,
  )}
</div>`
}`;
  return layout("문의함", "inbox", ctx, body, drafting ? 5 : undefined);
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

export function detailPage(
  ctx: PageContext,
  q: InquiryRow,
  draft: DraftRow | undefined,
  review: ReviewRow | undefined,
  reply: ReplyRow | undefined,
  openedAt: number,
) {
  const cost = draft ? draftCostUsd(draft) : null;
  const left = html`
<div class="stack">
  <div class="card">
    <div class="muted small">#${q.article_no} · ${q.writer} · ${formatDate(q.created_date)}</div>
    <h1>${q.title}</h1>
    <div>
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
    right = html`<div class="card"><h2>초안 생성 중</h2><p class="muted">잠시 후 새로고침해 주세요.</p></div>`;
  } else if (q.status === "error") {
    right = html`<div class="card">
  <div class="notice danger"><strong>초안을 만들지 못했습니다</strong><div>${q.error}</div></div>
  <form method="post" action="/inquiries/${q.article_no}/redraft" class="actions"><button class="primary">다시 생성</button></form>
</div>`;
  } else if (q.status === "drafted" && draft) {
    right = html`<div class="card">
  <h2>답변 초안 <span class="chip">${draft.category}</span>${confidenceChip(draft.confidence)}</h2>
  <form method="post" action="/inquiries/${q.article_no}/review">
    <input type="hidden" name="opened_at" value="${openedAt}">
    <textarea name="answer" aria-label="답변">${draft.answer}</textarea>
    <div class="actions">
      <button class="primary" name="decision" value="approve">승인하고 등록</button>
      <span class="muted small">고친 내용은 "수정 후 승인"으로 기록됩니다.</span>
    </div>
  </form>
  <!-- 반려는 따로 둔다. 같은 폼이면 반려 이유 칸에서 Enter를 눌렀을 때 첫 버튼(승인)이 눌린다. -->
  <form method="post" action="/inquiries/${q.article_no}/review" class="reject-form">
    <input type="hidden" name="opened_at" value="${openedAt}">
    <input type="text" name="reject_reason" placeholder="반려 이유 (예: 사진 확인 후 직접 답변)">
    <div class="actions"><button class="danger" name="decision" value="reject">반려 (직접 처리)</button></div>
  </form>
  <form method="post" action="/inquiries/${q.article_no}/redraft" class="actions">
    <button>초안 다시 생성</button>
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

  return layout(`#${q.article_no}`, "inbox", ctx, html`<p><a class="muted small" href="/inbox">← 문의함</a></p><div class="detail">${left}${right}</div>`);
}

export function metricsPage(ctx: PageContext, m: Metrics) {
  const seconds = (v: number | null) => (v === null ? "–" : v < 60 ? `${Math.round(v)}초` : `${(v / 60).toFixed(1)}분`);
  const kpi = (label: string, value: string, help: string) =>
    html`<div class="card kpi"><div class="label">${label}</div><div class="value">${value}</div><div class="help">${help}</div></div>`;
  const body = html`
<h1>지표</h1>
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
  return layout("지표", "metrics", ctx, body);
}

export function errorPage(ctx: PageContext, message: string) {
  return layout("오류", "inbox", ctx, html`<div class="notice danger"><strong>처리하지 못했습니다</strong><div>${message}</div></div><p><a href="/inbox">문의함으로</a></p>`);
}
