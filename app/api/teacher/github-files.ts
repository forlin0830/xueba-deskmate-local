import { extractMaterialPages } from "./material";
import { githubGetJson, githubHeaders, githubResponseError, GitHubRequestError } from "./github-api";
import type { Citation, SourceCategory } from "./model";
import type { Material } from "@/lib/learning-store";

const MAX_FILE_BYTES = 30_000_000;
type TreeItem = { path?: string; type?: string; size?: number; sha?: string };
type Candidate = Pick<Material, "repository" | "path" | "revision" | "category" | "title" | "url" | "note" | "blobSha" | "fileSize">;
type RepositoryInfo = { branch: string; description: string; tree: { tree?: TreeItem[]; truncated?: boolean } | null };
type RepositoryCache = Map<string, Promise<RepositoryInfo>>;

function repositoryFromUrl(address: string): string | null {
  try {
    const url = new URL(address);
    if (url.hostname !== "github.com") return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2 || !parts.slice(0, 2).every((part) => /^[A-Za-z0-9_.-]{1,100}$/.test(part))) return null;
    return parts[0] + "/" + parts[1].replace(/\.git$/, "");
  } catch { return null; }
}

function validCandidate(repository: string, path: string, revision: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)
    && !!path && path.length < 600 && !path.includes("\\") && !path.split("/").some((part) => !part || part === "." || part === "..")
    && /^[A-Za-z0-9_.\/-]{1,120}$/.test(revision) && !revision.includes("..");
}

function fileScore(path: string, category: SourceCategory, subject: string, repositoryContext = "", minimumYear?: number): number {
  const name = path.toLowerCase();
  const context = `${name} ${repositoryContext.toLowerCase()}`;
  const supported = /\.(?:pdf|docx|txt|md)$/i.test(name);
  const unsupported = /\.(?:zip|rar|7z|doc)$/i.test(name);
  if (!supported && !unsupported) return -100;
  const subjectName = subject.replace(/^(?:考研|高考|中考)/, "").trim();
  if (/数学/.test(subjectName)) {
    if (!/数学|math|数[一二三123]/i.test(context)) return -100;
    const requestedVersion = /数学[一1]|数一/.test(subjectName) ? "1" : /数学[二2]|数二/.test(subjectName) ? "2" : /数学[三3]|数三/.test(subjectName) ? "3" : "";
    const fileVersion = name.match(/(?:math|数学|数)[_-]?([123一二三])(?:[_./-]|$)/i)?.[1];
    if (requestedVersion && fileVersion && ({ 一: "1", 二: "2", 三: "3" }[fileVersion as "一" | "二" | "三"] || fileVersion) !== requestedVersion) return -100;
  } else if (/英语/.test(subjectName) && !/英语|english|cet|ielts|toefl/i.test(context)) return -100;
  else if (/政治/.test(subjectName) && !/政治|politic/i.test(context)) return -100;
  else if (/408|计算机/.test(subjectName) && !/408|计算机|computer/i.test(context)) return -100;
  else if (subjectName.length >= 3 && !context.includes(subjectName.toLowerCase())) return -100;
  const terms: Record<SourceCategory, RegExp> = {
    textbook: /教材|课本|教科书|参考书|textbook|ebook|book/i,
    syllabus: /大纲|考点|考试范围|课程标准|syllabus|outline/i,
    past_exam: /真题|试卷|试题|历年|past.paper|exam.paper|试卷/i,
  };
  const categoryInPath = terms[category].test(name);
  const categoryInRepository = terms[category].test(repositoryContext);
  const datedExam = category === "past_exam" && /(?:19|20)\d{2}/.test(name) && /考研|kaoyan|exam|真题|试卷|历年/i.test(repositoryContext);
  if (!categoryInPath && !categoryInRepository && !datedExam) return -100;
  let score = categoryInPath ? 12 : categoryInRepository ? 5 : 3;
  if (category === "past_exam" && /20(?:1\d|2\d)/.test(name)) score += 4;
  const years = [...name.matchAll(/20\d{2}/g)].map((match) => Number(match[0]));
  if (years.length) {
    const latest = Math.max(...years);
    if (minimumYear && latest < minimumYear) return -100;
    score += Math.max(0, Math.min(8, latest - 2020));
  }
  if (/readme/i.test(name)) score -= 5;
  if (/\.(?:md|txt)$/i.test(name)) score += 3;
  if (unsupported) score -= 20;
  score -= Math.min(path.split("/").length, 8);
  return score;
}

