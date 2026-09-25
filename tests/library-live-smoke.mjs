import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { newArchive } from "../lib/learning-store.ts";
import { passwordProof, passwordSalt } from "../lib/cloud-auth.ts";

const origin = process.env.CLOUD_TEST_ORIGIN || "http://127.0.0.1:8787";
const testIp = `2001:db8:${crypto.randomUUID().replaceAll("-", "").slice(0, 4)}::1`;
function d1(command) {
  execFileSync(process.execPath, [fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
    "d1", "execute", "DB", "--local", "--config", "dist/server/wrangler.json", "--persist-to", ".wrangler/state", "--command", command],
  { cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
}
async function call(method, path, value, cookie = "") {
  const response = await fetch(`${origin}${path}`, { method,
    headers: { "cf-connecting-ip": testIp, ...(cookie ? { Cookie: cookie } : {}), ...(method === "POST" ? { Origin: origin, "Content-Type": "application/json" } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(value) } : {}) });
  return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
}
async function signup(prefix) {
  const salt = passwordSalt();
  const username = `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
  const created = await call("POST", "/api/cloud", { action: "signup", username, salt, proof: await passwordProof("test-library-password-2026", salt) });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  return { username, id: created.data.accountId, cookie: created.cookie };
}
const owner = await signup("owner");
const visitor = await signup("visitor");
const reviewer = await signup("reviewer");
const archive = newArchive();
const materialId = crypto.randomUUID();
const sha256 = "c".repeat(64);
const now = new Date().toISOString();
archive.spaces[0].profile.goal = "考研";
archive.spaces[0].profile.subject = "数学一";
archive.spaces[0].profile.year = "2027";
archive.spaces[0].materials.push({ version: 1, id: materialId, title: "测试资料.txt", category: "textbook", reliability: "reference",
  status: "read", origin: "upload", note: "", summary: "测试微积分笔记", topics: [], excerpt: "极限与导数", storedText: true,
  coverage: { total: 2, processed: 2, ocr: 0, unit: "segment", analyzedParts: 1, sha256, complete: true, checkedAt: now }, addedAt: now });
assert.equal((await call("POST", "/api/library", { action: "submit", materialId, sourceNote: "这是我自行整理的考研数学笔记", confirmRights: true }, owner.cookie)).status, 409);
assert.equal((await call("POST", "/api/cloud", { action: "document-start", materialId, sha256, total: 2, ocr: 0 }, owner.cookie)).status, 200);
assert.equal((await call("POST", "/api/cloud", { action: "document-pages", materialId, sha256, pages: [
  { number: 1, method: "text", text: "第一段：极限的定义。" }, { number: 2, method: "text", text: "第二段：导数的定义。" } ] }, owner.cookie)).status, 200);
assert.equal((await call("POST", "/api/cloud", { action: "document-finish", materialId, sha256 }, owner.cookie)).status, 200);
assert.equal((await call("POST", "/api/cloud", { action: "archive-save", expectedRevision: 0, archive }, owner.cookie)).status, 200);
assert.equal((await call("POST", "/api/library", { action: "submit", materialId, sourceNote: "这是我自行整理的考研数学笔记" }, owner.cookie)).status, 400);
const submitted = await call("POST", "/api/library", { action: "submit", materialId, sourceNote: "这是我自行整理的考研数学笔记", confirmRights: true }, owner.cookie);
assert.equal(submitted.status, 200, JSON.stringify(submitted.data));
const itemId = submitted.data.id;
assert.equal(submitted.data.status, "pending");
assert.equal((await call("GET", "/api/library?subject=数学一")).data.items.length, 0);
assert.equal((await call("GET", `/api/library?action=item&id=${itemId}`, undefined, visitor.cookie)).status, 404);
assert.equal((await call("GET", "/api/library?action=mine", undefined, owner.cookie)).data.items[0].status, "pending");
assert.equal((await call("POST", "/api/library", { action: "review", id: itemId, decision: "approve" }, visitor.cookie)).status, 403);
d1(`INSERT INTO library_reviewers(user_id) VALUES('${reviewer.id}')`);
assert.equal((await call("GET", "/api/library?action=review-queue", undefined, reviewer.cookie)).data.items[0].id, itemId);
const privateDetail = await call("GET", `/api/library?action=item&id=${itemId}`, undefined, reviewer.cookie);
assert.equal(privateDetail.data.pages.length, 2);
assert.equal((await call("POST", "/api/library", { action: "review", id: itemId, decision: "approve" }, reviewer.cookie)).status, 200);
assert.equal((await call("GET", "/api/library?subject=数学一")).data.items[0].id, itemId);
const publicDetail = await call("GET", `/api/library?action=item&id=${itemId}`);
assert.deepEqual(publicDetail.data.pages.map((page) => page.text), ["第一段：极限的定义。", "第二段：导数的定义。"]);
assert.equal((await call("POST", "/api/library", { action: "withdraw", id: itemId }, visitor.cookie)).status, 403);
assert.equal((await call("POST", "/api/library", { action: "withdraw", id: itemId }, owner.cookie)).status, 200);
assert.equal((await call("GET", `/api/library?action=item&id=${itemId}`)).status, 404);
assert.equal((await call("GET", "/api/library?subject=数学一")).data.items.length, 0);
assert.equal((await call("GET", `/api/cloud?action=document&materialId=${materialId}&sha256=${sha256}`, undefined, owner.cookie)).data.pages.length, 2);
const resubmitted = await call("POST", "/api/library", { action: "submit", materialId, sourceNote: "这是我自行整理的考研数学笔记", confirmRights: true }, owner.cookie);
assert.equal(resubmitted.status, 200);
assert.equal((await call("POST", "/api/library", { action: "review", id: resubmitted.data.id, decision: "reject" }, reviewer.cookie)).status, 400);
assert.equal((await call("POST", "/api/library", { action: "review", id: resubmitted.data.id, decision: "reject", note: "来源说明不足，请补充版本" }, reviewer.cookie)).status, 200);
assert.equal((await call("GET", "/api/library?subject=数学一")).data.items.length, 0);
assert.match((await call("GET", "/api/library?action=mine", undefined, owner.cookie)).data.items[0].reviewNote, /版本/);
assert.equal((await call("POST", "/api/library", { action: "withdraw", id: resubmitted.data.id }, owner.cookie)).status, 200);
console.log("Library smoke: private submission, reviewer approval/rejection, public pages, isolation and withdrawal passed");
