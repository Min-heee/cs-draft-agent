// 불만 사유 분류 정확도 재기: '규칙만'과 '규칙+LLM+검사'를 같은 글로 비교한다.
//
//   node scripts/eval-complaints.ts [--runs 3] [--sets dev] [--rules-only] [--show-errors]
//
// - dev: 규칙·프롬프트를 만들며 본 글(data/complaint-eval/dev.json, bh044 가짜 글 27건). 기본값.
// - holdout, hard: 만들 때 한 번도 보지 않은 시험 글. --sets dev,holdout,hard처럼 이름을 줘야 돌린다.
//   시험 글은 글별 결과(아이디·정답·결과)를 파일에도 화면에도 남기지 않는다(개발하며 보지 않게).
// LLM은 로그인한 Claude Code(구독)로만 부른다. 결과는 data/complaint-eval/results-*.md·json(git에 올리지 않음)에 쓴다.
//
// 주의: 시험 글과 정답은 Claude 하위 에이전트가 기준표(GUIDE.md)대로 쓰고 달았다. 분류도 Claude다.
// 그래서 LLM 점수는 실제 고객 글 정확도가 아니라 '같은 기준표를 같은 모델 계열이 읽은 일치도'에 가깝다.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { classifyPosts } from "../src/complaints/classify.ts";
import { ClaudeCodeComplaintClassifier } from "../src/complaints/llm.ts";
import { filePostToComplaintPost, type FilePost } from "../src/complaints/source.ts";
import { parseGold, REASON_CODES, reasonKey, type ReasonCode } from "../src/complaints/taxonomy.ts";
import type { Classification, ComplaintPost } from "../src/complaints/types.ts";
import { loadConfig, ROOT } from "../src/config.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const runs = Math.max(1, Number(option("--runs", "3")));
const sets = option("--sets", "dev").split(",");
const config = loadConfig();
const dir = path.join(ROOT, "data/complaint-eval");

interface Item {
  post: ComplaintPost;
  gold: ReturnType<typeof parseGold>;
}

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 12);

function load(set: string): { items: Item[]; file: string } {
  const file = path.join(dir, `${set}.json`);
  if (!existsSync(file)) throw new Error(`시험 글 파일이 없습니다: ${file}`);
  const posts = (JSON.parse(readFileSync(file, "utf8")) as { posts: FilePost[] }).posts;
  const ids = new Set<string>();
  for (const p of posts) {
    // 정답이 빠진 글을 '불만 아님'으로 채점하지 않는다. 불만 아님은 ["none"]으로 적어야 한다.
    if (!p.gold?.length) throw new Error(`${set}: 정답(gold)이 없는 글이 있습니다: ${p.id}`);
    if (ids.has(p.id)) throw new Error(`${set}: 같은 id가 두 번 있습니다: ${p.id}`);
    ids.add(p.id);
  }
  return { items: posts.map((p) => ({ post: filePostToComplaintPost(p), gold: parseGold(p.gold!) })), file };
}

const top = (reasons: { code: ReasonCode }[]) => [...new Set(reasons.map((r) => r.code))].sort().join("+") || "none";
const full = (reasons: { code: ReasonCode; part: string | null }[]) =>
  [...new Set(reasons.map((r) => reasonKey(r as never)))].sort().join("+") || "none";

interface Score {
  posts: number;
  exactTop: number;
  exactFull: number;
  complaintTP: number;
  complaintFP: number;
  complaintFN: number;
  needsCheck: number;
  /** 틀렸는데 확인 필요가 붙은 글(사람이 볼 기회가 있음) */
  wrongChecked: number;
  /** 틀렸는데 확인 필요도 없음(리포트 순위 단위 = 사이즈 부위까지 기준) */
  wrongUnchecked: number;
  /** LLM 실패로 규칙 결과로 대신 채운 글 */
  fallbacks: number;
  perCode: Record<string, { tp: number; fp: number; fn: number }>;
  inputTokens: number;
  outputTokens: number;
  seconds: number;
  errors: { id: string; gold: string; got: string; check: boolean }[];
}

