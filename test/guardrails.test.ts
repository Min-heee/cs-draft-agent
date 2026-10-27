import assert from "node:assert/strict";
import { test } from "node:test";
import { applyGuardrails, type DraftOutput } from "../src/agent/guardrails.ts";
import { editDistance, editRatio } from "../src/textdiff.ts";

const base: DraftOutput = {
  category: "배송",
  answer: "안녕하세요, 고객님. 주문하신 상품은 배송중이며 보통 1~2영업일 안에 도착합니다.\n데모몰 CS팀 드림",
  confidence: "high",
  needs_human: false,
  human_reasons: [],
  sources: ["order:20261020-0000123", "shipping#택배사와 도착 시간"],
  internal_note: "",
};

test("근거가 충분한 초안은 그대로 둔다", () => {
  const out = applyGuardrails(base);
  assert.equal(out.needs_human, false);
  assert.deepEqual(out.human_reasons, []);
});

test("확신도가 낮으면 담당자 확인으로 넘긴다", () => {
  const out = applyGuardrails({ ...base, confidence: "low" });
  assert.equal(out.needs_human, true);
});

test("정책 근거 없이 금액을 말하면 표시한다", () => {
  const out = applyGuardrails({ ...base, answer: "왕복 배송비 6,000원이 발생합니다.", sources: ["order:1"] });
  assert.ok(out.human_reasons.some((r) => r.includes("금액")));
  const ok = applyGuardrails({ ...base, answer: "왕복 배송비 6,000원이 발생합니다.", sources: ["exchange-return#배송비"] });
  assert.equal(ok.needs_human, false);
});

// 2026-10-21 12:00 (한국 시간)
const TODAY = new Date("2026-10-21T03:00:00Z");
const flagged = (answer: string, today = TODAY) => applyGuardrails({ ...base, answer }, today).needs_human;

test("앞으로의 날짜와 상대 날짜 약속은 표시한다", () => {
  assert.equal(flagged("10월 25일에 재입고됩니다."), true);
  assert.equal(flagged("10월 23일까지 교환 신청을 하실 수 있습니다."), true);
  assert.equal(flagged("다음 주 중으로 입고될 예정입니다."), true);
  assert.ok(
    applyGuardrails({ ...base, answer: "10월 23일까지 신청해 주세요." }, TODAY).human_reasons.some((r) => r.includes("2026-10-23")),
  );
});

test("이미 지난 날짜와 정책 기간 안내는 표시하지 않는다 (1차 평가 오탐)", () => {
  assert.equal(flagged("주문하신 슬랙스는 10월 20일 오후에 출고되어 배송 중입니다."), false);
  assert.equal(flagged("2026년 10월 16일에 배송 완료되었습니다."), false);
  assert.equal(flagged("받으신 날(10월 17일)로부터 7일 이내에 신청해 주세요."), false);
  assert.equal(flagged("오늘(10월 21일) 접수되었습니다."), false);
  assert.equal(flagged("받은 날로부터 7일 이내에 신청해 주세요."), false);
});

test("상대 날짜를 약속하지 않겠다는 문장은 표시하지 않는다 (2차 평가 오탐)", () => {
  assert.equal(
    flagged("재입고 여부와 날짜는 생산 일정이 확정된 뒤에만 안내드릴 수 있어, 지금은 이번 주 안에 입고된다고 말씀드리기 어렵습니다."),
    false,
  );
  assert.equal(flagged("내일 도착한다고 확정해 드릴 수 없습니다."), false);
  // 같은 답변 안의 다른 문장에서 약속하면 여전히 잡는다
  assert.equal(flagged("이번 주 안에 입고된다고 말씀드리기 어렵습니다. 다만 다음 주에는 재입고됩니다."), true);
});

test("연말에 쓴 1월 날짜는 내년으로 본다", () => {
  const dec = new Date("2026-12-28T03:00:00Z");
  assert.equal(flagged("1월 3일까지 신청해 주세요.", dec), true);
  assert.equal(flagged("12월 20일에 출고되었습니다.", dec), false);
});

test("에이전트가 준 이유는 유지하고 중복은 합친다", () => {
  const out = applyGuardrails({ ...base, needs_human: true, human_reasons: ["불량 주장", "불량 주장"], confidence: "low" });
  assert.deepEqual(out.human_reasons, ["불량 주장", "[자동] 확신도 낮음"]);
});

test("첫 사이즈 교환 무료를 안내하면 내부 메모에 사용 이력 확인을 덧붙인다 (3차 1212)", () => {
  const answer = "안녕하세요, 고객님.\n회원 1인당 첫 사이즈 교환 1회는 왕복 배송비 없이 교환해 드립니다.\n데모몰 CS팀 드림";
  const added = applyGuardrails({ ...base, answer, internal_note: "" }, TODAY);
  assert.equal(added.internal_note, "[자동] 답변에 첫 사이즈 교환 무료를 안내함: 이 회원이 이미 썼는지 확인");
  assert.equal(added.needs_human, false); // 승인할 때 볼 점이지 담당자 확인 사유는 아니다

  const kept = applyGuardrails({ ...base, answer, internal_note: "첫 사이즈 교환 무료를 이미 썼는지 확인 필요" }, TODAY);
  assert.equal(kept.internal_note, "첫 사이즈 교환 무료를 이미 썼는지 확인 필요");

  const appended = applyGuardrails({ ...base, answer, internal_note: "재고 확인함" }, TODAY);
  assert.equal(appended.internal_note, "재고 확인함\n[자동] 답변에 첫 사이즈 교환 무료를 안내함: 이 회원이 이미 썼는지 확인");

  assert.equal(applyGuardrails(base, TODAY).internal_note, "");
});

