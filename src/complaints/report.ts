import { maskPersonalInfo } from "./mask.ts";
import type { LabeledPost } from "./store.ts";
import { reasonKey, reasonKeyLabel } from "./taxonomy.ts";

// 분류 결과로 리포트를 계산하고 HTML·CSV로 쓴다.
// 글 하나에 사유가 둘이면 두 사유에 하나씩 센다. 비율은 '불만 글 수' 대비다.

const DAY = 86_400_000;

export interface ReasonCount {
  key: string;
  label: string;
  count: number;
  /** 불만 글 중 이 사유가 나온 비율(0~1) */
  share: number;
  /** 바로 앞 같은 길이 기간의 건수. 전체 기간 리포트는 null */
  previous: number | null;
}

export interface Quote {
  text: string;
  kind: string;
  rating: number | null;
  created_date: string;
}

/** 확인 필요로 둔 글. 관리자 화면에서 어떤 글이고 왜인지 본다. */
export interface CheckItem {
  product: string;
  reasons: string[];
  why: string[];
  text: string;
  kind: string;
  created_date: string;
  fallback: boolean;
}

export interface ProductBlock {
  product_no: number | null;
  name: string;
  complaints: number;
  reasons: ReasonCount[];
  quotes: Quote[];
}

export interface ComplaintReport {
  generated_at: string;
  /** 기준 시각(EVAL_NOW로 고정할 수 있다) */
  now: string;
  /** 기간(일). null이면 전체 기간 */
  days: number | null;
  posts: number;
  complaints: number;
  not_complaints: number;
  needs_check: number;
  /** LLM이 실패해 규칙으로 대신 채운 글 수(다음 실행 때 다시 분류) */
  fallback: number;
  overall: ReasonCount[];
  /** 지난 기간보다 늘었고 건수가 기준 이상인 사유 */
  rising: ReasonCount[];
  products: ProductBlock[];
  checks: CheckItem[];
  classifier: string;
}

export interface ReportOptions {
  now: Date;
  days: number | null;
  /** '늘어난 사유'로 알릴 최소 건수 */
  minRise?: number;
  quotesPerProduct?: number;
  productNames?: Map<number, string>;
}

function inRange(date: string, from: number, to: number): boolean {
  const t = Date.parse(date);
  return t > from && t <= to;
}

