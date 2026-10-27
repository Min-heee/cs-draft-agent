import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Bm25Index } from "./bm25.ts";

// 정책 문서를 "## 소제목" 단위로 잘라 검색한다.
// 섹션 ID는 "파일명#소제목" 형식이고, 초안의 근거(sources)로 그대로 남는다.
// 섹션 안의 "검색어: …" 줄은 고객이 실제로 쓰는 말(예: "며칠 걸려요")이다.
// 검색에만 쓰고, 에이전트에게 돌려주는 본문에서는 뺀다.

export interface PolicySection {
  id: string;
  docTitle: string;
  heading: string;
  body: string;
  keywords: string;
}

const KEYWORD_LINE = /^검색어:(.*)$/gm;

export interface PolicySearchResult extends PolicySection {
  score: number;
}

export function loadPolicySections(dir: string): PolicySection[] {
  const sections: PolicySection[] = [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  for (const file of files) {
    const slug = path.basename(file, ".md");
    const text = readFileSync(path.join(dir, file), "utf8");
    const docTitle = text.match(/^# (.+)$/m)?.[1]?.trim() ?? slug;
    for (const part of text.split(/^## /m).slice(1)) {
      const newline = part.indexOf("\n");
      const heading = (newline === -1 ? part : part.slice(0, newline)).trim();
      const rest = newline === -1 ? "" : part.slice(newline + 1);
      const keywords = [...rest.matchAll(KEYWORD_LINE)].map((m) => m[1].trim()).join(", ");
      const body = rest.replace(KEYWORD_LINE, "").trim();
      sections.push({ id: `${slug}#${heading}`, docTitle, heading, body, keywords });
    }
  }
  return sections;
}

export class PolicyStore {
  private readonly sections: Map<string, PolicySection>;
  private readonly index: Bm25Index;

  constructor(sections: PolicySection[]) {
    this.sections = new Map(sections.map((s) => [s.id, s]));
    // 소제목은 본문보다 짧고 핵심어가 몰려 있어서 두 번 넣어 가중치를 준다.
    this.index = new Bm25Index(
      sections.map((s) => ({ id: s.id, text: `${s.docTitle} ${s.heading} ${s.heading} ${s.keywords} ${s.body}` })),
    );
  }

  static fromDir(dir: string): PolicyStore {
    return new PolicyStore(loadPolicySections(dir));
  }

  search(query: string, limit = 3): PolicySearchResult[] {
    return this.index.search(query, limit).map((hit) => ({ ...this.sections.get(hit.id)!, score: hit.score }));
  }

  get(id: string): PolicySection | undefined {
    return this.sections.get(id);
  }
}
