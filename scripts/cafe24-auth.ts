// 카페24 앱을 쇼핑몰에 설치하고(OAuth) 토큰을 받는 도우미. 시크릿과 토큰은 화면에 찍지 않는다.
//
//   node --env-file-if-exists=.env scripts/cafe24-auth.ts url            설치(권한 동의) 주소 만들기
//   node --env-file-if-exists=.env scripts/cafe24-auth.ts token <code>   돌아온 주소의 code로 토큰 받아 저장
//   node --env-file-if-exists=.env scripts/cafe24-auth.ts boards         토큰으로 게시판 목록 확인
//
// 필요한 .env: CAFE24_MALL_ID, CAFE24_CLIENT_ID, CAFE24_CLIENT_SECRET, CAFE24_REDIRECT_URI
// 인증 코드는 금방 만료되므로 돌아온 즉시 token을 실행한다.
import { randomBytes } from "node:crypto";
import { writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../src/config.ts";

const SCOPES = ["mall.read_community", "mall.write_community", "mall.read_order", "mall.read_product"];

function need(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`.env에 ${name}가 없습니다.`);
    process.exit(1);
  }
  return value;
}

const [command, arg] = process.argv.slice(2);
const mallId = need("CAFE24_MALL_ID");
const tokenFile = path.resolve(ROOT, process.env.CAFE24_TOKEN_FILE ?? "data/cafe24-token.json");
const base = `https://${mallId}.cafe24api.com/api/v2`;

if (command === "url") {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: need("CAFE24_CLIENT_ID"),
    state: randomBytes(8).toString("hex"),
    redirect_uri: need("CAFE24_REDIRECT_URI"),
    scope: SCOPES.join(","),
  });
  console.log(`${base}/oauth/authorize?${query}`);
} else if (command === "token") {
  if (!arg) {
    console.error("사용법: scripts/cafe24-auth.ts token <돌아온 주소의 code 값>");
    process.exit(1);
  }
  const basic = Buffer.from(`${need("CAFE24_CLIENT_ID")}:${need("CAFE24_CLIENT_SECRET")}`).toString("base64");
  const response = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: arg, redirect_uri: need("CAFE24_REDIRECT_URI") }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== "string") {
    // 오류 응답에는 토큰이 없으므로 그대로 보여 준다.
    console.error(`토큰 발급 실패 (${response.status}):`, JSON.stringify(body));
    process.exit(1);
  }
  const saved = {
    access_token: body.access_token,
    expires_at: body.expires_at,
    refresh_token: body.refresh_token,
    refresh_token_expires_at: body.refresh_token_expires_at,
    mall_id: body.mall_id,
    scopes: body.scopes,
  };
  writeFileSync(tokenFile, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
  console.log(`토큰을 저장했습니다: ${path.relative(ROOT, tokenFile)}`);
  console.log(`쇼핑몰 ${String(saved.mall_id)} · 권한 ${JSON.stringify(saved.scopes)}`);
  console.log(`액세스 토큰 만료 ${String(saved.expires_at)} · 리프레시 토큰 만료 ${String(saved.refresh_token_expires_at)}`);
} else if (command === "boards") {
  const token = JSON.parse(readFileSync(tokenFile, "utf8")) as { access_token: string };
  const response = await fetch(`${base}/admin/boards`, {
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json", "X-Cafe24-Api-Version": "2026-09-01" },
  });
  const body = (await response.json()) as { boards?: { board_no: number; board_name: string; board_type: number }[] };
  if (!response.ok || !body.boards) {
    console.error(`게시판 조회 실패 (${response.status}):`, JSON.stringify(body));
    process.exit(1);
  }
  for (const b of body.boards) console.log(`${b.board_no}\t${b.board_type}\t${b.board_name}`);
} else {
  console.error("명령: url | token <code> | boards");
  process.exit(1);
}
