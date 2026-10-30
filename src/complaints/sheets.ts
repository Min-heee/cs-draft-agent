import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Cell, Sheet } from "./xlsx.ts";

// 불만 사유 리포트를 구글시트에 쓴다. 패키지 없이 서비스 계정 키(JSON)로 로그인한다(JWT → 액세스 토큰).
// - 쓰는 곳: 대표님이 서비스 계정 메일에 편집자로 공유한 시트 하나(GOOGLE_SHEET_ID)
// - 쓰는 탭: 엑셀과 같은 다섯 탭에 "불만 "을 붙인 이름(불만 요약 …). 없으면 만든다.
//   같은 이름의 탭이 이미 있는데 첫 줄이 우리 제목 줄이 아니면(사람이 만든 탭) 아무것도 쓰지 않고 멈춘다.
// - 먼저 쓰고, 그다음 새 내용보다 아래에 남은 옛 줄만 지운다. 쓰다 실패해도 어제 값은 남는다.
// - 값은 RAW로 넣는다. "=…"로 시작하는 고객 글도 수식으로 읽지 않는다. 비율·날짜는 숫자로 넣고 서식을 입힌다.
// - 키 파일 내용은 로그·오류·알림에 절대 넣지 않는다.

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://sheets.googleapis.com/v4/spreadsheets";
/** 시트 쪽 탭 이름 앞에 붙인다. 이미 쓰던 시트의 '요약'·'정보' 같은 탭과 겹치지 않게. */
export const TAB_PREFIX = "불만 ";

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export class GoogleSheetsError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");

/** 서비스 계정 로그인용 JWT(RS256). 1시간 유효. */
export function signJwt(key: ServiceAccountKey, now: Date = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: key.token_uri ?? TOKEN_URL, iat, exp: iat + 3600 }));
  const signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(key.private_key);
  return `${header}.${claims}.${b64url(signature)}`;
}

/** 키 파일을 읽는다. 형식이 틀려도 오류 문구에 파일 내용(비밀 키 조각)이 들어가지 않게 한다. */
export function readServiceAccountKey(file: string): ServiceAccountKey {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new GoogleSheetsError(0, `구글 서비스 계정 키 파일을 열지 못했습니다: ${file}`);
  }
  let key: Partial<ServiceAccountKey>;
  try {
    key = JSON.parse(text) as Partial<ServiceAccountKey>;
  } catch {
    throw new GoogleSheetsError(0, "구글 서비스 계정 키 파일이 JSON 형식이 아닙니다. 콘솔에서 받은 JSON 키 파일인지 확인해 주세요.");
  }
  if (!key.client_email || !key.private_key) {
    throw new GoogleSheetsError(0, "구글 서비스 계정 키 파일에 client_email·private_key가 없습니다. 서비스 계정의 JSON 키인지 확인해 주세요.");
  }
  return { client_email: key.client_email, private_key: key.private_key, token_uri: key.token_uri };
}

/** 시트에 넣을 값. 비율은 0~1 숫자, 날짜는 한국 시각 날짜 일련번호(서식은 따로 입힌다). 글자는 반쪽 이모지 없이. */
export function sheetValue(cell: Cell): string | number {
  if (cell === null) return "";
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : "";
  if (typeof cell === "string") return cell.toWellFormed();
  if ("percent" in cell) return Number.isFinite(cell.percent) ? cell.percent : "";
  const t = cell.date.getTime();
  return Number.isNaN(t) ? "" : (t + 9 * 3_600_000) / 86_400_000 + 25569;
}

/** A1 표기의 탭 이름. 작은따옴표로 감싸고 안의 '는 두 번 쓴다. */
const tabRange = (title: string) => `'${title.replace(/'/g, "''")}'`;

/** 열마다 서식: 둘째 줄부터 그 열의 값이 비율이면 %, 날짜면 날짜·시각 */
function columnFormats(sheet: Sheet): { column: number; type: "PERCENT" | "DATE_TIME" }[] {
  const formats = new Map<number, "PERCENT" | "DATE_TIME">();
  for (const row of sheet.rows.slice(1)) {
    row.forEach((cell, column) => {
      if (cell && typeof cell === "object") formats.set(column, "percent" in cell ? "PERCENT" : "DATE_TIME");
    });
  }
  return [...formats].map(([column, type]) => ({ column, type }));
}

export interface GoogleSheetsOptions {
  keyFile: string;
  spreadsheetId: string;
  /** 설정에서 이미 알아챈 문제(예: '웹에 게시' 링크를 넣음). 있으면 쓰기 전에 이 문구로 멈춘다. */
  problem?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** 다시 시도하기 전 기다리는 시간(시험에서 0) */
  retryDelayMs?: number;
}

interface SheetInfo {
  properties: { sheetId: number; title: string };
}

export class GoogleSheetsWriter {
  private readonly options: GoogleSheetsOptions;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(options: GoogleSheetsOptions) {
    this.options = options;
  }

  get url(): string {
    return `https://docs.google.com/spreadsheets/d/${this.options.spreadsheetId}/edit`;
  }

  private get fetch(): typeof fetch {
    return this.options.fetch ?? fetch;
  }

