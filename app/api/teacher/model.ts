import { env } from "cloudflare:workers";
import { githubGetJson, GitHubRequestError } from "./github-api";
import type { Provider, QwenRegion } from "./key-store";

export type SourceCategory = "textbook" | "syllabus" | "past_exam";
export type SourceReliability = "official" | "github" | "reference";
export type Citation = { title: string; url: string; category?: SourceCategory; reliability?: SourceReliability };
export type GLMModel = "glm-5.3-flashx" | "glm-5.3-flash" | "glm-5.2";
type Schema = { name: string; value: unknown };
type ModelAnswer = { result: unknown; sources: Citation[] };
type Message = { role: "system" | "user" | "assistant"; content: string };

class ModelServiceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function workerValue(name: string, fallback: string): string {
  const values = env as unknown as Record<string, string | undefined>;
  return values[name] || process.env[name] || fallback;
}

export function parseGLMModel(value: unknown): GLMModel {
  return value === "glm-5.3-flashx" || value === "glm-5.3-flash" || value === "glm-5.2" ? value : "glm-5.3-flash";
}

function safeSources(raw: unknown): Citation[] {
  if (!Array.isArray(raw)) return [];
  const found: Citation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const source = item as { title?: unknown; url?: unknown; link?: unknown };
    const address = typeof source.url === "string" ? source.url : source.link;
    if (typeof address !== "string") continue;
    try {
      const url = new URL(address);
      if (url.protocol !== "https:" || found.some((entry) => entry.url === url.href)) continue;
      found.push({ title: typeof source.title === "string" ? source.title.slice(0, 140) : url.hostname, url: url.href });
    } catch { /* Ignore malformed links. */ }
  }
  return found.slice(0, 8);
}

export async function githubSearch(query: string, category: SourceCategory, minimumYear?: number, token = ""): Promise<{ context: string; sources: Citation[] }> {
  try {
    const data = await githubGetJson<{ items?: unknown }>("https://api.github.com/search/repositories?q=" + encodeURIComponent(query.slice(0, 180)) + "&per_page=8", token);
    if (!data) return { context: "", sources: [] };
    const items = Array.isArray(data.items) ? data.items.filter((item) => {
      if (!item || typeof item !== "object") return false;
      const repository = item as { archived?: unknown; updated_at?: unknown; name?: unknown; description?: unknown };
      if (repository.archived === true || /盗版|破解|网盘|扫描版/.test(String(repository.name || "") + " " + String(repository.description || ""))) return false;
      return isRecentSource(repository.name, repository.updated_at, minimumYear);
    }).slice(0, 6) : [];
    const sources = items.flatMap((item) => {
      const repository = item as { full_name?: unknown; html_url?: unknown; description?: unknown };
      if (typeof repository.full_name !== "string" || typeof repository.html_url !== "string") return [];
      return [{ title: repository.full_name, url: repository.html_url, category, reliability: "github" as const }];
    });
    const context = items.map((item, index) => {
      const repository = item as { full_name?: unknown; html_url?: unknown; description?: unknown; updated_at?: unknown; stargazers_count?: unknown; license?: { spdx_id?: unknown } | null };
      return JSON.stringify({ index: index + 1, source: "GitHub", repository: repository.full_name, url: repository.html_url, description: repository.description, updatedAt: repository.updated_at, stars: repository.stargazers_count, license: repository.license?.spdx_id || "未标注" });
    }).join("\n");
    return { context, sources };
  } catch (error) {
    if (error instanceof GitHubRequestError) throw error;
    return { context: "", sources: [] };
  }
}

function isRecentSource(title: unknown, date: unknown, minimumYear?: number): boolean {
  if (!minimumYear) return true;
  const years = (String(title || "") + " " + String(date || "")).match(/20\d{2}/g)?.map(Number) || [];
  return !years.length || Math.max(...years) >= minimumYear;
}

function openAIOutput(data: Record<string, unknown>): string {
  const output = Array.isArray(data.output) ? data.output : [];
  return output.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    return content.filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "output_text")
      .map((part) => (part as { text?: string }).text || "");
  }).join("\n").trim();
}

function openAICitations(data: Record<string, unknown>): Citation[] {
  const annotations: unknown[] = [];
  const output = Array.isArray(data.output) ? data.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const parts = (part as { annotations?: unknown }).annotations;
      if (Array.isArray(parts)) annotations.push(...parts.filter((entry) => entry && typeof entry === "object" && (entry as { type?: string }).type === "url_citation"));
    }
  }
  return safeSources(annotations);
}

function messagesFrom(input: unknown, instructions: string, schema?: Schema): Message[] {
  const format = schema ? "\n请只输出符合以下 JSON Schema 的 JSON 对象，不要添加 Markdown 或其他文字：\n" + JSON.stringify(schema.value) : "";
  const messages: Message[] = [{ role: "system", content: instructions + format }];
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") continue;
      const candidate = item as { role?: unknown; content?: unknown };
      const role = candidate.role === "assistant" ? "assistant" : "user";
      const content = typeof candidate.content === "string" ? candidate.content : JSON.stringify(candidate.content);
      messages.push({ role, content });
    }
  } else {
    messages.push({ role: "user", content: typeof input === "string" ? input : JSON.stringify(input) });
  }
  return messages;
}

