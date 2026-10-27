import { z } from "zod";

export const CATEGORIES = ["사이즈", "배송", "교환·반품", "주문변경", "상품정보", "재입고", "불량·클레임", "후기", "기타"] as const;

/** submit_draft 도구의 입력 = 에이전트가 제출하는 초안 */
export const DraftSchema = z.object({
  category: z.enum(CATEGORIES).describe("문의 유형"),
  answer: z.string().min(1).describe("고객에게 보낼 답변 전문"),
  confidence: z.enum(["high", "medium", "low"]).describe("답변이 도구 결과에 얼마나 근거하는지"),
  needs_human: z.boolean().describe("담당자 확인이 꼭 필요하면 true"),
  human_reasons: z.array(z.string()).describe("needs_human이 true인 이유. 없으면 빈 배열"),
  sources: z
    .array(z.string())
    .describe("근거로 쓴 것들. 정책 섹션 ID(예: shipping#배송비), order:주문번호, product:상품번호, size:상품번호"),
  internal_note: z.string().describe("CS 직원만 보는 메모. 확인할 점, 처리할 일. 없으면 빈 문자열"),
});

export type DraftOutput = z.infer<typeof DraftSchema>;

const MONEY = /\d[\d,]*\s*원/;
// "2026년 10월 25일", "10월 25일"
const CALENDAR_DATE = /(?:(\d{4})\s*년\s*)?(\d{1,2})\s*월\s*(\d{1,2})\s*일/g;
// "내일 도착", "이번 주 안에 입고" 같은 상대 날짜 약속
const RELATIVE_PROMISE = /(내일|모레|이번\s*주|다음\s*주)[^.。\n]{0,12}(도착|출고|입고|재입고|발송)/;
// "이번 주 안에 입고된다고 말씀드리기 어렵습니다"처럼 약속을 거절하는 문장은 약속이 아니다 (2차 평가 오탐)
const DECLINES = /어렵|못\s|못합|않습|없습|드릴 수 없/;

// 담당자가 해야 할 처리를 이미 했거나 하겠다고 약속하는 표현 (EVAL-CC: 1208 "변경을 진행하고",
// 1214 "합배송으로 처리하고", 3차 1210 "접수해 두었습니다"). "처리해 드립니다"처럼 정책을 일반적으로
// 설명하는 현재형은 잡지 않는다.
const RESULT_PROMISE =
  /(변경|처리|진행|환불|교환|접수|반품|합배송)(을|를|으로|로)?\s*(진행하고|처리하고|해\s*드리겠|하겠습니다|해\s*두었|해\s*드렸|완료했)/;
// 게시판 글은 교환·반품 신청으로 보지만 접수 확정은 CS팀이 확인한 뒤 안내한다(정책 "신청 기간").
// 그래서 교환·반품·환불 신청을 접수했다고 확정하는 표현을 잡는다.
// - 능동형: "환불을 원하시는 것으로 접수했고"(실제 경로 11회 1210)
// - 수동형: "이 글도 교환·반품 신청으로 접수되며"(13회 1210), "이 글로 이미 접수가 되었으니"(4회 1210)
// "변경 요청은 접수했으며"(요청을 받았다는 뜻), "10월 15일에 반품이 접수되었고"(주문 상태),
// "접수되면", "접수 여부"는 잡지 않는다.
const ACCEPTED_ACTIVE = /접수(했|해\s*두었)/;
const ACCEPTED_PASSIVE = /접수(되었|됐|되며|되어(?!\s*있)|된\s*것|가\s*되었|가\s*됐)/;
const APPLICATION = /교환|반품|환불/;
// 수동형은 이 게시글이나 신청 기간에 묶여 있을 때만 접수 확정이다. 주문 상태를 말하는 문장과 구분한다.
// "같이 문의"의 "이 문의"처럼 낱말 중간에 걸리지 않게, "이·이번·오늘" 앞에는 한글이 오지 않아야 한다.
const THIS_APPLICATION =
  /(?<![가-힣])(이|이번|오늘)\s*(글|문의)|(남겨\s*주신|남기신)\s*(글|문의)|(신청|요청)으로\s*접수|기간\s*(안|내)에\s*접수/;
