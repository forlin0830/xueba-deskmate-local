import { env } from "cloudflare:workers";
import { parseArchive } from "@/lib/learning-store";
import { passwordSaltFrom, sessionToken, storedPassword, tokenHash, usernameFrom, validProof, validSalt, verifyProof } from "@/lib/cloud-auth";
import { cloudAccount as account, cloudCookieValue as cookieValue, validCloudToken as validCode } from "@/lib/cloud-session";
import type { LearningArchive } from "@/lib/learning-store";

const COOKIE = "xueba_cloud";
const MAX_JSON = 1_900_000;
type CloudDocument = { materialId: string; sha256: string; total: number; ocr: number; complete: number };

function database(): D1Database | null { return env.DB || null; }
function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
function sameOrigin(request: Request): boolean { return request.headers.get("origin") === new URL(request.url).origin; }
function authCookie(code: string, request: Request, maxAge = 60 * 60 * 24 * 30): string {
  return `${COOKIE}=${code}; Path=/; HttpOnly; SameSite=Strict; ${new URL(request.url).protocol === "https:" ? "Secure; " : ""}Max-Age=${maxAge}`;
}
async function createSession(db: D1Database, userId: string, request: Request): Promise<string> {
  const code = sessionToken();
  await db.prepare("INSERT INTO cloud_sessions (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)")
    .bind(await tokenHash(code), userId, Date.now() + 30 * 86400_000, new Date().toISOString()).run();
  return authCookie(code, request);
}
async function throttle(db: D1Database, request: Request, scope: string, subject: string, limit: number): Promise<boolean> {
  const now = Date.now();
  const ip = request.headers.get("cf-connecting-ip") || "local";
  const keys = [`ip:${ip}`, `subject:${subject}`];
  for (const key of keys) {
    const digest = await tokenHash(`${scope}:${key}`);
    await db.prepare("INSERT INTO cloud_auth_attempts (scope,subject_hash,attempts,reset_at) VALUES (?,?,1,?) ON CONFLICT(scope,subject_hash) DO UPDATE SET attempts=CASE WHEN reset_at<? THEN 1 ELSE attempts+1 END, reset_at=CASE WHEN reset_at<? THEN excluded.reset_at ELSE reset_at END")
      .bind(scope, digest, now + 15 * 60_000, now, now).run();
    const row = await db.prepare("SELECT attempts FROM cloud_auth_attempts WHERE scope=? AND subject_hash=?")
      .bind(scope, digest).first<{ attempts: number }>();
    if ((row?.attempts || 0) > limit) return false;
  }
  return true;
}
async function body(request: Request, limit = MAX_JSON): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length"));
  if (!Number.isSafeInteger(length) || length < 1 || length > limit || request.headers.get("content-type")?.split(";")[0] !== "application/json") throw new Error("请求内容过大或格式无效。");
  const value: unknown = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求格式无效。");
  return value as Record<string, unknown>;
}
function docKey(value: Record<string, unknown>): value is Record<string, unknown> & { materialId: string; sha256: string } {
  return typeof value.materialId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value.materialId)
    && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256);
}
function documentRefs(archive: LearningArchive): { materialId: string; sha256: string; total: number; ocr: number }[] {
  return archive.spaces.flatMap((space) => space.materials.filter((material) => material.storedText).map((material) => ({
    materialId: material.id, sha256: material.coverage?.sha256 || "", total: material.coverage?.total || 0, ocr: material.coverage?.ocr || 0,
  })));
}

