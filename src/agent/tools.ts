import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { Cafe24Client, Inquiry, Order, Product } from "../cafe24/types.ts";
import type { TraceEntry } from "../db.ts";
import type { PolicyStore } from "../knowledge/policies.ts";
import { MEASUREMENT_LABELS, recommendSize, type SizeChart } from "../sizing.ts";
import { DraftSchema } from "./guardrails.ts";

// 에이전트가 쓰는 도구. submit_draft를 빼면 모두 읽기 전용이다(설계 문서 4.4).
// 도구 본체(createToolHandlers)는 Claude API 도구 실행기와 MCP 서버가 함께 쓴다.
// 도구 결과는 카페24 원본 대신 사람이 읽기 쉬운 요약으로 돌려준다.

export interface ToolDeps {
  cafe24: Cafe24Client;
  policies: PolicyStore;
  sizeCharts: Map<number, SizeChart>;
}

export interface ToolScope {
  /** 문의 작성자의 회원 ID. 있으면 이 회원의 주문만 보여 준다. */
  memberId: string | null;
}

export const SUBMIT_TOOL = "submit_draft";

export const OrderInput = z.object({ order_id: z.string().describe("주문번호. 예: 20261020-0000123") });
export const ProductInput = z.object({ product_no: z.number().int().describe("카페24 상품번호") });
export const SizeInput = z.object({
  product_no: z.number().int().describe("카페24 상품번호"),
  height_cm: z.number().optional().describe("키(cm)"),
  weight_kg: z.number().optional().describe("몸무게(kg)"),
  waist_inch: z.number().optional().describe("평소 입는 바지 허리 사이즈(인치)"),
  usual_size: z.string().optional().describe("평소 입는 상의 사이즈. 예: 3XL, XXXL, 115"),
  body_notes: z
    .array(z.enum(["broad_upper", "belly", "thick_thigh"]))
    .optional()
    .describe("고객이 말한 체형 특징. broad_upper=어깨·상체가 큼, belly=배가 나옴, thick_thigh=허벅지가 굵음"),
});
export const PolicyInput = z.object({ query: z.string().describe("찾을 내용. 예: 사이즈 교환 배송비") });

export const TOOL_DESCRIPTIONS = {
  get_order:
    "카페24 주문을 조회합니다. 결제 상태, 배송 상태, 송장번호, 상품별 진행 상태(교환·반품 신청 여부 포함)를 돌려줍니다.",
  get_product:
    "상품 정보를 조회합니다. 가격, 소재, 옵션별 재고, 핏 설명, 사이즈별 권장 체형과 실측표(cm, 단면)를 돌려줍니다.",
  recommend_size:
    "고객 체형으로 추천 사이즈를 계산합니다. 사이즈 추천은 반드시 이 결과를 따르세요. " +
    "고객이 말한 정보만 넣고, 말하지 않은 값은 비워 두세요. " +
    "결과의 안내_원칙(사이즈 상담 원칙, 첫 사이즈 교환 무료)은 답변에 함께 반영하고 그 id를 sources에 적으세요. " +
    "바지 기장이 길거나 짧을지는 스스로 짐작하지 말고 결과의 lengthNote를 따르세요(키를 알 때만 나옵니다).",
  search_policy:
    "쇼핑몰 정책 문서(교환·반품, 배송, 사이즈 가이드, 상품 관리, 재입고·기타)에서 관련 섹션을 찾습니다. " +
    "결과의 id를 초안의 sources에 그대로 적으세요.",
} as const;

const PAID: Record<Order["paid"], string> = { T: "결제완료", F: "입금 전", M: "부분 결제" };
const SHIPPING: Record<Order["shipping_status"], string> = {
  F: "출고 전",
  M: "배송 중",
  T: "배송 완료",
  W: "배송 보류",
  X: "확인 대기",
};

const won = (amount: string) => `${Number(amount).toLocaleString("ko-KR")}원`;

// 사이즈 추천을 안내할 때 함께 따라야 하는 정책. 실제 경로(claude -p)에서는 모델이 정책 검색을
// 건너뛰어 이 안내가 매번 빠졌다(EVAL-CC). 그래서 사이즈 계산 결과에 늘 함께 넣는다.
const SIZE_POLICY_IDS = ["size-guide#상담 원칙", "exchange-return#첫 사이즈 교환 무료"];

function stockLabel(quantity: number, selling: "T" | "F"): string {
  if (selling === "F") return "판매 중지";
  if (quantity <= 0) return "품절";
  return quantity <= 5 ? "재고 있음(소량)" : "재고 있음";
}

export function summarizeOrder(order: Order) {
  return {
    order_id: order.order_id,
    주문일시: order.order_date,
    결제: PAID[order.paid],
    취소: order.canceled === "F" ? "없음" : order.canceled === "T" ? "전체 취소" : "부분 취소",
    배송상태: SHIPPING[order.shipping_status],
    결제금액: won(order.payment_amount),
    배송비: won(order.shipping_fee),
    상품: order.items.map((item) => ({
      product_no: item.product_no,
      상품명: item.product_name,
      옵션: item.option_value,
      수량: item.quantity,
      상태: `${item.status_text} (${item.order_status})`,
      송장: item.tracking_no ? `${item.shipping_company_name ?? ""} ${item.tracking_no}`.trim() : null,
      출고일시: item.shipped_date,
      배송완료일시: item.delivered_date,
      교환신청일시: item.exchange_request_date,
      반품신청일시: item.return_request_date,
      환불일시: item.refund_date,
    })),
  };
}

