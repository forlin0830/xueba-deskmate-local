import mammoth from "mammoth";
import { getDocumentProxy } from "unpdf";

export type DocumentPage = { number: number; text: string; method: "text" | "ocr" };
export type ExtractedDocument = {
  pages: DocumentPage[];
  totalPages: number;
  unit: "page" | "segment";
  sha256: string;
  needsOcr: number[];
};

const MAX_DOCUMENT_CHARACTERS = 500_000;
const SEGMENT_CHARACTERS = 12_000;

function cleanText(value: string): string {
  return value.replaceAll("\u0000", "").trim();
}

function splitText(text: string): DocumentPage[] {
  const pages: DocumentPage[] = [];
  for (let offset = 0; offset < text.length; offset += SEGMENT_CHARACTERS) {
    pages.push({ number: pages.length + 1, text: text.slice(offset, offset + SEGMENT_CHARACTERS), method: "text" });
  }
  return pages;
}

export async function extractMaterialPages(file: File): Promise<ExtractedDocument> {
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  let pages: DocumentPage[];
  let unit: ExtractedDocument["unit"] = "segment";

  if (extension === "txt" || extension === "md") {
    pages = splitText(cleanText(new TextDecoder().decode(bytes)));
  } else if (extension === "docx") {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    pages = splitText(cleanText(result.value));
  } else if (extension === "pdf") {
    unit = "page";
    const pdf = await getDocumentProxy(bytes);
    pages = [];
    try {
      for (let number = 1; number <= pdf.numPages; number += 1) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        const text = cleanText(content.items.flatMap((item) => "str" in item && typeof item.str === "string"
          ? [item.str + ("hasEOL" in item && item.hasEOL ? "\n" : " ")] : []).join(""));
        pages.push({ number, text, method: "text" });
        page.cleanup();
      }
    } finally {
      pdf.cleanup();
    }
  } else {
    throw new Error("目前支持 PDF、DOCX、TXT 和 Markdown 文件；旧版 DOC 请先另存为 DOCX 或 PDF。");
  }

  if (!pages.length) throw new Error("文件中没有可读取的正文。");
  if (pages.reduce((sum, page) => sum + page.text.length, 0) > MAX_DOCUMENT_CHARACTERS) {
    throw new Error("文件正文超过 50 万字，当前无法完整分析；请按章节拆分。网站没有只读取前半部分。");
  }
  const needsOcr = unit === "page" ? pages.filter((page) => page.text.replace(/\s/g, "").length < 10).map((page) => page.number) : [];
  if (unit === "segment" && !pages.some((page) => page.text.replace(/\s/g, "").length >= 10)) {
    throw new Error("文件中没有足够文字可供分析。");
  }
  return { pages, totalPages: pages.length, unit, sha256, needsOcr };
}

// Older callers use this while moving to the page-aware reader. It never
// silently returns only the beginning of a document.
export async function extractMaterialText(file: File): Promise<{ text: string; note: string }> {
  const document = await extractMaterialPages(file);
  if (document.needsOcr.length) throw new Error(`PDF 第 ${document.needsOcr.join("、")} 页需要 OCR，不能标记整份文件已读取。`);
  return { text: document.pages.map((page) => page.text).join("\n"), note: "" };
}
