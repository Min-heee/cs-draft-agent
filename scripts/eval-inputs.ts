// API 비용 없이 평가할 때(eval/workflow.js) 쓸 문의별 입력 파일을 만든다.
//
//   node scripts/eval-inputs.ts <출력 폴더> <비교 기준 DB> [오늘 ISO 시각] [새 초안 DB]
//   예) node scripts/eval-inputs.ts /tmp/eval-3 data/eval-2.db 2026-10-21T06:30:00Z
//
// [새 초안 DB]를 주면 채점용 파일에 그 DB의 초안을 new_draft로 넣는다. 초안을 다른 경로(예: DRAFTER=claude-code)로
// 이미 만들어 두고 채점만 할 때 쓴다(eval/workflow.js의 judgeOnly).
//
// 문의마다 두 파일을 만든다.
// - draft-<번호>.json: 초안 작성 에이전트용. 시스템 프롬프트, MCP 서버가 실제로 내주는 도구 목록
//   (입력 스키마와 설명 포함), 실제 경로와 같은 출력 스키마, 사용자 메시지. 기대 동작과 이전 답변은 넣지 않는다.
// - judge-<번호>.json: 채점 에이전트용. 문의, 기대 동작, 비교 기준 초안.
//
// 마지막으로 워크플로에 넘길 출력 스키마(도구 호출 기록 포함)를 표준 출력에 찍는다.
// 2차 평가 때 도구 스키마와 필드 설명을 빼먹어 결과가 왜곡된 적이 있어(EVAL-2), 실제 경로와 같은 것을 넣는다.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DraftSchema } from "../src/agent/guardrails.ts";
import { buildSystemPrompt, todayLine, userMessage } from "../src/agent/prompt.ts";
import { MockCafe24Client } from "../src/cafe24/mock.ts";
import { ROOT } from "../src/config.ts";
import { Store } from "../src/db.ts";
import { PolicyStore } from "../src/knowledge/policies.ts";
import { createMcpServer } from "../src/mcp/server.ts";
import { loadSizeCharts } from "../src/sizing.ts";

const [outDir, baselineDb, todayIso, newDb] = process.argv.slice(2);
if (!outDir || !baselineDb) {
  console.error("사용법: node scripts/eval-inputs.ts <출력 폴더> <비교 기준 DB> [오늘 ISO 시각]");
  process.exit(1);
}
const today = todayIso ? new Date(todayIso) : new Date();
const deps = {
  cafe24: new MockCafe24Client(path.join(ROOT, "data/mock")),
  policies: PolicyStore.fromDir(path.join(ROOT, "data/policies")),
  sizeCharts: loadSizeCharts(path.join(ROOT, "data/size-charts.json")),
};

// MCP 클라이언트가 모델에게 보여 주는 것과 같은 도구 목록
const server = createMcpServer(deps, { scope: { memberId: "eval" } });
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await server.connect(serverSide);
const client = new Client({ name: "eval-inputs", version: "1.0.0" });
await client.connect(clientSide);
const tools = (await client.listTools()).tools.map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema,
}));
await client.close();

const systemPrompt = buildSystemPrompt("structured");
const outputSchema = z.toJSONSchema(DraftSchema) as { properties: Record<string, unknown>; required: string[] };
const expected = JSON.parse(readFileSync(path.join(ROOT, "eval/expected.json"), "utf8")) as Record<string, string>;
const baseline = new Store(path.resolve(ROOT, baselineDb)).latestDrafts();
const fresh = newDb ? new Store(path.resolve(ROOT, newDb)).latestDrafts() : null;

const summarize = (d: NonNullable<ReturnType<typeof baseline.get>>) => ({
  answer: d.answer,
  category: d.category,
  confidence: d.confidence,
  needs_human: d.needs_human,
  human_reasons: d.human_reasons,
  sources: d.sources,
  internal_note: d.internal_note,
});

mkdirSync(outDir, { recursive: true });
for (const q of await deps.cafe24.listUnansweredInquiries()) {
  const write = (name: string, data: unknown) =>
    writeFileSync(path.join(outDir, `${name}-${q.article_no}.json`), JSON.stringify(data, null, 1));
  write("draft", {
    system_prompt: systemPrompt,
    tools,
    output_schema: outputSchema,
    member_id: q.member_id,
    user_message: userMessage(q, today),
  });
  const b = baseline.get(q.article_no);
  write("judge", {
    today: todayLine(today),
    system_prompt: systemPrompt,
    article_no: q.article_no,
    title: q.title,
    content: q.content,
    member_id: q.member_id,
    expected: expected[String(q.article_no)],
    baseline: b && summarize(b),
    ...(fresh?.get(q.article_no) && {
      new_draft: {
        ...summarize(fresh.get(q.article_no)!),
        tool_calls: fresh.get(q.article_no)!.trace.map((t) => ({
          tool: t.tool,
          args: JSON.stringify(t.input),
          result_excerpt: t.output.slice(0, 300),
        })),
      },
    }),
  });
}

const workflowSchema = {
  type: "object",
  properties: {
    ...outputSchema.properties,
    tool_calls: {
      type: "array",
      description: "실행한 도구 호출을 순서대로: 도구 이름, JSON 인자 문자열, 결과 앞부분 300자",
      items: {
        type: "object",
        properties: { tool: { type: "string" }, args: { type: "string" }, result_excerpt: { type: "string" } },
        required: ["tool", "args", "result_excerpt"],
      },
    },
  },
  required: [...outputSchema.required, "tool_calls"],
};
console.log(JSON.stringify(workflowSchema));
