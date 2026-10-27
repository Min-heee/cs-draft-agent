import { serve } from "@hono/node-server";
import { rmSync } from "node:fs";
import path from "node:path";
import { ClaudeCodeDrafter } from "./agent/claudeCode.ts";
import { ClaudeDrafter, FakeDrafter, type Drafter } from "./agent/drafter.ts";
import { createCafe24Client, loadConfig, ROOT } from "./config.ts";
import { Store } from "./db.ts";
import { PolicyStore } from "./knowledge/policies.ts";
import { Pipeline, SyncError } from "./pipeline.ts";
import { createApp } from "./server.ts";
import { loadSizeCharts } from "./sizing.ts";
import { Watcher } from "./watcher.ts";

// 사용법: node src/cli.ts <serve|sync|draft|reset>

const config = loadConfig();
const command = process.argv[2] ?? "serve";

if (command === "reset") {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(config.dbFile + suffix, { force: true });
  console.log(`DB를 지웠습니다: ${path.relative(process.cwd(), config.dbFile)}`);
  process.exit(0);
}

const store = new Store(config.dbFile);
const cafe24 = createCafe24Client(config);
const now = config.now ? () => config.now! : undefined;
let drafter: Drafter;
if (config.drafter === "fake") {
  drafter = new FakeDrafter();
} else if (config.drafter === "claude-code") {
  // API 키 대신 로그인한 Claude Code(구독)를 쓴다. 문의마다 claude -p + MCP 서버.
  drafter = new ClaudeCodeDrafter({ model: config.model, effort: config.effort, root: ROOT, now });
} else {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("경고: ANTHROPIC_API_KEY가 없습니다. .env에 넣거나 DRAFTER=fake로 실행하세요. 초안 생성이 실패합니다.");
  }
  drafter = new ClaudeDrafter(
    {
      cafe24,
      policies: PolicyStore.fromDir(path.join(config.dataDir, "policies")),
      sizeCharts: loadSizeCharts(path.join(config.dataDir, "size-charts.json")),
    },
    { model: config.model, effort: config.effort, now },
  );
}
const pipeline = new Pipeline(store, cafe24, drafter, config.concurrency);

if (command === "sync") {
  try {
    console.log(`새 글 ${await pipeline.sync()}건을 불러왔습니다.`);
  } catch (error) {
    if (!(error instanceof SyncError)) throw error;
    console.error(`새 글 ${error.added}건을 불러왔지만 일부를 확인하지 못했습니다: ${error.message}`);
    process.exitCode = 1;
  }
} else if (command === "draft") {
  await pipeline.draftPending();
  console.log(store.countByStatus());
} else if (command === "serve") {
  store.resetStuckDrafting();
  const drafterLabel = { fake: "가짜 초안", "claude-code": `Claude Code 구독(${config.model})`, claude: config.model }[config.drafter];
  const modeLabel = `카페24 ${config.cafe24Mode === "mock" ? "목업" : "실제 API"} · ${drafterLabel}`;
  const watcher = new Watcher(pipeline, store, config.autoSyncSeconds);
  const app = createApp({ store, pipeline, modeLabel, baselineMinutes: config.baselineMinutes, watcher });
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`관리자 화면: http://localhost:${info.port}`);
    console.log(config.autoSyncSeconds ? `새 글을 ${config.autoSyncSeconds}초마다 확인합니다.` : "자동 확인 꺼짐 (AUTO_SYNC_SECONDS=0)");
    watcher.start();
  });
} else {
  console.error(`모르는 명령입니다: ${command} (serve | sync | draft | reset)`);
  process.exit(1);
}
