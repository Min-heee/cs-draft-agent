import type { LlmBatchResult, LlmResult } from "./llm.ts";
import { classifyByRules, hasInjection } from "./rules.ts";
import { isSizeCode, reasonKey, type Reason } from "./taxonomy.ts";
import type { Classification, ComplaintPost } from "./types.ts";

// LLM + 코드 검사. 낱말 규칙은 LLM에 넘기지 않고 보조로만 쓴다(글 속 지시 찾기, LLM 실패 시 대신 채우기, '규칙만' 비교 기준).
// LLM이 사유를 고르고, 코드가 그 결과를 확인한다:
//   - 사유가 목록 안인지(스키마), 사이즈 사유에 부위가 있는지
//   - 근거 구절이 원문에 정말 있는지
//   - 확신도가 낮은지, 별점은 낮은데 사유가 없는지, 글 안에 지시가 있는지
// 걸리면 '확인 필요'로 둔다. 순위에는 세지만 대표 인용에서는 뺀다.

export interface BatchClassifier {
  classifyBatch(posts: ComplaintPost[]): Promise<LlmBatchResult>;
}

export interface ClassifyOptions {
  /** 없으면 규칙만으로 분류한다. */
  llm?: BatchClassifier;
  /** LLM에 한 번에 보낼 글 수 */
  batchSize?: number;
  /** 배치를 동시에 몇 개까지 보낼지 */
  concurrency?: number;
  /** 배치 하나가 끝날 때마다 부른다(진행 표시) */
  onProgress?: (done: number, total: number) => void;
}

