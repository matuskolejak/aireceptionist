/**
 * What the server will throw away from the "Exact answers" field.
 *
 * The server keeps only Q:/A: pairs and drops every other line without a word:
 * parseVerifiedLines in the web repo (lib/knowledge/sources.ts). It also keeps
 * only the first 25 pairs and cuts questions past 200 and answers past 600
 * characters: readVerified, same file. This mirrors both, so the two must change
 * together. The notes sheet in app/knowledge.tsx uses it to name the problem and
 * keep Save off.
 *
 * No imports, so a plain Node script can check it.
 */

// Mirror readVerified in the web repo (lib/knowledge/sources.ts); change together.
const MAX_ANSWERS = 25;
const MAX_QUESTION_CHARS = 200;
const MAX_ANSWER_CHARS = 600;

function scan(text: string): { dropped: string[]; pairs: { q: string; a: string }[] } {
  const dropped: string[] = [];
  const pairs: { q: string; a: string }[] = [];
  // The question line still waiting for its answer, and its text without the prefix.
  let question: { line: string; body: string } | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const isAnswer = /^a\s*:/i.test(line);
    const body = line.replace(/^[qa]\s*:/i, '').trim();
    if (isAnswer) {
      // A pair is kept only when both halves have text.
      if (!question || !question.body || !body) {
        if (question) dropped.push(question.line);
        dropped.push(line);
      } else {
        pairs.push({ q: question.body, a: body });
      }
      question = null;
    } else {
      // A new question replaces one that got no answer.
      if (question) dropped.push(question.line);
      question = { line, body };
    }
  }
  if (question) dropped.push(question.line);
  return { dropped, pairs };
}

export function droppedAnswerLines(text: string): string[] {
  return scan(text).dropped;
}

/**
 * Why the server would cut or drop kept Q:/A: pairs, or null. readVerified in the
 * web repo keeps the first 25 pairs and cuts longer halves, again without a word.
 */
export function answerLimitProblem(text: string): string | null {
  const { pairs } = scan(text);
  if (pairs.length > MAX_ANSWERS) {
    const extra = pairs.length - MAX_ANSWERS;
    return `Only ${MAX_ANSWERS} answers are kept. Remove ${extra}.`;
  }
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i].q.length > MAX_QUESTION_CHARS)
      return `Question ${i + 1} is too long: keep it to ${MAX_QUESTION_CHARS} characters or fewer.`;
    if (pairs[i].a.length > MAX_ANSWER_CHARS)
      return `Answer ${i + 1} is too long: keep it to ${MAX_ANSWER_CHARS} characters or fewer.`;
  }
  return null;
}
