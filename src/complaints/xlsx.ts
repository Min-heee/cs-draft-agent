import { crc32 } from "node:zlib";

// 엑셀(.xlsx) 파일을 패키지 없이 만든다. xlsx는 XML 몇 개를 zip으로 묶은 것이라, 압축 없이(stored) 묶어도 엑셀이 연다.
// 글자 칸은 inlineStr로 넣는다. 수식(<f>)을 쓰지 않으므로 "=…"로 시작하는 고객 글도 수식으로 실행되지 않는다.

/** 글자, 숫자, 빈칸, 비율(0~1, % 형식), 날짜·시각(엑셀 날짜로 넣어 필터·정렬이 된다) */
export type Cell = string | number | null | { percent: number } | { date: Date };

export interface Sheet {
  /** 시트 이름(31자 안, []:*?/\ 는 쓸 수 없어 바꾼다) */
  name: string;
  /** 첫 줄은 제목 줄(굵게, 고정, 필터) */
  rows: Cell[][];
  /** 열 너비(글자 수 기준) */
  widths?: number[];
}

// XML 1.0에 넣을 수 없는 제어 문자는 뺀다(탭·줄바꿈은 둔다).
const INVALID_XML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g;

function xml(text: string): string {
  return text
    .replace(INVALID_XML, "")
    // 엑셀은 _x0041_ 같은 꼴을 글자 코드로 풀어 보여 준다. 고객 글에 그런 글자가 있어도 그대로 보이게 _를 _x005F_로 바꾼다.
    .replace(/_(?=x[0-9A-Fa-f]{4}_)/g, "_x005F_")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function columnName(index: number): string {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function sheetName(name: string, used: Set<string>): string {
  let base = name.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31);
  // 31자에서 자를 때 이모지(서로게이트 쌍)가 반으로 잘리지 않게
  if (/[\uD800-\uDBFF]$/.test(base)) base = base.slice(0, -1);
  base ||= "Sheet";
  let candidate = base;
  for (let i = 2; used.has(candidate.toLowerCase()); i++) candidate = `${base.slice(0, 28)} ${i}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

// 스타일: 0 기본, 1 제목 줄(굵게), 2 비율(0%), 3 줄바꿈 글자, 4 글자로 고정(quotePrefix), 5 글자로 고정 + 줄바꿈, 6 날짜·시각
// 4·5: =, +, -, @로 시작하는 글을 셀에서 고쳐 Enter를 눌러도 수식으로 바뀌지 않게 한다.
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" quotePrefix="1"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" quotePrefix="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

/** 엑셀 날짜 일련번호(1900 날짜 체계). 한국 시각으로 보이게 9시간을 더한다. */
function excelDate(date: Date): number {
  return (date.getTime() + 9 * 3_600_000) / 86_400_000 + 25569;
}

function cellXml(value: Cell, ref: string, header: boolean): string {
  if (value === null || value === "") return "";
  if (typeof value === "number") return Number.isFinite(value) ? `<c r="${ref}"${header ? ' s="1"' : ""}><v>${value}</v></c>` : "";
  if (typeof value === "object") {
    if ("date" in value) return Number.isNaN(value.date.getTime()) ? "" : `<c r="${ref}" s="6"><v>${excelDate(value.date)}</v></c>`;
    return Number.isFinite(value.percent) ? `<c r="${ref}" s="2"><v>${value.percent}</v></c>` : "";
  }
  const multiline = value.includes("\n");
  const formulaLike = /^[=+\-@\t\r]/.test(value);
  const style = header ? ' s="1"' : formulaLike ? (multiline ? ' s="5"' : ' s="4"') : multiline ? ' s="3"' : "";
  return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

function worksheet(sheet: Sheet): string {
  const width = Math.max(1, ...sheet.rows.map((r) => r.length));
  const last = `${columnName(width - 1)}${Math.max(1, sheet.rows.length)}`;
  const cols = sheet.widths?.length
    ? `<cols>${sheet.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const rows = sheet.rows
    .map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cellXml(v, `${columnName(c)}${r + 1}`, r === 0)).join("")}</row>`)
    .join("");
  const frozen =
    sheet.rows.length > 1
      ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`
      : `<sheetViews><sheetView workbookViewId="0"/></sheetViews>`;
  const filter = sheet.rows.length > 1 ? `<autoFilter ref="A1:${last}"/>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${last}"/>${frozen}${cols}<sheetData>${rows}</sheetData>${filter}</worksheet>`;
}

/** 압축하지 않은 zip(stored). 엑셀·넘버스·구글시트 모두 읽는다. */
function zip(files: [string, string][]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  // 1980-01-01 00:00 (DOS 날짜). 날짜는 의미 없고 같은 입력이면 같은 파일이 나오게 고정한다.
  const time = 0;
  const date = (0 << 9) | (1 << 5) | 1;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // 풀 때 필요한 버전
    local.writeUInt16LE(0x0800, 6); // 이름이 UTF-8
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export function buildXlsx(sheets: Sheet[]): Buffer {
  const used = new Set<string>();
  const named = sheets.map((s) => ({ ...s, name: sheetName(s.name, used) }));
  const files: [string, string][] = [
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${named.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("\n")}
</Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    ],
    [
      "xl/workbook.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${named.map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>
${named.some((s) => s.rows.length > 1) ? `<definedNames>${named.map((s, i) => (s.rows.length > 1 ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${xml(s.name).replace(/'/g, "''")}'!$A$1:$${columnName(Math.max(1, ...s.rows.map((r) => r.length)) - 1)}$${s.rows.length}</definedName>` : "")).join("")}</definedNames>` : ""}
</workbook>`,
    ],
    [
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${named.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("\n")}
<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    ],
    ["xl/styles.xml", STYLES],
    ...named.map((s, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, worksheet(s)]),
  ];
  return zip(files);
}
