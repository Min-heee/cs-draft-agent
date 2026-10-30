import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Store } from "../db.ts";
import { classifyPosts, type BatchClassifier } from "./classify.ts";
import { complaintSheets } from "./excel.ts";
import { buildXlsx, type Sheet } from "./xlsx.ts";
import { computeReport, inPeriod, kstDate, renderCsv, renderHtml, type ComplaintReport } from "./report.ts";
import type { ComplaintSource } from "./source.ts";
import { productNamesKey, type ComplaintStore } from "./store.ts";
import type { Classifier } from "./types.ts";

// 리포트 한 번 만들기: 고객 글 읽기(GET만) → 새 글·바뀐 글만 분류해 저장 → 7일·30일 리포트 계산 → HTML·CSV·엑셀 쓰기
// → 늘어난 사유가 있으면 관리자 화면 알림. 쇼핑몰에는 아무것도 쓰지 않는다.

export interface ComplaintJobDeps {
  source: ComplaintSource;
  complaints: ComplaintStore;
  /** 알림을 남길 앱 DB. 없으면 알림을 남기지 않는다(시험 파일로 한 번 돌릴 때). */
  app?: Store;
  /** 없으면 규칙만으로 분류한다. */
  llm?: BatchClassifier;
  batchSize?: number;
  /** 리포트 파일을 쓸 폴더. git에 올리지 않는 폴더(data/reports)다. */
  outDir: string;
  now?: () => Date;
  minRise?: number;
  /** 구글시트(설정했을 때만). 엑셀과 같은 탭을 시트에도 쓴다. 실제 카페24 자료일 때만 쓴다(목업 시연이 시트를 덮지 않게). */
  sheets?: { writeSheets(sheets: Sheet[]): Promise<{ url: string }> };
}

export interface ComplaintJobResult {
  date: string;
  added: number;
  changed: number;
  classified: number;
  /** LLM이 실패해 규칙으로 대신 채운 글 수. 다음 실행 때 다시 분류한다. */
  fallbacks: number;
  /** 대신 채운 글이 있을 때 첫 이유(예: 로그인 만료). 관리자 화면에 보여 준다. */
  warning: string | null;
  reports: ComplaintReport[];
  files: { html: string; csv: string; xlsx: string };
  /** 구글시트에 썼으면 그 주소, 실패했으면 이유. 설정하지 않았으면 null */
  sheet: { url: string } | { error: string } | null;
  tokens: { input: number; output: number };
  seconds: number;
}

/** 시험 파일 같은 출처는 정식 리포트(카페24·목업)와 파일 이름이 겹치지 않게 한다. */
export function isOfficialSource(name: string): boolean {
  return name === "cafe24" || name === "mock";
}

export function reportNotes(source: string, classifier: Classifier): string[] {
  return [
    source === "cafe24"
      ? "자료: 카페24 게시판의 고객 글(상품 후기, 상품 Q&A, 댓글)을 GET으로만 읽었습니다. 우리가 쓴 답글·직원 이름의 글은 세지 않습니다."
      : `자료: ${source}(시연·시험용 글). 실제 쇼핑몰 글이 아닙니다.`,
    classifier === "rules+llm"
      ? "분류: Claude(구독)가 사유와 근거 구절을 고르고, 근거 구절이 원문에 있는지 등을 코드가 확인합니다. Claude가 실패한 글은 낱말 규칙으로 대신 채웁니다. 확인 필요 글은 순위에는 세고 인용에서는 뺍니다."
      : "분류: 낱말·별점 규칙만 썼습니다(LLM 없음). 반어나 낱말 없는 불만은 놓칠 수 있습니다.",
    "인용문의 전화번호·주문번호·주소·이메일·계좌번호는 가렸습니다. 쇼핑몰에는 아무것도 쓰지 않습니다.",
  ];
}

const riseKey = (source: string, date: string) => `complaints_rise:${source}:${date}`;
/** 구글시트에 마지막으로 쓴 시각(관리자 화면에 보여 준다) */
export const SHEET_WRITTEN_KEY = "complaints_sheet_written";
/** 구글시트에 쓰지 못한 이유와 시각(JSON). 성공하면 비운다. */
export const SHEET_ERROR_KEY = "complaints_sheet_error";