test("처리 결과를 약속하는 표현을 잡는다 (EVAL-CC)", () => {
  const reasonOf = (answer: string) =>
    applyGuardrails({ ...base, answer, needs_human: true, human_reasons: ["배송지 변경"] }, TODAY).human_reasons.find((r) =>
      r.includes("처리 결과를 약속"),
    );
  // 실제 경로·하위 에이전트 초안에서 나온 문장
  assert.match(reasonOf("본인 확인 후 회사 주소로 변경을 진행하고 결과를 안내해 드리겠습니다.")!, /변경을 진행하고/);
  assert.match(reasonOf("담당자가 두 주문을 합배송으로 처리하고 연락드리겠습니다.")!, /합배송으로 처리하고/);
  assert.match(reasonOf("이번 문의는 환불(반품) 요청으로 접수해 두었습니다.")!, /접수해 두었/);
  // 정책을 설명하는 일반 문장은 잡지 않는다
  assert.equal(reasonOf("CS팀이 본인 확인을 거친 뒤 처리해 드립니다."), undefined);
  assert.equal(reasonOf("합배송으로 처리되면 이미 내신 배송비는 환불해 드립니다."), undefined);
  assert.equal(reasonOf("같은 상품의 다른 사이즈로 교환해 드립니다."), undefined);
  assert.equal(reasonOf("담당자가 확인한 뒤 안내드리겠습니다."), undefined);
});

test("교환·반품·환불 접수를 확정하는 표현을 잡는다 (게시판 신청 인정 정책)", () => {
  const reasonOf = (answer: string) =>
    applyGuardrails({ ...base, answer, needs_human: true, human_reasons: ["분쟁"] }, TODAY).human_reasons.find((r) =>
      r.includes("처리 결과를 약속"),
    );
  // 실제 경로 11회 1210
  assert.match(reasonOf("지금은 교환 대신 환불을 원하시는 것으로 접수했고, 담당자가 확인한 뒤 연락드리겠습니다.")!, /접수했/);
  assert.ok(reasonOf("남겨 주신 반품 신청은 접수했습니다."));
  // 요청을 받았다는 뜻, 주문 상태, 확인 후 안내는 잡지 않는다
  assert.equal(reasonOf("남겨 주신 변경 요청은 접수했으며, 담당자가 본인 확인을 한 뒤 처리 여부를 안내해 드리겠습니다."), undefined);
  assert.equal(reasonOf("10월 15일에 반품 접수되었고, 현재 반품접수 상태입니다."), undefined);
  assert.equal(reasonOf("CS팀이 주문과 신청 내용을 확인한 뒤 접수 여부를 안내드리겠습니다. 접수되면 회수 기사님이 방문합니다."), undefined);
});

test("수동형으로 접수를 확정하는 표현도 잡는다", () => {
  const reasonOf = (answer: string) =>
    applyGuardrails({ ...base, answer, needs_human: true, human_reasons: ["분쟁"] }, TODAY).human_reasons.find((r) =>
      r.includes("처리 결과를 약속"),
    );
  // 실제 경로 2·3·4·9·13회 1210
  for (const answer of [
    "오늘 남겨 주신 이 글도 교환·반품 신청으로 접수되며, 신청 기간은 글을 남기신 날을 기준으로 합니다.",
    "바지 반품을 원하신다고 하셨습니다. 이 글로 이미 접수가 되었으니 따로 다시 신청하지 않으셔도 됩니다.",
    "고객님의 이번 환불 요청은 기간 안에 접수된 것으로 확인했습니다.",
    "슬랙스는 10월 17일에 배송 완료되었고, 이번에 남겨 주신 글로 반품(환불) 요청이 기간 안에 접수되었습니다.",
    "이번 문의는 교환·반품 신청 기간(상품을 받으신 날로부터 7일) 안에 접수되었으며, 지금 담당자에게 바로 넘겼습니다.",
  ]) {
    assert.ok(reasonOf(answer), answer);
  }
  // 주문 상태, 신청 기록이 없다는 사실, 일반 문의 접수, 조건·여부는 잡지 않는다
  for (const answer of [
    "주문하신 데님은 10월 15일에 반품이 접수되었고, 아직 환불은 진행되지 않았습니다.",
    "데님 반품 신청이 접수되어 있고, 아직 환불은 진행되지 않았습니다.",
    "주문내역에는 아직 교환이나 반품 신청이 접수되어 있지 않습니다.",
    "사업자 지출증빙용 현금영수증 발행에 대한 문의 잘 접수되었습니다.",
    "남겨 주신 두 주문의 합배송 요청을 접수했습니다.",
    "교환이 접수되면 보통 1~2영업일 안에 택배 기사님이 회수하러 방문합니다.",
    "단추 탈락은 불량 접수 대상이며, 고객님 주문은 지금 접수 가능합니다.",
    "반품 문의와 같이 문의하신 현금영수증 건도 잘 접수되었습니다.",
  ]) {
    assert.equal(reasonOf(answer), undefined, answer);
  }
});

