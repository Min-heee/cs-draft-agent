import type { Store } from "./db.ts";
import { SyncError, type Pipeline } from "./pipeline.ts";

export interface WatchStatus {
  /** 자동 확인 간격(초). 0이면 자동 확인을 하지 않는다. */
  intervalSeconds: number;
  checking: boolean;
  lastCheckedAt: string | null;
  lastAdded: number;
  lastError: string | null;
  nextCheckAt: string | null;
}

export interface CheckResult {
  added: number;
  error: string | null;
}

/**
 * 정해진 간격으로 카페24에서 새 글을 가져오고, 들어온 글은 바로 초안을 만들기 시작한다.
 * 확인이 끝난 뒤에 다음 확인을 잡으므로 느린 확인이 겹치지 않는다.
 */
export class Watcher {
  private readonly pipeline: Pipeline;
  private readonly store: Store;
  private readonly intervalSeconds: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private current: Promise<CheckResult> | null = null;
  private lastCheckedAt: string | null = null;
  private lastAdded = 0;
  private lastError: string | null = null;
  private nextCheckAt: string | null = null;

  constructor(pipeline: Pipeline, store: Store, intervalSeconds: number) {
    this.pipeline = pipeline;
    this.store = store;
    this.intervalSeconds = Math.max(0, intervalSeconds);
  }

  /** 바로 한 번 확인하고, 그 뒤로 간격마다 확인한다. 간격이 0이면 아무것도 하지 않는다. */
  start(): void {
    if (this.intervalSeconds === 0 || this.running) return;
    this.running = true;
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.nextCheckAt = null;
  }

  /** 지금 확인한다. 이미 확인 중이면 그 결과를 같이 기다린다. */
  checkNow(): Promise<CheckResult> {
    this.current ??= this.check().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  get status(): WatchStatus {
    return {
      intervalSeconds: this.intervalSeconds,
      checking: this.current !== null,
      lastCheckedAt: this.lastCheckedAt,
      lastAdded: this.lastAdded,
      lastError: this.lastError,
      nextCheckAt: this.nextCheckAt,
    };
  }

  private async tick(): Promise<void> {
    await this.checkNow();
    if (!this.running) return;
    this.nextCheckAt = new Date(Date.now() + this.intervalSeconds * 1000).toISOString();
    this.timer = setTimeout(() => void this.tick(), this.intervalSeconds * 1000);
    this.timer.unref?.();
  }

  private async check(): Promise<CheckResult> {
    try {
      const added = await this.pipeline.sync();
      this.lastAdded = added;
      this.lastError = null;
      return { added, error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 토큰 만료처럼 같은 실패가 매번 반복되면 알림은 처음 한 번만 남긴다.
      if (message !== this.lastError) {
        this.store.addNotification({ article_no: null, type: "sync_failed", message: `새 글 확인 실패 · ${message}` });
      }
      this.lastError = message;
      // 일부만 실패했으면 그 전에 가져온 글은 저장돼 있다.
      this.lastAdded = error instanceof SyncError ? error.added : 0;
      return { added: this.lastAdded, error: message };
    } finally {
      this.lastCheckedAt = new Date().toISOString();
      // 새 글이 없어도, 서버가 꺼지기 전에 남은 new 문의나 다시 만들기를 누른 문의가 있으면 이어서 만든다.
      this.pipeline.draftPending().catch((error) => console.error("[draft]", error));
    }
  }
}
