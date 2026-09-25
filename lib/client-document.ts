import type { StoredDocumentPage } from "./document-chunks";

const MAX_CHARACTERS = 500_000;
const MAX_PAGES = 1000;
const SEGMENT_CHARACTERS = 12_000;
const MAX_OCR_IMAGE_CHARACTERS = 7_800_000;

export type ClientDocument = {
  pages: StoredDocumentPage[];
  totalPages: number;
  unit: "page" | "segment";
  sha256: string;
  needsOcr: number[];
  renderOcrPage: (number: number) => Promise<string>;
  close: () => Promise<void>;
};

function segments(text: string): StoredDocumentPage[] {
  const pages: StoredDocumentPage[] = [];
  for (let offset = 0; offset < text.length; offset += SEGMENT_CHARACTERS) {
    pages.push({ number: pages.length + 1, text: text.slice(offset, offset + SEGMENT_CHARACTERS), method: "text" });
  }
  return pages;
}

export async function extractClientDocument(file: File): Promise<ClientDocument> {
  const extension = file.name.split(".").at(-1)?.toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const sha256 = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  let pages: StoredDocumentPage[] = [];
  let unit: ClientDocument["unit"] = "segment";
  let renderOcrPage: ClientDocument["renderOcrPage"] = async () => { throw new Error("仅 PDF 页面需要 OCR。"); };
  let close: ClientDocument["close"] = async () => {};

  if (extension === "txt" || extension === "md") {
    pages = segments(new TextDecoder().decode(bytes).replaceAll("\u0000", "").trim());
  } else if (extension === "docx") {
    const mammoth = (await import("mammoth")).default;
    const result = await mammoth.extractRawText({ arrayBuffer: bytes.buffer as ArrayBuffer });
    pages = segments(result.value.replaceAll("\u0000", "").trim());
  } else if (extension === "pdf") {
    unit = "page";
    const { getDocumentProxy, renderPageAsImage } = await import("unpdf");
    const pdf = await getDocumentProxy(bytes);
    close = async () => { await pdf.cleanup(); await pdf.loadingTask.destroy(); };
    if (pdf.numPages > MAX_PAGES) {
      await close();
      throw new Error(`文件有 ${pdf.numPages} 页，超过当前可完整保存的 ${MAX_PAGES} 页上限；请分卷后重试。`);
    }
    try {
      for (let number = 1; number <= pdf.numPages; number += 1) {
        const page = await pdf.getPage(number);
        const content = await page.getTextContent();
        const text = content.items.flatMap((item) => "str" in item && typeof item.str === "string"
          ? [item.str + ("hasEOL" in item && item.hasEOL ? "\n" : " ")] : []).join("").replaceAll("\u0000", "").trim();
        pages.push({ number, text, method: "text" });
        page.cleanup();
      }
    } catch (error) {
      await close();
      throw error;
    }
    renderOcrPage = async (number) => {
      const image = await renderPageAsImage(pdf, number, { scale: 1.6, toDataURL: true });
      if (!image.startsWith("data:image/png;base64,") || image.length > MAX_OCR_IMAGE_CHARACTERS) {
        throw new Error(`第 ${number} 页的图像过大，未跳过该页；请压缩或分卷后重试。`);
      }
      return image;
    };
  } else {
    throw new Error("目前支持 PDF、DOCX、TXT 和 Markdown 文件；旧版 DOC 请先另存为 DOCX 或 PDF。");
  }

  if (!pages.length) { await close(); throw new Error("文件中没有可读取的正文。"); }
  if (pages.reduce((sum, page) => sum + page.text.length, 0) > MAX_CHARACTERS) {
    await close();
    throw new Error("文件正文超过 50 万字，当前无法完整分析；请按章节拆分。网站不会只读取前半部分。");
  }
  const needsOcr = unit === "page" ? pages.filter((page) => page.text.replace(/\s/g, "").length < 10).map((page) => page.number) : [];
  if (unit === "segment" && !pages.some((page) => page.text.replace(/\s/g, "").length >= 10)) {
    await close();
    throw new Error("文件中没有足够文字可供分析。");
  }
  return { pages, totalPages: pages.length, unit, sha256, needsOcr, renderOcrPage, close };
}
