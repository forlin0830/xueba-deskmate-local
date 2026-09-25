import { env } from "cloudflare:workers";
import { cloudAccount } from "@/lib/cloud-session";
import { parseArchive } from "@/lib/learning-store";
import type { DocumentCoverage, SourceCategory } from "@/lib/learning-store";

type LibraryRow = {
  id: string; ownerUserId: string; materialId: string; sha256: string; title: string; category: SourceCategory;
  goal: string; subject: string; year: string; institution: string; summary: string; topicsJson: string;
  sourceNote: string; sourceUrl: string; coverageJson: string; status: "pending" | "approved" | "rejected";
  reviewNote: string; createdAt: string; reviewedAt: string | null;
};
type Page = { number: number; method: "text" | "ocr"; text: string };
const ITEM_ID = /^[0-9a-f-]{36}$/i;
const MATERIAL_ID = /^[A-Za-z0-9_-]{1,100}$/;
const SELECT = `SELECT id, owner_user_id AS ownerUserId, material_id AS materialId, sha256, title, category, goal, subject, year,
  institution, summary, topics_json AS topicsJson, source_note AS sourceNote, source_url AS sourceUrl,
  coverage_json AS coverageJson, status, review_note AS reviewNote, created_at AS createdAt, reviewed_at AS reviewedAt FROM library_items`;

function json(value: unknown, status = 200): Response { return Response.json(value, { status, headers: { "Cache-Control": "no-store" } }); }
function sameOrigin(request: Request): boolean { return request.headers.get("origin") === new URL(request.url).origin; }
function publicItem(row: LibraryRow, showReview = false) {
  const coverage = JSON.parse(row.coverageJson) as DocumentCoverage;
  return { id: row.id, title: row.title, category: row.category, goal: row.goal, subject: row.subject, year: row.year,
    institution: row.institution, summary: row.summary, topics: JSON.parse(row.topicsJson) as string[], sourceNote: row.sourceNote,
    sourceUrl: row.sourceUrl, coverage, status: row.status, createdAt: row.createdAt,
    ...(showReview ? { reviewNote: row.reviewNote, reviewedAt: row.reviewedAt } : {}) };
}
async function reviewer(db: D1Database, userId: string): Promise<boolean> {
  return Boolean(await db.prepare("SELECT 1 AS permitted FROM library_reviewers WHERE user_id=?").bind(userId).first());
}
async function body(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length < 1 || length > 5_000 || request.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw new Error("请求格式无效。");
  const value: unknown = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求格式无效。");
  return value as Record<string, unknown>;
}
function safeSourceUrl(value: unknown): string | null {
  if (value === "" || value === undefined) return "";
  if (typeof value !== "string" || value.length > 500) return null;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null; }
  catch { return null; }
}

