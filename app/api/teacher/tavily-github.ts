import type { Citation, SourceCategory } from "./model";

function githubRepository(address: unknown): string | null {
  if (typeof address !== "string") return null;
  try {
    const url = new URL(address);
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.username || url.password) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2 || !parts.slice(0, 2).every((part) => /^[A-Za-z0-9_.-]{1,100}$/.test(part))) return null;
    const repository = parts[1].replace(/\.git$/, "");
    return repository ? `${parts[0]}/${repository}` : null;
  } catch { return null; }
}

function serviceDetail(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const detail = (data as { detail?: unknown; error?: unknown }).detail || (data as { error?: unknown }).error;
  if (typeof detail === "string") return detail.slice(0, 160);
  if (detail && typeof detail === "object" && typeof (detail as { error?: unknown }).error === "string") {
    return String((detail as { error: string }).error).slice(0, 160);
  }
  return "";
}

export async function tavilyGithubSearch(key: string, query: string, category: SourceCategory): Promise<{ sources: Citation[] }> {
  let response: Response;
  try {
    response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: `site:github.com ${query}`.slice(0, 400), search_depth: "basic", max_results: 8,
        include_domains: ["github.com"], include_domains_mode: "restrict", include_answer: false, include_raw_content: false }),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error("Tavily 搜索连接超时或暂不可用，请稍后重试。");
  }
  const data = await response.json().catch(() => ({})) as { results?: unknown };
  if (!response.ok) {
    const detail = serviceDetail(data);
    if (response.status === 401 || response.status === 403) throw new Error("Tavily 密钥无效或没有搜索权限。" + (detail ? ` 服务商提示：${detail}` : ""));
    if (response.status === 429 || response.status === 432 || response.status === 433) throw new Error("Tavily 搜索额度或请求频率已达到限制。" + (detail ? ` 服务商提示：${detail}` : ""));
    throw new Error(`Tavily 搜索失败（${response.status}）。` + (detail ? ` 服务商提示：${detail}` : ""));
  }
  const repositories = new Set<string>();
  for (const result of Array.isArray(data.results) ? data.results : []) {
    if (!result || typeof result !== "object") continue;
    const repository = githubRepository((result as { url?: unknown }).url);
    if (repository) repositories.add(repository);
  }
  return { sources: [...repositories].slice(0, 6).map((repository) => ({
    title: repository, url: `https://github.com/${repository}`, category, reliability: "github" as const,
  })) };
}