const CALENDAR_DATE_ONCE = /\d{1,2}\s*월\s*\d{1,2}\s*일/;
// 공개 게시판 댓글로 개인정보를 남기라는 요청 (실제 경로 13회 1213 "사업자등록번호를 이 글에 댓글로 남겨 주시면").
// 비밀글·마이페이지처럼 다른 경로를 안내하거나, 적지 말라고 하는 문장은 잡지 않는다.
// "마이페이지 > 주문내역에 나오는 주문번호와 성함을 댓글로"(1차 1216)처럼 정보의 출처로 쓴 마이페이지는 경로가 아니다.
const PERSONAL_INFO =
  /사업자\s*(등록\s*)?번호|주민\s*(등록\s*)?번호|외국인\s*등록\s*번호|계좌|카드\s*번호|비밀\s*번호|(전화|휴대폰|핸드폰)\s*번호|휴대폰|연락처|이메일|메일\s*주소|(집|회사|배송지|받으실|새|바꾸실|변경할)\s*주소|주소를|성함|실명/;
const POST_REQUEST = /(남겨|적어|올려|알려|써|작성해|기재해)\s*(주시면|주세요|주십시오|주시기|주실|주셔야)/;
const SAFE_CHANNEL =
  /비밀\s*글|1:1|일대일|전화로|이메일로|메일로|마이페이지에서|주문서에|(적지|남기지|쓰지|올리지)\s*마|공개\s*게시판에\s*(적|남기|쓰|올리)지|안내를\s*받(은|으신)\s*(뒤|후)/;
// 답변에 전화번호가 들어가면 고객이 글에 적은 번호를 공개 댓글로 되풀이했을 수 있다(상품 후기 R08 같은 경우).
const PHONE_NUMBER = /(?<!\d)0\d{1,2}-?\d{3,4}-?\d{4}(?!\d)/;
// 고객에게 담당자의 후속 확인·안내를 약속하는 문장. "담당자가"뿐 아니라 "CS팀이"도 본다
// (실제 경로 14회 1209 "CS팀이 반품 상품의 물류센터 도착 여부를 확인한 뒤 … 이 글에 다시 안내해 드리겠습니다").
const HANDOFF = /(담당자가|CS\s*팀(이|에서)|CS\s*담당자가)[^.\n]{0,40}(확인|안내|연락)/;
// 정책이 정한 보통 절차를 설명하는 문장은 후속 안내 약속으로 보지 않는다.
// 게시판 신청의 "접수 여부" 안내와 첫 사이즈 교환 무료의 "적용 여부(이용 이력)" 안내가 그렇다.
// 사이즈 답변과 1204에 거의 매번 나오는 문장이라, 이것까지 잡으면 확인 필요가 꺼져야 할 답변이 대부분 켜진다.
const POLICY_PROCESS = /접수\s*여부|적용\s*여부|이용\s*이력/;

function sentences(answer: string): string[] {
  return answer.split(/(?<=[.。!?])\s+|\n/);
}

function promisesHandoff(answer: string): boolean {
  return sentences(answer).some((sentence) => HANDOFF.test(sentence) && !POLICY_PROCESS.test(sentence));
}

function promisesRelativeDate(answer: string): boolean {
  return sentences(answer).some((sentence) => RELATIVE_PROMISE.test(sentence) && !DECLINES.test(sentence));
}

/** 교환·반품·환불 신청을 접수했다고 확정한 구절. 쉼표로 나눈 절 단위로 본다. */
function acceptanceClaim(answer: string): string | undefined {
  const aboutApplication = APPLICATION.test(answer);
  for (const clause of sentences(answer).flatMap((s) => s.split(","))) {
    const active = ACCEPTED_ACTIVE.exec(clause);
    const passive = ACCEPTED_PASSIVE.exec(clause);
    const tied = THIS_APPLICATION.test(clause) && aboutApplication;
    const hit =
      (active && (APPLICATION.test(clause) || tied) ? active : null) ??
      (passive && tied && !CALENDAR_DATE_ONCE.test(clause) ? passive : null);
    if (hit) return clause.slice(Math.max(0, hit.index - 20), hit.index + hit[0].length).trim();
  }
  return undefined;
}

/** 공개 게시판에 개인정보를 남기라고 요청한 문장에서, 요청한 정보 이름 */
function personalInfoRequest(answer: string): string | undefined {
  for (const sentence of sentences(answer)) {
    const info = PERSONAL_INFO.exec(sentence);
    if (info && POST_REQUEST.test(sentence) && !SAFE_CHANNEL.test(sentence)) return info[0];
  }
  return undefined;
}

/** 한국 시간 기준 날짜를 "YYYY-MM-DD"로 */
function seoulDate(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
}