function candidateRecord(candidate: Candidate, status: Material["status"] = "discovered", note = candidate.note): Material {
  return {
    version: 1, id: crypto.randomUUID(), title: candidate.title, url: candidate.url, category: candidate.category,
    reliability: "github", status, origin: "github", note, summary: "", topics: [], excerpt: "",
    repository: candidate.repository, path: candidate.path, revision: candidate.revision,
    blobSha: candidate.blobSha, fileSize: candidate.fileSize, addedAt: new Date().toISOString(),
  };
}

async function repositoryInfo(repository: string, token = ""): Promise<RepositoryInfo> {
  const metadata = await githubGetJson<{ default_branch?: string; description?: string }>(`https://api.github.com/repos/${repository}`, token, 1_800_000);
  const branch = metadata?.default_branch || "";
  if (!/^[A-Za-z0-9_.\/-]{1,120}$/.test(branch) || branch.includes("..")) return { branch: "", description: "", tree: null };
  const tree = await githubGetJson<{ tree?: TreeItem[]; truncated?: boolean }>(`https://api.github.com/repos/${repository}/git/trees/${encodeURIComponent(branch)}?recursive=1`, token, 1_800_000);
  return { branch, description: metadata?.description || "", tree };
}

async function repositoryCandidates(repository: string, category: SourceCategory, subject: string, cache: RepositoryCache, minimumYear?: number, token = ""): Promise<{ files: Candidate[]; score: number }> {
  let pending = cache.get(repository);
  if (!pending) {
    pending = repositoryInfo(repository, token);
    cache.set(repository, pending);
  }
  const { branch, description, tree } = await pending;
  const repositoryContext = `${repository} ${description}`;
  if (!Array.isArray(tree?.tree)) return { files: [], score: -100 };
  const candidates = tree.tree.filter((item) => item.type === "blob" && typeof item.path === "string" && item.path.length < 600)
    .map((item) => {
      const path = item.path!;
      return { repository, path, revision: branch, category, title: `${repository}/${path}`,
        url: `https://github.com/${repository}/blob/${encodeURIComponent(branch)}/${path.split("/").map(encodeURIComponent).join("/")}`,
        fileSize: typeof item.size === "number" ? item.size : undefined,
        blobSha: item.sha,
        note: tree.truncated ? "仓库目录过大，仅检查了 GitHub 返回的部分文件。" : "GitHub 社区资料，请与官方文件核对。" } satisfies Candidate;
    });
  const files = candidates.filter((item) => !/^readme\.(?:md|txt)$/i.test(item.path || ""))
    .sort((left, right) => fileScore(right.path || "", category, subject, repositoryContext, minimumYear) - fileScore(left.path || "", category, subject, repositoryContext, minimumYear))
    .filter((item) => fileScore(item.path || "", category, subject, repositoryContext, minimumYear) > 0)
    .slice(0, 5);
  const score = Math.max(-100, ...files.filter((file) => /\.(?:pdf|docx|txt|md)$/i.test(file.path || "") && (file.fileSize === undefined || file.fileSize <= MAX_FILE_BYTES))
    .map((file) => fileScore(file.path || "", category, subject, repositoryContext, minimumYear)));
  return { files, score };
}

async function fetchGithubRaw(address: string): Promise<Response> {
  let url = new URL(address);
  for (let redirectCount = 0; redirectCount < 3; redirectCount++) {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20000) });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("GitHub 文件跳转地址缺失。");
    const next = new URL(location, url);
    if (next.protocol !== "https:" || next.username || next.password || next.port
      || (next.hostname !== "raw.githubusercontent.com" && !next.hostname.endsWith(".githubusercontent.com"))) {
      throw new Error("GitHub 文件跳转到非可信地址，已停止读取。");
    }
    url = next;
  }
  throw new Error("GitHub 文件跳转次数过多。");
}

