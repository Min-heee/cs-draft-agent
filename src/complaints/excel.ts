import { quoteOf, type ComplaintReport } from "./report.ts";
import type { LabeledPost } from "./store.ts";
import { reasonKey, reasonKeyLabel } from "./taxonomy.ts";
import { buildXlsx, type Cell, type Sheet } from "./xlsx.ts";

// 불만 사유 리포트를 엑셀로. 시트 다섯:
//   요약 · 사유 순위 · 상품별 · 글별 분류(글마다 사유와 확인 필요 — 엑셀 필터로 거른다) · 정보(기준 시각, 자료, 분류, 안내)
// 작성자 이름은 넣지 않는다. 인용은 리포트와 같이 짧게(근거 구절 또는 90자) 가려서 넣고, 불만 아닌 글은 인용을 비운다.

const periodLabel = (days: number | null) => (days === null ? "전체 기간" : `지난 ${days}일`);
const kindLabel = (kind: string) => (kind === "review" ? "후기" : kind === "qna" ? "문의" : "댓글");

/** 한국 시각 "YYYY-MM-DD HH:mm" */
function kstTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t + 9 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
}

const dateCell = (iso: string): Cell => (Number.isNaN(Date.parse(iso)) ? iso : { date: new Date(iso) });

export interface ExcelInput {
  /** 위에서부터(예: 7일, 30일) */
  reports: ComplaintReport[];
  /** 글별 분류 시트에 넣을 글(보통 가장 긴 기간 안의 글) */
  posts: LabeledPost[];
  productNames: Map<number, string>;
  /** 자료 출처(cafe24·mock·시험 파일)와 리포트 안내 문장. 파일만 받아 본 사람도 무엇을 센 것인지 알게 한다. */
  source: string;
  notes: string[];
}

/** 엑셀에 넣을 시트들(요약 · 사유 순위 · 상품별 · 글별 분류) */
export function complaintSheets({ reports, posts, productNames, source, notes }: ExcelInput): Sheet[] {
  const nameOf = (no: number | null) => (no === null ? "상품 미지정" : (productNames.get(no) ?? `상품 ${no}`));

  const summary: Sheet = {
    name: "요약",
    widths: [12, 10, 10, 10, 10, 10],
    rows: [
      ["기간", "고객 글", "불만 글", "불만 아님", "확인 필요", "대신 채움"],
      ...reports.map((r): Cell[] => [periodLabel(r.days), r.posts, r.complaints, r.not_complaints, r.needs_check, r.fallback]),
    ],
  };

  const ranking: Sheet = {
    name: "사유 순위",
    widths: [12, 6, 26, 8, 12, 14],
    rows: [
      ["기간", "순위", "사유", "건수", "불만 글 중", "지난 기간 건수"],
      ...reports.flatMap((r) =>
        r.overall.map((x, i): Cell[] => [periodLabel(r.days), i + 1, x.label, x.count, { percent: x.share }, x.previous]),
      ),
    ],
  };

  const products: Sheet = {
    name: "상품별",
    widths: [12, 10, 30, 10, 26, 8, 14],
    rows: [
      ["기간", "상품번호", "상품명", "불만 글", "사유", "건수", "상품 불만 글 중"],
      ...reports.flatMap((r) =>
        r.products.flatMap((p) =>
          p.reasons.map((x): Cell[] => [periodLabel(r.days), p.product_no, p.name, p.complaints, x.label, x.count, { percent: x.share }]),
        ),
      ),
    ],
  };

  const byPost: Sheet = {
    name: "글별 분류",
    widths: [17, 6, 10, 26, 6, 6, 30, 9, 36, 9, 60],
    rows: [
      ["작성 시각", "종류", "상품번호", "상품명", "별점", "불만", "사유", "확인 필요", "확인 이유", "대신 채움", "인용(전화·주소 등 가림)"],
      ...[...posts]
        .sort((a, b) => b.post.created_date.localeCompare(a.post.created_date))
        .map((row): Cell[] => [
          dateCell(row.post.created_date),
          kindLabel(row.post.kind),
          row.post.product_no,
          nameOf(row.post.product_no),
          row.post.rating,
          row.label.reasons.length ? "예" : "아니오",
          row.label.reasons.map((x) => reasonKeyLabel(reasonKey(x))).join(", ") || "불만 아님",
          row.label.needs_check ? "예" : "",
          row.label.check_reasons.join(" / "),
          row.label.fallback ? "예" : "",
          // 불만이거나 확인이 필요한 글만 짧게 인용한다(불만 아닌 글의 본문은 파일에 넣지 않는다).
          row.label.reasons.length || row.label.needs_check ? quoteOf(row).text : "",
        ]),
    ],
  };

  const now = reports[0]?.now;
  const info: Sheet = {
    name: "정보",
    widths: [16, 90],
    rows: [
      ["항목", "내용"],
      ["기준 시각(한국)", now ? kstTime(now) : ""],
      ["자료", source],
      ["분류", reports[0]?.classifier === "rules+llm" ? "규칙 + Claude(구독) + 코드 검사" : "규칙만"],
      ["만든 시각(한국)", reports[0] ? kstTime(reports[0].generated_at) : ""],
      ...notes.map((n): Cell[] => ["안내", n]),
    ],
  };

  return [summary, ranking, products, byPost, info];
}

export function renderXlsx(input: ExcelInput): Buffer {
  return buildXlsx(complaintSheets(input));
}
