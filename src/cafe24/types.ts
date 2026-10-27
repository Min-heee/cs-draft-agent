// 카페24 Admin API(버전 2026-09-01) 응답에서 이 앱이 쓰는 필드만 옮겨 왔다.
// 필드 이름은 API 응답과 같게 두어서 목업 데이터와 실제 API를 바꿔 끼울 수 있게 한다.
// 참고: https://apidocs.cafe24.com/en/docs/admin/

/** GET /admin/boards/{board_no}/articles 의 글 하나 (상품 Q&A) */
export interface Inquiry {
  article_no: number;
  board_no: number;
  product_no: number | null;
  order_id: string | null;
  member_id: string | null;
  writer: string;
  title: string;
  content: string;
  created_date: string;
}

/** GET /admin/orders/{order_id}?embed=items 의 items[] */
export interface OrderItem {
  order_item_code: string;
  product_no: number;
  product_name: string;
  option_value: string;
  quantity: number;
  product_price: string;
  /** N00 입금전, N10 상품준비중, N20 배송준비중, N30 배송중, N40 배송완료, R** 반품, E** 교환, C** 취소 */
  order_status: string;
  status_text: string;
  tracking_no: string | null;
  shipping_company_name: string | null;
  shipped_date: string | null;
  delivered_date: string | null;
  exchange_request_date: string | null;
  return_request_date: string | null;
  refund_date: string | null;
}

/** GET /admin/orders/{order_id} */
export interface Order {
  order_id: string;
  member_id: string | null;
  order_date: string;
  payment_date: string | null;
  /** T 결제완료, F 미결제, M 부분 */
  paid: "T" | "F" | "M";
  /** T 취소, F 정상, M 부분취소 */
  canceled: "T" | "F" | "M";
  /** F 배송전, M 배송중, T 배송완료, W 보류, X 확인대기 */
  shipping_status: "F" | "M" | "T" | "W" | "X";
  payment_amount: string;
  shipping_fee: string;
  items: OrderItem[];
}

/** GET /admin/products/{product_no}/variants?embed=inventories 의 variants[] */
export interface Variant {
  variant_code: string;
  options: { name: string; value: string }[];
  selling: "T" | "F";
  quantity: number;
}

/** GET /admin/products/{product_no} (+ variants) */
export interface Product {
  product_no: number;
  product_name: string;
  price: string;
  selling: "T" | "F";
  sold_out: "T" | "F";
  summary_description: string;
  product_material: string;
  variants: Variant[];
}

export interface ReplyResult {
  /** 등록된 답글의 글 번호 */
  remote_id: string;
}

export interface Cafe24Client {
  /** 상품 Q&A 게시판에서 아직 답하지 않은(reply_status=N) 글 */
  listUnansweredInquiries(): Promise<Inquiry[]>;
  getOrder(orderId: string): Promise<Order | null>;
  getProduct(productNo: number): Promise<Product | null>;
  postReply(inquiry: Inquiry, content: string): Promise<ReplyResult>;
}
