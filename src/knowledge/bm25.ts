// 한국어 정책 문서용 BM25 검색.
// 형태소 분석기 없이 글자 2-gram을 쓴다. "교환은", "교환하고"처럼 조사·어미가 붙어도
// "교환"이라는 2-gram이 공통으로 남아서 문서 수십 개 규모에서는 충분히 잘 맞는다.

export interface Doc {
  id: string;
  text: string;
}

export interface Hit {
  id: string;
  score: number;
}

const K1 = 1.2;
const B = 0.75;

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  for (const word of words) {
    if (/^[\p{N}a-z]+$/u.test(word)) {
      tokens.push(word);
      continue;
    }
    if (word.length === 1) {
      tokens.push(word);
      continue;
    }
    for (let i = 0; i < word.length - 1; i++) tokens.push(word.slice(i, i + 2));
  }
  return tokens;
}

export class Bm25Index {
  private readonly docs: { id: string; tf: Map<string, number>; length: number }[];
  private readonly df = new Map<string, number>();
  private readonly avgLength: number;

  constructor(docs: Doc[]) {
    this.docs = docs.map((doc) => {
      const tokens = tokenize(doc.text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return { id: doc.id, tf, length: tokens.length };
    });
    const total = this.docs.reduce((sum, d) => sum + d.length, 0);
    this.avgLength = this.docs.length ? total / this.docs.length : 0;
  }

  search(query: string, limit = 3): Hit[] {
    const terms = [...new Set(tokenize(query))];
    const n = this.docs.length;
    const hits: Hit[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of terms) {
        const freq = doc.tf.get(term);
        if (!freq) continue;
        const df = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += (idf * freq * (K1 + 1)) / (freq + K1 * (1 - B + (B * doc.length) / this.avgLength));
      }
      if (score > 0) hits.push({ id: doc.id, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
