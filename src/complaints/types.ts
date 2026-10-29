import type { Reason } from "./taxonomy.ts";

/** 리포트가 세는 고객 글 하나. 카페24 게시판 글·댓글, 목업, 시험 글 파일에서 같은 모양으로 읽는다. */
export interface ComplaintPost {
  /** 출처 안에서 겹치지 않는 키. 카페24 글 "a:<게시판>:<글>", 댓글 "c:<게시판>:<댓글>", 파일 "f:<id>" */
  key: string;
  kind: "qna" | "review" | "comment";
  board_no: number | null;
  article_no: number | null;
  comment_no: number | null;
  product_no: number | null;
  /** 후기만 별점(1~5) */
  rating: number | null;
  title: string;
  content: string;
  /** 리포트에는 넣지 않는다. 직원 글을 거를 때만 쓴다. */
  writer: string;
  created_date: string;
}

export type Classifier = "rules" | "rules+llm";

export interface Classification {
  /** 불만 사유. 비어 있으면 '불만 아님'(칭찬·구매 전 질문·요청) */
  reasons: Reason[];
  confidence: "high" | "medium" | "low";
  /** 사람이 한 번 봐야 하는 글. 순위에는 세지만 대표 인용에서는 뺀다. */
  needs_check: boolean;
  check_reasons: string[];
  /** 글 안에 분류를 바꾸라는 지시가 들어 있음 */
  injection: boolean;
  classifier: Classifier;
  /**
   * LLM이 실패했거나 결과에서 이 글을 빠뜨려 규칙 결과로 대신 채움. 리포트에는 쓰지만,
   * 다음 실행 때 다시 LLM으로 분류한다(store.unlabeled가 다시 고른다).
   */
  fallback: boolean;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
}