export async function GET(request: Request): Promise<Response> {
  const db = database();
  if (!db) return json({ error: "云端档案数据库尚未配置。" }, 503);
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("action") === "login-salt") {
      const username = usernameFrom(url.searchParams.get("username"));
      if (!username) return json({ error: "用户名格式无效。" }, 400);
      const credential = await db.prepare("SELECT password_hash AS passwordHash FROM cloud_credentials WHERE username=?")
        .bind(username).first<{ passwordHash: string }>();
      const salt = credential ? passwordSaltFrom(credential.passwordHash) : null;
      return json({ salt: salt || (await tokenHash(`unknown-user:${username}`)).slice(0, 32) });
    }
    const user = await account(db, request);
    const action = url.searchParams.get("action") || "archive";
    if (!user) return action === "document" ? json({ error: "请先登录云端账号。" }, 401) : json({ connected: false, signupAvailable: true });
    if (action === "meta") {
      const row = await db.prepare("SELECT revision, updated_at AS updatedAt FROM cloud_archives WHERE user_id=?")
        .bind(user.id).first<{ revision: number; updatedAt: string }>();
      return json({ connected: true, accountId: user.id, username: user.username, legacy: Boolean(user.legacy), revision: row?.revision || 0, updatedAt: row?.updatedAt || "" });
    }
    if (action === "document") {
      const materialId = new URL(request.url).searchParams.get("materialId") || "";
      const sha256 = new URL(request.url).searchParams.get("sha256") || "";
      if (!docKey({ materialId, sha256 })) return json({ error: "资料编号无效。" }, 400);
      const meta = await db.prepare("SELECT total, ocr, complete FROM cloud_documents WHERE user_id=? AND material_id=? AND sha256=?")
        .bind(user.id, materialId, sha256).first<{ total: number; ocr: number; complete: number }>();
      if (!meta?.complete) return json({ error: "云端资料正文不完整。" }, 404);
      const pages = await db.prepare("SELECT page_number AS number, method, text FROM cloud_document_pages WHERE user_id=? AND material_id=? AND sha256=? ORDER BY page_number")
        .bind(user.id, materialId, sha256).all<{ number: number; method: string; text: string }>();
      if (pages.results.length !== meta.total || pages.results.some((page, index) => page.number !== index + 1 || !page.text)) return json({ error: "云端资料正文缺页。" }, 409);
      return json({ materialId, sha256, pages: pages.results });
    }
    const row = await db.prepare("SELECT revision, archive_json AS archiveJson, updated_at AS updatedAt FROM cloud_archives WHERE user_id=?")
      .bind(user.id).first<{ revision: number; archiveJson: string | null; updatedAt: string }>();
    return json({ connected: true, accountId: user.id, username: user.username, legacy: Boolean(user.legacy), revision: row?.revision || 0, archive: row?.archiveJson ? JSON.parse(row.archiveJson) : null, updatedAt: row?.updatedAt || "" });
  } catch { return json({ error: "云端档案暂时无法读取。" }, 500); }
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "请求来源无效。" }, 403);
  const db = database();
  if (!db) return json({ error: "云端档案数据库尚未配置。" }, 503);
  let value: Record<string, unknown>;
  try { value = await body(request); }
  catch (error) { return json({ error: error instanceof Error ? error.message : "请求无效。" }, 400); }
  const action = value.action;
  try {
    if (action === "signup") {
      const username = usernameFrom(value.username);
      if (!username || !validProof(value.proof) || !validSalt(value.salt)) return json({ error: "用户名或密码验证信息无效。" }, 400);
      if (!(await throttle(db, request, "signup", username, 5))) return json({ error: "尝试过于频繁，请 15 分钟后再试。" }, 429);
      if (await db.prepare("SELECT 1 AS found FROM cloud_credentials WHERE username=?").bind(username).first()) return json({ error: "用户名不可用，请换一个。" }, 409);
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const derivedPassword = await storedPassword(value.proof, value.salt);
      await db.batch([
        db.prepare("INSERT INTO cloud_accounts (id,key_hash,created_at) VALUES (?,?,?)").bind(id, `account:${id}`, now),
        db.prepare("INSERT INTO cloud_archives (user_id,revision,archive_json,updated_at) VALUES (?,0,NULL,?)").bind(id, now),
        db.prepare("INSERT INTO cloud_credentials (user_id,username,password_hash,created_at) VALUES (?,?,?,?)")
          .bind(id, username, derivedPassword, now),
      ]);
      const response = json({ connected: true, accountId: id, username, revision: 0, archive: null });
      response.headers.set("Set-Cookie", await createSession(db, id, request));
      return response;
    }
    if (action === "login-password") {
      const username = usernameFrom(value.username);
      if (!username || !validProof(value.proof)) return json({ error: "用户名或密码不正确。" }, 401);
      if (!(await throttle(db, request, "login", username, 10))) return json({ error: "尝试过于频繁，请 15 分钟后再试。" }, 429);
      const existing = await db.prepare("SELECT user_id AS id, password_hash AS passwordHash FROM cloud_credentials WHERE username=?")
        .bind(username).first<{ id: string; passwordHash: string }>();
      if (!existing || !(await verifyProof(value.proof, existing.passwordHash))) return json({ error: "用户名或密码不正确。" }, 401);
      const response = json({ connected: true });
      response.headers.set("Set-Cookie", await createSession(db, existing.id, request));
      return response;
    }
    if (action === "login" || action === "legacy-login") {
      if (!validCode(value.code)) return json({ error: "旧同步密钥无效。" }, 400);
      if (!(await throttle(db, request, "legacy", await tokenHash(value.code), 10))) return json({ error: "尝试过于频繁，请 15 分钟后再试。" }, 429);
      const existing = await db.prepare("SELECT a.id FROM cloud_accounts a LEFT JOIN cloud_credentials c ON c.user_id=a.id WHERE a.key_hash=? AND c.user_id IS NULL")
        .bind(await tokenHash(value.code)).first<{ id: string }>();
      if (!existing) return json({ error: "旧同步密钥无效，或该档案已迁移为账号。" }, 401);
      const response = json({ connected: true, legacy: true });
      response.headers.set("Set-Cookie", authCookie(value.code, request));
      return response;
    }
    if (action === "upgrade") {
      const current = await account(db, request);
      if (!current?.legacy) return json({ error: "请先用旧同步密钥连接待迁移的档案。" }, 401);
      const username = usernameFrom(value.username);
      if (!username || !validProof(value.proof) || !validSalt(value.salt)) return json({ error: "用户名或密码验证信息无效。" }, 400);
      if (!(await throttle(db, request, "upgrade", username, 5))) return json({ error: "尝试过于频繁，请 15 分钟后再试。" }, 429);
      if (await db.prepare("SELECT 1 AS found FROM cloud_credentials WHERE username=?").bind(username).first()) return json({ error: "用户名不可用，请换一个。" }, 409);
      await db.prepare("INSERT INTO cloud_credentials (user_id,username,password_hash,created_at) VALUES (?,?,?,?)")
        .bind(current.id, username, await storedPassword(value.proof, value.salt), new Date().toISOString()).run();
      const response = json({ connected: true, accountId: current.id, username, upgraded: true });
      response.headers.set("Set-Cookie", await createSession(db, current.id, request));
      return response;
    }
    if (action === "logout") {
      const code = cookieValue(request);
      if (validCode(code)) await db.prepare("DELETE FROM cloud_sessions WHERE token_hash=?").bind(await tokenHash(code)).run();
      const response = json({ connected: false });
      response.headers.set("Set-Cookie", authCookie("", request, 0));
      return response;
    }
    const user = await account(db, request);
    if (!user) return json({ error: "请先连接云端档案。" }, 401);
    if (action === "document-start") {
      if (!docKey(value) || !Number.isSafeInteger(value.total) || (value.total as number) < 1 || (value.total as number) > 1000
        || !Number.isSafeInteger(value.ocr) || (value.ocr as number) < 0 || (value.ocr as number) > (value.total as number)) return json({ error: "逐页资料信息无效。" }, 400);
      const existing = await db.prepare("SELECT total, ocr, complete FROM cloud_documents WHERE user_id=? AND material_id=? AND sha256=?")
        .bind(user.id, value.materialId, value.sha256).first<{ total: number; ocr: number; complete: number }>();
      if (existing?.complete && existing.total === value.total && existing.ocr === value.ocr) return json({ complete: true });
      await db.batch([
        db.prepare("DELETE FROM cloud_document_pages WHERE user_id=? AND material_id=? AND sha256=?").bind(user.id, value.materialId, value.sha256),
        db.prepare("INSERT INTO cloud_documents (user_id,material_id,sha256,total,ocr,complete) VALUES (?,?,?,?,?,0) ON CONFLICT(user_id,material_id,sha256) DO UPDATE SET total=excluded.total,ocr=excluded.ocr,complete=0")
          .bind(user.id, value.materialId, value.sha256, value.total, value.ocr),
      ]);
      return json({ complete: false });
    }
    if (action === "document-pages") {
      if (!docKey(value) || !Array.isArray(value.pages) || value.pages.length < 1 || value.pages.length > 20) return json({ error: "逐页资料格式无效。" }, 400);
      const meta = await db.prepare("SELECT total, complete FROM cloud_documents WHERE user_id=? AND material_id=? AND sha256=?")
        .bind(user.id, value.materialId, value.sha256).first<{ total: number; complete: number }>();
      if (!meta || meta.complete) return json({ error: "请重新开始上传这份资料。" }, 409);
      const pages = value.pages as { number?: unknown; method?: unknown; text?: unknown }[];
      if (pages.some((page) => !page || !Number.isSafeInteger(page.number) || (page.number as number) < 1 || (page.number as number) > meta.total
        || (page.method !== "text" && page.method !== "ocr") || typeof page.text !== "string" || !page.text.trim() || page.text.length > 50_000)
        || new Set(pages.map((page) => page.number)).size !== pages.length) return json({ error: "资料页面缺失或内容无效。" }, 400);
      await db.batch(pages.map((page) => db.prepare("INSERT OR REPLACE INTO cloud_document_pages (user_id,material_id,sha256,page_number,method,text) VALUES (?,?,?,?,?,?)")
        .bind(user.id, value.materialId, value.sha256, page.number, page.method, page.text)));
      return json({ saved: pages.length });
    }
    if (action === "document-finish") {
      if (!docKey(value)) return json({ error: "资料编号无效。" }, 400);
      const meta = await db.prepare("SELECT total, ocr, complete FROM cloud_documents WHERE user_id=? AND material_id=? AND sha256=?")
        .bind(user.id, value.materialId, value.sha256).first<{ total: number; ocr: number; complete: number }>();
      if (!meta) return json({ error: "云端资料不存在。" }, 404);
      const result = await db.prepare("SELECT COUNT(*) AS count, MIN(page_number) AS first, MAX(page_number) AS last, SUM(LENGTH(text)) AS chars, SUM(CASE WHEN method='ocr' THEN 1 ELSE 0 END) AS ocr FROM cloud_document_pages WHERE user_id=? AND material_id=? AND sha256=?")
        .bind(user.id, value.materialId, value.sha256).first<{ count: number; first: number; last: number; chars: number; ocr: number }>();
      if (!result || result.count !== meta.total || result.first !== 1 || result.last !== meta.total || result.ocr !== meta.ocr || result.chars > 500_000) return json({ error: "逐页正文未完整上传，云端资料不会启用。" }, 409);
      await db.prepare("UPDATE cloud_documents SET complete=1 WHERE user_id=? AND material_id=? AND sha256=?")
        .bind(user.id, value.materialId, value.sha256).run();
      return json({ complete: true });
    }
    if (action === "archive-save") {
      if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 0) return json({ error: "档案版本无效。" }, 400);
      const archive = parseArchive(value.archive);
      const serialized = JSON.stringify(archive);
      if (new TextEncoder().encode(serialized).length > 1_800_000) return json({ error: "档案记录过大，请先导出备份并清理无用记录。" }, 413);
      const refs = documentRefs(archive);
      if (refs.length > 150 || refs.some((ref) => !/^[A-Za-z0-9_-]{1,100}$/.test(ref.materialId) || !/^[0-9a-f]{64}$/.test(ref.sha256) || ref.total < 1)) return json({ error: "资料完整性记录无效。" }, 400);
      const completed = await db.prepare("SELECT material_id AS materialId, sha256, total, ocr, complete FROM cloud_documents WHERE user_id=? AND complete=1")
        .bind(user.id).all<CloudDocument>();
      const byKey = new Map(completed.results.map((doc) => [`${doc.materialId}:${doc.sha256}`, doc]));
      if (refs.some((ref) => { const doc = byKey.get(`${ref.materialId}:${ref.sha256}`); return !doc || doc.total !== ref.total || doc.ocr !== ref.ocr; }))
        return json({ error: "有逐页正文尚未完整上传，云端档案没有覆盖。" }, 409);
      const next = (value.expectedRevision as number) + 1;
      const result = await db.prepare("UPDATE cloud_archives SET revision=?, archive_json=?, updated_at=? WHERE user_id=? AND revision=?")
        .bind(next, serialized, new Date().toISOString(), user.id, value.expectedRevision).run();
      if (!result.meta.changes) return json({ error: "云端档案已在另一设备更新，请先从云端恢复后再继续。", conflict: true }, 409);
      const keep = JSON.stringify(refs.map((ref) => `${ref.materialId}:${ref.sha256}`));
      let cleanupPending = false;
      try {
        await db.batch([
          db.prepare("DELETE FROM cloud_document_pages WHERE user_id=? AND (material_id || ':' || sha256) NOT IN (SELECT value FROM json_each(?))").bind(user.id, keep),
          db.prepare("DELETE FROM cloud_documents WHERE user_id=? AND (material_id || ':' || sha256) NOT IN (SELECT value FROM json_each(?))").bind(user.id, keep),
        ]);
      } catch { cleanupPending = true; }
      return json({ revision: next, saved: true, cleanupPending });
    }
    return json({ error: "未知的云端操作。" }, 400);
  } catch (error) {
    return json({ error: error instanceof Error && /格式|版本|学习空间|档案/.test(error.message) ? error.message : "云端保存失败，请稍后重试。本地档案未被覆盖。" }, 500);
  }
}
