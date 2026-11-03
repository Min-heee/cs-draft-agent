// 키 없이 화면을 보는 데모. Claude를 부르지 않고, 3차 평가 때 Claude가 쓴 초안(data/eval-3-drafts.json)을 넣어 보여 준다.
// 정책 문장 점검(docs/POLICY-AUDIT.md) 전의 프롬프트·정책으로 쓴 초안이라, 그 뒤 고친 동작은 반영되지 않았다.
//
//   npm run start:demo            (다른 포트: PORT=3100 npm run start:demo)
//
// 1. data/demo.db를 지우고 처음부터 다시 만든다. 몇 번을 다시 실행해도 같은 화면에서 시작한다.
// 2. 목업 문의 16건과 그 초안을 scripts/import-drafts.ts로 넣는다(코드 안전장치도 똑같이 적용된다).
// 3. 불만 사유 리포트를 규칙만으로 한 번 만든다(src/cli.ts complaints).
// 4. 같은 설정으로 관리자 화면을 띄운다(src/cli.ts serve).
//
// .env는 읽지 않는다. 실제 카페24, API 키, 구글시트를 쓰지 않게 하려는 것이다.
// 후기·고객 댓글은 기록된 초안이 없어 넣지 않고, 자동 확인도 끈다. '지금 확인'을 누르면 후기·댓글이 들어오고
// 가짜 초안(DRAFTER=fake)이 붙는다.

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.ts";

const DB_FILE = "data/demo.db";
// data/eval-3.db에 남은 초안과 같은 모델 이름(3차 평가는 Claude Code 하위 에이전트로 돌렸다)
const MODEL = "claude-code-subagent:claude-opus-5-5";

Object.assign(process.env, {
  DB_FILE,
  CAFE24_MODE: "mock",
  DRAFTER: "fake",
  COMPLAINT_CLASSIFIER: "rules",
  COMPLAINT_SOURCE: "",
  GOOGLE_SERVICE_ACCOUNT_FILE: "",
  GOOGLE_SHEET_ID: "",
  AUTO_SYNC_SECONDS: "0",
  MOCK_DRIP: "0",
});
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

for (const suffix of ["", "-wal", "-shm"]) rmSync(path.join(ROOT, DB_FILE + suffix), { force: true });

/** 기존 명령을 같은 환경 변수로 한 번 돌린다. 실패하면 데모를 멈춘다. */
function step(...args: string[]) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

step("scripts/import-drafts.ts", "data/eval-3-drafts.json", MODEL);
step("src/cli.ts", "complaints");

// src/cli.ts는 불러올 때 명령(process.argv)과 환경 변수를 읽는다.
process.argv.splice(2, Infinity, "serve");
await import("../src/cli.ts");