test("공개 게시판에 개인정보를 남기라는 요청을 잡는다", () => {
  const reasonOf = (answer: string) =>
    applyGuardrails({ ...base, answer }, TODAY).human_reasons.find((r) => r.includes("개인정보"));
  // 실제 경로 13회 1213, 11회 1216
  assert.match(
    reasonOf("발행을 원하시면 주문번호와 사업자등록번호를 이 글에 댓글로 남겨 주시면 확인할 때 함께 보겠습니다.")!,
    /사업자등록번호/,
  );
  assert.match(reasonOf("주문하신 분 성함과 주문일, 주문하신 상품명을 이 글에 댓글로 남겨 주세요.")!, /성함/);
  assert.ok(reasonOf("마이페이지 > 주문내역에 나오는 정확한 주문번호와 주문자 성함을 이 게시글 댓글로 남겨 주시면 감사하겠습니다."));
  assert.ok(reasonOf("환불 받으실 계좌번호를 댓글로 남겨 주세요."));
  assert.ok(reasonOf("연락처를 남겨 주시면 담당자가 연락드리겠습니다."));
  // 적지 말라는 안내, 비밀글·마이페이지 안내, 주문번호 요청, 요청이 아닌 문장은 잡지 않는다
  for (const answer of [
    "사업자등록번호 같은 정보는 공개 게시판에 적지 마시고, 담당자 안내를 받은 뒤에 전달해 주시면 됩니다.",
    "사업자등록번호는 비밀글로 남겨 주세요.",
    "마이페이지에서 회사 주소로 변경해 주시면 됩니다.",
    "정확한 주문번호를 이 글에 댓글로 남겨 주세요.",
    "같은 날 출고 전이고 받는 분 주소가 같으면 합쳐서 보내 드릴 수 있습니다.",
    "문의하신 상품명을 남겨 주세요.",
  ]) {
    assert.equal(reasonOf(answer), undefined, answer);
  }
});

test("담당자 후속 안내를 약속하면 확인 필요를 켠다 (EVAL-CC 1209)", () => {
  const out = applyGuardrails(
    { ...base, answer: "반품 상품의 도착과 검수 진행 상황은 담당자가 확인한 뒤 다시 안내해 드리겠습니다." },
    TODAY,
  );
  assert.equal(out.needs_human, true);
  assert.ok(out.human_reasons.some((r) => r.includes("담당자 후속 안내")));
  // "CS팀이"로 써도 잡는다 (실제 경로 14회 1209)
  assert.equal(
    applyGuardrails(
      { ...base, answer: "CS팀이 반품 상품의 물류센터 도착 여부를 확인한 뒤 환불 진행 상황을 이 글에 다시 안내해 드리겠습니다." },
      TODAY,
    ).needs_human,
    true,
  );
  // 정책이 정한 보통 절차(게시판 신청의 접수 여부, 첫 사이즈 교환 무료의 적용 여부)는 잡지 않는다
  for (const answer of [
    "교환 신청 시 요청사항에 \"첫 사이즈 교환\"이라고 적어 주시면 CS팀이 이용 이력을 확인한 뒤 적용 여부를 안내해 드립니다.",
    "상품 Q&A 게시판에 남겨 주신 이 글도 교환 신청으로 보며, CS팀이 주문과 신청 내용을 확인한 뒤 접수 여부를 안내해 드리겠습니다.",
    "첫 교환에 해당하는지는 CS팀이 이용 이력을 확인한 뒤 함께 안내해 드리겠습니다.",
    "적용 여부는 담당자가 이용 이력을 확인한 뒤 안내해 드립니다.",
  ]) {
    assert.equal(applyGuardrails({ ...base, answer }, TODAY).needs_human, false, answer);
  }
  // 이미 확인 필요면 이유를 덧붙이지 않는다
  const already = applyGuardrails(
    { ...base, answer: "담당자가 확인한 뒤 안내드리겠습니다.", needs_human: true, human_reasons: ["불량 주장"] },
    TODAY,
  );
  assert.deepEqual(already.human_reasons, ["불량 주장"]);
});

test("편집 거리와 수정률", () => {
  assert.equal(editDistance("교환", "교환"), 0);
  assert.equal(editDistance("사이즈", "사이즈요"), 1);
  assert.equal(editRatio("가나다라", "가나다라"), 0);
  assert.equal(editRatio("가나다라\r\n", "가나다라"), 0);
  assert.equal(editRatio("가나다라", "가나다마"), 0.25);
  assert.equal(editRatio("가", "완전히 다른 긴 문장"), 1);
});