/**
 * 답변에 나온 날짜 가운데 오늘 이후인 것. "10월 20일에 출고"처럼 이미 지난 사실은 빼고,
 * 약속이나 계산한 기한처럼 앞으로의 날짜만 남긴다. 연도가 없으면 올해로 보되,
 * 반년 넘게 지난 날짜라면 내년 날짜로 본다(12월에 "1월 3일까지"라고 쓰는 경우).
 */
export function futureDates(answer: string, today: Date): string[] {
  const todayKey = seoulDate(today);
  const thisYear = Number(todayKey.slice(0, 4));
  const found: string[] = [];
  for (const [, year, month, day] of answer.matchAll(CALENDAR_DATE)) {
    const key = (y: number) => `${y}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
    let date = key(year ? Number(year) : thisYear);
    if (!year && Date.parse(todayKey) - Date.parse(date) > 183 * 86_400_000) date = key(thisYear + 1);
    if (date > todayKey) found.push(date);
  }
  return found;
}

/**
 * 답변에 자격 조건이 있는 혜택을 안내했으면, 승인 전에 확인할 점을 내부 메모에 덧붙인다.
 * 담당자 확인(needs_human)으로 넘길 일은 아니고 승인할 때 볼 점이다.
 * 프롬프트로 시켜도 매번 한 건씩 빠져서(2차 1201, 3차 1212) 코드로 보장한다.
 */
const APPROVAL_CHECKS: { when: RegExp; covered: RegExp; note: string }[] = [
  {
    when: /첫 사이즈 교환/,
    covered: /첫 사이즈 교환[^\n]*(이미|사용|이력|썼)|(이미|사용|이력|썼)[^\n]*첫 사이즈 교환/,
    note: "[자동] 답변에 첫 사이즈 교환 무료를 안내함: 이 회원이 이미 썼는지 확인",
  },
];

function withApprovalChecks(answer: string, note: string): string {
  const extra = APPROVAL_CHECKS.filter((c) => c.when.test(answer) && !c.covered.test(note)).map((c) => c.note);
  return [note.trim(), ...extra].filter(Boolean).join("\n");
}

/**
 * 프롬프트가 놓쳐도 사람 확인으로 넘어가게 하는 코드 규칙 (설계 문서 4.5).
 * 초안을 막지는 않고 needs_human과 이유, 승인 전 확인할 점만 덧붙인다.
 */
export function applyGuardrails(draft: DraftOutput, today: Date = new Date()): DraftOutput {
  const reasons = new Set(draft.human_reasons.map((r) => r.trim()).filter(Boolean));
  const hasPolicySource = draft.sources.some((s) => s.includes("#"));

  if (draft.confidence === "low") reasons.add("[자동] 확신도 낮음");
  if (MONEY.test(draft.answer) && !hasPolicySource) reasons.add("[자동] 금액을 안내했지만 근거 정책 문서가 없음");
  const upcoming = futureDates(draft.answer, today);
  if (upcoming.length > 0) {
    reasons.add(`[자동] 앞으로의 날짜가 있음(${upcoming.join(", ")}): 약속인지, 계산한 기한이 맞는지 확인`);
  }
  if (promisesRelativeDate(draft.answer)) reasons.add("[자동] 도착·입고 시점을 약속하는 표현이 있음");
  const promise = draft.answer.match(RESULT_PROMISE)?.[0] ?? acceptanceClaim(draft.answer);
  if (promise) reasons.add(`[자동] 처리 결과를 약속하는 표현이 있음("${promise}"): 담당자가 확인할 내용만 쓰고 결과는 약속하지 말 것`);
  if (PHONE_NUMBER.test(draft.answer)) reasons.add("[자동] 답변에 전화번호가 있음: 고객이 남긴 개인정보를 공개 글에 되풀이하지 않았는지 확인");
  const info = personalInfoRequest(draft.answer);
  if (info) reasons.add(`[자동] 공개 게시판에 개인정보("${info}")를 남기라고 요청함: 비밀글이나 다른 경로로 받도록 고칠 것`);
  // 답변이 담당자의 후속 안내를 약속하면, 실제로 담당자에게 넘어가야 한다.
  if (!draft.needs_human && reasons.size === 0 && promisesHandoff(draft.answer)) {
    reasons.add("[자동] 답변이 담당자 후속 안내를 약속하는데 확인 필요가 꺼져 있었음");
  }

  const human_reasons = [...reasons];
  return {
    ...draft,
    human_reasons,
    needs_human: draft.needs_human || human_reasons.length > 0,
    internal_note: withApprovalChecks(draft.answer, draft.internal_note),
  };
}
