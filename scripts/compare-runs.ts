// 두 실행(DB)의 초안을 LLM 없이 비교한다. 같은 프롬프트를 다른 경로로 돌렸을 때 결과가 같은지 볼 때 쓴다.
//
//   node scripts/compare-runs.ts <기준 DB> <비교 DB>
//   예) node scripts/compare-runs.ts data/eval-3.db data/eval-cc.db

import path from "node:path";
import { ROOT } from "../src/config.ts";
import { Store, type DraftRow } from "../src/db.ts";
import { editRatio } from "../src/textdiff.ts";

const [aFile, bFile] = process.argv.slice(2);
if (!aFile || !bFile) {
  console.error("사용법: node scripts/compare-runs.ts <기준 DB> <비교 DB>");
  process.exit(1);
}
const load = (file: string) => new Store(path.resolve(ROOT, file)).latestDrafts();
const A = load(aFile);
const B = load(bFile);

const lines = (s: string) => s.trim().split("\n").map((l) => l.trim()).filter(Boolean);
const size = (d: DraftRow) => {
  const call = d.trace.find((t) => t.tool === "recommend_size");
  if (!call) return "-";
  try {
    const out = JSON.parse(call.output) as { recommended: string | null; alternative: string | null };
    return `${out.recommended ?? "?"}${out.alternative ? `/${out.alternative}` : ""}`;
  } catch {
    return "오류";
  }
};
const tools = (d: DraftRow) => d.trace.filter((t) => t.tool !== "submit_draft").map((t) => t.tool.replace(/^(get_|search_|recommend_)/, "")).join("+") || "-";
const yn = (v: boolean) => (v ? "Y" : "n");

console.log(`기준: ${aFile}  비교: ${bFile}\n`);
console.log("| # | 확인 필요 | 유형 | 확신도 | 사이즈 | 도구 | 답변 차이 |");
console.log("|---|---|---|---|---|---|---|");
const nos = [...new Set([...A.keys(), ...B.keys()])].sort((x, y) => x - y);
let sameHuman = 0, sameCategory = 0, sameSize = 0, sizeCases = 0;
const ratios: number[] = [];
for (const no of nos) {
  const a = A.get(no);
  const b = B.get(no);
  if (!a || !b) {
    console.log(`| ${no} | ${a ? "" : "기준 없음"} ${b ? "" : "비교 없음"} | | | | | |`);
    continue;
  }
  const r = editRatio(a.answer, b.answer);
  ratios.push(r);
  if (a.needs_human === b.needs_human) sameHuman++;
  if (a.category === b.category) sameCategory++;
  if (size(a) !== "-" || size(b) !== "-") {
    sizeCases++;
    if (size(a) === size(b)) sameSize++;
  }
  const cell = (x: string, y: string) => (x === y ? x : `${x} → **${y}**`);
  console.log(
    `| ${no} | ${cell(yn(a.needs_human), yn(b.needs_human))} | ${cell(a.category, b.category)} | ${cell(a.confidence, b.confidence)} | ${cell(size(a), size(b))} | ${cell(tools(a), tools(b))} | ${Math.round(r * 100)}% |`,
  );
}

const fmt = (m: Map<number, DraftRow>) => {
  const d = [...m.values()];
  return {
    첫줄: d.filter((x) => lines(x.answer)[0] === "안녕하세요, 고객님.").length,
    서명: d.filter((x) => lines(x.answer).at(-1) === "데모몰 CS팀 드림").length,
    맺음말: d.filter((x) => /더 궁금하신|언제든/.test(x.answer)).length,
    평균길이: Math.round(d.reduce((s, x) => s + x.answer.length, 0) / d.length),
    확인필요: d.filter((x) => x.needs_human).length,
    도구호출: d.reduce((s, x) => s + x.trace.filter((t) => t.tool !== "submit_draft").length, 0),
    평균초: d.some((x) => x.latency_ms) ? Math.round(d.reduce((s, x) => s + x.latency_ms, 0) / d.length / 100) / 10 : null,
  };
};
const n = ratios.length;
console.log(`\n확인 필요 일치 ${sameHuman}/${n}, 유형 일치 ${sameCategory}/${n}, 사이즈 계산 일치 ${sameSize}/${sizeCases}`);
console.log(`답변 차이(글자 기준 수정률) 평균 ${Math.round((ratios.reduce((s, x) => s + x, 0) / n) * 100)}%`);
console.log("기준:", JSON.stringify(fmt(A)));
console.log("비교:", JSON.stringify(fmt(B)));