function parsedResult(content: string, schema?: Schema): unknown {
  if (!content.trim()) throw new Error("模型没有返回可用内容，请重试。");
  if (!schema) return content.trim();
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(cleaned) as unknown; }
  catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)) as unknown; }
      catch { /* Fall through to the user-facing error. */ }
    }
    throw new Error("模型返回格式不完整，请重试。");
  }
}

function serviceMessage(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const value = data as { message?: unknown; msg?: unknown; error?: unknown };
  if (typeof value.message === "string") return value.message;
  if (typeof value.msg === "string") return value.msg;
  if (typeof value.error === "string") return value.error;
  if (value.error && typeof value.error === "object" && typeof (value.error as { message?: unknown }).message === "string") return String((value.error as { message?: unknown }).message);
  return "";
}

async function checkedJson(url: string, key: string, body: Record<string, unknown>, timeoutMs = 90000): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new ModelServiceError("模型服务响应超时。请改用响应更快的模型，或缩小本次资料范围。", 504);
    }
    throw error;
  }
  const raw = await response.text();
  let data: Record<string, unknown> = {};
  try { data = raw ? JSON.parse(raw) as Record<string, unknown> : {}; }
  catch { if (response.ok) throw new Error("模型服务返回了无法读取的数据，请重试。"); }
  if (!response.ok) {
    const detail = serviceMessage(data).slice(0, 180);
    if (response.status === 401) throw new ModelServiceError("API 密钥无效。请确认使用的是开放平台模型 API 密钥，而不是编程套餐专用 Key。" + (detail ? " 服务商提示：" + detail : ""), response.status);
    if (response.status === 403) throw new ModelServiceError("当前密钥没有该模型或搜索服务的权限。" + (detail ? " 服务商提示：" + detail : ""), response.status);
    if (response.status === 429) throw new ModelServiceError("API 余额、并发数或请求频率已达到限制。" + (detail ? " 服务商提示：" + detail : ""), response.status);
    throw new ModelServiceError("模型服务请求失败（" + response.status + "）。" + (detail ? " 服务商提示：" + detail : ""), response.status);
  }
  return data;
}

function chatContent(data: Record<string, unknown>): string {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0] as { message?: { content?: unknown } } | undefined;
  const content = first?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const value = part as { text?: unknown; content?: unknown };
    return typeof value.text === "string" ? [value.text] : typeof value.content === "string" ? [value.content] : [];
  }).join("\n");
  return "";
}

async function callOpenAI(key: string, instructions: string, input: unknown, schema?: Schema): Promise<ModelAnswer> {
  const body: Record<string, unknown> = {
    model: workerValue("OPENAI_MODEL", "gpt-5.6-terra"),
    instructions,
    input,
    store: false,
    max_output_tokens: 3000,
    reasoning: { effort: "low" },
  };
  if (schema) body.text = { format: { type: "json_schema", name: schema.name, strict: true, schema: schema.value } };
  const data = await checkedJson("https://api.openai.com/v1/responses", key, body);
  return { result: parsedResult(openAIOutput(data), schema), sources: openAICitations(data) };
}

function qwenHost(region: QwenRegion): string {
  return region === "cn-beijing" ? "https://dashscope.aliyuncs.com" : "https://dashscope-intl.aliyuncs.com";
}

async function callQwen(key: string, region: QwenRegion, instructions: string, input: unknown, schema?: Schema): Promise<ModelAnswer> {
  const messages = messagesFrom(input, instructions, schema);
  const model = workerValue("QWEN_MODEL", "qwen-plus");
  const body: Record<string, unknown> = { model, messages, max_tokens: 3000 };
  if (schema) body.response_format = { type: "json_object" };
  const data = await checkedJson(qwenHost(region) + "/compatible-mode/v1/chat/completions", key, body);
  return { result: parsedResult(chatContent(data), schema), sources: [] };
}

async function callGLM(key: string, model: GLMModel, instructions: string, input: unknown, schema?: Schema): Promise<ModelAnswer> {
  const messages = messagesFrom(input, instructions, schema);
  const maxTokens = schema?.name === "preliminary_plan" ? 1800 : schema ? 2600 : 3000;
  const body: Record<string, unknown> = { model, messages, max_tokens: maxTokens };
  if (schema) {
    body.thinking = { type: "enabled" };
    body.reasoning_effort = "low";
  }
  if (schema) body.response_format = { type: "json_object" };
  try {
    const data = await checkedJson("https://open.bigmodel.cn/api/paas/v4/chat/completions", key, body);
    return { result: parsedResult(chatContent(data), schema), sources: [] };
  } catch (error) {
    if (schema && error instanceof ModelServiceError && error.status === 400) {
      delete body.response_format;
      const data = await checkedJson("https://open.bigmodel.cn/api/paas/v4/chat/completions", key, body);
      return { result: parsedResult(chatContent(data), schema), sources: [] };
    }
    throw error;
  }
}

export function callModel(provider: Provider, region: QwenRegion, key: string, instructions: string, input: unknown, schema?: Schema, _search = false, glmModel: GLMModel = "glm-5.3-flash"): Promise<ModelAnswer> {
  if (_search) throw new Error("当前仅支持检索 GitHub 文件。");
  if (provider === "qwen") return callQwen(key, region, instructions, input, schema);
  if (provider === "glm") return callGLM(key, glmModel, instructions, input, schema);
  return callOpenAI(key, instructions, input, schema);
}