async function downloadGithubFile(candidate: Candidate, rawUrl: string, token = ""): Promise<Uint8Array> {
  let rawError = "原始文件下载失败";
  try {
    const response = await fetchGithubRaw(rawUrl);
    if (response.ok && !/text\/html/i.test(response.headers.get("content-type") || "")) {
      if (Number(response.headers.get("content-length")) > MAX_FILE_BYTES) throw new Error("文件超过 30 MB。");
      return new Uint8Array(await response.arrayBuffer());
    }
    rawError = `原始文件下载失败（${response.status}）`;
  } catch (error) { rawError = error instanceof Error ? error.message : rawError; }
  if (!candidate.blobSha || !/^[0-9a-f]{40}$/i.test(candidate.blobSha)) throw new Error(rawError);
  const response = await fetch(`https://api.github.com/repos/${candidate.repository}/git/blobs/${candidate.blobSha}`, {
    headers: githubHeaders(token), signal: AbortSignal.timeout(45000),
  });
  if (response.status === 403 || response.status === 429 || response.status === 401) throw await githubResponseError(response, "GitHub 文件下载");
  if (!response.ok) throw new Error(`GitHub 文件下载失败（${response.status}）。`);
  const blob = await response.json() as { content?: string; encoding?: string; size?: number };
  if (typeof blob.size === "number" && blob.size > MAX_FILE_BYTES) throw new Error("文件超过 30 MB。");
  if (blob.encoding !== "base64" || !blob.content) throw new Error("GitHub 未返回可读取的文件正文。");
  return new Uint8Array(Buffer.from(blob.content.replace(/\s/g, ""), "base64"));
}

function categoryForPath(path: string): SourceCategory {
  if (/大纲|考纲|syllabus|outline/i.test(path)) return "syllabus";
  if (/教材|课本|textbook|ebook/i.test(path)) return "textbook";
  return "past_exam";
}

export async function catalogGithubRepository(address: string, subject: string, token = ""): Promise<{ materials: Material[]; total: number; truncated: boolean }> {
  const repository = repositoryFromUrl(address);
  if (!repository) throw new Error("请输入完整的 GitHub 仓库地址，例如 https://github.com/用户名/仓库名。");
  const { branch, description, tree } = await repositoryInfo(repository, token);
  if (!branch || !Array.isArray(tree?.tree)) throw new Error("无法取得仓库文件目录，请检查地址或稍后重试。");
  const blobs = tree.tree.filter((item) => item.type === "blob" && typeof item.path === "string" && item.path.length < 600);
  const materials = blobs.slice(0, 500).map((item) => {
    const path = item.path!;
    const category = categoryForPath(path);
    const candidate: Candidate = {
      repository, path, revision: branch, category, title: `${repository}/${path}`,
      url: `https://github.com/${repository}/blob/${encodeURIComponent(branch)}/${path.split("/").map(encodeURIComponent).join("/")}`,
      blobSha: item.sha, fileSize: item.size,
      note: `${typeof item.size === "number" ? `文件大小 ${(item.size / 1_000_000).toFixed(1)} MB。` : ""}已列入仓库目录；读取正文并核对后才能用于教学。`,
    };
    const score = fileScore(path, category, subject, `${repository} ${description}`);
    if (!/\.(?:pdf|docx|txt|md)$/i.test(path)) return candidateRecord(candidate, "excluded", "文件格式不支持直接提取文字。");
    if (score <= 0) return candidateRecord(candidate, "excluded", "文件名与当前科目或资料类别不匹配；不会自动读取。");
    if (typeof item.size === "number" && item.size > MAX_FILE_BYTES) return candidateRecord(candidate, "unreadable", "文件超过 30 MB，暂无法在线读取；可分卷上传文字版。");
    return candidateRecord(candidate);
  });
  return { materials, total: blobs.length, truncated: Boolean(tree.truncated || blobs.length > materials.length) };
}

