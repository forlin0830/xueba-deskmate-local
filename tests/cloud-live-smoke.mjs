import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { newArchive } from "../lib/learning-store.ts";
import { passwordProof, passwordSalt } from "../lib/cloud-auth.ts";

const origin = process.env.CLOUD_TEST_ORIGIN || "http://127.0.0.1:8787";
const testIp = `2001:db8:${crypto.randomUUID().replaceAll("-", "").slice(0, 4)}::1`;
const username = `smoke_${crypto.randomUUID().slice(0, 12)}`;
const password = "local-smoke-password-2026";

async function call(method, value, cookie = "", query = "") {
  const response = await fetch(`${origin}/api/cloud${query}`, {
    method,
    headers: { "cf-connecting-ip": testIp, ...(cookie ? { Cookie: cookie } : {}), ...(method === "POST" ? { Origin: origin, "Content-Type": "application/json" } : {}) },
    ...(method === "POST" ? { body: JSON.stringify(value) } : {}),
  });
  return { response, data: await response.json() };
}

const salt = passwordSalt();
const proof = await passwordProof(password, salt);
const created = await call("POST", { action: "signup", username, salt, proof });
assert.equal(created.response.status, 200, JSON.stringify(created.data));
assert.equal(created.data.username, username);
assert.equal("code" in created.data, false);
const cookie = created.response.headers.get("set-cookie")?.split(";")[0];
assert.ok(cookie);
assert.equal((await call("POST", { action: "login-password", username, proof: await passwordProof("wrong-password", salt) })).response.status, 401);

const archive = newArchive();
const materialId = crypto.randomUUID();
const sha256 = "a".repeat(64);
archive.spaces[0].materials.push({ version: 1, id: materialId, title: "两页测试考纲", category: "syllabus", reliability: "reference",
  status: "read", origin: "upload", note: "", summary: "测试", topics: ["函数"], excerpt: "函数", storedText: true,
  coverage: { total: 2, processed: 2, ocr: 1, unit: "page", analyzedParts: 1, sha256, complete: true, checkedAt: new Date().toISOString() },
  addedAt: new Date().toISOString() });
assert.equal((await call("POST", { action: "archive-save", expectedRevision: 0, archive }, cookie)).response.status, 409);
assert.equal((await call("POST", { action: "document-start", materialId, sha256, total: 2, ocr: 1 }, cookie)).data.complete, false);
assert.equal((await call("POST", { action: "document-pages", materialId, sha256, pages: [{ number: 1, method: "text", text: "函数定义" }] }, cookie)).response.status, 200);
assert.equal((await call("POST", { action: "document-finish", materialId, sha256 }, cookie)).response.status, 409);
assert.equal((await call("POST", { action: "document-pages", materialId, sha256, pages: [{ number: 2, method: "ocr", text: "导数考点" }] }, cookie)).response.status, 200);
assert.equal((await call("POST", { action: "document-finish", materialId, sha256 }, cookie)).data.complete, true);
const saved = await call("POST", { action: "archive-save", expectedRevision: 0, archive }, cookie);
assert.equal(saved.data.revision, 1, JSON.stringify(saved.data));
assert.equal((await call("POST", { action: "archive-save", expectedRevision: 0, archive }, cookie)).response.status, 409);
const challenge = await call("GET", undefined, "", `?action=login-salt&username=${username}`);
assert.equal(challenge.data.salt, salt);
const secondDevice = await call("POST", { action: "login-password", username, proof: await passwordProof(password, challenge.data.salt) });
assert.equal(secondDevice.response.status, 200);
const secondCookie = secondDevice.response.headers.get("set-cookie")?.split(";")[0];
assert.ok(secondCookie);
const secondMeta = await call("GET", undefined, secondCookie, "?action=meta");
assert.equal(secondMeta.data.revision, 1);
assert.equal("archive" in secondMeta.data, false);
assert.equal((await call("POST", { action: "archive-save", expectedRevision: 0, archive }, secondCookie)).response.status, 409);
assert.equal((await call("GET", undefined, secondCookie)).data.archive.spaces[0].materials[0].id, materialId);
assert.equal((await call("POST", { action: "logout" }, secondCookie)).response.status, 200);
assert.equal((await call("GET", undefined, secondCookie)).data.connected, false);
const snapshot = await call("GET", undefined, cookie);
assert.equal(snapshot.data.archive.spaces[0].materials[0].id, materialId);
const document = await call("GET", undefined, cookie, `?action=document&materialId=${materialId}&sha256=${sha256}`);
assert.deepEqual(document.data.pages.map((page) => page.text), ["函数定义", "导数考点"]);
assert.equal((await call("GET", undefined, "", `?action=document&materialId=${materialId}&sha256=${sha256}`)).response.status, 401);
const strangerSalt = passwordSalt();
const stranger = await call("POST", { action: "signup", username: `other_${crypto.randomUUID().slice(0, 12)}`,
  salt: strangerSalt, proof: await passwordProof(password, strangerSalt) });
