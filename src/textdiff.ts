/** 글자 단위 편집 거리(레벤슈타인). 답변 길이(수백 자)에서는 단순한 DP로 충분하다. */
export function editDistance(a: string, b: string): number {
  const s = [...a];
  const t = [...b];
  let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[t.length];
}

const normalize = (text: string) => text.replace(/\r\n/g, "\n").trim();

/** 초안 대비 얼마나 고쳤는지 (0 = 그대로, 1 = 전부 다시 씀). 줄바꿈 형식 차이는 무시한다. */
export function editRatio(draft: string, final: string): number {
  const a = normalize(draft);
  const b = normalize(final);
  if (a === b) return 0;
  return Math.min(1, editDistance(a, b) / Math.max(1, [...a].length));
}
