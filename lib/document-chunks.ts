export type StoredDocumentPage = { number: number; text: string; method: "text" | "ocr" };
export type DocumentChunk = { pages: number[]; text: string };

export function chunkDocument(pages: StoredDocumentPage[], maxCharacters = 12_000): DocumentChunk[] {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 100) throw new Error("无效的分段长度");
  const chunks: DocumentChunk[] = [];
  let current = "";
  let numbers: number[] = [];
  const flush = () => {
    if (current) chunks.push({ pages: numbers, text: current });
    current = "";
    numbers = [];
  };
  for (const page of pages) {
    let offset = 0;
    while (offset < page.text.length) {
      const room = maxCharacters - current.length;
      if (!room) { flush(); continue; }
      const part = page.text.slice(offset, offset + room);
      current += part;
      if (!numbers.includes(page.number)) numbers.push(page.number);
      offset += part.length;
      if (current.length === maxCharacters) flush();
    }
  }
  flush();
  return chunks;
}

export function representativeExcerpt(pages: StoredDocumentPage[], maxCharacters = 16_000): string {
  if (!pages.length) return "";
  const sampleCount = Math.min(pages.length, Math.max(1, Math.floor(maxCharacters / 110)));
  const sampled = Array.from({ length: sampleCount }, (_, index) =>
    pages[Math.round(index * (pages.length - 1) / Math.max(1, sampleCount - 1))]);
  const quota = Math.max(1, Math.floor(maxCharacters / sampleCount) - 24);
  const parts = sampled.map((page) => `【第 ${page.number} ${page.method === "ocr" ? "OCR" : "页"}】\n${page.text.slice(0, quota)}`);
  return parts.join("\n").slice(0, maxCharacters);
}
