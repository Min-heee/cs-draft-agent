import type { DraftRow, InquiryStatus, ReviewRow, Store } from "./db.ts";

// 달러 / 100만 토큰. 캐시 쓰기는 5분 캐시 기준(입력 단가 × 1.25).
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
};

export function draftCostUsd(d: Pick<DraftRow, "model" | "input_tokens" | "output_tokens" | "cache_read_tokens" | "cache_write_tokens">): number | null {
  const p = PRICES[d.model];
  if (!p) return null;
  return (
    (d.input_tokens * p.input + d.output_tokens * p.output + d.cache_read_tokens * p.cacheRead + d.cache_write_tokens * p.cacheWrite) /
    1_000_000
  );
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const average = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const rate = (part: number, whole: number) => (whole ? part / whole : null);

export interface CategoryMetrics {
  category: string;
  drafts: number;
  reviewed: number;
  asIsRate: number | null;
  humanFlagRate: number | null;
}

export interface Metrics {
  statusCounts: Record<InquiryStatus, number>;
  reviewed: number;
  approvedAsIs: number;
  editedApproved: number;
  rejected: number;
  asIsRate: number | null;
  avgEditRatio: number | null;
  medianReviewSeconds: number | null;
  avgDraftSeconds: number | null;
  avgCostUsd: number | null;
  totalCostUsd: number;
  cacheHitRate: number | null;
  humanFlagRate: number | null;
  baselineMinutes: number | null;
  savedMinutes: number | null;
  byCategory: CategoryMetrics[];
}

export function computeMetrics(store: Store, baselineMinutes: number | null): Metrics {
  const allDrafts = store.allDrafts();
  // 가짜 작성기(DRAFTER=fake) 초안은 시간·비용 통계에서 뺀다.
  const drafts = allDrafts.filter((d) => d.model !== "fake");
  const reviews = store.allReviews();
  const draftById = new Map(allDrafts.map((d) => [d.id, d]));

  const approvedAsIs = reviews.filter((r) => r.action === "approve").length;
  const editedApproved = reviews.filter((r) => r.action === "edit_approve").length;
  const rejected = reviews.filter((r) => r.action === "reject").length;
  const approvals = reviews.filter((r) => r.action !== "reject");
  // 검토 화면을 열어 둔 채 자리를 비운 경우가 섞이므로 평균 대신 중앙값을 쓴다.
  const medianReview = median(reviews.map((r) => r.review_seconds));

  const costs = drafts.map(draftCostUsd).filter((c): c is number => c !== null);
  const promptTokens = drafts.reduce((s, d) => s + d.input_tokens + d.cache_read_tokens + d.cache_write_tokens, 0);
  const cacheRead = drafts.reduce((s, d) => s + d.cache_read_tokens, 0);

  const categories = [...new Set(allDrafts.map((d) => d.category))].sort();
  const byCategory = categories.map((category) => {
    const catDrafts = allDrafts.filter((d) => d.category === category);
    const catReviews = reviews.filter((r: ReviewRow) => draftById.get(r.draft_id)?.category === category);
    return {
      category,
      drafts: catDrafts.length,
      reviewed: catReviews.length,
      asIsRate: rate(catReviews.filter((r) => r.action === "approve").length, catReviews.length),
      humanFlagRate: rate(catDrafts.filter((d) => d.needs_human).length, catDrafts.length),
    };
  });

  return {
    statusCounts: store.countByStatus(),
    reviewed: reviews.length,
    approvedAsIs,
    editedApproved,
    rejected,
    asIsRate: rate(approvedAsIs, reviews.length),
    avgEditRatio: average(approvals.map((r) => r.edit_ratio ?? 0)),
    medianReviewSeconds: medianReview,
    avgDraftSeconds: average(drafts.map((d) => d.latency_ms / 1000)),
    avgCostUsd: average(costs),
    totalCostUsd: costs.reduce((a, b) => a + b, 0),
    cacheHitRate: rate(cacheRead, promptTokens),
    humanFlagRate: rate(allDrafts.filter((d) => d.needs_human).length, allDrafts.length),
    baselineMinutes,
    savedMinutes:
      baselineMinutes !== null && medianReview !== null
        ? Math.max(0, baselineMinutes - medianReview / 60) * approvals.length
        : null,
    byCategory,
  };
}
