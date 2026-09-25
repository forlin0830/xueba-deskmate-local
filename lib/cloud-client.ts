import { documentsForExport, getDocument, saveDocument, validDocument } from "./document-store";
import { parseArchive } from "./learning-store";
import type { StoredDocument } from "./document-store";
import type { LearningArchive } from "./learning-store";

export type CloudSnapshot = { connected: boolean; accountId?: string; username?: string; legacy?: boolean; signupAvailable?: boolean; unavailable?: boolean; revision?: number; archive?: LearningArchive | null; updatedAt?: string };

export async function archiveDigest(archive: LearningArchive): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(archive));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function cloudGet(query = ""): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/cloud${query}`, { cache: "no-store" });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error || "云端暂时无法读取。"));
  return data;
}

export async function cloudPost(value: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch("/api/cloud", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error || "云端暂时无法保存。"));
  return data;
}

export async function sendArchive(archive: LearningArchive, revision: number, progress: (message: string) => void): Promise<{ revision: number; cleanupPending: boolean }> {
  const materials = archive.spaces.flatMap((space) => space.materials.filter((material) => material.storedText));
  const documents = await documentsForExport(materials.map((material) => material.id));
  const byId = new Map(documents.map((document) => [document.materialId, document]));
  if (materials.some((material) => !material.coverage?.complete || byId.get(material.id)?.sha256 !== material.coverage.sha256
    || byId.get(material.id)?.pages.length !== material.coverage.total || byId.get(material.id)?.pages.filter((page) => page.method === "ocr").length !== material.coverage.ocr)) {
    throw new Error("有资料的逐页正文缺失或与完整性记录不符。云端档案没有覆盖。");
  }
  for (let index = 0; index < materials.length; index += 1) {
    const material = materials[index];
    const document = byId.get(material.id)!;
    progress(`上传逐页资料 ${index + 1}/${materials.length}：${material.title}`);
    const start = await cloudPost({ action: "document-start", materialId: material.id, sha256: document.sha256,
      total: document.pages.length, ocr: material.coverage!.ocr });
    if (!start.complete) {
      for (let offset = 0; offset < document.pages.length; offset += 20) {
        await cloudPost({ action: "document-pages", materialId: material.id, sha256: document.sha256,
          pages: document.pages.slice(offset, offset + 20) });
      }
      await cloudPost({ action: "document-finish", materialId: material.id, sha256: document.sha256 });
    }
  }
  progress("核对云端档案版本与资料完整性…");
  const result = await cloudPost({ action: "archive-save", expectedRevision: revision, archive });
  if (!Number.isSafeInteger(result.revision)) throw new Error("云端未返回有效档案版本。");
  return { revision: result.revision as number, cleanupPending: result.cleanupPending === true };
}

export async function receiveArchive(value: unknown, progress: (message: string) => void): Promise<LearningArchive> {
  const archive = parseArchive(value);
  const materials = archive.spaces.flatMap((space) => space.materials.filter((material) => material.storedText));
  const documents: StoredDocument[] = [];
  for (let index = 0; index < materials.length; index += 1) {
    const material = materials[index];
    progress(`下载逐页资料 ${index + 1}/${materials.length}：${material.title}`);
    const cached = await getDocument(material.id);
    if (cached && material.coverage && cached.sha256 === material.coverage.sha256
      && cached.pages.length === material.coverage.total
      && cached.pages.filter((page) => page.method === "ocr").length === material.coverage.ocr) continue;
    const params = new URLSearchParams({ action: "document", materialId: material.id, sha256: material.coverage?.sha256 || "" });
    const document = await cloudGet(`?${params}`);
    if (!validDocument(document) || document.sha256 !== material.coverage?.sha256 || document.pages.length !== material.coverage.total
      || document.pages.filter((page) => page.method === "ocr").length !== material.coverage.ocr) {
      throw new Error(`《${material.title}》的云端正文缺失或不完整，本地档案没有替换。`);
    }
    documents.push(document);
  }
  for (const document of documents) await saveDocument(document);
  return archive;
}