assert.equal(stranger.response.status, 200);
const strangerCookie = stranger.response.headers.get("set-cookie")?.split(";")[0];
assert.equal((await call("GET", undefined, strangerCookie)).data.archive, null);
assert.equal((await call("GET", undefined, strangerCookie, `?action=document&materialId=${materialId}&sha256=${sha256}`)).response.status, 404);
archive.spaces[0].materials = [];
assert.equal((await call("POST", { action: "archive-save", expectedRevision: 1, archive }, cookie)).data.revision, 2);
assert.equal((await call("GET", undefined, cookie, `?action=document&materialId=${materialId}&sha256=${sha256}`)).response.status, 404);

const legacyId = crypto.randomUUID();
const legacyCode = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const legacyHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(legacyCode))), (byte) => byte.toString(16).padStart(2, "0")).join("");
const legacyArchive = newArchive();
legacyArchive.spaces[0].name = "旧档案迁移测试";
const legacyJson = JSON.stringify(legacyArchive).replaceAll("'", "''");
const now = new Date().toISOString();
const sql = `INSERT INTO cloud_accounts(id,key_hash,created_at) VALUES('${legacyId}','${legacyHash}','${now}'); INSERT INTO cloud_archives(user_id,revision,archive_json,updated_at) VALUES('${legacyId}',1,'${legacyJson}','${now}');`;
execFileSync(process.execPath, [fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
  "d1", "execute", "DB", "--local", "--config", "dist/server/wrangler.json", "--persist-to", ".wrangler/state", "--command", sql],
{ cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: "pipe" });
const legacyLogin = await call("POST", { action: "legacy-login", code: legacyCode });
assert.equal(legacyLogin.response.status, 200, JSON.stringify(legacyLogin.data));
const legacyCookie = legacyLogin.response.headers.get("set-cookie")?.split(";")[0];
assert.equal((await call("GET", undefined, legacyCookie)).data.archive.spaces[0].name, "旧档案迁移测试");
const migratedUsername = `migrated_${crypto.randomUUID().slice(0, 12)}`;
const migrationSalt = passwordSalt();
const upgraded = await call("POST", { action: "upgrade", username: migratedUsername, salt: migrationSalt, proof: await passwordProof(password, migrationSalt) }, legacyCookie);
assert.equal(upgraded.response.status, 200, JSON.stringify(upgraded.data));
const upgradedCookie = upgraded.response.headers.get("set-cookie")?.split(";")[0];
const upgradedSnapshot = await call("GET", undefined, upgradedCookie);
assert.equal(upgradedSnapshot.data.accountId, legacyId);
assert.equal(upgradedSnapshot.data.archive.spaces[0].name, "旧档案迁移测试");
assert.equal((await call("GET", undefined, legacyCookie)).data.connected, false);
assert.equal((await call("POST", { action: "legacy-login", code: legacyCode })).response.status, 401);
assert.equal((await call("POST", { action: "login-password", username: migratedUsername, proof: await passwordProof(password, migrationSalt) })).response.status, 200);
console.log("Cloud smoke: signup, second-device login, document integrity, conflict, logout, legacy migration passed");
