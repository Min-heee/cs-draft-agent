// 테스트 쇼핑몰(bh044) 게시판에 가짜 문의·후기를 올린다. 실제 운영 쇼핑몰에는 쓰지 않는다.
//
//   node --env-file-if-exists=.env scripts/seed-cafe24.ts [--only 1201,R01] [--dry-run]
//
// 같은 게시판에 제목과 작성자가 같은 글이 이미 있으면 건너뛴다(여러 번 돌려도 한 번만 올라간다).
// 필요한 권한: mall.write_community. 토큰은 scripts/cafe24-auth.ts로 받는다.
import { readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.ts";

interface SeedItem {
  demo_no?: number;
  key?: string;
  writer: string;
  title: string;
  content: string;
  product_no: number | null;
  rating?: number;
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyIdx = args.indexOf("--only");
const only = onlyIdx >= 0 ? new Set(args[onlyIdx + 1].split(",")) : null;

const seed = JSON.parse(readFileSync(path.join(ROOT, "data/seed/bh044.json"), "utf8")) as {
  qna_board_no: number;
  review_board_no: number;
  qna: SeedItem[];
  reviews: SeedItem[];
};
const mallId = process.env.CAFE24_MALL_ID;
if (mallId !== "bh044") {
  console.error(`테스트 쇼핑몰(bh044)에만 올립니다. 지금 CAFE24_MALL_ID: ${mallId ?? "(없음)"}`);
  process.exit(1);
}
const tokenFile = path.resolve(ROOT, process.env.CAFE24_TOKEN_FILE ?? "data/cafe24-token.json");
const token = JSON.parse(readFileSync(tokenFile, "utf8")) as { access_token: string };
const base = `https://${mallId}.cafe24api.com/api/v2/admin`;
const headers = {
  Authorization: `Bearer ${token.access_token}`,
  "Content-Type": "application/json",
  "X-Cafe24-Api-Version": "2026-09-01",
};

async function existing(boardNo: number): Promise<Set<string>> {
  const response = await fetch(`${base}/boards/${boardNo}/articles?limit=100`, { headers });
  const body = (await response.json()) as { articles?: { title: string; writer: string }[] };
  if (!response.ok) throw new Error(`게시판 ${boardNo} 조회 실패 ${response.status}: ${JSON.stringify(body)}`);
  return new Set((body.articles ?? []).map((a) => `${a.writer}\t${a.title}`));
}

async function post(boardNo: number, item: SeedItem): Promise<number> {
  const request: Record<string, unknown> = {
    writer: item.writer,
    title: item.title,
    content: item.content,
    client_ip: process.env.CAFE24_CLIENT_IP ?? "127.0.0.1",
  };
  if (item.product_no) request.product_no = item.product_no;
  if (item.rating) request.rating = item.rating;
  const response = await fetch(`${base}/boards/${boardNo}/articles`, {
    method: "POST",
    headers,
    body: JSON.stringify({ shop_no: 1, requests: [request] }),
  });
  const body = (await response.json()) as { articles?: { article_no: number }[] };
  if (!response.ok || !body.articles?.[0]) throw new Error(`올리기 실패 ${response.status}: ${JSON.stringify(body)}`);
  return body.articles[0].article_no;
}

const groups: [number, SeedItem[], (i: SeedItem) => string][] = [
  [seed.qna_board_no, seed.qna, (i) => String(i.demo_no)],
  [seed.review_board_no, seed.reviews, (i) => String(i.key)],
];
for (const [boardNo, items, idOf] of groups) {
  const have = await existing(boardNo);
  for (const item of items) {
    const id = idOf(item);
    if (only && !only.has(id)) continue;
    if (have.has(`${item.writer}\t${item.title}`)) {
      console.log(`건너뜀 ${id} (이미 있음)`);
      continue;
    }
    if (dryRun) {
      console.log(`올릴 것 ${id} → 게시판 ${boardNo} · 상품 ${item.product_no ?? "-"} · ${item.title}`);
      continue;
    }
    const articleNo = await post(boardNo, item);
    console.log(`올림 ${id} → 게시판 ${boardNo} 글 ${articleNo} · ${item.title}`);
  }
}