  private async accessToken(): Promise<string> {
    const now = this.options.now?.() ?? new Date();
    if (this.token && this.token.expiresAt - 60_000 > now.getTime()) return this.token.value;
    const key = readServiceAccountKey(this.options.keyFile);
    const response = await this.fetch(key.token_uri ?? TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signJwt(key, now) }),
    });
    const body = (await response.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!response.ok || !body.access_token) {
      throw new GoogleSheetsError(response.status, `구글 로그인에 실패했습니다(${response.status}): ${body.error_description ?? "키가 맞는지, 서비스 계정이 지워지지 않았는지 확인해 주세요."}`);
    }
    this.token = { value: body.access_token, expiresAt: now.getTime() + (body.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  /** 429·5xx는 잠깐 쉬고 두 번까지 다시 시도한다. */
  private async call<T>(method: "GET" | "POST", url: string, body?: unknown, attempt = 0): Promise<T> {
    const response = await this.fetch(url, {
      method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, (this.options.retryDelayMs ?? 1000) * 2 ** attempt));
      return this.call<T>(method, url, body, attempt + 1);
    }
    if (!response.ok) {
      const detail = ((await response.json().catch(() => null)) as { error?: { message?: string } } | null)?.error?.message ?? response.statusText;
      const hint =
        response.status === 403
          ? " 시트를 서비스 계정 메일에 '편집자'로 공유했는지, 프로젝트에서 Google Sheets API를 켰는지 확인해 주세요."
          : response.status === 404
            ? " GOOGLE_SHEET_ID가 시트 주소의 /d/와 /edit 사이 값인지 확인해 주세요."
            : /not supported for this document/i.test(detail)
              ? " 엑셀(.xlsx) 파일을 연 것 같습니다. '파일 → Google Sheets로 저장' 뒤 새 시트 주소를 넣어 주세요."
              : /protected/i.test(detail)
                ? " 보호된 탭입니다. 보호를 풀거나 서비스 계정 메일을 편집 허용 목록에 넣어 주세요."
                : "";
      throw new GoogleSheetsError(response.status, `구글시트 ${response.status}: ${detail}.${hint}`);
    }
    return (await response.json()) as T;
  }

  async writeSheets(sheets: Sheet[]): Promise<{ url: string; tabs: string[] }> {
    if (this.options.problem) throw new GoogleSheetsError(0, this.options.problem);
    const id = encodeURIComponent(this.options.spreadsheetId);
    const tabs = sheets.map((s) => ({ ...s, title: `${TAB_PREFIX}${s.name}` }));

    const meta = await this.call<{ sheets?: SheetInfo[] }>("GET", `${API}/${id}?fields=sheets.properties(sheetId,title)`);
    const sheetIds = new Map((meta.sheets ?? []).map((s) => [s.properties.title, s.properties.sheetId]));

    // 같은 이름의 탭이 있으면 첫 줄이 우리 제목 줄(또는 빈 탭)인지 본다. 아니면 사람이 만든 탭이라 쓰지 않는다.
    const existing = tabs.filter((t) => sheetIds.has(t.title));
    if (existing.length) {
      const got = await this.call<{ valueRanges?: { values?: unknown[][] }[] }>(
        "GET",
        `${API}/${id}/values:batchGet?${existing.map((t) => `ranges=${encodeURIComponent(`${tabRange(t.title)}!1:1`)}`).join("&")}`,
      );
      const foreign = existing.filter((t, i) => {
        const first = (got.valueRanges?.[i]?.values?.[0] ?? []).map(String);
        const ours = (t.rows[0] ?? []).map((c) => String(sheetValue(c)));
        return first.length > 0 && first.join("\u0001") !== ours.join("\u0001");
      });
      if (foreign.length) {
        throw new GoogleSheetsError(
          0,
          `시트에 같은 이름의 탭(${foreign.map((t) => t.title).join(", ")})이 이미 있는데 우리 리포트가 아니라서 쓰지 않았습니다. 그 탭 이름을 바꾸거나 빈 시트를 써 주세요.`,
        );
      }
    }

    const missing = tabs.filter((t) => !sheetIds.has(t.title));
    if (missing.length) {
      const added = await this.call<{ replies?: { addSheet?: SheetInfo }[] }>("POST", `${API}/${id}:batchUpdate`, {
        requests: missing.map((t) => ({ addSheet: { properties: { title: t.title, gridProperties: { frozenRowCount: 1 } } } })),
      });
      for (const reply of added.replies ?? []) {
        if (reply.addSheet) sheetIds.set(reply.addSheet.properties.title, reply.addSheet.properties.sheetId);
      }
    }

    // 먼저 쓴다. 실패해도 어제 값은 그대로 남는다.
    await this.call("POST", `${API}/${id}/values:batchUpdate`, {
      valueInputOption: "RAW",
      data: tabs.map((t) => ({ range: `${tabRange(t.title)}!A1`, values: t.rows.map((row) => row.map(sheetValue)) })),
    });
    // 그다음 새 내용보다 아래에 남은 옛 줄만 지운다.
    await this.call("POST", `${API}/${id}/values:batchClear`, {
      ranges: tabs.map((t) => `${tabRange(t.title)}!A${t.rows.length + 1}:ZZ`),
    });
    // 비율·날짜 열에 서식(실패해도 값은 이미 들어갔으니 오류로 올린다)
    const formats = tabs.flatMap((t) => {
      const sheetId = sheetIds.get(t.title);
      if (sheetId === undefined) return [];
      return columnFormats(t).map(({ column, type }) => ({
        repeatCell: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: column, endColumnIndex: column + 1 },
          cell: { userEnteredFormat: { numberFormat: type === "PERCENT" ? { type, pattern: "0%" } : { type, pattern: "yyyy-mm-dd hh:mm" } } },
          fields: "userEnteredFormat.numberFormat",
        },
      }));
    });
    if (formats.length) await this.call("POST", `${API}/${id}:batchUpdate`, { requests: formats });
    return { url: this.url, tabs: tabs.map((t) => t.title) };
  }
}
