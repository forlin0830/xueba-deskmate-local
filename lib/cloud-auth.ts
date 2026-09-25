const PASSWORD_ITERATIONS = 600_000;

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function unhex(value: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) return null;
  return Uint8Array.from(value.match(/../g) || [], (part) => parseInt(part, 16));
}

export function usernameFrom(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().normalize("NFKC").toLowerCase();
  return Array.from(name).length >= 3 && Array.from(name).length <= 32 && /^[\p{L}\p{N}_-]+$/u.test(name) ? name : null;
}

export function validPassword(value: unknown): value is string {
  return typeof value === "string" && value.length >= 12 && value.length <= 128
    && new TextEncoder().encode(value).length <= 512;
}

export function passwordSalt(): string {
  return hex(crypto.getRandomValues(new Uint8Array(16)));
}

export function validProof(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function validSalt(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

// PBKDF2 runs in the browser so registration and login fit the Workers Free CPU limit.
export async function passwordProof(password: string, saltHex: string): Promise<string> {
  if (!validSalt(saltHex)) throw new Error("密码盐值无效。");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(unhex(saltHex)!), iterations: PASSWORD_ITERATIONS }, key, 256);
  return hex(new Uint8Array(derived));
}

export async function storedPassword(proof: string, salt: string): Promise<string> {
  if (!validProof(proof) || !validSalt(salt)) throw new Error("密码验证信息无效。");
  return `pbkdf2-client-sha256$${PASSWORD_ITERATIONS}$${salt}$${await tokenHash(`${salt}:${proof}`)}`;
}

export function passwordSaltFrom(stored: string): string | null {
  const parts = stored.split("$");
  return parts.length === 4 && parts[0] === "pbkdf2-client-sha256" && parts[1] === String(PASSWORD_ITERATIONS)
    && validSalt(parts[2]) && validProof(parts[3]) ? parts[2] : null;
}

export async function verifyProof(proof: string, stored: string): Promise<boolean> {
  const salt = passwordSaltFrom(stored);
  if (!salt || !validProof(proof)) return false;
  const expected = unhex(stored.split("$")[3])!;
  const actual = unhex(await tokenHash(`${salt}:${proof}`))!;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= actual[index] ^ expected[index];
  return difference === 0;
}

export function sessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export async function tokenHash(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