/** 따옴표·공백·문장부호 차이(그리고 혹시 남은 HTML 태그·&nbsp;)는 무시하고 원문에 있는지 본다. */
function normalize(text: string): string {
  return text
    .replace(/<[^>]+>|&nbsp;/g, "")
    .replace(/[\s"'“”‘’.,!?~…·()[\]]/g, "")
    .toLowerCase();
}

export function evidenceFound(evidence: string, post: Pick<ComplaintPost, "title" | "content">): boolean {
  const e = normalize(evidence);
  return e.length > 0 && normalize(`${post.title}${post.content}`).includes(e);
}

export function checkLlmResult(post: ComplaintPost, r: LlmResult, usage: Omit<LlmBatchResult, "results">, share: number): Classification {
  const check_reasons: string[] = [];
  const seen = new Set<string>();
  const reasons: Reason[] = [];
  for (const raw of r.reasons) {
    const reason: Reason = {
      code: raw.code,
      part: isSizeCode(raw.code) ? (raw.part ?? "unknown") : null,
      evidence: raw.evidence.trim(),
    };
    const key = reasonKey(reason);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!evidenceFound(reason.evidence, post)) check_reasons.push(`근거 구절이 원문에 없음: ${key}`);
    reasons.push(reason);
  }
  const injection = r.injection || hasInjection(post);
  if (injection) check_reasons.push("글 안에 분류를 바꾸라는 지시가 있음");
  if (r.confidence === "low") check_reasons.push("확신도 낮음");
  if (!reasons.length && post.rating !== null && post.rating <= 2) check_reasons.push(`별점 ${post.rating}인데 불만 사유가 없음`);
  return {
    reasons,
    confidence: r.confidence,
    needs_check: check_reasons.length > 0,
    check_reasons,
    injection,
    classifier: "rules+llm",
    fallback: false,
    model: usage.model,
    // 배치 하나의 사용량을 글 수로 나눠 글마다 적는다(합계는 같다).
    input_tokens: Math.round(usage.input_tokens * share),
    output_tokens: Math.round(usage.output_tokens * share),
    latency_ms: Math.round(usage.latency_ms * share),
  };
}

/**
 * LLM이 실패했거나 결과를 빠뜨린 글은 규칙 결과로 두고 '확인 필요'를 붙인다.
 * fallback으로 표시해, 저장해도 다음 실행 때 다시 LLM으로 분류한다. 배치 토큰은 이 글에도 같은 몫을 적는다.
 */
function fallback(post: ComplaintPost, why: string, usage?: Omit<LlmBatchResult, "results">, share = 0): Classification {
  const rules = classifyByRules(post);
  return {
    ...rules,
    classifier: "rules+llm",
    fallback: true,
    needs_check: true,
    check_reasons: [...rules.check_reasons, why],
    model: null,
    input_tokens: usage ? Math.round(usage.input_tokens * share) : 0,
    output_tokens: usage ? Math.round(usage.output_tokens * share) : 0,
    latency_ms: usage ? Math.round(usage.latency_ms * share) : 0,
  };
}

export async function classifyPosts(posts: ComplaintPost[], options: ClassifyOptions = {}): Promise<Map<string, Classification>> {
  const out = new Map<string, Classification>();
  if (!options.llm) {
    for (const p of posts) out.set(p.key, classifyByRules(p));
    return out;
  }
  const llm = options.llm;
  const size = Math.max(1, options.batchSize ?? 10);
  // 분류를 바꾸라는 지시가 보이는 글은 따로 한 건씩 보낸다. 같은 묶음의 다른 글 분류에 번지지 않게.
  const suspicious = posts.filter((p) => hasInjection(p));
  const normal = posts.filter((p) => !hasInjection(p));
  const batches: ComplaintPost[][] = suspicious.map((p) => [p]);
  for (let i = 0; i < normal.length; i += size) batches.push(normal.slice(i, i + size));
  let done = 0;
  const runBatch = async (batch: ComplaintPost[]) => {
    try {
      const { results, ...usage } = await llm.classifyBatch(batch);
      const share = 1 / batch.length;
      for (const p of batch) {
        const r = results.get(p.key);
        out.set(p.key, r ? checkLlmResult(p, r, usage, share) : fallback(p, "LLM 결과에 이 글이 없음", usage, share));
      }
      // 규칙이 못 본 지시를 LLM이 찾았으면, 같은 묶음의 다른 글도 영향을 받았을 수 있다.
      // 그 글을 빼고 나머지만 한 번 더 분류한다. 다시 분류하지 못하면 나머지 글에 확인 필요를 붙인다.
      const mates = batch.length > 1 && batch.some((p) => out.get(p.key)?.injection) ? batch.filter((p) => !out.get(p.key)!.injection) : [];
      if (mates.length) {
        try {
          const again = await llm.classifyBatch(mates);
          const { results: redo, ...redoUsage } = again;
          for (const p of mates) {
            const r = redo.get(p.key);
            if (!r) throw new Error("다시 분류한 결과에 글이 빠짐");
            // 처음 묶음의 몫과 다시 분류한 몫을 더해 사용량 합계가 맞게 한다.
            const first = out.get(p.key)!;
            const next = checkLlmResult(p, r, redoUsage, 1 / mates.length);
            out.set(p.key, {
              ...next,
              input_tokens: next.input_tokens + first.input_tokens,
              output_tokens: next.output_tokens + first.output_tokens,
              latency_ms: next.latency_ms + first.latency_ms,
            });
          }
        } catch {
          for (const p of mates) {
            const c = out.get(p.key)!;
            out.set(p.key, { ...c, needs_check: true, check_reasons: [...c.check_reasons, "같은 묶음에 분류를 바꾸라는 지시가 든 글이 있음"] });
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[complaints] 분류 실패(${batch.length}건, 규칙 결과로 둠): ${message}`);
      for (const p of batch) out.set(p.key, fallback(p, `LLM 실패: ${message.slice(0, 120)}`));
    }
    done += batch.length;
    options.onProgress?.(done, posts.length);
  };
  // 배치 몇 개를 동시에 돌린다(기본 1: 매일 아침 작업은 천천히, 평가는 빨리).
  const queue = [...batches];
  const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 1, batches.length)) }, async () => {
    for (let batch = queue.shift(); batch; batch = queue.shift()) await runBatch(batch);
  });
  await Promise.all(workers);
  return out;
}