export async function runComplaintJob(deps: ComplaintJobDeps): Promise<ComplaintJobResult> {
  const started = performance.now();
  const now = deps.now?.() ?? new Date();
  const date = kstDate(now);
  const classifier: Classifier = deps.llm ? "rules+llm" : "rules";
  const source = deps.source.name;

  // 이번에 읽은 글만 분류하고 센다(지운 글, 다른 출처 글은 빠진다).
  const posts = await deps.source.listPosts();
  const { added, changed } = deps.complaints.upsertPosts(posts, source);
  const pending = deps.complaints.unlabeled(classifier, source);
  const labels = await classifyPosts(
    pending.map((p) => p.post),
    { llm: deps.llm, batchSize: deps.batchSize },
  );
  let input = 0;
  let output = 0;
  let fallbacks = 0;
  let warning: string | null = null;
  for (const item of pending) {
    const label = labels.get(item.post.key);
    if (!label) continue;
    deps.complaints.saveLabel(item, label);
    input += label.input_tokens;
    output += label.output_tokens;
    if (label.fallback) {
      fallbacks++;
      warning ??= label.check_reasons.at(-1) ?? "LLM 분류 실패";
    }
  }

  const rows = deps.complaints.labeled(classifier, source);
  const names = await deps.source.productNames(rows.map((r) => r.post.product_no).filter((n): n is number => n !== null));
  deps.complaints.setMeta(productNamesKey(source), JSON.stringify([...names.entries()]));
  const reports = [7, 30].map((days) => computeReport(rows, { now, days, minRise: deps.minRise, productNames: names }));

  mkdirSync(deps.outDir, { recursive: true });
  const tag = isOfficialSource(source) ? "" : `-${source.replace(/[^\w.-]+/g, "_")}`;
  const files = {
    html: path.join(deps.outDir, `complaints-${date}${tag}.html`),
    csv: path.join(deps.outDir, `complaints-${date}${tag}.csv`),
    xlsx: path.join(deps.outDir, `complaints-${date}${tag}.xlsx`),
  };
  writeFileSync(files.html, renderHtml({ reports, source, notes: reportNotes(source, classifier) }));
  writeFileSync(files.csv, renderCsv(reports));
  // 엑셀의 '글별 분류' 시트에는 지난 30일 글을 넣는다(필터로 거르기 좋게).
  const sheets = complaintSheets({
    reports,
    posts: inPeriod(rows, now, 30),
    productNames: names,
    source,
    notes: reportNotes(source, classifier),
  });
  writeFileSync(files.xlsx, buildXlsx(sheets));

  // 구글시트는 실패해도 리포트 파일은 그대로 두고, 실패 이유를 따로 남긴다(관리자 화면이 보여 주고, 다음 실행 때 다시 쓴다).
  let sheet: ComplaintJobResult["sheet"] = null;
  if (deps.sheets && source === "cafe24") {
    try {
      sheet = { url: (await deps.sheets.writeSheets(sheets)).url };
      deps.complaints.setMeta(SHEET_WRITTEN_KEY, new Date().toISOString());
      deps.complaints.setMeta(SHEET_ERROR_KEY, "");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sheet = { error: message };
      deps.complaints.setMeta(SHEET_ERROR_KEY, JSON.stringify({ at: new Date().toISOString(), message }));
    }
  }

  // 같은 날 다시 만들어도(지금 만들기, CLI) 이미 알린 사유는 건수가 늘었을 때만 다시 알린다.
  if (deps.app) {
    const notified: Record<string, number> = JSON.parse(deps.complaints.getMeta(riseKey(source, date)) ?? "{}");
    for (const r of reports[0].rising) {
      if ((notified[r.key] ?? 0) >= r.count) continue;
      deps.app.addNotification({
        article_no: null,
        type: "complaint_rise",
        message: `불만 사유 늘어남 · ${r.label} ${r.previous}→${r.count}건 (지난 7일)`,
      });
      notified[r.key] = r.count;
    }
    deps.complaints.setMeta(riseKey(source, date), JSON.stringify(notified));
  }

  return {
    date,
    added,
    changed,
    classified: pending.length,
    fallbacks,
    warning,
    reports,
    files,
    sheet,
    tokens: { input, output },
    seconds: Math.round((performance.now() - started) / 100) / 10,
  };
}
