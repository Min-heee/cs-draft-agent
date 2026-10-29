import { serve } from "@hono/node-server";
import { rmSync } from "node:fs";
import path from "node:path";
import { ClaudeCodeDrafter } from "./agent/claudeCode.ts";
import { ClaudeDrafter, FakeDrafter, type Drafter } from "./agent/drafter.ts";
import { ClaudeCodeComplaintClassifier } from "./complaints/llm.ts";
import { isOfficialSource, runComplaintJob } from "./complaints/job.ts";
import { DailyReportScheduler, LAST_REPORT_KEY } from "./complaints/scheduler.ts";
import { ComplaintStore } from "./complaints/store.ts";
import { createCafe24Client, createComplaintSource, loadConfig, ROOT } from "./config.ts";
import { Store } from "./db.ts";
import { PolicyStore } from "./knowledge/policies.ts";
import { Pipeline, SyncError } from "./pipeline.ts";
import { createApp } from "./server.ts";
import { loadSizeCharts } from "./sizing.ts";
import { Watcher } from "./watcher.ts";

// 사용법: node src/cli.ts <serve|sync|draft|complaints|reset>

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

// 불만 사유 리포트(U-7): 고객 글을 GET으로만 읽어 사유를 나누고 data/reports에 HTML·CSV를 쓴다.
const complaints = new ComplaintStore(store.db);
const complaintSource = createComplaintSource(config, cafe24);
const complaintLlm =
  config.complaintClassifier === "claude-code" ? new ClaudeCodeComplaintClassifier({ model: config.model, effort: config.effort }) : undefined;
// 시험 파일로 돌릴 때는 정식 리포트 기록(오늘 만듦·알림)을 건드리지 않는다.
const officialSource = isOfficialSource(complaintSource.name);
const runComplaints = () =>
  runComplaintJob({
    source: complaintSource,
    complaints,
    app: officialSource ? store : undefined,
    llm: complaintLlm,
    outDir: path.join(config.dataDir, "reports"),
    now,
  });
const reportScheduler = new DailyReportScheduler({
  hour: config.complaintReportHour,
  run: runComplaints,
  getLast: () => complaints.getMeta(LAST_REPORT_KEY),
  setLast: (date) => complaints.setMeta(LAST_REPORT_KEY, date),
  now,
});

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
} else if (command === "complaints") {
  const result = await runComplaints();
  if (officialSource) complaints.setMeta(LAST_REPORT_KEY, result.date);
  const week = result.reports[0];
  console.log(`자료 ${complaintSource.name} · 분류 ${complaintLlm ? "규칙+Claude Code" : "규칙만"} · 새 글 ${result.added}건, 바뀐 글 ${result.changed}건, 이번에 분류 ${result.classified}건 (${result.seconds}초)`);
  if (result.fallbacks) console.warn(`주의: ${result.fallbacks}건은 Claude 분류에 실패해 규칙 결과로 뒀습니다(다음 실행 때 다시 분류). ${result.warning ?? ""}`);
  console.log(`지난 7일: 고객 글 ${week.posts}건 중 불만 ${week.complaints}건, 확인 필요 ${week.needs_check}건`);
  for (const r of week.overall.slice(0, 5)) console.log(`  ${r.label} ${r.count}건`);
  console.log(`리포트: ${path.relative(process.cwd(), result.files.html)}, ${path.relative(process.cwd(), result.files.csv)}`);
} else if (command === "serve") {
  store.resetStuckDrafting();
  const drafterLabel = { fake: "가짜 초안", "claude-code": `Claude Code 구독(${config.model})`, claude: config.model }[config.drafter];
  const modeLabel = `카페24 ${config.cafe24Mode === "mock" ? "목업" : "실제 API"} · ${drafterLabel}`;
  const watcher = new Watcher(pipeline, store, config.autoSyncSeconds);
  const app = createApp({
    store,
    pipeline,
    modeLabel,
    baselineMinutes: config.baselineMinutes,
    watcher,
    complaints: {
      store: complaints,
      classifier: complaintLlm ? "rules+llm" : "rules",
      scheduler: reportScheduler,
      sourceName: complaintSource.name,
      now: now ?? (() => new Date()),
    },
  });
  // 사내 PC에서 직원이 쓰는 화면이라 기본은 이 컴퓨터에서만 열린다. 다른 기기에서 열려면 HOST=0.0.0.0.
  serve({ fetch: app.fetch, port: config.port, hostname: process.env.HOST ?? "127.0.0.1" }, (info) => {
    console.log(`관리자 화면: http://localhost:${info.port}`);
    console.log(config.autoSyncSeconds ? `새 글을 ${config.autoSyncSeconds}초마다 확인합니다.` : "자동 확인 꺼짐 (AUTO_SYNC_SECONDS=0)");
    watcher.start();
    if (config.complaintReportHour >= 0) {
      console.log(`불만 사유 리포트: 매일 ${config.complaintReportHour}시 이후 처음 확인할 때 만듭니다(${complaintSource.name}).`);
    }
    reportScheduler.start();
  });
} else {
  console.error(`모르는 명령입니다: ${command} (serve | sync | draft | complaints | reset)`);
  process.exit(1);
}
