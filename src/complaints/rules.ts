import type { Reason, ReasonCode, SizePart } from "./taxonomy.ts";
import type { Classification, ComplaintPost } from "./types.ts";

// 규칙만으로 사유를 붙인다. 두 가지로 쓴다.
// 1) 정확도를 잴 때 'LLM 없이 규칙만' 기준선
// 2) LLM 결과를 확인하는 단서(별점, 주입 지시)
// 낱말 목록은 일부러 단순하게 둔다. 부정("안 줄었어요")과 구매 전 질문은 따로 거른다.

const PATTERNS: [Exclude<ReasonCode, "size_big" | "size_small" | "other">, RegExp][] = [
  ["shrink_wash", /줄었|줄어(들|요|서|든)|수축|보풀|늘어났|늘어나(요|서)|물 ?빠|이염|뒤틀|변형/],
  ["fabric", /얇(아|다|고|네|은|더)|비(쳐|치|침)|까슬|따가(워|운)|두께가|재질이|원단이 ?(별로|안 ?좋|싸)/],
  ["color", /색(상|깔|감)?이? ?(사진|화면)?(이랑|과|하고|와)? ?(달라|다르|틀려)|사진(이랑|과|보다|하고) ?색/],
  ["defect", /불량|단추.{0,6}(없|떨어|빠졌|하나)|지퍼.{0,6}(고장|안 ?올|안 ?내|걸려|망가|뻑뻑)|박음질|실밥|터(졌|져)|구멍|오염|얼룩|찢어/],
  ["shipping_delay", /배송.{0,8}(늦|느려|안 ?와|안 ?오)|아직.{0,8}(안 ?왔|못 ?받|안 ?와|도착 ?안)|출고.{0,8}(늦|안 ?돼|안 ?됐)|늦게 ?(왔|도착)|일주일.{0,6}(안 ?와|째)/],
  ["wrong_item", /다른 ?(사이즈|색|상품|제품)(이|가|으로) ?(왔|배송)|잘못 ?(왔|배송|보내)|오배송|주문한 ?(거|것)(랑|과) ?다른|빠져 ?(있|왔)|누락|하나만 ?왔/],
  ["service", /답(변|장)이? ?(없|안 ?(와|오|달))|연락이? ?(없|안 ?(와|오))|(두|세|네) ?번째 ?문의|몇 ?번(을|째)|환불.{0,10}(언제|늦|안 ?돼|아직)|교환.{0,10}(늦|아직|안 ?돼)|응대|불친절|무시(하|당)/],
  // "3XL 입고 다녀요", "4XL 샀는데 불편함 없이"처럼 입는다는 말·칭찬에 걸리지 않게 재고 낱말만 본다.
  [
    "big_size_stock",
    /([2-6] ?xl|빅 ?사이즈|큰 ?사이즈).{0,12}(품절|재입고|입고 ?(예정|되|일|문의|언제|안)|없(나요|어서|네요|어요|더라|던데|습니다))|(품절|재입고).{0,12}([2-6] ?xl|큰 ?사이즈)/i,
  ],
];

const SIZE_BIG = /크(다|네|고|게 ?나|더|ㄴ)|커(요|서|다|용|도|가지고)|헐렁|내려(와|가|옴)|길(어|다|고 ?불편|더|게 ?나)|남아(요|서)|흘러 ?내/;
const SIZE_SMALL = /작(아|다|고|네|게 ?나|더|은 ?편)|끼(어|여|고|네|는|다|어서)|껴(요|서)|조이|타이트|짧(아|다|고|네|게 ?나|더)|안 ?잠기|터질 ?것/;

// '품'은 상품·제품·품절·품질에, '팔'은 팔렸·팔아에 걸리지 않게 앞뒤 글자를 본다.
const PARTS: [SizePart, RegExp][] = [
  ["sleeve", /팔(?![렸리아고])|소매/],
  ["length", /기장|길이|총장|밑단|바지 ?길|길어|짧아|길다|짧다/],
  ["lower", /허리|허벅지|엉덩이|밑위|힙|종아리/],
  ["upper", /어깨|가슴|(?<![상제작부물])품(?![절질번목])|배가|배 ?부분|몸통|등판/],
];

