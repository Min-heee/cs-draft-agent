import { kstDate, kstHour } from "./report.ts";

// 매일 아침(한국 시각 hour시) 리포트를 한 번 만든다.
// 정확한 시각에 맞춰 깨우지 않고 10분마다 "오늘 것을 만들 때가 됐는지" 본다.
// 그래서 9시에 맥이나 앱이 꺼져 있었으면 켠 뒤 처음 확인할 때 만든다. 오늘 만든 날짜는 DB에 남긴다.

export const LAST_REPORT_KEY = "complaints_last_report";
const CHECK_MS = 10 * 60_000;

export interface SchedulerDeps {
  /** 한국 시각 몇 시부터 만들지. 음수면 끈다. */
  hour: number;
  /** 리포트를 만든다. warning이 있으면(예: LLM 실패로 일부를 규칙으로 대신 채움) 화면에 보여 준다. */
  run: () => Promise<{ warning?: string | null } | void>;
  getLast: () => string | null;
  setLast: (date: string) => void;
  now?: () => Date;
}

export interface ReportSchedule {
  hour: number;
  running: boolean;
  lastDate: string | null;
  lastError: string | null;
  lastWarning: string | null;
}

export class DailyReportScheduler {
  private readonly deps: SchedulerDeps;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastError: string | null = null;
  private lastWarning: string | null = null;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
  }

  get status(): ReportSchedule {
    return {
      hour: this.deps.hour,
      running: this.running,
      lastDate: this.deps.getLast(),
      lastError: this.lastError,
      lastWarning: this.lastWarning,
    };
  }

  /** 지금 만들 때인가: 오늘 아직 안 만들었고 hour시가 지났다. */
  due(at: Date = this.deps.now?.() ?? new Date()): boolean {
    if (this.deps.hour < 0) return false;
    return this.deps.getLast() !== kstDate(at) && kstHour(at) >= this.deps.hour;
  }

  start(): void {
    if (this.deps.hour < 0 || this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), CHECK_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<boolean> {
    if (this.running || !this.due()) return false;
    await this.runNow();
    return true;
  }

  /** 시간과 상관없이 지금 만든다(관리자 화면의 "지금 만들기"). 성공하면 시작한 날의 날짜를 남긴다. */
  async runNow(): Promise<void> {
    if (this.running) return;
    this.running = true;
    // 자정을 넘겨 끝나도 시작한 날 것으로 남긴다(리포트 파일 이름도 시작 시각 기준).
    const date = kstDate(this.deps.now?.() ?? new Date());
    try {
      const result = await this.deps.run();
      this.deps.setLast(date);
      this.lastError = null;
      this.lastWarning = result?.warning ?? null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      console.error("[complaints] 리포트를 만들지 못했습니다:", error);
    } finally {
      this.running = false;
    }
  }
}
