import { getApiKey } from "../key-store";

const OCR_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/layout_parsing";
const MAX_BODY_BYTES = 8_000_000;

export async function POST(request: Request): Promise<Response> {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    return Response.json({ error: "请求来源无效。" }, { status: 403 });
  }
  const length = Number(request.headers.get("content-length"));
  if (request.headers.get("content-type") !== "application/json" || !Number.isSafeInteger(length)
    || length < 100 || length > MAX_BODY_BYTES || !request.body) {
    return Response.json({ error: "OCR 页面数据过大或格式无效。" }, { status: 413 });
  }
  const key = await getApiKey(request, "glm", "cn-beijing");
  if (!key) return Response.json({ error: "扫描页需要智谱 OCR 密钥，请先在上方保存智谱 API 密钥。" }, { status: 503 });
  try {
    // Forward one browser-rendered page without decoding its base64 payload in the Worker.
    const upstream = await fetch(OCR_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: request.body,
      signal: AbortSignal.timeout(300_000),
    });
    return new Response(upstream.body, { status: upstream.status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "OCR 服务暂时无法连接。已完成的页面保存在当前浏览器，重新读取可继续。" }, { status: 502 });
  }
}
