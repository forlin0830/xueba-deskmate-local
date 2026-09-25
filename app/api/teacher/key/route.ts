import { canSaveKey, clearedCookies, cookieForKey, parseApiService, parseRegion } from "../key-store";

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return Boolean(origin && origin === new URL(request.url).origin);
}

async function readSelection(request: Request) {
  if (Number(request.headers.get("content-length")) > 2000) throw new Error("请求内容过长。");
  const body = await request.json() as { key?: unknown; provider?: unknown; region?: unknown };
  const provider = parseApiService(body.provider);
  if (!provider) throw new Error("请选择有效的模型服务商。");
  return { body, provider, region: parseRegion(body.region) };
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "请求来源无效。" }, { status: 403 });
  if (!canSaveKey()) return Response.json({ error: "网站尚未启用安全密钥保存。" }, { status: 503 });
  try {
    const { body, provider, region } = await readSelection(request);
    const key = typeof body.key === "string" ? body.key.trim() : "";
    if (!/^[A-Za-z0-9._-]{20,500}$/.test(key) || (provider === "openai" && !key.startsWith("sk-")) || (provider === "tavily" && !key.startsWith("tvly-"))
      || (provider === "github" && !/^(?:github_pat_|ghp_|gho_)/.test(key))) {
      return Response.json({ error: "请输入有效的 API 密钥。" }, { status: 400 });
    }
    const response = Response.json({ saved: true });
    response.headers.set("Set-Cookie", await cookieForKey(key, request, provider, region));
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法保存密钥，请重试。";
    return Response.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: "请求来源无效。" }, { status: 403 });
  try {
    const { provider, region } = await readSelection(request);
    const response = Response.json({ removed: true });
    for (const cookie of clearedCookies(request, provider, region)) response.headers.append("Set-Cookie", cookie);
    response.headers.set("Cache-Control", "no-store");
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法移除密钥。";
    return Response.json({ error: message }, { status: 400 });
  }
}
