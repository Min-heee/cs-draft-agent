import { serve } from "@hono/node-server";
import { rmSync } from "node:fs";
import path from "node:path";
import { ClaudeCodeDrafter } from "./agent/claudeCode.ts";
import { ClaudeDrafter, FakeDrafter, type Drafter } from "./agent/drafter.ts";
import { createCafe24Client, loadConfig, ROOT } from "./config.ts";
import { Store } from "./db.ts";
import { PolicyStore } from "./knowledge/policies.ts";
import { Pipeline } from "./pipeline.ts";
import { createApp } from "./server.ts";
import { loadSizeCharts } from "./sizing.ts";

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
  console.log(`새 문의 ${await pipeline.sync()}건을 불러왔습니다.`);
} else if (command === "draft") {
  await pipeline.draftPending();
  console.log(store.countByStatus());
} else if (command === "serve") {
  store.resetStuckDrafting();
  const drafterLabel = { fake: "가짜 초안", "claude-code": `Claude Code 구독(${config.model})`, claude: config.model }[config.drafter];
  const modeLabel = `카페24 ${config.cafe24Mode === "mock" ? "목업" : "실제 API"} · ${drafterLabel}`;
  const app = createApp({ store, pipeline, modeLabel, baselineMinutes: config.baselineMinutes });
  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`검토 화면: http://localhost:${info.port}`);
  });
} else {
  console.error(`모르는 명령입니다: ${command} (serve | sync | draft | reset)`);
  process.exit(1);
}
