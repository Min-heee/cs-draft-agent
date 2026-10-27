// 다른 곳(예: Claude Code 하위 에이전트로 돌린 평가)에서 만든 초안 JSON을 문의함 DB에 넣는다.
// 코드 안전장치(applyGuardrails)는 여기서 똑같이 적용한다.
//
//   DB_FILE=data/eval-2.db node scripts/import-drafts.ts <drafts.json> <모델 이름> [오늘 ISO 시각]
//
// drafts.json: [{ article_no, draft: { category, answer, ..., tool_calls?: [{ tool, args, result_excerpt }] } }]

import { readFileSync } from "node:fs";
import { applyGuardrails, DraftSchema } from "../src/agent/guardrails.ts";
import { createCafe24Client, loadConfig } from "../src/config.ts";
import { Store, type TraceEntry } from "../src/db.ts";

const [file, model, todayIso] = process.argv.slice(2);
if (!file || !model) {
  console.error("사용법: node scripts/import-drafts.ts <drafts.json> <모델 이름> [오늘 ISO 시각]");
  process.exit(1);
}
const today = todayIso ? new Date(todayIso) : new Date();
const config = loadConfig();
const store = new Store(config.dbFile);
store.addInquiries(await createCafe24Client(config).listUnansweredInquiries());

const rows = JSON.parse(readFileSync(file, "utf8")) as {
  article_no: number;
  draft: Record<string, unknown> & { tool_calls?: { tool: string; args: string; result_excerpt: string }[] };
}[];

let imported = 0;
for (const { article_no, draft } of rows) {
  const parsed = DraftSchema.safeParse(draft);
  if (!parsed.success) {
    console.error(`#${article_no} 형식 오류: ${parsed.error.message}`);
    store.setStatus(article_no, "error", "초안 형식 오류");
    continue;
  }
  const trace: TraceEntry[] = (draft.tool_calls ?? []).map((c) => {
    let input: unknown = c.args;
    try {
      input = JSON.parse(c.args);
    } catch {}
    return { tool: c.tool, input, output: c.result_excerpt };
  });
  store.insertDraft({
    ...applyGuardrails(parsed.data, today),
    article_no,
    trace,
    model,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    latency_ms: 0,
  });
  store.setStatus(article_no, "drafted");
  imported++;
}
console.log(`${imported}/${rows.length}건을 넣었습니다: ${config.dbFile}`);
store.close();
