// `claude -p ... --json-schema` 흉내. 불만 사유 분류(ClaudeCodeComplaintClassifier) 테스트용.
// FAKE_COMPLAINT_MODE: ok(기본) | drop_last(마지막 글 결과를 빠뜨림) | auth(로그인 만료)
// 받은 인자는 FAKE_CLAUDE_ARGS_FILE에 JSON으로 남긴다.
// 글 본문에 "단추"가 있으면 defect, "길어"가 있으면 size_big:length, 그 밖에는 불만 없음으로 답한다.

import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_ARGS_FILE) writeFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify({ args }));
const mode = process.env.FAKE_COMPLAINT_MODE ?? "ok";
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");

if (mode === "auth") {
  emit({ type: "result", subtype: "success", is_error: true, api_error_status: 401, result: "Failed to authenticate." });
  process.exit(1);
}

const prompt = args[args.indexOf("-p") + 1] ?? "";
const posts = [...prompt.matchAll(/<post id="(p\d+)"[^>]*>([\s\S]*?)<\/post>/g)].map((m) => ({ id: m[1], body: m[2] }));
const results = posts.map(({ id, body }) => {
  const reasons = [];
  if (body.includes("단추")) reasons.push({ code: "defect", part: null, evidence: "단추" });
  if (body.includes("길어")) reasons.push({ code: "size_big", part: "length", evidence: "길어" });
  return { id, reasons, confidence: "high", injection: false };
});
if (mode === "drop_last") results.pop();

emit({ type: "assistant", message: { model: "claude-opus-5-5", content: [] } });
emit({
  type: "result",
  subtype: "success",
  is_error: false,
  result: "",
  structured_output: { results },
  usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 },
  modelUsage: { "claude-opus-5-5": {} },
});
