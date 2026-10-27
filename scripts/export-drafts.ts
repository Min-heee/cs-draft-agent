// 초안과 도구 호출 기록을 마크다운으로 뽑는다. 프롬프트를 바꾼 뒤 결과를 비교할 때 쓴다.
// 사용법: DB_FILE=data/eval-1.db node scripts/export-drafts.ts > data/eval-1.md

import { loadConfig } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { draftCostUsd } from "../src/metrics.ts";

const config = loadConfig();
const store = new Store(config.dbFile);
const drafts = store.latestDrafts();
const inquiries = store
  .listInquiries(["new", "drafting", "drafted", "approved", "rejected", "error"])
  .sort((a, b) => a.article_no - b.article_no);

const clip = (text: string, max = 600) => (text.length > max ? `${text.slice(0, max)}…(${text.length}자)` : text);
const out: string[] = [];
let totalCost = 0;

for (const q of inquiries) {
  const d = drafts.get(q.article_no);
  out.push(`## #${q.article_no} ${q.title}`, "", `> ${q.content}`, "");
  if (!d) {
    out.push(`**상태: ${q.status}** ${q.error ?? ""}`, "");
    continue;
  }
  const cost = draftCostUsd(d);
  totalCost += cost ?? 0;
  out.push(
    `- 유형: ${d.category} · 확신도: ${d.confidence} · 확인 필요: ${d.needs_human ? "예" : "아니오"}`,
    ...(d.human_reasons.length ? [`- 확인 이유: ${d.human_reasons.join(" / ")}`] : []),
    `- 근거: ${d.sources.join(", ") || "없음"}`,
    ...(d.internal_note ? [`- 내부 메모: ${d.internal_note}`] : []),
    `- ${d.model} · ${(d.latency_ms / 1000).toFixed(1)}초 · 입력 ${d.input_tokens}+캐시읽기 ${d.cache_read_tokens}+캐시쓰기 ${d.cache_write_tokens} / 출력 ${d.output_tokens}${cost !== null ? ` · $${cost.toFixed(4)}` : ""}`,
    "",
    "도구 호출:",
    ...d.trace
      .filter((t) => t.tool !== "submit_draft")
      .map((t) => `- \`${t.tool}\` ${JSON.stringify(t.input)} → ${clip(t.output.replace(/\n/g, " "), 300)}`),
    "",
    "답변:",
    "",
    "```",
    d.answer,
    "```",
    "",
  );
}

console.log(`# 초안 검토용 내보내기 (${config.dbFile})\n\n총 ${inquiries.length}건 · 비용 합계 $${totalCost.toFixed(3)}\n`);
console.log(out.join("\n"));
store.close();
