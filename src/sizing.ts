import { readFileSync } from "node:fs";

// 사이즈 추천은 LLM이 아니라 이 코드가 계산한다(설계 문서 4.1).
// 권장 체형 범위에서 얼마나 벗어났는지를 점수로 매기고, 가장 낮은 점수의 사이즈를 고른다.

export type GarmentKind = "top" | "bottom";
export type BodyNote = "broad_upper" | "belly" | "thick_thigh";

export interface SizeRow {
  size: string;
  height: [number, number];
  weight: [number, number];
  measurements: Record<string, number>;
}

export interface SizeChart {
  product_no: number;
  kind: GarmentKind;
  fit_note: string;
  /** 바지: 기본 기장(총장)이 수선 없이 맞는 키 범위(cm). MD가 정한다. */
  length_fit_height?: [number, number];
  sizes: SizeRow[];
}

export interface SizeRequest {
  heightCm?: number;
  weightKg?: number;
  /** 평소 입는 바지 허리 사이즈(인치) */
  waistInch?: number;
  /** 평소 입는 상의 사이즈. "3XL", "XXXL", "115" 모두 받는다 */
  usualSize?: string;
  bodyNotes?: BodyNote[];
}

export interface SizeRecommendation {
  recommended: string | null;
  alternative: string | null;
  confidence: "high" | "medium" | "low";
  reasons: string[];
  caveats: string[];
  /** 추천 사이즈의 실측(cm), 한국어 이름으로 */
  measurements: Record<string, number> | null;
  inStock: Record<string, boolean>;
  /**
   * 바지 기장 안내: 고객 키를 기본 기장이 맞는 키 범위와 비교한 결과.
   * 모델이 "키 170이면 길 것 같다"고 스스로 추론하던 것을(EVAL-CC 1202) 데이터로 대신한다.
   */
  lengthNote: string | null;
}

function lengthNote(chart: SizeChart, row: SizeRow, heightCm: number | undefined): string | null {
  if (heightCm === undefined || !chart.length_fit_height) return null;
  const [lo, hi] = chart.length_fit_height;
  const length = row.measurements.length;
  const range = `기본 기장이 수선 없이 맞는 키(${lo}~${hi}cm)`;
  if (heightCm < lo) return `키 ${heightCm}cm는 ${range}보다 작아 총장 ${length}cm가 길 수 있음`;
  if (heightCm > hi) return `키 ${heightCm}cm는 ${range}보다 커서 총장 ${length}cm가 짧을 수 있음`;
  return `키 ${heightCm}cm는 ${range} 안이라 총장 ${length}cm를 수선 없이 입을 수 있음`;
}

export const MEASUREMENT_LABELS: Record<string, string> = {
  shoulder: "어깨",
  chest: "가슴 단면",
  sleeve: "소매",
  length: "총장",
  waist: "허리 단면",
  hip: "엉덩이 단면",
  thigh: "허벅지 단면",
  rise: "밑위",
  hem: "밑단 단면",
};

const TOP_ORDER = ["M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];
// 국내 호칭(100, 105 …)을 영문 사이즈로 바꾼다.
const KOREAN_TOP_SIZES: Record<string, string> = {
  "95": "M", "100": "L", "105": "XL", "110": "2XL", "115": "3XL", "120": "4XL", "125": "5XL",
};

export function loadSizeCharts(file: string): Map<number, SizeChart> {
  const raw = JSON.parse(readFileSync(file, "utf8")) as { charts: SizeChart[] };
  return new Map(raw.charts.map((c) => [c.product_no, c]));
}

export function normalizeTopSize(input: string): string | null {
  const s = input.trim().toUpperCase().replace(/\s+/g, "");
  if (KOREAN_TOP_SIZES[s]) return KOREAN_TOP_SIZES[s];
  const xs = s.match(/^(X+)L$/);
  if (xs) return xs[1].length === 1 ? "XL" : `${xs[1].length}XL`;
  return TOP_ORDER.includes(s) ? s : null;
}

function rangeDistance(value: number, [lo, hi]: [number, number]): number {
  if (value < lo) return lo - value;
  if (value > hi) return value - hi;
  return 0;
}

function labelled(measurements: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(measurements).map(([k, v]) => [MEASUREMENT_LABELS[k] ?? k, v]));
}

function score(chart: SizeChart, row: SizeRow, req: SizeRequest): number {
  let s = 0;
  if (req.weightKg !== undefined) s += rangeDistance(req.weightKg, row.weight) / 5;
  if (req.heightCm !== undefined) s += (0.3 * rangeDistance(req.heightCm, row.height)) / 5;
  if (chart.kind === "bottom" && req.waistInch !== undefined) {
    const diff = Number(row.size) - req.waistInch;
    // 평소 사이즈와 같거나 1~2인치 큰 것이 정답 범위. 작은 쪽은 아예 안 맞으므로 크게 깎는다.
    if (diff < 0) s += 2 + -diff * 1.5;
    else if (diff > 2) s += (diff - 2) * 0.5;
  }
  if (chart.kind === "top" && req.usualSize) {
    const usual = normalizeTopSize(req.usualSize);
    if (usual) s += 0.4 * Math.abs(TOP_ORDER.indexOf(usual) - TOP_ORDER.indexOf(row.size));
  }
  return s;
}

