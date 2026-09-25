import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMaterialPages } from "../app/api/teacher/material.ts";
import { fillOcrPages } from "../app/api/teacher/ocr.ts";
import { chunkDocument, representativeExcerpt } from "../lib/document-chunks.ts";

function simplePdf(pageTexts) {
  const objects = ["", "<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const refs = [];
  pageTexts.forEach((text, index) => {
    const pageId = 4 + index * 2;
    const streamId = pageId + 1;
    refs.push(`${pageId} 0 R`);
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`;
    objects[streamId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  objects[2] = `<< /Type /Pages /Kids [${refs.join(" ")}] /Count ${refs.length} >>`;
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = body.length;
    body += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objects.length; index += 1) body += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Root 1 0 R /Size ${objects.length} >>\nstartxref\n${xref}\n%%EOF\n`;
  return body;
}

test("long uploaded text keeps the final character across all segments and model chunks", async () => {
  const original = "开头" + "甲".repeat(110_000) + "末尾";
  const document = await extractMaterialPages(new File([original], "syllabus.txt"));
  assert.equal(document.totalPages, 10);
  assert.equal(document.needsOcr.length, 0);
  assert.equal(document.pages.map((page) => page.text).join(""), original);
  assert.equal(chunkDocument(document.pages).map((chunk) => chunk.text).join(""), original);
  assert.match(representativeExcerpt(document.pages), /第 10/);
  const manyPages = Array.from({ length: 300 }, (_, index) => ({ number: index + 1, text: "正文".repeat(50), method: "text" }));
  assert.match(representativeExcerpt(manyPages), /第 300/);
});

test("over-limit text fails rather than silently returning the beginning", async () => {
  await assert.rejects(extractMaterialPages(new File(["甲".repeat(500_001)], "large.txt")), /超过 50 万字/);
});

test("PDF extraction counts every page and flags a page with no text", async () => {
  const pdf = simplePdf(["PAGE ONE CONTENT", "", "PAGE THREE CONTENT"]);
  const document = await extractMaterialPages(new File([pdf], "three-pages.pdf"));
  assert.equal(document.totalPages, 3);
  assert.deepEqual(document.needsOcr, [2]);
  assert.match(document.pages[0].text, /PAGE ONE CONTENT/);
  assert.match(document.pages[2].text, /PAGE THREE CONTENT/);
});

test("OCR requires every requested page and fills only missing pages", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body));
    calls.push(body);
    return Response.json({ layout_details: [[{ label: "text", content: "这是第二页完整的识别正文。" }]] });
  };
  const document = { pages: [
    { number: 1, text: "第一页有足够的文字。", method: "text" },
    { number: 2, text: "", method: "text" },
    { number: 3, text: "第三页有足够的文字。", method: "text" },
  ], totalPages: 3, unit: "page", sha256: "0".repeat(64), needsOcr: [2] };
  try {
    const filled = await fillOcrPages(document, new File(["pdf"], "test.pdf"), "test-key");
    assert.deepEqual(calls.map((call) => [call.start_page_id, call.end_page_id]), [[2, 2]]);
    assert.equal(filled.pages[1].method, "ocr");
    assert.equal(filled.needsOcr.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test("OCR missing page and missing key never produce complete documents", async () => {
  const document = { pages: [{ number: 1, text: "", method: "text" }],
    totalPages: 1, unit: "page", sha256: "0".repeat(64), needsOcr: [1] };
  await assert.rejects(fillOcrPages(document, new File(["pdf"], "test.pdf"), ""), /智谱 API 密钥/);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ layout_details: [] });
  try {
    await assert.rejects(fillOcrPages(document, new File(["pdf"], "test.pdf"), "test-key"), /无法确认整份文件完整/);
  } finally { globalThis.fetch = originalFetch; }
});
