import type { ExtractedDocument } from "./material";

const OCR_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/layout_parsing";
const OCR_BATCH_PAGES = 20;

type LayoutBlock = { label?: unknown; content?: unknown };
type OcrResponse = { md_results?: unknown; layout_details?: unknown; message?: unknown; msg?: unknown };

function groups(numbers: number[]): number[][] {
  const result: number[][] = [];
  for (const number of numbers) {
    const last = result.at(-1);
    if (last && last.length < OCR_BATCH_PAGES && number === last.at(-1)! + 1) last.push(number);
    else result.push([number]);
  }
  return result;
}

function pageText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const block = value as LayoutBlock;
    return block.label !== "image" && typeof block.content === "string" ? [block.content] : [];
  }).join("\n").trim();
}

export async function fillOcrPages(document: ExtractedDocument, file: File, key: string): Promise<ExtractedDocument> {
  if (!document.needsOcr.length) return document;
  if (!key) throw new Error(`PDF 有 ${document.needsOcr.length} 页需要 OCR。请先保存智谱 API 密钥，再重新读取；未完成的文件不会用于教学。`);
  if (document.totalPages > 100) throw new Error("这份 PDF 超过当前 OCR 服务的 100 页处理范围。请分卷上传；未处理页面不会被标为已读取。");
  if (file.size > 30_000_000) throw new Error("扫描版 PDF 超过当前 30 MB OCR 处理上限，请分卷上传。");

  const fileData = `data:application/pdf;base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;
  const pages = document.pages.map((page) => ({ ...page }));
  for (const batch of groups(document.needsOcr)) {
    const response = await fetch(OCR_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm-ocr", file: fileData, start_page_id: batch[0], end_page_id: batch.at(-1) }),
      signal: AbortSignal.timeout(300_000),
    });
    const data = await response.json().catch(() => ({})) as OcrResponse;
    if (!response.ok) {
      const detail = typeof data.message === "string" ? data.message : typeof data.msg === "string" ? data.msg : "";
      throw new Error(`智谱 OCR 读取第 ${batch[0]}–${batch.at(-1)} 页失败（${response.status}）${detail ? `：${detail.slice(0, 120)}` : ""}。未完成的文件不会用于教学。`);
    }
    const layouts = Array.isArray(data.layout_details) ? data.layout_details : [];
    if (layouts.length !== batch.length) {
      throw new Error(`智谱 OCR 返回 ${layouts.length} 页，但请求了 ${batch.length} 页；无法确认整份文件完整，未将其用于教学。`);
    }
    for (let index = 0; index < batch.length; index += 1) {
      const text = pageText(layouts[index]);
      if (text.replace(/\s/g, "").length < 10) {
        throw new Error(`第 ${batch[index]} 页 OCR 正文不足，可能是空白页或识别失败。请核对原页后分卷重试。`);
      }
      pages[batch[index] - 1] = { number: batch[index], text, method: "ocr" };
    }
  }
  if (pages.some((page) => page.text.replace(/\s/g, "").length < 10)) {
    throw new Error("部分页面仍没有可核对的正文，整份文件未标为已读取。");
  }
  return { ...document, pages, needsOcr: [] };
}
