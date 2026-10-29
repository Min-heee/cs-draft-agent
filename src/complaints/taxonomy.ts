// 불만 사유 목록. 라벨 기준은 data/complaint-eval/GUIDE.md와 같다(정답을 단 기준).
// 목록은 고정이다. 분류 결과가 목록 밖이면 코드가 버린다.

export const REASON_CODES = [
  "size_big",
  "size_small",
  "shrink_wash",
  "fabric",
  "color",
  "defect",
  "shipping_delay",
  "wrong_item",
  "service",
  "big_size_stock",
  "other",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

/** 사이즈 사유에만 붙는 부위 */
export const SIZE_PARTS = ["upper", "sleeve", "length", "lower", "unknown"] as const;
export type SizePart = (typeof SIZE_PARTS)[number];

export interface Reason {
  code: ReasonCode;
  /** size_big·size_small일 때만. 나머지는 null */
  part: SizePart | null;
  /** 근거 문장. 원문에 그대로 있어야 한다(코드가 확인한다). 규칙 분류는 걸린 낱말을 넣는다. */
  evidence: string;
}

export const REASON_LABELS: Record<ReasonCode, string> = {
  size_big: "사이즈 큼",
  size_small: "사이즈 작음",
  shrink_wash: "수축·세탁",
  fabric: "소재·두께·비침",
  color: "색상 차이",
  defect: "불량(단추·지퍼·봉제)",
  shipping_delay: "배송 지연",
  wrong_item: "오배송·구성 누락",
  service: "교환·환불 처리·응대",
  big_size_stock: "큰 사이즈 품절",
  other: "기타 불만",
};

const PART_LABELS: Record<SizePart, string> = {
  upper: "어깨·가슴·배",
  sleeve: "팔",
  length: "기장",
  lower: "허리·허벅지",
  unknown: "부위 모름",
};

export function isSizeCode(code: ReasonCode): code is "size_big" | "size_small" {
  return code === "size_big" || code === "size_small";
}

/** 순위에서 한 줄로 세는 단위. 사이즈는 방향과 부위까지 나눈다(예: size_big:length = 기장이 김). */
export function reasonKey(reason: Pick<Reason, "code" | "part">): string {
  return isSizeCode(reason.code) ? `${reason.code}:${reason.part ?? "unknown"}` : reason.code;
}

/** 순위 키를 사람이 읽는 이름으로. 기장·팔은 "김/짧음"으로 쓴다. */
export function reasonKeyLabel(key: string): string {
  const [code, part] = key.split(":") as [ReasonCode, SizePart | undefined];
  if (!isSizeCode(code)) return REASON_LABELS[code] ?? key;
  const p = (part ?? "unknown") as SizePart;
  if (p === "length" || p === "sleeve") return `${PART_LABELS[p]} ${code === "size_big" ? "김" : "짧음"}`;
  return `${REASON_LABELS[code]}(${PART_LABELS[p]})`;
}

/** 정답 파일의 "size_big:length" 같은 문자열을 사유로 바꾼다. "none"은 빈 목록이다. */
export function parseGold(labels: string[]): Pick<Reason, "code" | "part">[] {
  if (labels.length === 1 && labels[0] === "none") return [];
  return labels.map((label) => {
    const [code, part] = label.split(":");
    if (!(REASON_CODES as readonly string[]).includes(code)) throw new Error(`모르는 사유 코드: ${label}`);
    const c = code as ReasonCode;
    if (isSizeCode(c)) {
      const p = (part ?? "unknown") as SizePart;
      if (!(SIZE_PARTS as readonly string[]).includes(p)) throw new Error(`모르는 부위: ${label}`);
      return { code: c, part: p };
    }
    return { code: c, part: null };
  });
}
