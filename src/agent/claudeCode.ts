import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Inquiry } from "../cafe24/types.ts";
import type { TraceEntry } from "../db.ts";
import { DraftError, type Drafter, type DraftResult } from "./drafter.ts";
import { applyGuardrails, DraftSchema } from "./guardrails.ts";
import { buildSystemPrompt, userMessage } from "./prompt.ts";

// API 크레딧 없이, 이미 로그인한 Claude Code(구독)로 초안을 만든다.
// 문의 한 건마다 `claude -p`를 띄우고 우리 MCP 서버를 그 문의 작성자 범위로 붙인다.
// 기본 도구(파일, 셸)는 모두 끄고 MCP의 읽기 도구 4개만 허용한다.
// 초안은 --json-schema 로 받은 구조화 출력이다.
//
// 개인 개발·데모용 경로다. 회사에서 운영할 때는 API 키나 회사 플랜 조건을 따른다.

const MCP_TOOLS = ["get_order", "get_product", "recommend_size", "search_policy"] as const;
const SERVER = "cs";

// claude에 넘기지 않을 환경 변수.
// - ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN: 앱은 .env를 읽어 API 키를 갖고 있다. 이게 넘어가면
//   claude가 구독 대신 API 키로 호출해 요금이 나간다. 이 경로의 목적은 API 비용 0원이다.
// - CLAUDE_CODE_*, CLAUDECODE, ANTHROPIC_BASE_URL 등: 앱을 Claude Code 세션 안에서 띄우면 그 세션의
//   변수가 따라 들어와, claude가 사용자 로그인 대신 부모 세션의 인증과 경로를 쓰려 한다(실제로 401이 났다).
const DROPPED_ENV = /^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|USE_LOCAL_OAUTH|USE_STAGING_OAUTH|CLAUDE_CODE_\w*|CLAUDE_AGENT_SDK_\w*|CLAUDE_PREVIEW_\w*)$/;

export function claudeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !DROPPED_ENV.test(key)));
}

/**
 * --json-schema에 넘길 초안 스키마. zod가 붙이는 "$schema"(draft 2020-12) 키는 뺀다.
 * Claude Code 2.1.306부터 이 키가 있으면 "not a valid JSON Schema"로 거절한다(2.1.146은 통과했다).
 */
export function draftJsonSchema(): Record<string, unknown> {
  const { $schema: _, ...schema } = z.toJSONSchema(DraftSchema) as Record<string, unknown>;
  return schema;
}

export interface ClaudeCodeOptions {
  /** 실행할 명령. 기본은 ["claude"]. 테스트에서는 가짜 CLI를 넣는다. */
  command?: string[];
  model: string;
  effort: "low" | "medium" | "high";
  /** 프로젝트 루트 (MCP 서버 실행 파일과 .env 위치) */
  root: string;
  now?: () => Date;
  timeoutMs?: number;
}

export interface StreamEvent {
  type: string;
  subtype?: string;
  message?: { model?: string; content?: ContentBlock[] };
  mcp_servers?: { name: string; status: string }[];
  is_error?: boolean;
  api_error_status?: number | null;
  result?: string;
  structured_output?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, unknown>;
}

type ContentBlock =
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string | { type: string; text?: string }[]; is_error?: boolean }
  | { type: string };

export class ClaudeCodeDrafter implements Drafter {
  private readonly options: ClaudeCodeOptions;

  constructor(options: ClaudeCodeOptions) {
    this.options = options;
  }

  async draft(inquiry: Inquiry): Promise<DraftResult> {
    const today = this.options.now?.() ?? new Date();
    const started = performance.now();
    const events = await this.run(this.args(inquiry, today));
    const trace = traceFrom(events);

    const init = events.find((e) => e.type === "system" && e.subtype === "init");
    const server = init?.mcp_servers?.find((s) => s.name === SERVER);
    if (init && server?.status !== "connected") {
      throw new DraftError(`MCP 서버에 연결하지 못했습니다(상태: ${server?.status ?? "없음"}).`, trace);
    }

    const result = events.findLast((e) => e.type === "result");
    if (!result) throw new DraftError("Claude Code가 결과 없이 끝났습니다.", trace);
    if (result.is_error) {
      if (result.api_error_status === 401) {
        throw new DraftError("Claude Code 로그인이 만료됐습니다. 터미널에서 claude 를 실행해 /login 해 주세요.", trace);
      }
      throw new DraftError(`Claude Code 실행 실패: ${result.result ?? result.subtype ?? "알 수 없음"}`, trace);
    }

    const parsed = DraftSchema.safeParse(result.structured_output ?? parseJson(result.result));
    if (!parsed.success) throw new DraftError(`초안 형식이 맞지 않습니다: ${parsed.error.message}`, trace);
    trace.push({ tool: "submit_draft", input: parsed.data, output: "제출됨" });

    const model =
      [...events].reverse().find((e) => e.type === "assistant" && e.message?.model)?.message?.model ??
      Object.keys(result.modelUsage ?? {})[0] ??
      this.options.model;
    return {
      ...applyGuardrails(parsed.data, today),
      trace,
      // 구독으로 돌린 호출은 API 요금이 없으므로 metrics.ts의 단가표에 없는 이름으로 남긴다.
      model: `claude-code:${model}`,
      input_tokens: result.usage?.input_tokens ?? 0,
      output_tokens: result.usage?.output_tokens ?? 0,
      cache_read_tokens: result.usage?.cache_read_input_tokens ?? 0,
      cache_write_tokens: result.usage?.cache_creation_input_tokens ?? 0,
      latency_ms: Math.round(performance.now() - started),
    };
  }

