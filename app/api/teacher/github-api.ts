const HEADERS = { Accept: "application/vnd.github+json", "User-Agent": "xueba-deskmate" };
const memory = new Map<string, { expires: number; value: unknown }>();
const pending = new Map<string, Promise<unknown | null>>();

export class GitHubRequestError extends Error {}

export async function githubResponseError(response: Response, label: string): Promise<GitHubRequestError> {
  const body = await response.clone().json().catch(() => ({})) as { message?: unknown };
  const detail = typeof body.message === "string" ? body.message.slice(0, 120) : "";
  const remaining = response.headers.get("x-ratelimit-remaining");
  const isLimited = response.status === 429 || remaining === "0" || /rate limit|secondary rate|abuse detection/i.test(detail);
  if (isLimited) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    const wait = remaining === "0" && reset > Date.now() / 1000
      ? `北京时间 ${new Date(reset * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })} 后重试。`
      : retryAfter > 0 ? `请约 ${Math.ceil(retryAfter / 60)} 分钟后重试。` : "请至少 1 分钟后重试。";
    return new GitHubRequestError(`${label}请求已达到 GitHub 限制。${wait}已保存的资料仍可使用。`);
  }
  if (response.status === 401) return new GitHubRequestError("GitHub 访问令牌无效，请在网站中移除或更换。");
  return new GitHubRequestError(`${label}失败（${response.status}）。${detail}`);
}

export async function githubGetJson<T>(url: string, token = "", ttlMs = 600_000): Promise<T | null> {
  const cacheKey = `${token}\u0000${url}`;
  const cached = memory.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value as T;
  const inflight = pending.get(cacheKey);
  if (inflight) return await inflight as T | null;
  const task = (async () => {
    try {
      const response = await fetch(url, {
        headers: { ...HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(15000),
      });
      if (response.status === 403 || response.status === 429 || response.status === 401) throw await githubResponseError(response, "GitHub API");
      if (!response.ok) return null;
      const value = await response.json() as T;
      if (memory.size >= 150) memory.delete(memory.keys().next().value!);
      memory.set(cacheKey, { value, expires: Date.now() + ttlMs });
      return value;
    } catch (error) {
      if (error instanceof GitHubRequestError) throw error;
      return null;
    }
  })();
  pending.set(cacheKey, task);
  try { return await task; }
  finally { pending.delete(cacheKey); }
}

export function githubHeaders(token = ""): HeadersInit {
  return { ...HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
