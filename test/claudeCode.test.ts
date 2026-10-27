import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { ClaudeCodeDrafter } from "../src/agent/claudeCode.ts";
import { DraftError } from "../src/agent/drafter.ts";
import type { Inquiry } from "../src/cafe24/types.ts";
import { ROOT } from "../src/config.ts";
import { draftCostUsd } from "../src/metrics.ts";

// 실제 claude CLI 대신 같은 형식으로 출력하는 가짜 CLI로 파싱과 인자 조립을 검증한다.

const FAKE = path.join(ROOT, "test/fixtures/fake-claude.mjs");
const dir = mkdtempSync(path.join(tmpdir(), "cs-cc-"));
const argsFile = path.join(dir, "args.json");

const inquiry: Inquiry = {
  article_no: 1203, board_no: 4, product_no: 102, order_id: "20261020-0000123", member_id: "demo_user01",
  writer: "이*민", title: "배송 언제 되나요", content: "언제 받을 수 있나요?", created_date: "2026-10-21T08:12:00+09:00",
};

function drafter(mode = "ok") {
  process.env.FAKE_CLAUDE_MODE = mode;
  process.env.FAKE_CLAUDE_ARGS_FILE = argsFile;
  return new ClaudeCodeDrafter({
    command: [process.execPath, FAKE],
    model: "claude-opus-5-5",
    effort: "medium",
    root: ROOT,
    now: () => new Date("2026-10-21T03:00:00Z"),
  });
}

afterEach(() => {
  delete process.env.FAKE_CLAUDE_MODE;
});

test("stream-json에서 초안, 도구 기록, 토큰을 읽는다", async () => {
  const result = await drafter().draft(inquiry);
  assert.equal(result.category, "배송");
  assert.equal(result.model, "claude-code:claude-opus-5-5");
  assert.deepEqual(result.trace.map((t) => t.tool), ["get_order", "submit_draft"]);
  assert.equal(result.trace[0].output, '{"배송상태":"배송중"}');
  assert.equal(result.cache_read_tokens, 900);
  // 구독 호출은 API 요금으로 계산하지 않는다
  assert.equal(draftCostUsd(result), null);
});

test("API 키와 부모 Claude Code 세션 변수는 claude에 넘기지 않는다", async () => {
  const saved = { ...process.env };
  Object.assign(process.env, {
    ANTHROPIC_API_KEY: "sk-ant-test",
    ANTHROPIC_BASE_URL: "http://localhost:9999",
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "parent",
    CLAUDE_EFFORT: "xhigh",
  });
  try {
    await drafter().draft(inquiry);
  } finally {
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_EFFORT"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
  const { envKeys }: { envKeys: string[] } = JSON.parse(readFileSync(argsFile, "utf8"));
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_EFFORT"]) {
    assert.ok(!envKeys.includes(key), `${key}가 넘어감`);
  }
  assert.ok(envKeys.includes("PATH"));
  assert.ok(envKeys.includes("FAKE_CLAUDE_MODE")); // 그 밖의 변수는 그대로 넘긴다
});

test("기본 도구는 끄고, 그 문의 작성자 범위의 MCP 읽기 도구만 허용한다", async () => {
  await drafter().draft(inquiry);
  const { args }: { args: string[] } = JSON.parse(readFileSync(argsFile, "utf8"));
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(value("--tools"), "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(value("--permission-mode"), "dontAsk");
  assert.equal(
    value("--allowedTools"),
    "mcp__cs__get_order,mcp__cs__get_product,mcp__cs__recommend_size,mcp__cs__search_policy",
  );
  const mcp = JSON.parse(value("--mcp-config"));
  assert.deepEqual(mcp.mcpServers.cs.env, { CS_SCOPE: "inquiry", CS_MEMBER_ID: "demo_user01" });
  assert.match(value("--system-prompt"), /지정된 JSON 형식/);
  assert.doesNotMatch(value("--system-prompt"), /submit_draft/);
  const schema = JSON.parse(value("--json-schema"));
  assert.ok(schema.properties.answer);
  assert.equal(schema.$schema, undefined); // CLI 2.1.306은 draft 2020-12 "$schema" 키가 있으면 거절한다
  assert.ok(schema.properties.sources.description); // 필드 설명은 남긴다(2차 평가 교훈)
  assert.match(value("-p"), /배송 언제 되나요/);
});

test("로그인이 만료되면 다시 로그인하라고 알린다", async () => {
  await assert.rejects(() => drafter("auth").draft(inquiry), (e: unknown) => e instanceof DraftError && /\/login/.test(e.message));
});

test("MCP 서버 연결에 실패하면 오류로 남긴다", async () => {
  await assert.rejects(() => drafter("mcp_failed").draft(inquiry), /MCP 서버에 연결하지 못했습니다/);
});

test("초안 형식이 틀리면 오류로 남긴다", async () => {
  await assert.rejects(() => drafter("bad_output").draft(inquiry), /초안 형식이 맞지 않습니다/);
});

test("claude 명령이 없으면 알린다", async () => {
  const missing = new ClaudeCodeDrafter({ command: ["/nonexistent/claude"], model: "x", effort: "medium", root: ROOT });
  await assert.rejects(() => missing.draft(inquiry), /claude 명령을 실행하지 못했습니다/);
});

test.after(() => rmSync(dir, { recursive: true, force: true }));