  private args(inquiry: Inquiry, today: Date): string[] {
    const { root } = this.options;
    const mcpConfig = {
      mcpServers: {
        [SERVER]: {
          command: process.execPath,
          args: [`--env-file-if-exists=${path.join(root, ".env")}`, path.join(root, "src/mcp/main.ts")],
          env: { CS_SCOPE: "inquiry", ...(inquiry.member_id ? { CS_MEMBER_ID: inquiry.member_id } : {}) },
        },
      },
    };
    return [
      "-p",
      userMessage(inquiry, today),
      "--system-prompt",
      buildSystemPrompt("structured"),
      "--tools",
      "",
      "--mcp-config",
      JSON.stringify(mcpConfig),
      "--strict-mcp-config",
      "--allowedTools",
      MCP_TOOLS.map((t) => `mcp__${SERVER}__${t}`).join(","),
      "--permission-mode",
      "dontAsk",
      "--json-schema",
      JSON.stringify(draftJsonSchema()),
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      this.options.model,
      "--effort",
      this.options.effort,
      "--no-session-persistence",
    ];
  }

  private async run(args: string[]): Promise<StreamEvent[]> {
    try {
      return await runClaude(this.options.command ?? ["claude"], args, this.options.timeoutMs ?? 300_000);
    } catch (error) {
      throw new DraftError(error instanceof Error ? error.message : String(error), []);
    }
  }
}

/**
 * `claude -p ... --output-format stream-json`을 띄우고 이벤트를 모은다. 초안과 불만 사유 분류가 같이 쓴다.
 * 프로젝트 밖(임시 폴더)에서 띄워 이 저장소의 설정이 섞이지 않게 한다.
 */
export function runClaude(commandLine: string[], args: string[], timeoutMs: number): Promise<StreamEvent[]> {
  const [command, ...prefix] = commandLine;
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...prefix, ...args], {
      cwd: tmpdir(),
      env: claudeEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`claude 명령을 실행하지 못했습니다: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const events = stdout
        .split("\n")
        .map((line) => parseJson(line) as StreamEvent | undefined)
        .filter((e): e is StreamEvent => typeof e?.type === "string");
      if (events.length === 0) {
        const why = signal ? `시간 초과(${signal})` : `종료 코드 ${code}`;
        reject(new Error(`claude 출력이 없습니다(${why}). ${stderr.trim().slice(0, 300)}`));
        return;
      }
      resolve(events);
    });
  });
}

export function parseJson(text: string | undefined): unknown {
  if (!text?.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** stream-json 이벤트에서 도구 호출과 결과를 짝지어 검토 화면용 기록을 만든다. */
function traceFrom(events: StreamEvent[]): TraceEntry[] {
  const calls = new Map<string, TraceEntry>();
  const trace: TraceEntry[] = [];
  for (const event of events) {
    for (const block of event.message?.content ?? []) {
      // 우리 MCP 도구만 기록한다. CLI 내부의 StructuredOutput(구조화 출력용) 호출은 초안 자체라 뺀다.
      if (block.type === "tool_use" && "id" in block && block.name.startsWith(`mcp__${SERVER}__`)) {
        const entry = { tool: block.name.replace(`mcp__${SERVER}__`, ""), input: block.input, output: "" };
        calls.set(block.id, entry);
        trace.push(entry);
      } else if (block.type === "tool_result" && "tool_use_id" in block) {
        const entry = calls.get(block.tool_use_id);
        if (!entry) continue;
        const text = typeof block.content === "string" ? block.content : block.content.map((c) => c.text ?? "").join("");
        entry.output = block.is_error ? `오류: ${text}` : text;
      }
    }
  }
  return trace;
}