/** 구매 전에 묻는 말. 받은 뒤라는 말이 없으면 사이즈 낱말이 있어도 불만으로 보지 않는다. */
const BEFORE_PURCHASE = /될까요|맞을까요|괜찮을까요|어떨까요|추천|몇 ?사이즈|입을 ?수 ?있|맞나요|궁금|문의드|사도 ?될|고민/;
const AFTER_PURCHASE = /받았|받아 ?보|받고|왔는데|왔어요|입어 ?보|입어봤|입었는데|입으니|샀는데|구매했|주문했는데|착용|빨았|세탁했|세탁 ?후|배송 ?받|도착했/;

/** 글 안에서 분류나 답을 바꾸라는 지시. 따르지 않고 '확인 필요'로 둔다. */
const INJECTION =
  /(이전|앞의|위의|기존)\s*(지시|명령|규칙)[^\n]{0,20}(무시|따르지)|ignore\s+(all\s+|the\s+)?(previous|prior|above)|\[(관리자|시스템|운영자|system|admin)[^\]]{0,20}\]|(불만\s*없음|불만\s*아님|정상)\s*(으로|이라고)\s*(분류|처리|표시)|분류\s*(하세요|하시오|해\s*주세요)|라고\s*(답|댓글)[^\n]{0,10}(다세요|하세요|달아)/i;

function negated(text: string, index: number, length: number): boolean {
  const before = text.slice(Math.max(0, index - 5), index);
  const after = text.slice(index + length, index + length + 4);
  return /(안|않|못|하나도 ?안|전혀 ?안)\s*$/.test(before) || /^지\s*(않|도 ?않)/.test(after);
}

function firstMatch(text: string, pattern: RegExp): string | null {
  const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
  for (const m of text.matchAll(new RegExp(pattern.source, flags))) {
    if (!negated(text, m.index ?? 0, m[0].length)) return m[0];
  }
  return null;
}

function sizePart(text: string): SizePart {
  for (const [part, pattern] of PARTS) if (pattern.test(text)) return part;
  return "unknown";
}

export function hasInjection(post: Pick<ComplaintPost, "title" | "content">): boolean {
  return INJECTION.test(`${post.title}\n${post.content}`);
}

export function rulesReasons(post: ComplaintPost): Reason[] {
  const text = `${post.title}\n${post.content}`;
  const beforePurchase = BEFORE_PURCHASE.test(text) && !AFTER_PURCHASE.test(text);
  const reasons: Reason[] = [];
  for (const [code, pattern] of PATTERNS) {
    // 큰 사이즈 재입고 문의는 구매 전이어도 센다. 나머지는 구매 전 질문이면 불만이 아니다.
    if (beforePurchase && code !== "big_size_stock") continue;
    const hit = firstMatch(text, pattern);
    if (hit) reasons.push({ code, part: null, evidence: hit });
  }
  if (!beforePurchase) {
    const big = firstMatch(text, SIZE_BIG);
    const small = firstMatch(text, SIZE_SMALL);
    // 기장은 "길다"=큼, "짧다"=작음. 둘 다 걸리면(예: "팔은 길고 기장은 짧아요") 둘 다 남긴다.
    if (big) reasons.push({ code: "size_big", part: sizePart(text), evidence: big });
    if (small) reasons.push({ code: "size_small", part: sizePart(text), evidence: small });
  }
  if (!reasons.length && post.rating !== null && post.rating <= 2) {
    reasons.push({ code: "other", part: null, evidence: `별점 ${post.rating}` });
  }
  return reasons;
}

/** 'LLM 없이 규칙만' 분류 */
export function classifyByRules(post: ComplaintPost): Classification {
  const reasons = rulesReasons(post);
  const injection = hasInjection(post);
  const check_reasons: string[] = [];
  if (injection) check_reasons.push("글 안에 분류를 바꾸라는 지시가 있음");
  if (reasons.some((r) => r.code === "other" && r.evidence.startsWith("별점"))) {
    check_reasons.push("별점은 낮은데 사유 낱말이 없음");
  }
  return {
    reasons,
    confidence: reasons.length ? "medium" : "low",
    needs_check: check_reasons.length > 0,
    check_reasons,
    injection,
    classifier: "rules",
    fallback: false,
    model: null,
    input_tokens: 0,
    output_tokens: 0,
    latency_ms: 0,
  };
}
