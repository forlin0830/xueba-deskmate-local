import type { QuestionSource } from "./learning-store";

export type PastExamReference = { id: string; title: string; excerpt: string };

export function verifiedExamReference(id: string, quote: string, references: PastExamReference[]): QuestionSource {
  const reference = references.find((item) => item.id === id);
  const normalizedQuote = quote.replace(/\s/g, "");
  if (!reference || normalizedQuote.length < 12 || !reference.excerpt.replace(/\s/g, "").includes(normalizedQuote)) {
    return { kind: "original" };
  }
  return { kind: "adapted", pastExamId: reference.id, pastExamTitle: reference.title };
}