export async function readGithubMaterial(candidate: Candidate, token = ""): Promise<Material> {
  const { repository = "", path = "", revision = "" } = candidate;
  if (!validCandidate(repository, path, revision)) throw new Error("GitHub 文件位置无效。");
  if (!/\.(?:pdf|docx|txt|md)$/i.test(path)) return candidateRecord(candidate, "unreadable", "压缩包或旧格式文件暂不支持直接分析，请先解压并上传其中的文字版资料。");
  if (typeof candidate.fileSize === "number" && candidate.fileSize > MAX_FILE_BYTES) return candidateRecord(candidate, "unreadable", "文件超过 30 MB，暂无法在线读取；可分卷上传文字版。");
  const url = `https://raw.githubusercontent.com/${repository}/${revision.split("/").map(encodeURIComponent).join("/")}/${path.split("/").map(encodeURIComponent).join("/")}`;
  try {
    const bytes = await downloadGithubFile(candidate, url, token);
    if (bytes.byteLength > MAX_FILE_BYTES) return candidateRecord(candidate, "unreadable", "文件超过 30 MB。");
    const file = new File([new Uint8Array(bytes)], path.split("/").at(-1) || "material.txt");
    const extracted = await extractMaterialPages(file);
    if (extracted.needsOcr.length) return candidateRecord(candidate, "ocr_needed", `第 ${extracted.needsOcr.join("、")} 页需要 OCR；请在仓库目录中点击“完整读取”。`);
    const completeText = extracted.pages.map((page) => page.text).join("\n");
    if (/^version https:\/\/git-lfs\.github\.com\/spec\/v1/m.test(completeText)) return candidateRecord(candidate, "unreadable", "这是 Git LFS 占位文件，没有试卷正文。");
    if (completeText.replace(/\s/g, "").length < 120) return candidateRecord(candidate, "unreadable", "可提取正文不足 120 字，无法可靠核对科目和资料类别。");
    if (completeText.length > 12_000) return candidateRecord(candidate, "discovered", "文件正文较长；请在仓库目录中点击“完整读取”，逐段核对全部内容。");
    return { ...candidateRecord(candidate, "read", candidate.note), excerpt: completeText,
      coverage: { total: extracted.totalPages, processed: extracted.totalPages, ocr: 0, unit: extracted.unit,
        analyzedParts: 1, sha256: extracted.sha256, complete: true, checkedAt: new Date().toISOString() } };
  } catch (error) {
    const message = error instanceof Error ? error.message : "文件无法读取";
    if (error instanceof GitHubRequestError) throw error;
    return candidateRecord(candidate, /扫描版|OCR|足够文字/.test(message) ? "ocr_needed" : "unreadable", /扫描版|OCR|足够文字/.test(message)
      ? "扫描版 PDF 没有可提取文字，需要先 OCR。" : /password|encrypted|加密/i.test(message)
        ? "加密文件无法读取，请解锁后上传文字版资料。" : `文件无法解析：${message.slice(0, 120)}`);
  }
}

export async function downloadGithubDocument(candidate: Candidate, token = ""): Promise<File> {
  const { repository = "", path = "", revision = "" } = candidate;
  if (!validCandidate(repository, path, revision) || !/\.(?:pdf|docx|txt|md)$/i.test(path)) throw new Error("GitHub 文件位置或格式无效。");
  if (typeof candidate.fileSize === "number" && candidate.fileSize > MAX_FILE_BYTES) throw new Error("文件超过 30 MB，请分卷处理。");
  const url = `https://raw.githubusercontent.com/${repository}/${revision.split("/").map(encodeURIComponent).join("/")}/${path.split("/").map(encodeURIComponent).join("/")}`;
  const bytes = await downloadGithubFile(candidate, url, token);
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error("文件超过 30 MB，请分卷处理。");
  return new File([new Uint8Array(bytes)], path.split("/").at(-1) || "material.txt");
}

export async function discoverGithubMaterials(sources: Citation[], category: SourceCategory, subject: string, minimumYear?: number, cache: RepositoryCache = new Map(), token = ""): Promise<Material[]> {
  const repositories = Array.from(new Set(sources.map((source) => repositoryFromUrl(source.url)).filter((item): item is string => !!item))).slice(0, 2);
  const inspected = await Promise.all(repositories.map(async (repository) => ({ repository,
    ...(await repositoryCandidates(repository, category, subject, cache, minimumYear, token)),
  })));
  inspected.sort((left, right) => right.score - left.score);
  const selected = inspected.flatMap(({ files }) => files.slice(0, 2))
    .filter((file) => /\.(?:pdf|docx|txt|md)$/i.test(file.path || "") && (file.fileSize === undefined || file.fileSize <= MAX_FILE_BYTES))
    .slice(0, 2);
  // PDF parsing now runs in the visitor's browser after they choose a file.
  return selected.map((candidate) => candidateRecord(candidate));
}

export function githubCandidateFromInput(value: unknown): Candidate | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (typeof item.repository !== "string" || typeof item.path !== "string" || typeof item.revision !== "string"
    || !validCandidate(item.repository, item.path, item.revision)
    || (item.category !== "textbook" && item.category !== "syllabus" && item.category !== "past_exam")) return null;
  return { repository: item.repository, path: item.path, revision: item.revision, category: item.category,
    title: `${item.repository}/${item.path}`, url: `https://github.com/${item.repository}/blob/${encodeURIComponent(item.revision)}/${item.path.split("/").map(encodeURIComponent).join("/")}`,
    blobSha: typeof item.blobSha === "string" && /^[0-9a-f]{40}$/i.test(item.blobSha) ? item.blobSha : undefined,
    fileSize: typeof item.fileSize === "number" && Number.isSafeInteger(item.fileSize) && item.fileSize >= 0 ? item.fileSize : undefined,
    note: "GitHub 社区资料，请与官方文件核对。" };
}
