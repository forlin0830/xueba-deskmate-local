import { tokenHash } from "./cloud-auth";

export type CloudAccount = { id: string; username?: string; legacy?: boolean };

export function cloudCookieValue(request: Request): string {
  return request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith("xueba_cloud="))?.slice("xueba_cloud=".length) || "";
}

export function validCloudToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export async function cloudAccount(db: D1Database, request: Request): Promise<CloudAccount | null> {
  const code = cloudCookieValue(request);
  if (!validCloudToken(code)) return null;
  const digest = await tokenHash(code);
  const session = await db.prepare("SELECT a.id, c.username FROM cloud_sessions s JOIN cloud_accounts a ON a.id=s.user_id JOIN cloud_credentials c ON c.user_id=a.id WHERE s.token_hash=? AND s.expires_at>?")
    .bind(digest, Date.now()).first<{ id: string; username: string }>();
  if (session) return session;
  const legacy = await db.prepare("SELECT a.id FROM cloud_accounts a LEFT JOIN cloud_credentials c ON c.user_id=a.id WHERE a.key_hash=? AND c.user_id IS NULL")
    .bind(digest).first<{ id: string }>();
  return legacy ? { ...legacy, legacy: true } : null;
}