export function summarizeProduct(product: Product, chart: SizeChart | undefined) {
  return {
    product_no: product.product_no,
    상품명: product.product_name,
    가격: won(product.price),
    소재: product.product_material,
    설명: product.summary_description,
    판매상태: product.selling === "T" ? "판매중" : "판매 중지",
    옵션재고: product.variants.map((v) => ({
      옵션: v.options.map((o) => `${o.name}=${o.value}`).join(", "),
      재고: stockLabel(v.quantity, v.selling),
    })),
    핏: chart?.fit_note ?? null,
    ...(chart?.length_fit_height && {
      기본기장_맞는키: `${chart.length_fit_height[0]}~${chart.length_fit_height[1]}cm`,
    }),
    실측표_cm: chart
      ? chart.sizes.map((row) => ({
          사이즈: row.size,
          권장키: `${row.height[0]}~${row.height[1]}cm`,
          권장몸무게: `${row.weight[0]}~${row.weight[1]}kg`,
          ...Object.fromEntries(Object.entries(row.measurements).map(([k, v]) => [MEASUREMENT_LABELS[k] ?? k, v])),
        }))
      : "실측표 없음",
  };
}

/** 도구 본체. 결과는 문자열이고, 실패하면 예외를 던진다(호출하는 쪽이 오류 결과로 바꾼다). */
export function createToolHandlers(deps: ToolDeps, scope: ToolScope) {
  return {
    async get_order(input: z.infer<typeof OrderInput>): Promise<string> {
      const order = await deps.cafe24.getOrder(input.order_id.trim());
      if (!order) throw new Error(`주문번호 ${input.order_id}를 찾을 수 없습니다.`);
      if (scope.memberId && order.member_id && order.member_id !== scope.memberId) {
        throw new Error("이 주문은 문의 작성자의 주문이 아닙니다. 주문 내용을 답변에 쓰지 말고 담당자 확인으로 넘기세요.");
      }
      return JSON.stringify(summarizeOrder(order));
    },

    async get_product(input: z.infer<typeof ProductInput>): Promise<string> {
      const product = await deps.cafe24.getProduct(input.product_no);
      if (!product) throw new Error(`상품번호 ${input.product_no}를 찾을 수 없습니다.`);
      return JSON.stringify(summarizeProduct(product, deps.sizeCharts.get(input.product_no)));
    },

    async recommend_size(input: z.infer<typeof SizeInput>): Promise<string> {
      const chart = deps.sizeCharts.get(input.product_no);
      if (!chart) throw new Error(`상품번호 ${input.product_no}는 실측표가 등록되어 있지 않습니다.`);
      const product = await deps.cafe24.getProduct(input.product_no);
      const inStock = (size: string) =>
        product?.variants.some((v) => v.options.some((o) => o.value === size) && v.quantity > 0 && v.selling === "T") ??
        true;
      const result = recommendSize(
        chart,
        {
          heightCm: input.height_cm,
          weightKg: input.weight_kg,
          waistInch: input.waist_inch,
          usualSize: input.usual_size,
          bodyNotes: input.body_notes,
        },
        inStock,
      );
      const 안내_원칙 = SIZE_POLICY_IDS.flatMap((id) => {
        const section = deps.policies.get(id);
        return section ? [{ id: section.id, text: section.body }] : [];
      });
      return JSON.stringify({ ...result, 안내_원칙 });
    },

    async search_policy(input: z.infer<typeof PolicyInput>): Promise<string> {
      const hits = deps.policies.search(input.query, 3);
      if (hits.length === 0) return "관련 정책을 찾지 못했습니다. 정책으로 답할 수 없는 질문이면 담당자 확인으로 넘기세요.";
      return JSON.stringify(hits.map((h) => ({ id: h.id, title: `${h.docTitle} > ${h.heading}`, text: h.body })));
    },
  };
}

export type ToolHandlers = ReturnType<typeof createToolHandlers>;

/** Claude API 도구 실행기용 도구. 호출을 trace에 기록해 검토 화면에 보여 준다. */
export function buildTools(deps: ToolDeps, inquiry: Inquiry, trace: TraceEntry[]) {
  const handlers = createToolHandlers(deps, { memberId: inquiry.member_id });

  async function recorded(tool: string, input: unknown, work: () => Promise<string>): Promise<string> {
    try {
      const output = await work();
      trace.push({ tool, input, output });
      return output;
    } catch (error) {
      trace.push({ tool, input, output: `오류: ${error instanceof Error ? error.message : String(error)}` });
      throw error; // 도구 실행기가 is_error 결과로 바꿔 모델에게 알려 준다
    }
  }

  return [
    betaZodTool({
      name: "get_order",
      description: TOOL_DESCRIPTIONS.get_order,
      inputSchema: OrderInput,
      run: (input) => recorded("get_order", input, () => handlers.get_order(input)),
    }),
    betaZodTool({
      name: "get_product",
      description: TOOL_DESCRIPTIONS.get_product,
      inputSchema: ProductInput,
      run: (input) => recorded("get_product", input, () => handlers.get_product(input)),
    }),
    betaZodTool({
      name: "recommend_size",
      description: TOOL_DESCRIPTIONS.recommend_size,
      inputSchema: SizeInput,
      run: (input) => recorded("recommend_size", input, () => handlers.recommend_size(input)),
    }),
    betaZodTool({
      name: "search_policy",
      description: TOOL_DESCRIPTIONS.search_policy,
      inputSchema: PolicyInput,
      run: (input) => recorded("search_policy", input, () => handlers.search_policy(input)),
    }),
    betaZodTool({
      name: SUBMIT_TOOL,
      description: "완성한 답변 초안을 제출합니다. 근거를 다 모은 뒤 마지막에 한 번만 호출하세요.",
      inputSchema: DraftSchema,
      run: () => "초안이 제출되었습니다.",
    }),
  ];
}
