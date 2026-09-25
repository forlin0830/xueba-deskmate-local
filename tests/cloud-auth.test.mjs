import assert from "node:assert/strict";
import test from "node:test";
import { passwordProof, passwordSalt, passwordSaltFrom, sessionToken, storedPassword, tokenHash, usernameFrom, validPassword, verifyProof } from "../lib/cloud-auth.ts";

test("account names normalize and passwords cannot be short", () => {
  assert.equal(usernameFrom("  学霸_A  "), "学霸_a");
  assert.equal(usernameFrom("ab"), null);
  assert.equal(usernameFrom("bad name"), null);
  assert.equal(validPassword("short"), false);
  assert.equal(validPassword("correct horse battery staple"), true);
});

test("browser password proof uses a random salt and server rejects wrong proof", async () => {
  const salt = passwordSalt();
  const first = await storedPassword(await passwordProof("correct horse battery staple", salt), salt);
  const otherSalt = passwordSalt();
  const second = await storedPassword(await passwordProof("correct horse battery staple", otherSalt), otherSalt);
  assert.notEqual(first, second);
  assert.equal(passwordSaltFrom(first), salt);
  assert.equal(await verifyProof(await passwordProof("correct horse battery staple", salt), first), true);
  assert.equal(await verifyProof(await passwordProof("wrong password", salt), first), false);
  assert.equal(await verifyProof(await passwordProof("correct horse battery staple", salt), "malformed"), false);
});

test("session tokens are distinct and only their digest needs storing", async () => {
  const first = sessionToken();
  const second = sessionToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
  assert.equal(await tokenHash(first), await tokenHash(first));
  assert.notEqual(await tokenHash(first), await tokenHash(second));
});
