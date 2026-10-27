import Anthropic from "@anthropic-ai/sdk";
import type { Inquiry } from "../cafe24/types.ts";
import type { NewDraft, TraceEntry } from "../db.ts";
import { applyGuardrails, DraftSchema, type DraftOutput } from "./guardrails.ts";
import { SYSTEM_PROMPT, userMessage } from "./prompt.ts";
import { buildTools, SUBMIT_TOOL, type ToolDeps } from "./tools.ts";

export type DraftResult = Omit<NewDraft, "article_no">;

export interface Drafter {
  draft(inquiry: Inquiry): Promise<DraftResult>;
}

/** 초안을 만들지 못했을 때. 그때까지의 도구 기록을 같이 남겨 원인을 볼 수 있게 한다. */
export class DraftError extends Error {
  readonly trace: TraceEntry[];
  constructor(message: string, trace: TraceEntry[]) {
    super(message);
    this.trace = trace;
  }
}

export interface ClaudeDrafterOptions {
  model: string;
  effort: "low" | "medium" | "high";
  client?: Anthropic;
  now?: () => Date;
}

export class ClaudeDrafter implements Drafter {
  private readonly client: Anthropic;
  private readonly deps: ToolDeps;
  private readonly options: ClaudeDrafterOptions;

  constructor(deps: ToolDeps, options: ClaudeDrafterOptions) {
    this.deps = deps;
    this.options = options;
    // 인증은 ANTHROPIC_API_KEY 환경 변수에서 읽는다. 429·5xx는 SDK가 2번까지 다시 시도한다.
    this.client = options.client ?? new Anthropic();
  }

  async draft(inquiry: Inquiry): Promise<DraftResult> {
    const trace: TraceEntry[] = [];
    const started = performance.now();
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    let model = this.options.model;
    let lastStop: string | null = null;
    let submitted: DraftOutput | null = null;
    const today = this.options.now?.() ?? new Date();

    const runner = this.client.beta.messages.toolRunner({
      model: this.options.model,
      max_tokens: 16000,
      max_iterations: 8,
      // 도구 정의와 시스템 프롬프트는 문의마다 같으므로 캐시한다.
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      output_config: { effort: this.options.effort },
      // 안전 분류기 오탐으로 거절되면 서버가 다른 모델로 이어서 처리한다.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      tools: buildTools(this.deps, inquiry, trace),
      messages: [{ role: "user", content: userMessage(inquiry, today) }],
    });

    for await (const message of runner) {
      usage.input += message.usage.input_tokens;
      usage.output += message.usage.output_tokens;
      usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
      usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;
      model = message.model;
      lastStop = message.stop_reason;

      if (message.stop_reason === "refusal") {
        throw new DraftError("모델이 이 문의에 대한 답변을 거절했습니다(refusal). 직접 답변해 주세요.", trace);
      }
      // submit_draft가 나오면 그 입력이 결과다. 도구를 실행하고 한 번 더 호출할 필요가 없으므로 여기서 멈춘다.
      // 입력이 스키마에 안 맞으면 멈추지 않고, 도구 실행기가 검증 오류를 모델에게 돌려줘 다시 쓰게 한다.
      const call = message.content.find((block) => block.type === "tool_use" && block.name === SUBMIT_TOOL);
      if (call?.type === "tool_use") {
        const parsed = DraftSchema.safeParse(call.input);
        if (parsed.success) {
          submitted = parsed.data;
          trace.push({ tool: SUBMIT_TOOL, input: call.input, output: "제출됨" });
          break;
        }
      }
    }

    if (!submitted) {
      throw new DraftError(`초안이 제출되지 않았습니다 (마지막 stop_reason: ${lastStop ?? "없음"}).`, trace);
    }
    return {
      ...applyGuardrails(submitted, today),
      trace,
      model,
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_tokens: usage.cacheRead,
      cache_write_tokens: usage.cacheWrite,
      latency_ms: Math.round(performance.now() - started),
    };
  }
}

/**
 * Claude를 부르지 않는 가짜 작성기. 테스트와 화면 개발용이다(DRAFTER=fake).
 * 만든 초안에는 가짜라는 표시가 붙는다.
 */
export class FakeDrafter implements Drafter {
  private readonly make: (inquiry: Inquiry) => DraftOutput;

  constructor(make?: (inquiry: Inquiry) => DraftOutput) {
    this.make =
      make ??
      ((inquiry) => ({
        category: "기타",
        answer: `[테스트용 가짜 초안: Claude를 호출하지 않았습니다]\n안녕하세요, 고객님. 문의하신 "${inquiry.title}" 건을 확인한 뒤 안내드리겠습니다.\n데모몰 CS팀 드림`,
        confidence: "low",
        needs_human: false,
        human_reasons: [],
        sources: [],
        internal_note: "DRAFTER=fake 로 만든 초안입니다.",
      }));
  }

  async draft(inquiry: Inquiry): Promise<DraftResult> {
    return {
      ...applyGuardrails(this.make(inquiry)),
      trace: [],
      model: "fake",
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      latency_ms: 0,
    };
  }
}
