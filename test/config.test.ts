import assert from "node:assert/strict";
import { test } from "node:test";
import { claudeEnv } from "../src/agent/claudeCode.ts";
import { loadConfig } from "../src/config.ts";

test("Claude Code 세션 변수(CLAUDE_EFFORT)는 앱 설정에 섞이지 않는다", () => {
  assert.equal(loadConfig({ CLAUDE_EFFORT: "high", CLAUDE_MODEL: "claude-haiku-5-5" }).effort, "medium");
  assert.equal(loadConfig({ CLAUDE_MODEL: "claude-haiku-5-5" }).model, "claude-opus-5-5");
  assert.equal(loadConfig({ DRAFT_EFFORT: "high" }).effort, "high");
  assert.equal(loadConfig({ DRAFT_MODEL: "claude-sonnet-5-5" }).model, "claude-sonnet-5-5");
});

test("EVAL_NOW로 평가 기준 시각을 고정한다", () => {
  assert.equal(loadConfig({ EVAL_NOW: "2026-10-21T15:30:00+09:00" }).now?.toISOString(), "2026-10-21T06:30:00.000Z");
  assert.equal(loadConfig({ EVAL_NOW: "아무 말" }).now, null);
  assert.equal(loadConfig({}).now, null);
});

test("claude에 넘기는 환경에서 API 키와 부모 세션 변수를 뺀다", () => {
  const env = claudeEnv({
    PATH: "/usr/bin",
    HOME: "/Users/x",
    ANTHROPIC_API_KEY: "sk-ant-x",
    ANTHROPIC_AUTH_TOKEN: "t",
    ANTHROPIC_BASE_URL: "http://localhost:1",
    CLAUDECODE: "1",
    CLAUDE_CODE_OAUTH_SCOPES: "x",
    CLAUDE_AGENT_SDK_VERSION: "1",
    CS_MEMBER_ID: "demo",
  });
  assert.deepEqual(Object.keys(env).sort(), ["CS_MEMBER_ID", "HOME", "PATH"]);
});