export function recommendSize(
  chart: SizeChart,
  req: SizeRequest,
  inStock: (size: string) => boolean = () => true,
): SizeRecommendation {
  const signals = [req.weightKg, req.waistInch, req.usualSize].filter((v) => v !== undefined).length;
  if (signals === 0) {
    return {
      recommended: null,
      alternative: null,
      confidence: "low",
      reasons: ["몸무게, 평소 사이즈, 허리 인치 중 하나도 없어 계산할 수 없음"],
      caveats: ["고객에게 키, 몸무게, 평소 입는 사이즈를 여쭤볼 것"],
      measurements: null,
      inStock: {},
      lengthNote: null,
    };
  }

  const ranked = chart.sizes
    .map((row, index) => ({ row, index, score: score(chart, row, req) }))
    .sort((a, b) => a.score - b.score || a.index - b.index);
  const best = ranked[0];
  const reasons: string[] = [];
  const caveats: string[] = [];
  let alternative: SizeRow | null = null;

  if (req.weightKg !== undefined) {
    const [lo, hi] = best.row.weight;
    reasons.push(
      req.weightKg >= lo && req.weightKg <= hi
        ? `몸무게 ${req.weightKg}kg이 ${best.row.size} 권장 범위(${lo}~${hi}kg) 안에 있음`
        : `몸무게 ${req.weightKg}kg에 가장 가까운 권장 범위는 ${best.row.size}(${lo}~${hi}kg)`,
    );
  }
  if (req.waistInch !== undefined && chart.kind === "bottom") {
    reasons.push(`평소 허리 ${req.waistInch}인치 기준 ${best.row.size}인치 (허리 단면 ${best.row.measurements.waist}cm)`);
  }
  if (req.usualSize && chart.kind === "top") {
    const usual = normalizeTopSize(req.usualSize);
    if (usual) reasons.push(`평소 사이즈 ${req.usualSize}(${usual}) 참고`);
    else caveats.push(`평소 사이즈 "${req.usualSize}"는 해석하지 못해 계산에서 뺐음`);
  }

  const next = chart.sizes[best.index + 1] ?? null;
  const notes = new Set(req.bodyNotes ?? []);
  if (chart.kind === "top" && notes.has("broad_upper") && next) {
    alternative = next;
    caveats.push(`상체가 큰 편이면 어깨·가슴 여유를 위해 ${next.size}도 고려 (가슴 단면 ${next.measurements.chest}cm)`);
  } else if (chart.kind === "bottom" && notes.has("thick_thigh") && next) {
    alternative = next;
    caveats.push(
      `허벅지가 굵은 편이면 ${best.row.size} 허벅지 단면 ${best.row.measurements.thigh}cm가 낄 수 있어 ${next.size}도 고려`,
    );
  } else if (ranked[1] && ranked[1].score - best.score <= 0.3) {
    alternative = ranked[1].row;
    // 모델이 이 문구를 고객 답변에 그대로 옮기는 일이 있어(2차 평가 1215) 고객에게 그대로 말해도 되는 표현으로 쓴다.
    const [lo, hi] = ranked[1].row.weight;
    caveats.push(`${ranked[1].row.size}(권장 몸무게 ${lo}~${hi}kg)도 맞을 수 있어, 더 여유 있게 입고 싶으면 ${ranked[1].row.size}를 골라도 됨`);
  }
  if (chart.kind === "bottom" && notes.has("belly") && req.waistInch === undefined) {
    caveats.push("배가 나온 체형은 몸무게보다 허리 인치 기준이 정확하므로 평소 허리 사이즈를 여쭤볼 것");
  }

  if (req.heightCm !== undefined) {
    const [lo, hi] = best.row.height;
    const length = best.row.measurements.length;
    if (req.heightCm > hi) caveats.push(`키 ${req.heightCm}cm는 ${best.row.size} 권장 키보다 커서 총장(${length}cm)이 짧게 느껴질 수 있음`);
    if (req.heightCm < lo) caveats.push(`키 ${req.heightCm}cm는 ${best.row.size} 권장 키보다 작아서 총장(${length}cm)이 길 수 있음`);
  }

  let confidence: SizeRecommendation["confidence"] =
    best.score <= 0.3 && req.weightKg !== undefined ? "high" : best.score <= 1.2 ? "medium" : "low";
  if (best.score >= 2) {
    confidence = "low";
    caveats.push("어떤 사이즈의 권장 체형에도 잘 맞지 않음. 담당자가 실측을 직접 비교해 안내할 것");
  }

  const stock: Record<string, boolean> = { [best.row.size]: inStock(best.row.size) };
  if (alternative) stock[alternative.size] = inStock(alternative.size);
  if (!stock[best.row.size]) caveats.push(`추천 사이즈 ${best.row.size}는 현재 품절`);

  return {
    recommended: best.row.size,
    alternative: alternative?.size ?? null,
    confidence,
    reasons,
    caveats,
    measurements: labelled(best.row.measurements),
    inStock: stock,
    lengthNote: lengthNote(chart, best.row, req.heightCm),
  };
}