function score(items: Item[], labels: Map<string, Classification>, seconds: number): Score {
  const s: Score = {
    posts: items.length, exactTop: 0, exactFull: 0, complaintTP: 0, complaintFP: 0, complaintFN: 0, needsCheck: 0,
    wrongChecked: 0, wrongUnchecked: 0, fallbacks: 0,
    perCode: Object.fromEntries(REASON_CODES.map((c) => [c, { tp: 0, fp: 0, fn: 0 }])),
    inputTokens: 0, outputTokens: 0, seconds, errors: [],
  };
  for (const { post, gold } of items) {
    const label = labels.get(post.key)!;
    const got = label.reasons;
    if (top(got) === top(gold)) s.exactTop++;
    const okFull = full(got) === full(gold);
    if (okFull) s.exactFull++;
    const isC = got.length > 0;
    const wantC = gold.length > 0;
    if (isC && wantC) s.complaintTP++;
    if (isC && !wantC) s.complaintFP++;
    if (!isC && wantC) s.complaintFN++;
    if (label.needs_check) s.needsCheck++;
    if (!okFull && label.needs_check) s.wrongChecked++;
    if (!okFull && !label.needs_check) s.wrongUnchecked++;
    if (label.fallback) s.fallbacks++;
    const g = new Set(gold.map((r) => r.code));
    const p = new Set(got.map((r) => r.code));
    for (const c of REASON_CODES) {
      if (g.has(c) && p.has(c)) s.perCode[c].tp++;
      else if (p.has(c)) s.perCode[c].fp++;
      else if (g.has(c)) s.perCode[c].fn++;
    }
    s.inputTokens += label.input_tokens;
    s.outputTokens += label.output_tokens;
    if (!okFull) s.errors.push({ id: post.key, gold: full(gold), got: full(got), check: label.needs_check });
  }
  return s;
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");
/** 정답도 결과도 없는 사유는 잴 수 없어 '–' */
const f1 = ({ tp, fp, fn }: { tp: number; fp: number; fn: number }) =>
  tp + fp + fn === 0 ? "–" : ((2 * tp) / (2 * tp + fp + fn)).toFixed(2);

function row(name: string, s: Score): string {
  const prec = s.complaintTP / Math.max(1, s.complaintTP + s.complaintFP);
  const rec = s.complaintTP / Math.max(1, s.complaintTP + s.complaintFN);
  return `| ${name} | ${s.exactTop}/${s.posts} (${pct(s.exactTop, s.posts)}) | ${s.exactFull}/${s.posts} | ${Math.round(prec * 100)}% / ${Math.round(rec * 100)}% | ${s.needsCheck} (틀림 ${s.wrongChecked}) | **${s.wrongUnchecked}** | ${s.fallbacks} | ${s.seconds}초 | ${s.inputTokens.toLocaleString()} / ${s.outputTokens.toLocaleString()} |`;
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const guide = path.join(dir, "GUIDE.md");
const lines: string[] = [
  `# 불만 사유 분류 평가 (${stamp})`,
  "",
  `- 모델: Claude Code 구독(${config.model}, effort ${config.effort}), 배치 10건, 동시 3배치. API 비용은 없고 토큰은 참고용.`,
  `- 기준표 GUIDE.md ${existsSync(guide) ? sha(guide) : "없음"}`,
  "- **합성 글·LLM 정답(사람 검증 전)**: 시험 글과 정답은 Claude 하위 에이전트가 기준표대로 쓰고 달았다. LLM 점수는 실제 고객 글 정확도가 아니다.",
  "- 맞힘(사유 종류): 사유 코드 묶음이 정답과 같은 글(부위 무시). 맞힘(부위까지): 리포트 순위 단위까지 같음.",
  "- 확인 필요(틀림 n): 확인 필요가 붙은 글과 그중 틀린 글. 확인 필요 없이 틀림: 사람이 못 보고 지나갈 수 있는 오류(부위까지 기준).",
  "- 대신 채움: LLM이 실패해 규칙 결과로 채운 글. 하나라도 있으면 그 회차는 LLM 점수로 보지 않는다.",
  "",
];
const summary: Record<string, unknown> = {};

const llm = new ClaudeCodeComplaintClassifier({ model: config.model, effort: config.effort });

for (const set of sets) {
  const { items, file } = load(set);
  const posts = items.map((i) => i.post);
  lines.push(
    `## ${set} (${items.length}건, 파일 ${sha(file)})`,
    "",
    "| 방식 | 맞힘(사유 종류) | 맞힘(부위까지) | 불만 찾기 정밀도/재현율 | 확인 필요 | 확인 필요 없이 틀림 | 대신 채움 | 시간 | 토큰(입력/출력) |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  const results: Record<string, Score[]> = { rules: [], llm: [] };

  const t0 = performance.now();
  const rules = await classifyPosts(posts);
  results.rules.push(score(items, rules, Math.round((performance.now() - t0) / 100) / 10));
  lines.push(row("규칙만", results.rules[0]));

  if (!flag("--rules-only")) {
    for (let run = 1; run <= runs; run++) {
      const started = performance.now();
      process.stdout.write(`[${set}] 규칙+LLM ${run}/${runs} … `);
      const labels = await classifyPosts(posts, { llm, batchSize: 10, concurrency: 3 });
      const s = score(items, labels, Math.round((performance.now() - started) / 100) / 10);
      results.llm.push(s);
      console.log(`맞힘 ${s.exactFull}/${s.posts}, 확인 필요 없이 틀림 ${s.wrongUnchecked}, 대신 채움 ${s.fallbacks}`);
      lines.push(row(`규칙+LLM+검사 ${run}회`, s));
    }
  }
  lines.push("", "사유별 F1 (규칙만 / 규칙+LLM 회차별). '–'는 정답도 결과도 없음:", "");
  for (const c of REASON_CODES) {
    const gold = items.filter((i) => i.gold.some((r) => r.code === c)).length;
    const r0 = results.rules[0].perCode[c];
    lines.push(
      `- ${c} (정답 ${gold}건): ${f1(r0)} [tp ${r0.tp} fp ${r0.fp} fn ${r0.fn}] / ${results.llm.map((s) => f1(s.perCode[c])).join(", ") || "–"}`,
    );
  }
  lines.push("");
  if (set === "dev" && flag("--show-errors")) {
    const last = results.llm.at(-1) ?? results.rules[0];
    for (const e of last.errors) console.log(`  ${e.id} 정답 ${e.gold} · 결과 ${e.got}${e.check ? " (확인 필요)" : ""}`);
  }
  // 시험 글은 글별 결과를 남기지 않는다(집계만).
  summary[set] =
    set === "dev"
      ? results
      : Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.map(({ errors: _, ...rest }) => rest)]));
}

const md = path.join(dir, `results-${stamp}.md`);
writeFileSync(md, lines.join("\n") + "\n");
writeFileSync(path.join(dir, `results-${stamp}.json`), JSON.stringify(summary, null, 1));
console.log(lines.filter((l) => l.startsWith("|") || l.startsWith("## ")).join("\n"));
console.log(`\n결과: ${path.relative(process.cwd(), md)}`);
