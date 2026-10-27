// `claude -p ... --output-format stream-json` 흉내. ClaudeCodeDrafter 테스트용.
// FAKE_CLAUDE_MODE: ok(기본) | auth | mcp_failed | bad_output
// 받은 인자는 FAKE_CLAUDE_ARGS_FILE에 JSON으로 남긴다.

import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGS_FILE) {
  writeFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify({ args, envKeys: Object.keys(process.env) }));
}
const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");

emit({
  type: "system",
  subtype: "init",
  mcp_servers: [{ name: "cs", status: mode === "mcp_failed" ? "failed" : "connected" }],
});

if (mode === "auth") {
  emit({ type: "result", subtype: "success", is_error: true, api_error_status: 401, result: "Failed to authenticate." });
  process.exit(1);
}

emit({
  type: "assistant",
  message: {
    model: "claude-opus-5-5",
    content: [{ type: "tool_use", id: "toolu_1", name: "mcp__cs__get_order", input: { order_id: "20261020-0000123" } }],
  },
});
emit({
  type: "user",
  message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: '{"배송상태":"배송중"}' }] }] },
});

// 실제 CLI(2.1.306)는 --json-schema 결과를 StructuredOutput 도구 호출로도 내보낸다
emit({
  type: "assistant",
  message: { model: "claude-opus-5-5", content: [{ type: "tool_use", id: "toolu_2", name: "StructuredOutput", input: {} }] },
});

const draft = {
  category: "배송",
  answer: "안녕하세요, 고객님.\n주문하신 슬랙스는 배송 중입니다.\n데모몰 CS팀 드림",
  confidence: "high",
  needs_human: false,
  human_reasons: [],
  sources: ["order:20261020-0000123", "shipping#택배사와 도착 시간"],
  internal_note: "",
};
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "",
  structured_output: mode === "bad_output" ? { answer: "형식이 틀림" } : draft,
  usage: { input_tokens: 120, output_tokens: 80, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
  modelUsage: { "claude-opus-5-5": {} },
});
