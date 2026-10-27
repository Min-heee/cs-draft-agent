import path from "node:path";
import { fileURLToPath } from "node:url";
import { Cafe24ApiClient } from "./cafe24/api.ts";
import { MockCafe24Client } from "./cafe24/mock.ts";
import type { Cafe24Client } from "./cafe24/types.ts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface AppConfig {
  dbFile: string;
  dataDir: string;
  cafe24Mode: "mock" | "api";
  /** claude=API 키, claude-code=로그인한 Claude Code 구독(API 비용 없음), fake=가짜 초안 */
  drafter: "claude" | "claude-code" | "fake";
  model: string;
  effort: "low" | "medium" | "high";
  port: number;
  /** 초안을 동시에 몇 건까지 만들지 */
  concurrency: number;
  /** 직원이 직접 답을 쓸 때 건당 걸리는 시간(분). 실제로 재서 넣는다. 없으면 절감 시간을 계산하지 않는다. */
  baselineMinutes: number | null;
  /** 평가 재현용 "지금" 시각(EVAL_NOW). 없으면 실제 현재 시각을 쓴다. */
  now: Date | null;
  /** 관리자 화면을 띄워 둔 동안 카페24에서 새 글을 확인하는 간격(초). 0이면 "지금 확인" 버튼으로만 가져온다. */
  autoSyncSeconds: number;
  /** 목업 시연용: 확인할 때마다 글을 이만큼씩만 더 내놓는다. 0이면 처음부터 모두 내놓는다. */
  mockDrip: number;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

// 모델·effort 설정 이름은 DRAFT_로 시작한다. CLAUDE_EFFORT 같은 이름은 Claude Code가 자기 세션에
// 쓰는 변수와 겹쳐서, 앱을 Claude Code 안에서 띄우면 그 값이 섞여 들어왔다.
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const baseline = Number(env.BASELINE_MINUTES_PER_REPLY);
  const now = env.EVAL_NOW ? new Date(env.EVAL_NOW) : null;
  const autoSync = Number(env.AUTO_SYNC_SECONDS ?? 60);
  const drip = Number(env.MOCK_DRIP ?? 0);
  return {
    dbFile: path.resolve(ROOT, env.DB_FILE ?? "data/app.db"),
    dataDir: path.join(ROOT, "data"),
    cafe24Mode: oneOf(env.CAFE24_MODE, ["mock", "api"], "mock"),
    drafter: oneOf(env.DRAFTER, ["claude", "claude-code", "fake"], "claude"),
    model: env.DRAFT_MODEL ?? "claude-opus-5-5",
    effort: oneOf(env.DRAFT_EFFORT, ["low", "medium", "high"], "medium"),
    port: Number(env.PORT ?? 3000),
    concurrency: Math.max(1, Number(env.DRAFT_CONCURRENCY ?? 3)),
    baselineMinutes: Number.isFinite(baseline) && baseline > 0 ? baseline : null,
    now: now && !Number.isNaN(now.getTime()) ? now : null,
    // 카페24 호출 한도를 생각해 10초보다 자주 확인하지 않는다.
    autoSyncSeconds: Number.isFinite(autoSync) && autoSync > 0 ? Math.max(10, autoSync) : 0,
    mockDrip: Number.isFinite(drip) && drip > 0 ? Math.floor(drip) : 0,
  };
}

export function createCafe24Client(config: AppConfig, env: NodeJS.ProcessEnv = process.env): Cafe24Client {
  if (config.cafe24Mode === "mock") return new MockCafe24Client(path.join(config.dataDir, "mock"), { drip: config.mockDrip });
  const required = ["CAFE24_MALL_ID", "CAFE24_CLIENT_ID", "CAFE24_CLIENT_SECRET", "CAFE24_BOARD_NO"] as const;
  const missing = required.filter((k) => !env[k]);
  if (missing.length) throw new Error(`CAFE24_MODE=api 에 필요한 환경 변수가 없습니다: ${missing.join(", ")}`);
  return new Cafe24ApiClient({
    mallId: env.CAFE24_MALL_ID!,
    clientId: env.CAFE24_CLIENT_ID!,
    clientSecret: env.CAFE24_CLIENT_SECRET!,
    boardNo: Number(env.CAFE24_BOARD_NO),
    reviewBoardNo: env.CAFE24_REVIEW_BOARD_NO ? Number(env.CAFE24_REVIEW_BOARD_NO) : undefined,
    tokenFile: path.resolve(ROOT, env.CAFE24_TOKEN_FILE ?? "data/cafe24-token.json"),
    replyWriter: env.CAFE24_REPLY_WRITER ?? "CS팀",
    staffWriters: (env.CAFE24_STAFF_WRITERS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    clientIp: env.CAFE24_CLIENT_IP ?? "127.0.0.1",
  });
}
