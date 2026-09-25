import { env } from "cloudflare:workers";

export type Provider = "openai" | "qwen" | "glm";
export type ApiService = Provider | "tavily" | "github";
export type QwenRegion = "cn-beijing" | "ap-southeast-1";

const LEGACY_COOKIE_NAME = "xueba_teacher_key";
const COOKIE_PREFIX = "xueba_teacher_key_";
const MAX_AGE = 60 * 60 * 24 * 30;

export function parseProvider(value: unknown): Provider | null {
  return value === "openai" || value === "qwen" || value === "glm" ? value : null;
}

export function parseApiService(value: unknown): ApiService | null {
  return value === "tavily" || value === "github" ? value : parseProvider(value);
}

export function parseRegion(value: unknown): QwenRegion {
  return value === "ap-southeast-1" ? value : "cn-beijing";
}

function cookieName(provider: ApiService, region: QwenRegion): string {
  return COOKIE_PREFIX + (provider === "qwen" ? "qwen_" + (region === "cn-beijing" ? "cn" : "sg") : provider);
}

function workerValue(name: string): string {
  const values = env as unknown as Record<string, string | undefined>;
  return values[name] || process.env[name] || "";
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sealingKey(): Promise<CryptoKey | null> {
  const secret = workerValue("TEACHER_CREDENTIAL_SEAL");
  if (!secret) return null;
  try {
    const bytes = base64UrlToBytes(secret);
    if (bytes.length !== 32) return null;
    return await crypto.subtle.importKey("raw", bytes.buffer as ArrayBuffer, "AES-GCM", false, ["encrypt", "decrypt"]);
  } catch {
    return null;
  }
}

export function canSaveKey(): boolean {
  return Boolean(workerValue("TEACHER_CREDENTIAL_SEAL"));
}

function findCookie(request: Request, name: string): string {
  const raw = (request.headers.get("cookie") || "").split(";").map((part) => part.trim())
    .find((part) => part.startsWith(name + "="));
  return raw?.slice(name.length + 1) || "";
}

export async function getApiKey(request: Request, provider: ApiService, region: QwenRegion): Promise<string> {
  const environmentKeys: Record<ApiService, string> = {
    openai: "OPENAI_API_KEY",
    qwen: region === "cn-beijing" ? "DASHSCOPE_API_KEY" : "DASHSCOPE_INTL_API_KEY",
    glm: "ZHIPU_API_KEY",
    tavily: "TAVILY_API_KEY",
    github: "GITHUB_API_TOKEN",
  };
  const configured = workerValue(environmentKeys[provider]);
  if (configured) return configured;
  const key = await sealingKey();
  if (!key) return "";
  const encoded = findCookie(request, cookieName(provider, region))
    || (provider === "openai" ? findCookie(request, LEGACY_COOKIE_NAME) : "");
  if (!encoded) return "";
  try {
    const packed = base64UrlToBytes(encoded);
    const iv = packed.slice(0, 12);
    const ciphertext = packed.slice(12);
    if (iv.length !== 12 || ciphertext.length < 17) return "";
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv.buffer as ArrayBuffer }, key, ciphertext.buffer as ArrayBuffer);
    return new TextDecoder().decode(plain);
  } catch {
    return "";
  }
}

export async function cookieForKey(value: string, request: Request, provider: ApiService, region: QwenRegion): Promise<string> {
  const key = await sealingKey();
  if (!key) throw new Error("服务器尚未启用密钥加密配置。");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value)));
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv);
  packed.set(ciphertext, iv.length);
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return cookieName(provider, region) + "=" + bytesToBase64Url(packed) + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=" + MAX_AGE + secure;
}

export function clearedCookies(request: Request, provider: ApiService, region: QwenRegion): string[] {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  const names = [cookieName(provider, region)];
  if (provider === "openai") names.push(LEGACY_COOKIE_NAME);
  return names.map((name) => name + "=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" + secure);
}