function countReasons(rows: LabeledPost[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { label } of rows) {
    for (const key of new Set(label.reasons.map(reasonKey))) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function ranked(current: LabeledPost[], previous: LabeledPost[] | null): ReasonCount[] {
  const complaints = current.filter((r) => r.label.reasons.length).length;
  const now = countReasons(current);
  const before = previous ? countReasons(previous) : null;
  return [...now.entries()]
    .map(([key, count]) => ({
      key,
      label: reasonKeyLabel(key),
      count,
      share: complaints ? count / complaints : 0,
      previous: before ? (before.get(key) ?? 0) : null,
    }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

/** 인용문: LLM이 고른 근거 구절이 있으면 그것, 없으면 본문 앞부분(90자). 개인정보는 가린다. 엑셀도 같은 규칙을 쓴다. */
export function quoteOf({ post, label }: LabeledPost): Quote {
  const evidence = label.classifier === "rules+llm" ? label.reasons.map((r) => r.evidence).find((e) => e.length >= 4) : undefined;
  const base = evidence ?? `${post.title} ${post.content}`.trim();
  // 이모지가 반으로 잘리지 않게 글자(코드 포인트) 단위로 자른다.
  const text = Array.from(maskPersonalInfo(base.replace(/\s+/g, " "))).slice(0, 90).join("");
  return { text, kind: post.kind, rating: post.rating, created_date: post.created_date };
}

/** 기간 안의 글(기준 시각부터 days일 전까지). days가 null이면 전부 */
export function inPeriod(rows: LabeledPost[], now: Date, days: number | null): LabeledPost[] {
  const to = now.getTime();
  return days === null ? rows.filter((r) => Date.parse(r.post.created_date) <= to) : rows.filter((r) => inRange(r.post.created_date, to - days * DAY, to));
}

export function computeReport(rows: LabeledPost[], options: ReportOptions): ComplaintReport {
  const to = options.now.getTime();
  const from = options.days === null ? -Infinity : to - options.days * DAY;
  const current = rows.filter((r) => inRange(r.post.created_date, from, to));
  const previous = options.days === null ? null : rows.filter((r) => inRange(r.post.created_date, from - options.days! * DAY, from));
  const complaintRows = current.filter((r) => r.label.reasons.length);
  const overall = ranked(current, previous);
  const minRise = options.minRise ?? 3;

  const nameOf = (no: number | null) => (no === null ? "상품 미지정" : (options.productNames?.get(no) ?? `상품 ${no}`));
  const groups = new Map<number | null, LabeledPost[]>();
  for (const r of complaintRows) groups.set(r.post.product_no, [...(groups.get(r.post.product_no) ?? []), r]);
  const products: ProductBlock[] = [...groups.entries()]
    .map(([product_no, list]) => ({
      product_no,
      name: nameOf(product_no),
      complaints: list.length,
      reasons: ranked(list, null),
      // 확인 필요·주입 의심 글은 대표 인용에서 뺀다. 최근 글부터.
      quotes: list
        .filter((r) => !r.label.needs_check && !r.label.injection)
        .sort((a, b) => b.post.created_date.localeCompare(a.post.created_date))
        .slice(0, options.quotesPerProduct ?? 2)
        .map(quoteOf),
    }))
    .sort((a, b) => b.complaints - a.complaints || (a.product_no ?? Infinity) - (b.product_no ?? Infinity));

  const checks: CheckItem[] = current
    .filter((r) => r.label.needs_check)
    .sort((a, b) => b.post.created_date.localeCompare(a.post.created_date))
    .map((r) => ({
      product: nameOf(r.post.product_no),
      reasons: r.label.reasons.map((x) => reasonKeyLabel(reasonKey(x))),
      why: r.label.check_reasons,
      text: Array.from(maskPersonalInfo(`${r.post.title} ${r.post.content}`.replace(/\s+/g, " ").trim())).slice(0, 90).join(""),
      kind: r.post.kind,
      created_date: r.post.created_date,
      fallback: r.label.fallback,
    }));

  return {
    generated_at: new Date().toISOString(),
    now: options.now.toISOString(),
    days: options.days,
    posts: current.length,
    complaints: complaintRows.length,
    not_complaints: current.length - complaintRows.length,
    needs_check: current.filter((r) => r.label.needs_check).length,
    fallback: current.filter((r) => r.label.fallback).length,
    overall,
    // 지난 기간에 글이 하나도 없으면(가게를 막 연 첫 주, 한꺼번에 올린 시연 자료) 견줄 기준이 없어 알리지 않는다.
    rising:
      options.days === null || !previous?.length ? [] : overall.filter((r) => r.count >= minRise && r.count > (r.previous ?? 0)),
    products,
    checks,
    classifier: rows[0]?.label.classifier ?? "-",
  };
}

/** 한국 시각 날짜(YYYY-MM-DD). 리포트 파일 이름과 '오늘 만들었는지'에 쓴다. */
export function kstDate(date: Date): string {
  return new Date(date.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function kstHour(date: Date): number {
  return new Date(date.getTime() + 9 * 3_600_000).getUTCHours();
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function delta(r: ReasonCount): string {
  if (r.previous === null) return "";
  const d = r.count - r.previous;
  return d > 0 ? `+${d}` : d < 0 ? String(d) : "0";
}

function periodLabel(report: Pick<ComplaintReport, "days">): string {
  return report.days === null ? "전체 기간" : `지난 ${report.days}일`;
}

export interface RenderInput {
  /** 위에서부터 보여 줄 기간들(예: 7일, 30일) */
  reports: ComplaintReport[];
  source: string;
  notes: string[];
}

export function renderHtml({ reports, source, notes }: RenderInput): string {
  const first = reports[0];
  const date = kstDate(new Date(first.now));
  const sections = reports.map((r) => {
    const rising = r.rising.length
      ? `<p class="rise">늘어난 사유: ${r.rising.map((x) => `<b>${esc(x.label)}</b> ${x.previous}→${x.count}건`).join(", ")}</p>`
      : "";
    const overall = r.overall.length
      ? `<table><thead><tr><th>순위</th><th>사유</th><th>건수</th><th>불만 글 중</th>${r.days === null ? "" : "<th>지난 기간 대비</th>"}</tr></thead><tbody>${r.overall
          .map(
            (x, i) =>
              `<tr><td>${i + 1}</td><td>${esc(x.label)}</td><td>${x.count}</td><td>${pct(x.share)}</td>${r.days === null ? "" : `<td>${delta(x)}</td>`}</tr>`,
          )
          .join("")}</tbody></table>`
      : `<p class="muted">이 기간에는 불만 글이 없습니다.</p>`;
    const products = r.products
      .map(
        (p) => `<div class="product"><h4>${esc(p.name)} <span class="muted">불만 글 ${p.complaints}건</span></h4>
<ol>${p.reasons.map((x) => `<li>${esc(x.label)} ${x.count}건</li>`).join("")}</ol>
${p.quotes.map((q) => `<blockquote>${esc(q.text)}<span class="muted"> · ${q.kind === "review" ? `후기${q.rating ? ` ★${q.rating}` : ""}` : q.kind === "qna" ? "문의" : "댓글"} · ${esc(q.created_date.slice(0, 10))}</span></blockquote>`).join("")}</div>`,
      )
      .join("");
    const fallback = r.fallback
      ? `<p class="rise">Claude 분류에 실패한 ${r.fallback}건은 규칙 결과로 셌습니다(다음에 만들 때 다시 분류).</p>`
      : "";
    const checks = r.checks.length
      ? `<h3>확인 필요 글 ${r.checks.length}건</h3><ul>${r.checks
          .map((c) => `<li>${esc(c.product)} · ${esc(c.reasons.join(", ") || "불만 아님")} <span class="muted">(${esc(c.why.join(" / "))})</span><br>${esc(c.text)}</li>`)
          .join("")}</ul>`
      : "";
    return `<section><h2>${periodLabel(r)}</h2>
<p>고객 글 ${r.posts}건 · 불만 글 <b>${r.complaints}건</b> · 불만 아님 ${r.not_complaints}건 · 확인 필요 ${r.needs_check}건</p>
${rising}${fallback}<h3>전체 사유 순위</h3>${overall}<h3>상품별</h3>${products || `<p class="muted">없음</p>`}${checks}</section>`;
  });
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>불만 사유 리포트 ${date}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo","Pretendard",sans-serif;margin:0;padding:24px 16px;background:#f7f7f5;color:#1d1d1b;line-height:1.55}
main{max-width:860px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 8px;border-top:1px solid #ddd;padding-top:20px}h3{font-size:15px;margin:18px 0 6px}h4{font-size:14px;margin:0 0 4px}
table{border-collapse:collapse;width:100%;background:#fff;font-size:14px}th,td{border-bottom:1px solid #eee;padding:6px 8px;text-align:left}th{color:#666;font-weight:600}
.product{background:#fff;border:1px solid #e6e6e1;border-radius:8px;padding:12px 14px;margin:8px 0}.product ol{margin:4px 0 6px;padding-left:20px;font-size:14px}
blockquote{margin:4px 0;padding:4px 10px;border-left:3px solid #ccc;font-size:13px;background:#fafafa}
.muted{color:#777;font-size:12px}.rise{background:#fff4e0;border:1px solid #f0d7a8;border-radius:6px;padding:8px 10px}
.notes{font-size:12px;color:#666;margin-top:28px}
</style></head><body><main>
<h1>불만 사유 리포트 · ${date}</h1>
<p class="muted">기준 ${esc(first.now.slice(0, 16).replace("T", " "))} UTC · 자료 ${esc(source)} · 분류 ${esc(first.classifier)} · 만든 시각 ${esc(first.generated_at.slice(0, 16).replace("T", " "))} UTC</p>
${sections.join("\n")}
<div class="notes"><p>${notes.map(esc).join("<br>")}</p></div>
</main></body></html>`;
}

/** 글자 칸이 = + - @로 시작하면 엑셀이 수식으로 읽는다. 앞에 '를 붙여 글자로 둔다. 숫자 칸은 그대로. */
function csvCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  const s = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 엑셀에서 한글이 깨지지 않게 BOM을 붙인다. */
export function renderCsv(reports: ComplaintReport[]): string {
  const rows: (string | number | null)[][] = [["기간", "구분", "상품번호", "상품명", "사유", "건수", "불만 글 중 비율", "지난 기간 건수"]];
  for (const r of reports) {
    const period = periodLabel(r);
    for (const x of r.overall) rows.push([period, "전체", null, null, x.label, x.count, pct(x.share), x.previous]);
    for (const p of r.products) {
      for (const x of p.reasons) rows.push([period, "상품별", p.product_no, p.name, x.label, x.count, pct(x.share), null]);
    }
  }
  return "﻿" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}
