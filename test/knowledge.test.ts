import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { ROOT } from "../src/config.ts";
import { tokenize } from "../src/knowledge/bm25.ts";
import { PolicyStore } from "../src/knowledge/policies.ts";

const policies = PolicyStore.fromDir(path.join(ROOT, "data/policies"));

test("한국어는 글자 2-gram, 숫자와 영문은 통째로 자른다", () => {
  assert.deepEqual(tokenize("교환은 7일 XL!"), ["교환", "환은", "7일", "xl"]);
});

// 고객이 실제로 쓸 법한 말로 검색했을 때 맞는 섹션이 상위 3개 안에 들어와야 한다.
const cases: [string, string][] = [
  ["사이즈 교환 배송비 무료", "exchange-return#첫 사이즈 교환 무료"],
  ["환불 언제 되나요 카드", "exchange-return#환불 시점"],
  ["단추 떨어짐 불량", "exchange-return#불량·오배송"],
  ["건조기 줄어드나요", "product-care#면 티셔츠 수축"],
  ["슬랙스 기장 수선", "size-guide#기장 수선 서비스"],
  ["배송지 변경", "shipping#배송지 변경"],
  ["두 주문 합배송", "shipping#합배송"],
  ["오프라인 매장", "restock-and-misc#오프라인 매장"],
  ["품절 재입고 일정", "restock-and-misc#재입고"],
  ["언제 도착 택배", "shipping#택배사와 도착 시간"],
  // 1차 평가(EVAL-1)에서 놓친 검색어. 고객 표현을 "검색어:" 줄로 섹션에 넣어 고쳤다.
  ["배송 기간 지연", "shipping#택배사와 도착 시간"],
  ["배송 기간", "shipping#택배사와 도착 시간"],
  ["배송 며칠 걸려요", "shipping#택배사와 도착 시간"],
  ["아직 안 왔어요 배송", "shipping#택배사와 도착 시간"],
  // 게시판 글도 신청으로 인정한 뒤(1210처럼 항의 투로 묻는 경우) 신청 기간 섹션을 찾아야 한다
  ["환불해 주세요 교환 요청했는데 답이 없어요", "exchange-return#신청 기간"],
  ["게시판으로 반품 신청", "exchange-return#신청 기간"],
];

for (const [query, expected] of cases) {
  test(`정책 검색: "${query}" → ${expected}`, () => {
    const ids = policies.search(query, 3).map((h) => h.id);
    assert.ok(ids.includes(expected), `상위 3개: ${ids.join(", ")}`);
  });
}

test("검색어 줄은 검색에만 쓰고 본문에서는 뺀다", () => {
  const section = policies.get("shipping#택배사와 도착 시간")!;
  assert.ok(section.keywords.includes("며칠 걸려요"));
  assert.ok(!section.body.includes("검색어"));
});

test("관련 없는 질문은 결과가 비거나 점수가 낮다", () => {
  const hits = policies.search("비트코인 시세", 3);
  assert.equal(hits.length, 0);
});
