import type { StoredDocumentPage } from "./document-chunks";

export type StoredDocument = { materialId: string; sha256: string; pages: StoredDocumentPage[] };

const DATABASE = "xueba-document-text-v1";
const STORE = "documents";
const DRAFTS = "ocr-drafts";
export type DraftDocument = { sha256: string; pages: StoredDocumentPage[]; totalPages: number };

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: "materialId" });
      if (!request.result.objectStoreNames.contains(DRAFTS)) request.result.createObjectStore(DRAFTS, { keyPath: "sha256" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("无法打开浏览器资料库"));
  });
}

async function transact<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore, resolve: (value: T) => void, reject: (error: unknown) => void) => void, storeName = STORE): Promise<T> {
  const database = await openDatabase();
  return new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const store = transaction.objectStore(storeName);
    let value: T;
    operation(store, (result) => { value = result; }, reject);
    transaction.onerror = () => reject(transaction.error || new Error("浏览器资料库操作失败"));
    transaction.oncomplete = () => { database.close(); resolve(value); };
    transaction.onabort = () => { database.close(); reject(transaction.error || new Error("浏览器资料库操作中断")); };
  });
}

export function validDocument(value: unknown): value is StoredDocument {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<StoredDocument>;
  return typeof item.materialId === "string" && item.materialId.length <= 100
    && typeof item.sha256 === "string" && /^[0-9a-f]{64}$/.test(item.sha256)
    && Array.isArray(item.pages) && item.pages.length > 0 && item.pages.length <= 1000
    && item.pages.every((page, index) => page && page.number === index + 1 && typeof page.text === "string"
      && page.text.length > 0 && (page.method === "text" || page.method === "ocr"))
    && item.pages.reduce((sum, page) => sum + page.text.length, 0) <= 500_000;
}

export async function saveDocument(document: StoredDocument): Promise<void> {
  if (!validDocument(document)) throw new Error("逐页正文不完整，资料没有保存。");
  await transact<void>("readwrite", (store, resolve, reject) => {
    const request = store.put(document);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getDocument(materialId: string): Promise<StoredDocument | undefined> {
  return transact<StoredDocument | undefined>("readonly", (store, resolve, reject) => {
    const request = store.get(materialId);
    request.onsuccess = () => resolve(validDocument(request.result) ? request.result : undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteDocument(materialId: string): Promise<void> {
  await transact<void>("readwrite", (store, resolve, reject) => {
    const request = store.delete(materialId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function documentsForExport(ids: string[]): Promise<StoredDocument[]> {
  const documents = await Promise.all(ids.map((id) => getDocument(id)));
  return documents.filter((document): document is StoredDocument => Boolean(document));
}

function validDraft(value: unknown): value is DraftDocument {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<DraftDocument>;
  return typeof draft.sha256 === "string" && /^[0-9a-f]{64}$/.test(draft.sha256)
    && Number.isSafeInteger(draft.totalPages) && draft.totalPages! > 0 && draft.totalPages! <= 1000
    && Array.isArray(draft.pages) && draft.pages.length === draft.totalPages
    && draft.pages.every((page, index) => page && page.number === index + 1 && typeof page.text === "string"
      && (page.method === "text" || page.method === "ocr"))
    && draft.pages.reduce((sum, page) => sum + page.text.length, 0) <= 500_000;
}

export async function saveDraft(document: DraftDocument): Promise<void> {
  if (!validDraft(document)) throw new Error("OCR 进度不完整，无法保存。");
  await transact<void>("readwrite", (store, resolve, reject) => {
    const request = store.put(document);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }, DRAFTS);
}

export async function getDraft(sha256: string): Promise<DraftDocument | undefined> {
  return transact<DraftDocument | undefined>("readonly", (store, resolve, reject) => {
    const request = store.get(sha256);
    request.onsuccess = () => resolve(validDraft(request.result) ? request.result : undefined);
    request.onerror = () => reject(request.error);
  }, DRAFTS);
}

export async function deleteDraft(sha256: string): Promise<void> {
  await transact<void>("readwrite", (store, resolve, reject) => {
    const request = store.delete(sha256);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }, DRAFTS);
}