export async function GET(request: Request): Promise<Response> {
  const db = env.DB;
  if (!db) return json({ error: "公共资料库数据库尚未配置。" }, 503);
  const url = new URL(request.url);
  const action = url.searchParams.get("action") || "browse";
  try {
    if (action === "browse") {
      const subject = (url.searchParams.get("subject") || "").trim().slice(0, 80);
      const category = url.searchParams.get("category") || "";
      if (category && !["syllabus", "textbook", "past_exam"].includes(category)) return json({ error: "资料类别无效。" }, 400);
      const rows = await db.prepare(`${SELECT} WHERE status='approved' AND (?='' OR subject=?) AND (?='' OR category=?) ORDER BY reviewed_at DESC LIMIT 60`)
        .bind(subject, subject, category, category).all<LibraryRow>();
      return json({ items: rows.results.map((row) => publicItem(row)) });
    }
    const user = await cloudAccount(db, request);
    if (action === "mine") {
      if (!user || user.legacy) return json({ error: "请先登录云端账号。" }, 401);
      const rows = await db.prepare(`${SELECT} WHERE owner_user_id=? ORDER BY created_at DESC LIMIT 100`).bind(user.id).all<LibraryRow>();
      return json({ items: rows.results.map((row) => publicItem(row, true)), reviewer: await reviewer(db, user.id) });
    }
    if (action === "review-queue") {
      if (!user || !(await reviewer(db, user.id))) return json({ error: "没有审核权限。" }, 403);
      const rows = await db.prepare(`${SELECT} WHERE status='pending' ORDER BY created_at ASC LIMIT 100`).all<LibraryRow>();
      return json({ items: rows.results.map((row) => publicItem(row, true)) });
    }
    if (action === "item") {
      const id = url.searchParams.get("id") || "";
      if (!ITEM_ID.test(id)) return json({ error: "资料编号无效。" }, 400);
      const row = await db.prepare(`${SELECT} WHERE id=?`).bind(id).first<LibraryRow>();
      if (!row || (row.status !== "approved" && user?.id !== row.ownerUserId && !(user && await reviewer(db, user.id))))
        return json({ error: "资料不存在或尚未公开。" }, 404);
      const pages = await db.prepare("SELECT page_number AS number, method, text FROM library_pages WHERE item_id=? ORDER BY page_number")
        .bind(id).all<Page>();
      const coverage = JSON.parse(row.coverageJson) as DocumentCoverage;
      if (pages.results.length !== coverage.total || pages.results.some((page, index) => page.number !== index + 1 || !page.text))
        return json({ error: "这份公共资料正文不完整，暂不可使用。" }, 409);
      return json({ item: publicItem(row, Boolean(user && (user.id === row.ownerUserId || await reviewer(db, user.id)))), pages: pages.results });
    }
    return json({ error: "未知资料库操作。" }, 400);
  } catch { return json({ error: "公共资料库暂时无法读取。" }, 500); }
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "请求来源无效。" }, 403);
  const db = env.DB;
  if (!db) return json({ error: "公共资料库数据库尚未配置。" }, 503);
  let value: Record<string, unknown>;
  try { value = await body(request); }
  catch { return json({ error: "请求格式无效。" }, 400); }
  try {
    const user = await cloudAccount(db, request);
    if (!user || user.legacy) return json({ error: "请先登录云端账号。" }, 401);
    if (value.action === "submit") {
      if (value.confirmRights !== true || typeof value.materialId !== "string" || !MATERIAL_ID.test(value.materialId))
        return json({ error: "请明确确认分享权限并选择有效资料。" }, 400);
      const sourceNote = typeof value.sourceNote === "string" ? value.sourceNote.trim().slice(0, 300) : "";
      const sourceUrl = safeSourceUrl(value.sourceUrl);
      if (sourceNote.length < 10 || sourceUrl === null) return json({ error: "请填写至少 10 个字的来源说明；来源链接需为 HTTPS。" }, 400);
      const archiveRow = await db.prepare("SELECT archive_json AS archiveJson FROM cloud_archives WHERE user_id=?").bind(user.id)
        .first<{ archiveJson: string | null }>();
      if (!archiveRow?.archiveJson) return json({ error: "请先将这份资料完整同步到私人云端。" }, 409);
      const archive = parseArchive(JSON.parse(archiveRow.archiveJson));
      const match = archive.spaces.flatMap((space) => space.materials.map((material) => ({ space, material })))
        .find(({ material }) => material.id === value.materialId);
      if (!match) return json({ error: "私人档案中找不到这份资料。" }, 404);
      const { space, material } = match;
      if (material.origin !== "upload" || !material.storedText || !material.coverage?.complete
        || !["read", "verified"].includes(material.status) || !/^[0-9a-f]{64}$/.test(material.coverage.sha256))
        return json({ error: "仅可贡献已完整读取的本人上传资料。" }, 409);
      const existing = await db.prepare("SELECT id, status FROM library_items WHERE owner_user_id=? AND material_id=? AND sha256=?")
        .bind(user.id, material.id, material.coverage.sha256).first<{ id: string; status: string }>();
      if (existing) return json({ error: `这份资料已经投稿（${existing.status === "approved" ? "已公开" : existing.status === "pending" ? "待审核" : "未通过审核"}）。` }, 409);
      const count = await db.prepare("SELECT COUNT(*) AS count FROM library_items WHERE owner_user_id=? AND status IN ('pending','approved')")
        .bind(user.id).first<{ count: number }>();
      if ((count?.count || 0) >= 20) return json({ error: "当前最多保留 20 份待审或公开投稿。请先撤回不需要的资料。" }, 429);
      const doc = await db.prepare("SELECT total, ocr, complete FROM cloud_documents WHERE user_id=? AND material_id=? AND sha256=?")
        .bind(user.id, material.id, material.coverage.sha256).first<{ total: number; ocr: number; complete: number }>();
      const stats = await db.prepare("SELECT COUNT(*) AS pages, MIN(page_number) AS first, MAX(page_number) AS last, SUM(LENGTH(text)) AS chars, SUM(CASE WHEN method='ocr' THEN 1 ELSE 0 END) AS ocr FROM cloud_document_pages WHERE user_id=? AND material_id=? AND sha256=?")
        .bind(user.id, material.id, material.coverage.sha256).first<{ pages: number; first: number; last: number; chars: number; ocr: number }>();
      if (!doc?.complete || doc.total !== material.coverage.total || doc.ocr !== material.coverage.ocr
        || !stats || stats.pages !== doc.total || stats.first !== 1 || stats.last !== doc.total || stats.ocr !== doc.ocr || stats.chars > 500_000)
        return json({ error: "私人云端的逐页正文不完整；投稿已取消。" }, 409);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await db.batch([
        db.prepare(`INSERT INTO library_items (id,owner_user_id,material_id,sha256,title,category,goal,subject,year,institution,summary,topics_json,source_note,source_url,coverage_json,status,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`)
          .bind(id, user.id, material.id, material.coverage.sha256, material.title.slice(0, 240), material.category,
            space.profile.goal.slice(0, 100), space.profile.subject.slice(0, 100), space.profile.year.slice(0, 20), space.institution.slice(0, 100),
            material.summary.slice(0, 1200), JSON.stringify(material.topics.slice(0, 300)), sourceNote, sourceUrl,
            JSON.stringify(material.coverage), now),
        db.prepare("INSERT INTO library_pages (item_id,page_number,method,text) SELECT ?,page_number,method,text FROM cloud_document_pages WHERE user_id=? AND material_id=? AND sha256=?")
          .bind(id, user.id, material.id, material.coverage.sha256),
      ]);
      return json({ id, status: "pending" });
    }
    if (value.action === "withdraw") {
      if (typeof value.id !== "string" || !ITEM_ID.test(value.id)) return json({ error: "资料编号无效。" }, 400);
      const row = await db.prepare("SELECT owner_user_id AS ownerUserId FROM library_items WHERE id=?").bind(value.id).first<{ ownerUserId: string }>();
      if (!row || row.ownerUserId !== user.id) return json({ error: "只能撤回自己的投稿。" }, 403);
      await db.batch([
        db.prepare("DELETE FROM library_pages WHERE item_id=?").bind(value.id),
        db.prepare("DELETE FROM library_items WHERE id=? AND owner_user_id=?").bind(value.id, user.id),
      ]);
      return json({ withdrawn: true });
    }
    if (value.action === "review") {
      if (!(await reviewer(db, user.id))) return json({ error: "没有审核权限。" }, 403);
      if (typeof value.id !== "string" || !ITEM_ID.test(value.id) || (value.decision !== "approve" && value.decision !== "reject"))
        return json({ error: "审核参数无效。" }, 400);
      const note = typeof value.note === "string" ? value.note.trim().slice(0, 500) : "";
      if (value.decision === "reject" && !note) return json({ error: "拒绝投稿时请填写原因。" }, 400);
      if (value.decision === "approve") {
        const item = await db.prepare("SELECT coverage_json AS coverageJson FROM library_items WHERE id=? AND status='pending'")
          .bind(value.id).first<{ coverageJson: string }>();
        if (!item) return json({ error: "投稿不存在或已审核。" }, 409);
        const coverage = JSON.parse(item.coverageJson) as DocumentCoverage;
        const stats = await db.prepare("SELECT COUNT(*) AS pages, MIN(page_number) AS first, MAX(page_number) AS last, SUM(LENGTH(text)) AS chars, SUM(CASE WHEN method='ocr' THEN 1 ELSE 0 END) AS ocr FROM library_pages WHERE item_id=?")
          .bind(value.id).first<{ pages: number; first: number; last: number; chars: number; ocr: number }>();
        if (!stats || stats.pages !== coverage.total || stats.first !== 1 || stats.last !== coverage.total || stats.ocr !== coverage.ocr || stats.chars > 500_000)
          return json({ error: "投稿正文不完整，无法公开。" }, 409);
      }
      const result = await db.prepare("UPDATE library_items SET status=?, review_note=?, reviewed_at=?, reviewed_by=? WHERE id=? AND status='pending'")
        .bind(value.decision === "approve" ? "approved" : "rejected", note, new Date().toISOString(), user.id, value.id).run();
      if (!result.meta.changes) return json({ error: "投稿不存在或已审核。" }, 409);
      return json({ status: value.decision === "approve" ? "approved" : "rejected" });
    }
    return json({ error: "未知资料库操作。" }, 400);
  } catch { return json({ error: "资料库操作失败，请稍后重试。" }, 500); }
}
