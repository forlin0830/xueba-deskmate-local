import type { DocumentCoverage, SourceCategory } from "./learning-store";
import type { StoredDocumentPage } from "./document-chunks";

export type LibraryItem = {
  id: string; title: string; category: SourceCategory; goal: string; subject: string; year: string; institution: string;
  summary: string; topics: string[]; sourceNote: string; sourceUrl: string; coverage: DocumentCoverage;
  status: "pending" | "approved" | "rejected"; createdAt: string; reviewNote?: string; reviewedAt?: string | null;
};
export type LibraryDetail = { item: LibraryItem; pages: StoredDocumentPage[] };

export async function libraryGet(query = ""): Promise<Record<string, unknown>> {
  const response = await fetch(`/api/library${query}`, { cache: "no-store" });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error || "公共资料库暂时无法读取。"));
  return data;
}

export async function libraryPost(value: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch("/api/library", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error || "公共资料库操作失败。"));
  return data;
}
