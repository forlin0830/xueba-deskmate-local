"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, SetStateAction } from "react";
import { ArrowRight, BookOpen, Check, CircleHelp, Download, FilePlus2, GraduationCap, MessageCircle, Plus, RotateCcw, Sparkles, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { MathText } from "./math-text";
import { ReinforcementCard } from "./reinforcement-card";
import { ContributionDialog, LibraryPanel } from "./library-panel";
import { deleteDocument, deleteDraft, documentsForExport, getDocument, getDraft, saveDocument, saveDraft, validDocument } from "@/lib/document-store";
import type { StoredDocument } from "@/lib/document-store";
import { extractClientDocument } from "@/lib/client-document";
import { archiveDigest, cloudGet, cloudPost, receiveArchive, sendArchive } from "@/lib/cloud-client";
import type { CloudSnapshot } from "@/lib/cloud-client";
import { libraryPost } from "@/lib/library-client";
import type { LibraryDetail } from "@/lib/library-client";
import { passwordProof, passwordSalt, validPassword } from "@/lib/cloud-auth";
import { chunkDocument, representativeExcerpt } from "@/lib/document-chunks";
import { dueReviewTargets, failReview, passReview, restartReviewAfterReinforcement, startReview } from "@/lib/review-schedule";
import { groundedTopics, initialProfile, loadArchive, matchedPreliminaryTopic, newArchive, newId, newSpace, parseArchive, reconciledProgress, safeWebSources, saveArchive, spaceName, withoutMaterial } from "@/lib/learning-store";
import type { Assessment, DiagnosticRecord, Difficulty, LearningArchive, LearningSpace, Material, PreliminaryMap, Profile, Question, QuestionType, ReinforcementAttempt, ReviewSchedule, Source, SourceCategory, TopicEvidence, TopicStatus } from "@/lib/learning-store";

type Provider = "openai" | "qwen" | "glm";
type QwenRegion = "cn-beijing" | "ap-southeast-1";
type GLMModel = "glm-5.3-flashx" | "glm-5.3-flash" | "glm-5.2";
type SearchProvider = "github" | "tavily";
const PROVIDER_STORAGE_KEY = "xueba-deskmate-provider-v1";
const CLOUD_SYNC_KEY = "xueba-private-cloud-sync-v1";
const PROVIDER_NAMES: Record<Provider, string> = { openai: "OpenAI", qwen: "通义千问", glm: "智谱 GLM" };
const GLM_MODELS: Array<{ value: GLMModel; label: string }> = [
  { value: "glm-5.3-flashx", label: "GLM-5.3-FlashX" },
  { value: "glm-5.3-flash", label: "GLM-5.3-Flash" },
  { value: "glm-5.2", label: "GLM-5.2" },
];
const PROVIDER_KEY_LINKS: Record<Provider, string> = {
  openai: "https://platform.openai.com/api-keys",
  qwen: "https://bailian.console.aliyun.com/",
  glm: "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
};
const SOURCE_GROUPS: Array<{ category: SourceCategory; label: string }> = [
  { category: "syllabus", label: "考试大纲与考点范围" },
  { category: "textbook", label: "教材与电子书" },
  { category: "past_exam", label: "往年真题" },
];
const initialArchive: LearningArchive = {
  version: 2, activeSpaceId: "initial", spaces: [{
    version: 1, id: "initial", name: spaceName(initialProfile), institution: "", profile: initialProfile,
    materials: [], diagnostics: [], reviews: [], createdAt: "", updatedAt: "",
  }],
};
const MATERIAL_STATUS: Record<Material["status"], string> = {
  discovered: "已发现 · 未读取", read: "已读取", verified: "已核对", ocr_needed: "需要 OCR", unreadable: "无法读取", excluded: "未通过核对",
};

async function api(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch("/api/teacher", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(120000),
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "TimeoutError") throw new Error("模型在 2 分钟内没有响应。请测试连接，或检查服务商额度和模型权限。");
    throw cause;
  }
  let data: Record<string, unknown>;
  try {
    data = await response.json() as Record<string, unknown>;
  } catch {
    throw new Error(response.ok
      ? "服务器返回了无法读取的数据，请重试。"
      : "请求执行时间过长或模型服务暂不可用，请稍后重试。");
  }
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "请求失败，请重试。");
  return data;
}

async function recognizeOcrPage(image: string, pageNumber: number): Promise<string> {
  let response: Response;
  try {
    response = await fetch("/api/teacher/ocr-page", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm-ocr", file: image }),
      signal: AbortSignal.timeout(300_000),
    });
  } catch { throw new Error(`第 ${pageNumber} 页 OCR 连接失败；已完成的页面保存在当前浏览器，重新读取可继续。`); }
  const data = await response.json().catch(() => ({})) as { error?: unknown; message?: unknown; msg?: unknown; layout_details?: unknown };
  if (!response.ok) {
    const detail = typeof data.error === "string" ? data.error : typeof data.message === "string" ? data.message : typeof data.msg === "string" ? data.msg : "";
    throw new Error(`第 ${pageNumber} 页 OCR 失败（${response.status}）${detail ? `：${detail.slice(0, 150)}` : ""}。重新读取可继续。`);
  }
  const layouts = Array.isArray(data.layout_details) ? data.layout_details : [];
  if (layouts.length !== 1 || !Array.isArray(layouts[0])) throw new Error(`第 ${pageNumber} 页 OCR 返回的页数不匹配，未将其标为已读取。`);
  const text = layouts[0].flatMap((value: unknown) => {
    if (!value || typeof value !== "object") return [];
    const block = value as { label?: unknown; content?: unknown };
    return block.label !== "image" && typeof block.content === "string" ? [block.content] : [];
  }).join("\n").trim();
  if (text.replace(/\s/g, "").length < 10) throw new Error(`第 ${pageNumber} 页 OCR 正文不足，需核对原页；整份文件尚未标为已读取。`);
  return text;
}

async function fetchGithubDocument(material: Material): Promise<File> {
  const repository = material.repository || "";
  const revision = material.revision || "";
  const path = material.path || "";
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repository)
    || !/^[A-Za-z0-9_.\/-]{1,120}$/.test(revision) || revision.includes("..")
    || !path || path.length >= 600 || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")
    || !/\.(?:pdf|docx|txt|md)$/i.test(path)) throw new Error("GitHub 文件位置或格式无效。");
  if (material.fileSize && material.fileSize > 30_000_000) throw new Error("文件超过 30 MB，请分卷处理。");
  const url = `https://raw.githubusercontent.com/${repository}/${revision.split("/").map(encodeURIComponent).join("/")}/${path.split("/").map(encodeURIComponent).join("/")}`;
  let response: Response;
  try { response = await fetch(url, { signal: AbortSignal.timeout(90_000) }); }
  catch { throw new Error("浏览器无法下载 GitHub 文件。请检查网络或把文件下载后上传。" ); }
  if (!response.ok) throw new Error(`GitHub 文件下载失败（${response.status}）。`);
  if (Number(response.headers.get("content-length")) > 30_000_000) throw new Error("文件超过 30 MB，请分卷处理。");
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 30_000_000) throw new Error("文件超过 30 MB，请分卷处理。");
  const file = new File([bytes], path.split("/").at(-1) || "material.pdf");
  if (file.size < 1000 && (await file.text()).startsWith("version https://git-lfs.github.com/spec/v1")) {
    throw new Error("这是 Git LFS 占位文件，没有试卷正文。");
  }
  return file;
}

function statusClass(status: TopicStatus): string {
  if (status === "已掌握") return "mastered";
  if (status === "待加强") return "weak";
  if (status === "待复测") return "retest";
  return "untested";
}

function difficultyLabel(difficulty: Difficulty): string {
  return difficulty === "foundation" ? "基础" : difficulty === "advanced" ? "进阶" : "综合";
}

function updatedEvidence(current: TopicEvidence | undefined, difficulty: Difficulty, verdict: "mastered" | "partial" | "weak"): TopicEvidence {
  const attempted = Array.from(new Set([...(current?.attempted || []), difficulty]));
  const passed = verdict === "mastered"
    ? Array.from(new Set([...(current?.passed || []), difficulty]))
    : (current?.passed || []).filter((item) => item !== difficulty);
  return { attempted, passed };
}

function statusFromEvidence(evidence: TopicEvidence, verdict: "mastered" | "partial" | "weak"): TopicStatus {
  if (verdict !== "mastered") return "待加强";
  const hasHigherLevel = evidence.passed.includes("advanced") || evidence.passed.includes("integrated");
  return evidence.passed.length >= 2 && hasHigherLevel ? "已掌握" : "待复测";
}

function QuestionBasis({ question, basis, materials }: { question: Question; basis: "preliminary" | "verified"; materials: Material[] }) {
  const source = question.source;
  const syllabus = materials.find((material) => material.id === source?.syllabusId);
  const pastExam = materials.find((material) => material.id === source?.pastExamId);
  return <div className="question-basis">
    <span className={question.purpose === "review" ? "review-label" : ""}>{question.purpose === "review" ? "复测题" : "诊断题"}</span>
    <span>{source ? source.kind === "adapted" ? "AI 改编题" : "AI 原创题" : "旧题 · 依据未记录"}</span>
    <span>{basis === "verified" ? source?.syllabusTitle
      ? <>考纲《{syllabus?.url?.startsWith("https://") ? <a href={syllabus.url} target="_blank" rel="noopener noreferrer">{source.syllabusTitle}</a> : source.syllabusTitle}》：{question.topic}</>
      : `考纲知识点：${question.topic}` : `初步知识点（待考纲核对）：${question.topic}`}</span>
    {source?.kind === "adapted" && source.pastExamTitle && <span>参考已读取真题《{pastExam?.url?.startsWith("https://")
      ? <a href={pastExam.url} target="_blank" rel="noopener noreferrer">{source.pastExamTitle}</a> : source.pastExamTitle}》</span>}
  </div>;
}

export default function Home() {
  const [archive, setArchive] = useState<LearningArchive>(initialArchive);
  const [hydrated, setHydrated] = useState(false);
  const [persistenceReady, setPersistenceReady] = useState(true);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [keySetupAvailable, setKeySetupAvailable] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [searchKeyInput, setSearchKeyInput] = useState("");
  const [githubKeyInput, setGithubKeyInput] = useState("");
  const [searchProvider, setSearchProvider] = useState<SearchProvider>("github");
  const [searchConfigured, setSearchConfigured] = useState<boolean | null>(null);
  const [githubConfigured, setGithubConfigured] = useState<boolean | null>(null);
  const [provider, setProvider] = useState<Provider>("openai");
  const [qwenRegion, setQwenRegion] = useState<QwenRegion>("cn-beijing");
  const [glmModel, setGlmModel] = useState<GLMModel>("glm-5.3-flash");
  const [section, setSection] = useState<"diagnosis" | "guided" | "archive" | "library">("diagnosis");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [cloud, setCloud] = useState<CloudSnapshot | null>(null);
  const [cloudBusy, setCloudBusy] = useState("");
  const [cloudMode, setCloudMode] = useState<"login" | "signup">("login");
  const [cloudUsername, setCloudUsername] = useState("");
  const [cloudPassword, setCloudPassword] = useState("");
  const [cloudPasswordConfirm, setCloudPasswordConfirm] = useState("");
  const [legacyCodeInput, setLegacyCodeInput] = useState("");
  const [cloudAutoSync, setCloudAutoSync] = useState(false);
  const [shareTarget, setShareTarget] = useState<Material | null>(null);
  const [libraryRefreshKey, setLibraryRefreshKey] = useState(0);
  const cloudBusyRef = useRef(false);
  const cloudSavedRef = useRef("");
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<string[]>([]);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [selectedAttemptByQuestion, setSelectedAttemptByQuestion] = useState<Record<number, number>>({});
  const [activeDiagnosticId, setActiveDiagnosticId] = useState<string | null>(null);
  const [diagnosticBasis, setDiagnosticBasis] = useState<"preliminary" | "verified">("verified");
  const [uploadCategory, setUploadCategory] = useState<SourceCategory>("syllabus");
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [viewedDocument, setViewedDocument] = useState<StoredDocument | null>(null);
  const [viewedPage, setViewedPage] = useState(0);
  const [message, setMessage] = useState("");
  const chatEnd = useRef<HTMLDivElement>(null);
  const materialInput = useRef<HTMLInputElement>(null);
  const archiveInput = useRef<HTMLInputElement>(null);
  const space = archive.spaces.find((item) => item.id === archive.activeSpaceId) || archive.spaces[0];
  const profile = space.profile;
  const viewedMaterial = viewedDocument ? space.materials.find((item) => item.id === viewedDocument.materialId) : undefined;
  const repositoryKey = (() => {
    try { const url = new URL(repositoryUrl); const parts = url.pathname.split("/").filter(Boolean); return url.hostname === "github.com" && parts.length >= 2 ? `${parts[0]}/${parts[1].replace(/\.git$/, "")}` : ""; }
    catch { return ""; }
  })();

  function setSpace(update: (previous: LearningSpace) => LearningSpace) {
    setArchive((previous) => ({ ...previous, spaces: previous.spaces.map((item) => item.id === previous.activeSpaceId
      ? { ...update(item), updatedAt: new Date().toISOString() } : item) }));
  }

  function setProfile(update: SetStateAction<Profile>) {
    setSpace((previous) => ({ ...previous, profile: typeof update === "function" ? update(previous.profile) : update }));
  }

  useEffect(() => {
    let active = true;
    let restored: LearningArchive | null = null;
    let loadError = false;
    let savedProvider: Provider = "openai";
    let savedRegion: QwenRegion = "cn-beijing";
    let savedGlmModel: GLMModel = "glm-5.3-flash";
    let savedSearchProvider: SearchProvider = "github";
    try { restored = loadArchive(localStorage); }
    catch { loadError = true; }
    try {
      const selection = localStorage.getItem(PROVIDER_STORAGE_KEY);
      if (selection) {
        const value = JSON.parse(selection) as { provider?: unknown; region?: unknown; model?: unknown; searchProvider?: unknown };
        if (value.provider === "openai" || value.provider === "qwen" || value.provider === "glm") savedProvider = value.provider;
        if (value.region === "ap-southeast-1") savedRegion = value.region;
        if (value.model === "glm-5.3-flashx" || value.model === "glm-5.3-flash" || value.model === "glm-5.2") savedGlmModel = value.model;
        if (value.searchProvider === "tavily") savedSearchProvider = "tavily";
      }
    } catch { /* A damaged model preference does not invalidate learning records. */ }
    queueMicrotask(() => {
      if (!active) return;
      setArchive(restored || newArchive());
      if (loadError) {
        setPersistenceReady(false);
        setError("现有学习档案无法读取。为避免覆盖原数据，自动保存已暂停；请先导出浏览器数据备份或导入有效档案。");
      }
      setProvider(savedProvider);
      setQwenRegion(savedRegion);
      setGlmModel(savedGlmModel);
      setSearchProvider(savedSearchProvider);
      setHydrated(true);
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!hydrated || !persistenceReady) return;
    try { saveArchive(localStorage, archive); }
    catch { queueMicrotask(() => setError("浏览器存储空间不足，当前改动可能无法保存。请导出档案备份。")); }
  }, [hydrated, archive, persistenceReady]);
  useEffect(() => {
    if (!hydrated) return;
    let active = true;
    cloudGet().then(async (data) => {
      const snapshot = data as CloudSnapshot;
      if (!active) return;
      setCloud(snapshot);
      if (!snapshot.connected || snapshot.legacy || !snapshot.archive || !snapshot.accountId) return;
      try {
        const saved = JSON.parse(localStorage.getItem(CLOUD_SYNC_KEY) || "null") as { accountId?: string; revision?: number; digest?: string } | null;
        if (saved?.accountId !== snapshot.accountId || saved.revision !== snapshot.revision) return;
        const current = loadArchive(localStorage);
        const signature = JSON.stringify(current);
        cloudSavedRef.current = saved.digest === await archiveDigest(current) ? signature : "";
        if (active) setCloudAutoSync(true);
      } catch { /* A damaged sync marker never changes the local archive. */ }
    }).catch(() => { if (active) setCloud({ connected: false, unavailable: true }); });
    return () => { active = false; };
  }, [hydrated]);
  useEffect(() => {
    if (!cloudAutoSync || !cloud?.connected || !persistenceReady || cloudBusyRef.current) return;
    const signature = JSON.stringify(archive);
    if (signature === cloudSavedRef.current) return;
    const timer = window.setTimeout(() => { void syncCloud(archive, cloud.revision || 0, true); }, 2200);
    return () => window.clearTimeout(timer);
  // syncCloud uses this render's archive and revision; unrelated state must not restart the debounce.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [archive, cloudAutoSync, cloud?.connected, cloud?.revision, persistenceReady]);
  useEffect(() => {
    if (!cloud?.connected) return;
    let active = true;
    async function refreshCloudVersion() {
      if (cloudBusyRef.current) return;
      try {
        const meta = await cloudGet("?action=meta") as CloudSnapshot;
        if (!active || cloudBusyRef.current) return;
        if (!meta.connected) {
          setCloudAutoSync(false);
          localStorage.removeItem(CLOUD_SYNC_KEY);
          setCloud({ connected: false, signupAvailable: cloud?.signupAvailable });
          setNotice("云端连接已在其他标签页断开，本机档案仍保留。");
          return;
        }
        if (meta.accountId !== cloud?.accountId || (meta.revision || 0) > (cloud?.revision || 0)) {
          const snapshot = await cloudGet() as CloudSnapshot;
          if (!active || cloudBusyRef.current || !snapshot.connected) return;
          setCloudAutoSync(false);
          localStorage.removeItem(CLOUD_SYNC_KEY);
          setCloud(snapshot);
          setNotice(meta.accountId !== cloud?.accountId
            ? "云端账户已在其他标签页切换。请核对账户并恢复云端档案；自动同步已暂停。"
            : "云端档案已在其他设备更新。请先导出本机备份，再从云端恢复；自动同步已暂停。");
        }
      } catch { /* Keep the local archive available during network interruptions. */ }
    }
    function onVisible() { if (document.visibilityState === "visible") void refreshCloudVersion(); }
    window.addEventListener("focus", refreshCloudVersion);
    document.addEventListener("visibilitychange", onVisible);
    return () => { active = false; window.removeEventListener("focus", refreshCloudVersion); document.removeEventListener("visibilitychange", onVisible); };
  }, [cloud?.connected, cloud?.accountId, cloud?.revision, cloud?.signupAvailable]);
  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(PROVIDER_STORAGE_KEY, JSON.stringify({ provider, region: qwenRegion, model: glmModel, searchProvider }));
    let active = true;
    const params = new URLSearchParams({ provider, region: qwenRegion });
    fetch("/api/teacher?" + params).then((response) => response.json() as Promise<{ configured?: boolean; keySetupAvailable?: boolean }>).then((data) => {
      if (!active) return;
      setConfigured(Boolean(data.configured));
      setKeySetupAvailable(Boolean(data.keySetupAvailable));
    }).catch(() => { if (active) setConfigured(false); });
    return () => { active = false; };
  }, [hydrated, provider, qwenRegion, glmModel, searchProvider]);
  useEffect(() => {
    if (!hydrated) return;
    let active = true;
    fetch("/api/teacher?provider=tavily").then((response) => response.json() as Promise<{ configured?: boolean }>).then((data) => {
      if (active) setSearchConfigured(Boolean(data.configured));
    }).catch(() => { if (active) setSearchConfigured(false); });
    fetch("/api/teacher?provider=github").then((response) => response.json() as Promise<{ configured?: boolean }>).then((data) => {
      if (active) setGithubConfigured(Boolean(data.configured));
    }).catch(() => { if (active) setGithubConfigured(false); });
    return () => { active = false; };
  }, [hydrated]);
  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [profile.messages.length]);

  const eligibleTopics = groundedTopics(space);
  const preliminaryTopics = space.preliminary?.topics || [];
  const topicBasis: "preliminary" | "verified" = eligibleTopics.length ? "verified" : "preliminary";
  const diagnosticTopics = eligibleTopics.length ? eligibleTopics : preliminaryTopics;
  const diagnosticMastery = topicBasis === "verified" ? profile.mastery : space.preliminary?.mastery || {};
  const diagnosticEvidence = topicBasis === "verified" ? profile.evidence || {} : space.preliminary?.evidence || {};
  const dueReviews = dueReviewTargets(space.reviews || [], diagnosticTopics, topicBasis, diagnosticEvidence);
  const listedTopics = new Set<string>();
  const syllabusGroups = space.materials.filter((material) => material.category === "syllabus" && (material.status === "verified" || (material.status === "read" && material.origin !== "library")))
    .map((material) => ({ material, topics: material.topics.filter((topic) => {
      if (listedTopics.has(topic) || !eligibleTopics.includes(topic)) return false;
      listedTopics.add(topic);
      return true;
    }) })).filter((group) => group.topics.length > 0);
  const covered = diagnosticTopics.filter((topic) => diagnosticMastery[topic] && diagnosticMastery[topic] !== "未检验").length;
  const weak = diagnosticTopics.filter((topic) => diagnosticMastery[topic] === "待加强" || diagnosticMastery[topic] === "待复测").length;
  const webSources = safeWebSources(profile.sourceLinks);
  const syllabusSummary = space.materials.filter((material) => material.category === "syllabus" && (material.status === "verified" || (material.status === "read" && material.origin !== "library")))
    .map((material) => material.summary).filter(Boolean).join("\n").slice(0, 2400);
  const matchedPreliminaryCount = space.preliminary?.topics.filter((topic) => eligibleTopics.some((official) => matchedPreliminaryTopic(space, official) === topic)).length || 0;
  const readMaterialSummary = space.materials.filter((material) => (material.status === "read" || material.status === "verified") && !(material.origin === "library" && material.category === "syllabus" && material.status !== "verified"))
    .map((material) => material.summary).filter(Boolean).join("\n").slice(0, 12000);
  const readableEvidence = space.materials.filter((material) => (material.status === "read" || material.status === "verified") && !(material.origin === "library" && material.category === "syllabus" && material.status !== "verified") && material.excerpt && !/^readme\./i.test(material.path || ""));
  const pastExamReferences = readableEvidence.filter((material) => material.category === "past_exam").slice(0, 2)
    .map((material) => ({ id: material.id, title: material.title, excerpt: material.excerpt.slice(0, 2400) }));
  const materialEvidence = [
    ...readableEvidence.filter((material) => material.category === "syllabus").slice(0, 2),
    ...readableEvidence.filter((material) => material.category === "past_exam").slice(0, 2),
    ...readableEvidence.filter((material) => material.category === "textbook").slice(0, 1),
  ].map((material) => `【${SOURCE_GROUPS.find((group) => group.category === material.category)?.label}：${material.title}】\n${material.excerpt.slice(0, 1500)}`)
    .join("\n\n").slice(0, 6500);
  const activeDiagnostic = space.diagnostics.find((record) => record.id === activeDiagnosticId);
  const reinforcedQuestions = activeDiagnostic?.reinforced || [];
  const wrongResults = assessment?.results.flatMap((item, index) => item.verdict === "mastered" ? [] : [{ item, index }]) || [];
  const base = {
    provider,
    region: qwenRegion,
    model: glmModel,
    goal: profile.goal,
    subject: profile.subject,
    year: profile.year,
    institution: space.institution,
    sourceSummary: readMaterialSummary,
    materialEvidence,
    topics: diagnosticTopics,
    mastery: diagnosticMastery,
    evidence: diagnosticEvidence,
    topicBasis,
  };
  const preliminaryMapView = space.preliminary ? <section className="syllabus-topic-group"><h3>初步知识地图 · 待核对<span>{space.preliminary.topics.length} 个候选点</span></h3><p>{space.preliminary.summary} {space.preliminary.note}</p><div className="live-topics">{space.preliminary.topics.map((topic) => { const matched = eligibleTopics.some((official) => matchedPreliminaryTopic(space, official) === topic); const evidence = space.preliminary?.evidence[topic]; const status = space.preliminary!.mastery[topic] || "未检验"; return <div className={"topic-tile " + statusClass(status)} key={topic}><BookOpen size={17}/><strong>{topic}</strong><span>{matched ? "已对应考纲" : eligibleTopics.length ? "尚未对应考纲" : "待考纲核对"} · {status === "已掌握" ? "初步掌握" : status}</span>{evidence?.attempted.length ? <small>初步诊断：{evidence.attempted.map(difficultyLabel).join("、")}</small> : null}</div>; })}</div></section> : null;

  async function run(label: string, work: () => Promise<void>) {
    setBusy(label); setError(""); setNotice("");
    try { await work(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "操作失败，请重试。"); }
    finally { setBusy(""); }
  }

  async function saveKey() {
    if (!apiKeyInput.trim()) return;
    await run("正在连接模型", async () => {
      const response = await fetch("/api/teacher/key", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: apiKeyInput.trim(), provider, region: qwenRegion }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "密钥保存失败。");
      setApiKeyInput("");
      const status = await fetch("/api/teacher?" + new URLSearchParams({ provider, region: qwenRegion })).then((result) => result.json()) as { configured?: boolean };
      setConfigured(Boolean(status.configured));
      const checked = await api({ action: "health", ...base });
      setNotice(PROVIDER_NAMES[provider] + " 密钥已保存并通过模型连接测试：" + String(checked.result || "连接正常"));
    });
  }

  async function testConnection() {
    await run("正在测试模型连接", async () => {
      const checked = await api({ action: "health", ...base });
      setNotice(PROVIDER_NAMES[provider] + " 连接正常：" + String(checked.result || "可以生成内容"));
    });
  }

  async function removeKey() {
    await run("正在断开连接", async () => {
      const response = await fetch("/api/teacher/key", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, region: qwenRegion }),
      });
      if (!response.ok) throw new Error("断开连接失败。");
      setConfigured(false);
      setNotice("已从此浏览器移除 " + PROVIDER_NAMES[provider] + " 的 API 密钥。");
    });
  }

  async function saveSearchKey() {
    if (!searchKeyInput.trim()) return;
    await run("正在保存搜索密钥", async () => {
      const response = await fetch("/api/teacher/key", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: searchKeyInput.trim(), provider: "tavily" }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Tavily 密钥保存失败。");
      setSearchKeyInput("");
      setSearchConfigured(true);
      setNotice("Tavily 密钥已保存。选择 Tavily 时仅用它发现 GitHub 线索；文件正文仍由 GitHub 读取和核对。");
    });
  }

  async function removeSearchKey() {
    await run("正在移除搜索密钥", async () => {
      const response = await fetch("/api/teacher/key", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "tavily" }),
      });
      if (!response.ok) throw new Error("Tavily 密钥移除失败。");
      setSearchConfigured(false);
      setNotice("已从此浏览器移除 Tavily 密钥。");
    });
  }

  async function saveGithubKey() {
    if (!githubKeyInput.trim()) return;
    await run("正在保存 GitHub 访问令牌", async () => {
      const response = await fetch("/api/teacher/key", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: githubKeyInput.trim(), provider: "github" }),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "GitHub 访问令牌保存失败。");
      setGithubKeyInput(""); setGithubConfigured(true);
      setNotice("GitHub 访问令牌已保存，只用于读取 GitHub 仓库和文件。请重试刚才的操作。");
    });
  }

  async function removeGithubKey() {
    await run("正在移除 GitHub 访问令牌", async () => {
      const response = await fetch("/api/teacher/key", {
        method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "github" }),
      });
      if (!response.ok) throw new Error("GitHub 访问令牌移除失败。");
      setGithubConfigured(false); setNotice("已从此浏览器移除 GitHub 访问令牌。");
    });
  }

  function clearTransient() {
    setQuestions([]); setAnswers([]); setAssessment(null);
    setSelectedAttemptByQuestion({}); setActiveDiagnosticId(null); setDiagnosticBasis("verified"); setMessage("");
    setViewedDocument(null); setViewedPage(0); setShareTarget(null);
  }

  function createStudySpace() {
    const next = newSpace({ ...initialProfile, goal: profile.goal, year: profile.year, subject: "" }, `新学习空间 ${archive.spaces.length + 1}`);
    setArchive((previous) => ({ ...previous, activeSpaceId: next.id, spaces: [...previous.spaces, next] }));
    clearTransient(); setError(""); setNotice("已创建学习空间。填写科目后，可上传资料或检索。");
  }

  function switchStudySpace(id: string) {
    if (!archive.spaces.some((item) => item.id === id) || id === archive.activeSpaceId) return;
    setArchive((previous) => ({ ...previous, activeSpaceId: id }));
    clearTransient(); setError(""); setNotice("已切换到保存的学习空间，没有重新检索或调用模型。");
  }

  function deleteStudySpace() {
    if (!window.confirm(`确定删除「${space.name}」及其中的资料、知识点和诊断记录吗？此操作无法撤销。`)) return;
    void Promise.all(space.materials.map((material) => deleteDocument(material.id))).catch(() => setError("学习空间已删除，但浏览器中可能残留部分逐页正文。"));
    setArchive((previous) => {
      const spaces = previous.spaces.filter((item) => item.id !== previous.activeSpaceId);
      const remaining = spaces.length ? spaces : [newSpace()];
      return { ...previous, activeSpaceId: remaining[0].id, spaces: remaining };
    });
    clearTransient(); setError(""); setNotice("学习空间已删除。");
  }

  function deleteMaterial(id: string) {
    const material = space.materials.find((item) => item.id === id);
    if (!material || !window.confirm(`确定删除资料「${material.title}」吗？`)) return;
    setSpace((previous) => withoutMaterial(previous, id));
    void deleteDocument(id).catch(() => setError("资料记录已删除，但浏览器中的逐页正文清理失败。"));
    clearTransient(); setNotice("已删除资料；知识点只保留其他已读取考纲支持的内容。历史诊断仍在档案中。");
  }

  async function viewDocument(material: Material) {
    try {
      const saved = await getDocument(material.id);
      if (!saved) { setError("这份资料没有保存逐页正文。旧版资料或自动检索到的短文件，可通过“重新完整读取”保存正文；上传资料请重新上传。"); return; }
      setViewedDocument(saved); setViewedPage(0); setError("");
    } catch { setError("无法打开浏览器中的逐页正文。请先导出档案备份。"); }
  }

  function verifyMaterial(id: string) {
    setSpace((previous) => {
      const materials = previous.materials.map((item) => item.id === id && item.status === "read"
        ? { ...item, status: "verified" as const, note: [item.note, "已由用户核对来源与内容。"].filter(Boolean).join(" ") } : item);
      return { ...previous, materials, profile: { ...previous.profile, ...reconciledProgress(previous, materials) } };
    });
    setNotice("已标记为已核对；公共资料库考纲的知识点现可进入正式学习地图。请仍以原始发布单位的考纲核对考试范围。");
  }

  async function alignPreliminaryMap(syllabusTopics: string[]): Promise<PreliminaryMap | undefined> {
    if (!space.preliminary || !syllabusTopics.length) return space.preliminary;
    const reviewedTopics = Array.from(new Set(syllabusTopics)).slice(0, 40);
    try {
      setBusy("正在用考纲核对初步地图");
      const data = await api({ action: "align_map", ...base, candidates: space.preliminary.topics, syllabusTopics: reviewedTopics });
      const result = data.result as { matches?: Array<{ candidate?: string; syllabus?: string }> };
      const matches = Object.fromEntries((Array.isArray(result.matches) ? result.matches : [])
        .filter((item) => item && space.preliminary!.topics.includes(item.candidate || "") && reviewedTopics.includes(item.syllabus || ""))
        .map((item) => [item.candidate!, item.syllabus!]));
      return { ...space.preliminary, matches, reviewedTopics };
    } catch {
      return { ...space.preliminary, matches: {}, reviewedTopics,
        note: [space.preliminary.note, "本次自动对应未完成；正式考点已按考纲保存，初步成绩仍单独保留。"].filter(Boolean).join(" ").slice(0, 800) };
    }
  }

  async function processDocumentFile(file: File, category: SourceCategory) {
    setBusy("正在浏览器中检查全部页面");
    const extracted = await extractClientDocument(file);
    try {
      const pages = extracted.pages.map((page) => ({ ...page }));
      const draft = extracted.needsOcr.length ? await getDraft(extracted.sha256) : undefined;
      if (draft?.totalPages === extracted.totalPages) {
        for (const page of draft.pages) {
          if (page.method === "ocr" && page.text.replace(/\s/g, "").length >= 10 && extracted.needsOcr.includes(page.number)) {
            pages[page.number - 1] = page;
          }
        }
      }
      const missing = extracted.needsOcr.filter((number) => pages[number - 1].method !== "ocr");
      if (missing.length) {
        if (!window.confirm(`这份 PDF 有 ${extracted.totalPages} 页，其中 ${missing.length} 页需要逐页 OCR。将使用你保存的智谱密钥并消耗相应额度；完成的页会保存在此浏览器，可在中断后重试。是否继续？`)) {
          throw new Error("已取消 OCR；资料尚未标记为已读取。");
        }
        for (const [index, number] of missing.entries()) {
          setBusy(`正在 OCR 第 ${number}/${extracted.totalPages} 页（本次 ${index + 1}/${missing.length}）`);
          const image = await extracted.renderOcrPage(number);
          const text = await recognizeOcrPage(image, number);
          pages[number - 1] = { number, text, method: "ocr" };
          await saveDraft({ sha256: extracted.sha256, totalPages: extracted.totalPages, pages });
        }
      }
      if (pages.some((page) => page.text.replace(/\s/g, "").length < 10)) {
        throw new Error("部分页面仍没有可核对的正文；整份文件未标记为已读取。");
      }
      if (pages.reduce((sum, page) => sum + page.text.length, 0) > 500_000) {
        throw new Error("OCR 后正文超过 50 万字，当前无法完整分析；请分卷处理。");
      }
      const checked: StoredDocument = { materialId: "pending", sha256: extracted.sha256, pages };
      if (!validDocument(checked) || pages.length !== extracted.totalPages) throw new Error("逐页正文不完整，资料未保存为已读取。");
      const chunks = chunkDocument(pages);
      if (!chunks.length || chunks.length > 45) throw new Error(`文件需分成 ${chunks.length} 段分析，超过 45 段上限；请分卷处理。`);
      const summaries: string[] = [];
      const notes: string[] = [];
      const topics = new Set<string>();
      let relevantParts = 0;
      for (const [index, chunk] of chunks.entries()) {
        setBusy(`正在核对资料第 ${index + 1}/${chunks.length} 段`);
        const response = await api({ action: "review_part", ...base, category, title: file.name,
          partText: chunk.text, pageNumbers: chunk.pages, partIndex: index, partCount: chunks.length,
          ocrPages: chunk.pages.filter((number) => pages[number - 1]?.method === "ocr").length });
        const result = response.result as { relevant?: unknown; summary?: unknown; topics?: unknown; note?: unknown } | undefined;
        if (!result || typeof result.relevant !== "boolean" || typeof result.summary !== "string" || !result.summary.trim()
          || !Array.isArray(result.topics) || typeof result.note !== "string") {
          throw new Error(`第 ${index + 1} 段核对结果不完整；整份资料未标记为已读取。`);
        }
        if (result.relevant) relevantParts += 1;
        summaries.push(`第 ${index + 1} 段：${result.summary.trim().slice(0, 260)}`);
        if (result.note.trim()) notes.push(result.note.trim().slice(0, 180));
        if (category === "syllabus" && result.relevant) {
          for (const topic of result.topics) {
            if (typeof topic === "string" && topic.trim()) topics.add(topic.trim().slice(0, 80));
            if (topics.size > 300) throw new Error("考纲考点超过 300 项上限；请分卷处理，网站不会丢弃后半部分考点。");
          }
        }
      }
      if (relevantParts < Math.ceil(chunks.length / 2) || (category === "syllabus" && !topics.size)) {
        throw new Error("已核对全部正文，但没有足够证据证明文件属于当前科目和资料类别；本次未加入教学资料。");
      }
      const ocrPages = pages.filter((page) => page.method === "ocr").length;
      return { pages, summary: summaries.join("；"), topics: Array.from(topics), excerpt: representativeExcerpt(pages),
        note: [notes.filter((item, index, all) => all.indexOf(item) === index).join("；").slice(0, 1000),
          `已完整读取 ${pages.length}/${extracted.totalPages} ${extracted.unit === "page" ? "页" : "段"}，其中 OCR ${ocrPages} 页；全部 ${chunks.length} 段均已核对。OCR 公式和图表请对照原件检查。`].filter(Boolean).join(" "),
        coverage: { total: extracted.totalPages, processed: pages.length, ocr: ocrPages, unit: extracted.unit,
          analyzedParts: chunks.length, sha256: extracted.sha256, complete: true, checkedAt: new Date().toISOString() } satisfies NonNullable<Material["coverage"]> };
    } finally { await extracted.close().catch(() => {}); }
  }

  async function readCandidateOnce(material: Material): Promise<Material> {
    if (!material.repository || !material.path || !material.revision) throw new Error("GitHub 文件位置不完整。");
    const file = await fetchGithubDocument(material);
    const data = await processDocumentFile(file, material.category);
    const document: StoredDocument = { materialId: material.id, sha256: data.coverage.sha256, pages: data.pages };
    if (!validDocument(document) || data.coverage.processed !== data.coverage.total || document.pages.length !== data.coverage.total) {
      throw new Error("逐页正文不完整，资料未保存为已读取。");
    }
    await saveDocument(document);
    await deleteDraft(data.coverage.sha256).catch(() => {});
    const result: Material = { ...material, status: "read", summary: data.summary, topics: data.topics,
      excerpt: data.excerpt, coverage: data.coverage, storedText: true,
      note: [material.note, data.note, "GitHub 社区资料仍需与正式考纲核对。"].filter(Boolean).join(" ").slice(0, 900) };
    const aligned = result.category === "syllabus" && result.topics.length
      ? await alignPreliminaryMap([...eligibleTopics, ...result.topics]) : space.preliminary;
    setSpace((previous) => {
      const materials = previous.materials.map((item) => item.id === material.id ? { ...result, id: item.id } : item);
      const nextSpace = { ...previous, preliminary: aligned };
      const progress = reconciledProgress(nextSpace, materials);
      return { ...nextSpace, materials, profile: { ...previous.profile, ...progress,
        sourceSummary: [previous.profile.sourceSummary, result.summary].filter(Boolean).join("\n").slice(0, 12000),
      } };
    });
    return result;
  }

  async function readCandidate(material: Material) {
    await run("正在读取 GitHub 文件", async () => {
      const result = await readCandidateOnce(material);
      setNotice(result.status === "read" ? material.category === "syllabus" ? "已读取考纲并建立知识点。" : "已读取文件正文，作为教学或出题参考；知识点仍由考纲决定。" : result.note);
    });
  }

  async function inspectRepository(refresh = false) {
    if (!refresh && repositoryKey && space.catalogedRepositories?.includes(repositoryKey) && space.materials.some((item) => item.repository === repositoryKey)) {
      setError(""); setNotice("这个仓库的文件目录已保存在当前学习空间，可以直接查看下方记录或继续读取；无需重复请求 GitHub。");
      return;
    }
    await run("正在查看 GitHub 仓库目录", async () => {
      const response = await api({ action: "catalog_github", ...base, repositoryUrl: repositoryUrl.trim() });
      const materials = Array.isArray(response.materials) ? response.materials as Material[] : [];
      setSpace((previous) => {
        const merged = [...previous.materials];
        for (const material of materials) {
          const index = merged.findIndex((item) => item.repository === material.repository && item.path === material.path);
          if (index < 0) merged.push(material);
          else if (merged[index].status === "discovered" || merged[index].status === "unreadable" || merged[index].status === "excluded") {
            merged[index] = { ...material, id: merged[index].id, addedAt: merged[index].addedAt };
          }
        }
        return { ...previous, materials: merged,
          catalogedRepositories: Array.from(new Set([...(previous.catalogedRepositories || []), ...materials.map((item) => item.repository).filter((value): value is string => !!value)])) };
      });
      const available = materials.filter((item) => item.status === "discovered").length;
      setNotice(`已列出仓库中 ${response.total || materials.length} 份文件，${available} 份与当前科目匹配、可尝试读取。${response.truncated ? "仓库目录过大，GitHub 只返回了部分文件。" : ""} 点击“完整读取”后，扫描页将逐页 OCR 并核对。`);
    });
  }

  async function readAllCandidates() {
    const candidates = space.materials.filter((item) => item.repository && item.path && item.status === "discovered");
    if (!candidates.length) return;
    await run("正在逐份读取 GitHub 文件", async () => {
      let read = 0;
      let ocr = 0;
      let skipped = 0;
      let failed = 0;
      for (const [index, material] of candidates.entries()) {
        setBusy(`正在读取第 ${index + 1}/${candidates.length} 份文件`);
        try {
          const result = await readCandidateOnce(material);
          if (result.status === "read") { read++; if (result.coverage?.ocr) ocr++; }
          else skipped++;
        } catch { failed++; }
      }
      setNotice(`本轮已检查 ${candidates.length} 份文件：完整读取并核对 ${read} 份，其中 ${ocr} 份包含 OCR 页面；其他未采用 ${skipped} 份，处理失败 ${failed} 份。失败文件仍保留为候选，可单独点击“完整读取”查看原因。`);
    });
  }

  function updateStudyTarget(field: "goal" | "subject" | "year" | "institution", value: string) {
    const changed = field === "institution" ? space.institution !== value : profile[field] !== value;
    const hasScope = profile.topics.length > 0 || space.materials.length > 0 || Boolean(space.preliminary?.topics.length);
    if (changed && hasScope) void Promise.all(space.materials.map((item) => deleteDocument(item.id))).catch(() => setError("旧资料已从学习空间移除，但浏览器中可能残留逐页正文。"));
    setSpace((previous) => {
      const nextProfile = field === "institution" ? previous.profile : { ...previous.profile, [field]: value };
      return { ...previous, institution: field === "institution" ? value : previous.institution,
        materials: changed && hasScope ? [] : previous.materials,
        catalogedRepositories: changed && hasScope ? [] : previous.catalogedRepositories,
        diagnostics: changed && hasScope ? [] : previous.diagnostics,
        preliminary: changed && hasScope ? undefined : previous.preliminary,
        profile: changed && hasScope ? { ...nextProfile, sourceSummary: "", sourceNote: "", sourceNames: [], sourceLinks: [], topics: [], mastery: {}, evidence: {} } : nextProfile };
    });
    if (changed && hasScope) {
      clearTransient(); setError(""); setNotice("当前空间的学习范围已改变，原资料和知识点已清空。建议为不同科目创建独立学习空间。");
    }
  }

  async function makePlan() {
    await run("正在检索并核对 GitHub 文件", async () => {
      const research = await api({ action: "research", ...base, searchProvider });
      const researchResult = research.result as { scopeNotice?: string; screened?: number; readable?: number };
      const materials = Array.isArray(research.materials) ? research.materials.filter((item): item is Material => !!item && typeof item === "object" && typeof item.id === "string" && typeof item.title === "string" && typeof item.status === "string").slice(0, 80) : [];
      const readMaterials = materials.filter((item) => item.status === "read" && item.excerpt && !/^readme\./i.test(item.path || ""));
      const readSyllabus = readMaterials.filter((item) => item.category === "syllabus");
      const newSyllabusTopics = readSyllabus.flatMap((item) => item.topics);
      const aligned = newSyllabusTopics.length ? await alignPreliminaryMap([...eligibleTopics, ...newSyllabusTopics]) : space.preliminary;
      const sources = safeWebSources(research.sources);
      setSpace((previous) => {
        const incoming = materials.map((item) => ({ ...item }));
        const mergedMaterials = [...previous.materials];
        const changedMaterials: Material[] = [];
        for (const item of incoming) {
          const index = mergedMaterials.findIndex((existing) => (existing.url || existing.title) === (item.url || item.title));
          if (index < 0) {
            mergedMaterials.push(item);
            changedMaterials.push(item);
          } else {
            const old = mergedMaterials[index];
            if (old.status !== "read" && old.status !== "verified" && (item.status !== "discovered" || old.status === "unreadable")) {
              const replacement = { ...item, id: old.id, addedAt: old.addedAt };
              mergedMaterials[index] = replacement;
              changedMaterials.push(replacement);
            }
          }
        }
        mergedMaterials.splice(150);
        const nextSpace = { ...previous, preliminary: aligned };
        const progress = reconciledProgress(nextSpace, mergedMaterials);
        return { ...nextSpace, materials: mergedMaterials, profile: { ...previous.profile,
          ...progress,
          sourceSummary: [previous.profile.sourceSummary, ...changedMaterials.filter((item) => item.status === "read").map((item) => item.summary)].filter(Boolean).join("\n").slice(0, 12000),
          sourceNote: [previous.profile.sourceNote, researchResult.scopeNotice || "GitHub 社区文件需与正式考纲核对。"].filter((item, index, all) => !!item && all.indexOf(item) === index).join(" ").slice(0, 1200),
          sourceLinks: safeWebSources([...(previous.profile.sourceLinks || []), ...sources]),
        } };
      });
      setNotice([readMaterials.length ? `已从 GitHub 保存 ${readMaterials.length} 份可读取且内容相关的文件。`
        : `找到 ${researchResult.screened || 0} 份 GitHub 候选文件；请在下方选择“完整读取”，核对正文后才会用于教学。`,
        `候选教材 ${materials.filter((item) => item.category === "textbook").length}、候选考纲 ${materials.filter((item) => item.category === "syllabus").length}、候选真题 ${materials.filter((item) => item.category === "past_exam").length}。`,
        researchResult.scopeNotice].filter(Boolean).join(" "));
    });
  }

  async function addMaterial(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    await run("正在分析资料", async () => {
      if (file.size > 25_000_000) throw new Error("文件超过当前 25 MB 上限，请分卷后上传；不会只分析前半部分。");
      const data = await processDocumentFile(file, uploadCategory);
      const topics = data.topics;
      if (uploadCategory === "syllabus" && !topics.length) throw new Error("未能从考纲中提取明确考点，请检查文件是否可读取。");
      const id = newId();
      const coverage = data.coverage;
      const document: StoredDocument = { materialId: id, sha256: coverage.sha256, pages: data.pages };
      if (!coverage.complete || coverage.processed !== coverage.total || !validDocument(document)
        || document.pages.length !== coverage.total) throw new Error("逐页正文不完整，本次资料未保存。");
      await saveDocument(document);
      await deleteDraft(coverage.sha256).catch(() => {});
      const material: Material = { version: 1, id, title: file.name, category: uploadCategory, reliability: "reference",
        status: "read", origin: "upload", note: data.note,
        summary: data.summary.slice(0, 12000), topics: uploadCategory === "syllabus" ? topics : [],
        excerpt: data.excerpt.slice(0, 16000), coverage, storedText: true, addedAt: new Date().toISOString() };
      const aligned = uploadCategory === "syllabus" ? await alignPreliminaryMap([...eligibleTopics, ...topics]) : space.preliminary;
      setSpace((previous) => {
        const materials = [...previous.materials, material].slice(0, 150);
        const nextSpace = { ...previous, preliminary: aligned };
        const progress = reconciledProgress(nextSpace, materials);
        return { ...nextSpace, materials, profile: {
          ...previous.profile,
          sourceNames: [...previous.profile.sourceNames, file.name].slice(0, 40),
          sourceSummary: [previous.profile.sourceSummary, material.summary].filter(Boolean).join("\n").slice(0, 12000),
          sourceNote: material.note,
          ...progress,
        } };
      });
      setNotice("已完整处理「" + file.name + "」的 " + coverage.total + (coverage.unit === "page" ? " 页" : " 段") + "，逐页正文已保存在当前浏览器。" + (uploadCategory === "syllabus" ? "考纲知识点已加入学习地图。" : "资料已保存作参考，未改变考纲知识点。"));
      setShareTarget(material);
    });
  }

  function resetScope() {
    if (!window.confirm("确定清空当前学习空间的资料和知识点吗？")) return;
    void Promise.all(space.materials.map((item) => deleteDocument(item.id))).catch(() => setError("资料已清空，但浏览器中可能残留逐页正文。"));
    setSpace((previous) => ({ ...previous, materials: [], catalogedRepositories: [], preliminary: undefined, profile: { ...previous.profile, sourceSummary: "", sourceNote: "", sourceNames: [], sourceLinks: [], topics: [], mastery: {}, evidence: {} } }));
    clearTransient();
    setError(""); setNotice("已清空资料摘要和知识点；聊天与诊断历史仍保留。");
  }

  async function createPreliminaryMap(): Promise<PreliminaryMap> {
    if (!profile.goal.trim() || !profile.subject.trim()) throw new Error("请先填写考试目标和科目。");
    const data = await api({ action: "preliminary_map", ...base });
    const result = data.result as { summary?: unknown; note?: unknown; topics?: unknown };
    const topics = Array.isArray(result.topics)
      ? Array.from(new Set(result.topics.filter((topic): topic is string => typeof topic === "string" && !!topic.trim()).map((topic) => topic.trim().slice(0, 80)))).slice(0, 20)
      : [];
    if (topics.length < 3) throw new Error("模型未能生成足够的初步知识点，请重试或更换模型。");
    const preliminary: PreliminaryMap = { version: 1,
      summary: typeof result.summary === "string" ? result.summary.slice(0, 800) : "",
      note: typeof result.note === "string" ? result.note.slice(0, 800) : "待考纲核对。",
      topics, mastery: Object.fromEntries(topics.map((topic) => [topic, "未检验" as const])), evidence: {},
      createdAt: new Date().toISOString(),
    };
    setSpace((previous) => ({ ...previous, preliminary }));
    return preliminary;
  }

  async function preparePreliminaryMap() {
    await run("正在生成初步知识地图", async () => {
      const preliminary = await createPreliminaryMap();
      setSection("archive");
      setNotice(`已生成 ${preliminary.topics.length} 个待核对知识点。现在可以进行初步诊断；取得考纲后会核对正式范围。`);
    });
  }

  async function startDiagnosis() {
    await run("正在生成诊断题", async () => {
      let topics = diagnosticTopics;
      let mastery = diagnosticMastery;
      let evidence = diagnosticEvidence;
      let basis = topicBasis;
      if (!topics.length) {
        setBusy("正在生成初步知识地图");
        const preliminary = await createPreliminaryMap();
        topics = preliminary.topics;
        mastery = preliminary.mastery;
        evidence = preliminary.evidence;
        basis = "preliminary";
        setBusy("正在生成初步诊断题");
      }
      const reviewTargets = dueReviewTargets(space.reviews || [], topics, basis, evidence);
      const priority = [...reviewTargets.map((item) => item.topic), ...topics.filter((item) => !evidence[item]?.attempted?.length), ...topics.filter((item) => mastery[item] === "待加强" || mastery[item] === "待复测")];
      const remaining = topics.filter((item) => !priority.includes(item));
      const offset = profile.rounds.length % Math.max(remaining.length, 1);
      const selectedTopics = Array.from(new Set([...priority, ...remaining.slice(offset), ...remaining.slice(0, offset)])).slice(0, 40);
      const examReferences = await Promise.all(pastExamReferences.map(async (reference) => {
        const material = space.materials.find((item) => item.id === reference.id);
        if (!material?.storedText) return reference;
        const document = await getDocument(reference.id).catch(() => undefined);
        if (!document?.pages.length) return reference;
        const step = Math.max(1, Math.floor(document.pages.length / 3));
        const start = profile.rounds.length * 3 % document.pages.length;
        const chosen = [0, 1, 2].map((index) => document.pages[(start + index * step) % document.pages.length]);
        return { ...reference, excerpt: chosen.map((page) => `【第 ${page.number} 页】${page.text.slice(0, 700)}`).join("\n").slice(0, 2400) };
      }));
      const data = await api({ action: "diagnose", ...base, topics: selectedTopics, mastery, evidence, topicBasis: basis,
        previousQuestions: profile.previousQuestions.slice(-30),
        reviewTargets: reviewTargets.map((item) => ({ topic: item.topic, difficulty: item.difficulty })), pastExamReferences: examReferences });
      const result = data.result as { questions?: Question[] };
      const generated = Array.isArray(result.questions) ? result.questions.flatMap((item, questionIndex) => {
        if (!item || typeof item.topic !== "string" || typeof item.prompt !== "string" || typeof item.correctAnswer !== "string") return [];
        const groundedTopic = selectedTopics.find((topic) => topic === item.topic || topic.includes(item.topic) || item.topic.includes(topic));
        if (!groundedTopic) return [];
        const type: QuestionType = item.type === "single_choice" || item.type === "true_false" || item.type === "fill_blank" ? item.type : "fill_blank";
        const fallbackDifficulties: Difficulty[] = ["foundation", "foundation", "advanced", "advanced", "integrated", "integrated"];
        const difficulty: Difficulty = item.difficulty === "foundation" || item.difficulty === "advanced" || item.difficulty === "integrated" ? item.difficulty : fallbackDifficulties[questionIndex] || "advanced";
        const suppliedOptions = Array.isArray(item.options) ? item.options.filter((option): option is string => typeof option === "string" && Boolean(option.trim())).slice(0, 6) : [];
        const options = type === "true_false" ? ["正确", "错误"] : type === "single_choice" && suppliedOptions.length >= 2 ? suppliedOptions : [];
        const syllabus = basis === "verified" ? space.materials.find((material) => material.category === "syllabus"
          && (material.status === "verified" || (material.status === "read" && material.origin !== "library")) && material.topics.includes(groundedTopic)) : undefined;
        const referencedExam = item.source?.kind === "adapted" ? space.materials.find((material) => material.id === item.source?.pastExamId
          && material.category === "past_exam" && (material.status === "read" || material.status === "verified") && material.excerpt) : undefined;
        return [{ topic: groundedTopic.slice(0, 80), difficulty, prompt: item.prompt, type: type === "single_choice" && options.length < 2 ? "fill_blank" as const : type,
          options, correctAnswer: item.correctAnswer, explanation: typeof item.explanation === "string" ? item.explanation : "",
          source: { kind: referencedExam ? "adapted" as const : "original" as const,
            syllabusId: syllabus?.id, syllabusTitle: syllabus?.title,
            pastExamId: referencedExam?.id, pastExamTitle: referencedExam?.title } }];
      }).slice(0, 12) : [];
      const selectedIndexes = new Set<number>();
      const next: Question[] = [];
      for (const target of reviewTargets) {
        const index = generated.findIndex((item, itemIndex) => !selectedIndexes.has(itemIndex)
          && item.topic === target.topic && item.difficulty === target.difficulty);
        if (index < 0) throw new Error("模型未按到期知识点生成复测题，请重试本轮诊断。");
        selectedIndexes.add(index);
        next.push({ ...generated[index], purpose: "review" });
      }
      for (const difficulty of ["foundation", "advanced", "integrated"] as Difficulty[]) {
        for (let index = 0; index < generated.length && next.filter((item) => item.difficulty === difficulty).length < 2; index += 1) {
          if (generated[index].difficulty !== difficulty || selectedIndexes.has(index)) continue;
          selectedIndexes.add(index);
          next.push({ ...generated[index], purpose: "diagnostic" });
        }
      }
      for (let index = 0; next.length < 6 && index < generated.length; index += 1) {
        if (!selectedIndexes.has(index)) next.push({ ...generated[index], purpose: "diagnostic" });
      }
      if (next.length !== 6 || (["foundation", "advanced", "integrated"] as Difficulty[]).some((difficulty) => next.filter((item) => item.difficulty === difficulty).length !== 2)) {
        throw new Error("模型未生成符合已读取资料范围的 6 道分层题，请重试或换用更合适的模型。");
      }
      setQuestions(next);
      setAnswers(next.map(() => ""));
      setAssessment(null);
      setSelectedAttemptByQuestion({});
      setActiveDiagnosticId(null);
      setDiagnosticBasis(basis);
      setSection("diagnosis");
    });
  }

  async function submitDiagnosis() {
    if (answers.some((answer) => !answer.trim())) {
      setError("请回答全部题目；不会做可以填写「不会」。");
      return;
    }
    await run("正在分析作答", async () => {
      const data = await api({ action: "assess", ...base, topicBasis: diagnosticBasis, questions, answers });
      const result = data.result as Assessment;
      if (!Array.isArray(result.results) || result.results.length !== questions.length) {
        throw new Error("评估结果不完整，请重新提交。");
      }
      setAssessment(result);
      const mastered = result.results.filter((item) => item.verdict === "mastered").length;
      const recordId = newId();
      const date = new Date().toLocaleDateString("zh-CN");
      setActiveDiagnosticId(recordId);
      setSpace((previous) => {
        const isPreliminary = diagnosticBasis === "preliminary" && Boolean(previous.preliminary);
        const mastery = { ...(isPreliminary ? previous.preliminary!.mastery : previous.profile.mastery) };
        const evidence = { ...(isPreliminary ? previous.preliminary!.evidence : previous.profile.evidence || {}) };
        const outcomes = new Map<string, { difficulty: Difficulty; review: boolean; failed: boolean }>();
        result.results.forEach((item, index) => {
          const topic = questions[index].topic;
          const nextEvidence = updatedEvidence(evidence[topic], questions[index].difficulty, item.verdict);
          evidence[topic] = nextEvidence;
          mastery[topic] = statusFromEvidence(nextEvidence, item.verdict);
          const current = outcomes.get(topic);
          outcomes.set(topic, { difficulty: item.verdict !== "mastered" || !current ? questions[index].difficulty : current.difficulty,
            review: Boolean(current?.review || questions[index].purpose === "review"),
            failed: Boolean(current?.failed || item.verdict !== "mastered") });
        });
        let reviews: ReviewSchedule[] = previous.reviews || [];
        const now = new Date();
        for (const [topic, outcome] of outcomes) {
          if (outcome.failed) {
            mastery[topic] = "待加强";
            reviews = failReview(reviews, topic, diagnosticBasis, outcome.difficulty, now);
          } else if (outcome.review) reviews = passReview(reviews, topic, diagnosticBasis, outcome.difficulty, now);
          else reviews = startReview(reviews, topic, diagnosticBasis, outcome.difficulty, now);
        }
        const record: DiagnosticRecord = { version: 1, id: recordId, date, questions, answers, assessment: result, reinforced: [], reinforcements: {}, basis: diagnosticBasis };
        return { ...previous, diagnostics: [...previous.diagnostics, record].slice(-30), reviews,
          preliminary: isPreliminary ? { ...previous.preliminary!, mastery, evidence } : previous.preliminary,
          profile: {
          ...previous.profile, ...(!isPreliminary ? { mastery, evidence } : {}),
          previousQuestions: [...previous.profile.previousQuestions, ...questions.map((item) => item.prompt)].slice(-60),
          rounds: [...previous.profile.rounds, {
            id: recordId, date,
            covered: questions.length,
            mastered,
            total: questions.length,
            basis: diagnosticBasis,
          }].slice(-30),
        } };
      });
    });
  }

  async function makeLesson(index: number) {
    const focus = questions[index]?.topic;
    const assessmentItem = assessment?.results[index];
    if (!focus || !assessmentItem || assessmentItem.verdict === "mastered" || !activeDiagnosticId) { setError("请先选择一道需要强化的错题。"); return; }
    await run("正在准备专题讲解", async () => {
      const previousAttempts = activeDiagnostic?.reinforcements?.[String(index)] || [];
      const feedback = [
        `原题：${questions[index].prompt}`,
        `学生答案：${answers[index] || "未作答"}`,
        `参考答案：${assessmentItem.correctAnswer}`,
        `诊断反馈：${assessmentItem.feedback}`,
        `原题难度：${difficultyLabel(questions[index].difficulty)}`,
        ...previousAttempts.map((attempt, attemptIndex) => `此前强化 ${attemptIndex + 1} 的练习：${attempt.lesson.checkQuestion}；学生答案：${attempt.answer || "未作答"}；反馈：${attempt.feedback || "尚未作答"}`),
      ].join("\n").slice(0, 5000);
      const data = await api({ action: "lesson", ...base, topicBasis: diagnosticBasis,
        topics: diagnosticBasis === "preliminary" ? space.preliminary?.topics || [] : eligibleTopics,
        focus, feedback });
      const lessonResult = data.result as ReinforcementAttempt["lesson"];
      if (typeof lessonResult.explanation !== "string" || !lessonResult.explanation.trim()
        || typeof lessonResult.example !== "string" || typeof lessonResult.checkQuestion !== "string" || !lessonResult.checkQuestion.trim()
        || typeof lessonResult.checkAnswer !== "string" || !lessonResult.checkAnswer.trim()) throw new Error("讲解内容不完整，请重试。");
      const attempt: ReinforcementAttempt = { id: newId(), lesson: lessonResult, answer: "", feedback: "", passed: false, clarifications: [] };
      setSpace((previous) => ({ ...previous, diagnostics: previous.diagnostics.map((record) => record.id === activeDiagnosticId
        ? { ...record, reinforcements: { ...record.reinforcements,
          [String(index)]: [...(record.reinforcements?.[String(index)] || []), attempt] } } : record) }));
      setSelectedAttemptByQuestion((previous) => ({ ...previous, [index]: previousAttempts.length }));
    });
  }

  async function checkLesson(index: number, attemptId: string, answer: string) {
    const focus = questions[index]?.topic;
    const attempt = activeDiagnostic?.reinforcements?.[String(index)]?.find((item) => item.id === attemptId);
    if (!focus || !attempt || !answer.trim() || attempt.feedback) return;
    await run("正在检查练习", async () => {
      const data = await api({
        action: "assess",
        ...base,
        topicBasis: diagnosticBasis,
        questions: [{ topic: focus, difficulty: questions[index].difficulty, prompt: attempt.lesson.checkQuestion, type: "fill_blank", options: [], correctAnswer: attempt.lesson.checkAnswer, explanation: attempt.lesson.checkAnswer }],
        answers: [answer],
      });
      const result = data.result as Assessment;
      const item = result.results?.[0];
      if (!item) throw new Error("没有收到练习反馈，请重试。");
      const passed = item.verdict === "mastered";
      setSpace((previous) => ({
        ...previous,
        reviews: passed ? restartReviewAfterReinforcement(previous.reviews || [], focus, diagnosticBasis, questions[index].difficulty)
          : failReview(previous.reviews || [], focus, diagnosticBasis, questions[index].difficulty),
        diagnostics: previous.diagnostics.map((record) => record.id === activeDiagnosticId
          ? { ...record,
            reinforced: passed ? Array.from(new Set([...record.reinforced, index])) : record.reinforced.filter((item) => item !== index),
            reinforcements: { ...record.reinforcements, [String(index)]: (record.reinforcements?.[String(index)] || []).map((entry) => entry.id === attemptId
              ? { ...entry, answer, feedback: item.feedback + "\n参考答案：" + item.correctAnswer, passed } : entry) } }
          : record),
        preliminary: diagnosticBasis === "preliminary" && previous.preliminary
          ? { ...previous.preliminary, mastery: { ...previous.preliminary.mastery, [focus]: passed ? "待复测" : "待加强" } } : previous.preliminary,
        profile: diagnosticBasis === "verified" ? { ...previous.profile,
          mastery: { ...previous.profile.mastery, [focus]: passed ? "待复测" : "待加强" } } : previous.profile,
      }));
    });
  }

  async function clarifyLesson(index: number, attemptId: string, target: string) {
    const focus = questions[index]?.topic;
    const attempt = activeDiagnostic?.reinforcements?.[String(index)]?.find((item) => item.id === attemptId);
    if (!focus || !attempt) return;
    await run("正在换一种讲法", async () => {
      const data = await api({ action: "clarify_lesson", ...base, topicBasis: diagnosticBasis,
        focus, originalQuestion: questions[index].prompt, lesson: attempt.lesson,
        target: target.slice(0, 500), previousClarifications: attempt.clarifications.slice(-5) });
      const result = data.result as { explanation?: string };
      if (!result?.explanation?.trim()) throw new Error("没有收到更详细的讲解，请重试。");
      setSpace((previous) => ({ ...previous, diagnostics: previous.diagnostics.map((record) => record.id === activeDiagnosticId
        ? { ...record, reinforcements: { ...record.reinforcements,
          [String(index)]: (record.reinforcements?.[String(index)] || []).map((entry) => entry.id === attemptId
            ? { ...entry, clarifications: [...entry.clarifications, { target: target.slice(0, 500), explanation: result.explanation!.slice(0, 6000) }] } : entry) } }
        : record) }));
    });
  }

  async function askTeacher() {
    const prompt = message.trim();
    if (!prompt) return;
    setMessage("");
    setProfile((previous) => ({ ...previous, messages: [...previous.messages, { role: "user" as const, content: prompt }].slice(-30) }));
    await run("正在思考", async () => {
      const data = await api({ action: "chat", ...base, message: prompt, history: profile.messages.slice(-8) });
      const content = typeof data.result === "string" ? data.result : "";
      if (!content) throw new Error("没有收到回答，请重试。");
      const sources = Array.isArray(data.sources) ? data.sources.filter((item): item is Source => item && typeof item.url === "string" && typeof item.title === "string") : [];
      setProfile((previous) => ({ ...previous, messages: [...previous.messages, { role: "assistant" as const, content, sources }].slice(-30) }));
    });
  }

  async function createCloudAccount() {
    if (cloudBusyRef.current) return;
    if (cloudPassword !== cloudPasswordConfirm) { setError("两次输入的密码不一致。"); return; }
    if (!validPassword(cloudPassword)) { setError("密码需为 12～128 个字符。"); return; }
    cloudBusyRef.current = true; setCloudBusy("创建私人账号…"); setError("");
    try {
      const salt = passwordSalt();
      const proof = await passwordProof(cloudPassword, salt);
      const data = await cloudPost({ action: "signup", username: cloudUsername, salt, proof });
      localStorage.removeItem(CLOUD_SYNC_KEY);
      setCloud({ connected: true, accountId: String(data.accountId || ""), username: String(data.username || ""), revision: 0, archive: null });
      setCloudPassword(""); setCloudPasswordConfirm("");
      setNotice("账号已创建。请点击“首次上传本机档案”，之后就能在其他设备用用户名和密码继续学习。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法创建云端档案。"); }
    finally { cloudBusyRef.current = false; setCloudBusy(""); }
  }

  async function loginCloudAccount() {
    if (cloudBusyRef.current) return;
    cloudBusyRef.current = true; setCloudBusy("登录私人账号…"); setError("");
    try {
      const challenge = await cloudGet(`?${new URLSearchParams({ action: "login-salt", username: cloudUsername })}`);
      const proof = await passwordProof(cloudPassword, String(challenge.salt || ""));
      await cloudPost({ action: "login-password", username: cloudUsername, proof });
      const snapshot = await cloudGet() as CloudSnapshot;
      localStorage.removeItem(CLOUD_SYNC_KEY);
      setCloud(snapshot); setCloudPassword(""); setCloudPasswordConfirm(""); setCloudAutoSync(false);
      setNotice(snapshot.archive ? "已连接云端档案。请先恢复到这台设备，再继续学习；本机档案不会自动覆盖云端。" : "已连接空白云端档案。可以首次上传本机学习空间。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "云端连接失败。"); }
    finally { cloudBusyRef.current = false; setCloudBusy(""); }
  }

  async function connectLegacyCloud() {
    if (cloudBusyRef.current) return;
    cloudBusyRef.current = true; setCloudBusy("查找旧云端档案…"); setError("");
    try {
      await cloudPost({ action: "legacy-login", code: legacyCodeInput.trim() });
      const snapshot = await cloudGet() as CloudSnapshot;
      localStorage.removeItem(CLOUD_SYNC_KEY);
      setCloud(snapshot); setCloudAutoSync(false); setLegacyCodeInput("");
      setNotice("已找到旧云端档案。请设置用户名和密码，原有学习空间及资料会保留。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "旧档案连接失败。"); }
    finally { cloudBusyRef.current = false; setCloudBusy(""); }
  }

  async function upgradeLegacyCloud() {
    if (cloudBusyRef.current || !cloud?.legacy) return;
    if (cloudPassword !== cloudPasswordConfirm) { setError("两次输入的密码不一致。"); return; }
    if (!validPassword(cloudPassword)) { setError("密码需为 12～128 个字符。"); return; }
    cloudBusyRef.current = true; setCloudBusy("迁移旧档案到账号…"); setError("");
    try {
      const salt = passwordSalt();
      const proof = await passwordProof(cloudPassword, salt);
      await cloudPost({ action: "upgrade", username: cloudUsername, salt, proof });
      const snapshot = await cloudGet() as CloudSnapshot;
      localStorage.removeItem(CLOUD_SYNC_KEY);
      setCloud(snapshot); setCloudPassword(""); setCloudPasswordConfirm(""); setCloudAutoSync(false);
      setNotice("旧档案已迁移到账号。原同步密钥现已失效；请从云端恢复到这台设备后继续学习。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "旧档案迁移失败。"); }
    finally { cloudBusyRef.current = false; setCloudBusy(""); }
  }

  async function logoutCloudAccount() {
    if (cloudBusyRef.current) return;
    cloudBusyRef.current = true; setCloudBusy("断开云端…");
    try {
      await cloudPost({ action: "logout" });
      localStorage.removeItem(CLOUD_SYNC_KEY);
      setCloud({ connected: false, signupAvailable: true });
      setCloudAutoSync(false); cloudSavedRef.current = ""; setCloudPassword(""); setCloudPasswordConfirm("");
      setNotice("已断开云端档案；本机资料仍保留在当前浏览器。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "无法断开云端档案。"); }
    finally { cloudBusyRef.current = false; setCloudBusy(""); }
  }

  async function submitContribution(materialId: string, sourceNote: string, sourceUrl: string) {
    if (!cloud?.connected || cloud.legacy || !cloud.accountId) throw new Error("请先登录云端账号。");
    if (cloudBusyRef.current) throw new Error("云端正在处理其他操作，请稍后再投稿。");
    if (cloud.archive && !cloudAutoSync) throw new Error("云端已有档案，请先在账号区恢复到这台设备，或确认用本机档案覆盖，再投稿。");
    const material = space.materials.find((item) => item.id === materialId);
    if (!material || material.origin !== "upload" || !material.storedText || !material.coverage?.complete) throw new Error("只能投稿已完整读取的本人上传资料。");
    cloudBusyRef.current = true; setCloudBusy("正在准备私人云端资料…"); setError("");
    try {
      const result = await sendArchive(archive, cloud.revision || 0, setCloudBusy);
      if (result.cleanupPending) throw new Error("私人云端资料清理尚未完成，请稍后重试投稿。");
      cloudSavedRef.current = JSON.stringify(archive);
      setCloud((previous) => previous ? { ...previous, revision: result.revision, archive, updatedAt: new Date().toISOString() } : previous);
      localStorage.setItem(CLOUD_SYNC_KEY, JSON.stringify({ accountId: cloud.accountId, revision: result.revision, digest: await archiveDigest(archive) }));
      setCloudAutoSync(true);
      setCloudBusy("正在提交资料审核…");
      await libraryPost({ action: "submit", materialId, sourceNote, sourceUrl, confirmRights: true });
      setShareTarget(null); setLibraryRefreshKey((previous) => previous + 1);
      setNotice("资料已提交审核，目前仅你和审核员可见；审核通过后才会进入公共资料库。");
    } catch (cause) { const message = cause instanceof Error ? cause.message : "投稿失败，私人资料仍保留。"; setError(message); throw new Error(message); }
    finally { cloudBusyRef.current = false; setCloudBusy(""); }
  }

  async function importLibraryItem(detail: LibraryDetail) {
    const { item, pages } = detail;
    if (item.goal.trim().toLowerCase() !== profile.goal.trim().toLowerCase() || item.subject.trim().toLowerCase() !== profile.subject.trim().toLowerCase())
      throw new Error("请先切换到目标和科目相同的学习空间。");
    if (space.materials.some((material) => material.libraryId === item.id)) throw new Error("这份公共资料已经在当前学习空间中。");
    const id = newId();
    const document: StoredDocument = { materialId: id, sha256: item.coverage.sha256, pages };
    if (!validDocument(document) || pages.length !== item.coverage.total || pages.filter((page) => page.method === "ocr").length !== item.coverage.ocr)
      throw new Error("公共资料正文缺页或完整性信息不符，未加入学习空间。");
    await saveDocument(document);
    const material: Material = { version: 1, id, libraryId: item.id, title: item.title, category: item.category,
      reliability: "reference", status: "read", origin: "library", note: `公共资料库投稿；来源：${item.sourceNote}。请对照原始来源核对内容。`.slice(0, 900),
      url: item.sourceUrl || undefined, summary: item.summary, topics: item.category === "syllabus" ? item.topics : [],
      excerpt: pages.map((page) => page.text).join("\n").slice(0, 16000), coverage: item.coverage, storedText: true, addedAt: new Date().toISOString() };
    setSpace((previous) => {
      const materials = [...previous.materials, material].slice(0, 150);
      const progress = reconciledProgress(previous, materials);
      return { ...previous, materials, profile: { ...previous.profile, ...progress,
        sourceNames: [...previous.profile.sourceNames, material.title].slice(0, 40),
        sourceSummary: [previous.profile.sourceSummary, material.summary].filter(Boolean).join("\n").slice(0, 12000) } };
    });
    setNotice(`「${item.title}」的 ${pages.length} ${item.coverage.unit === "page" ? "页" : "段"}正文已加入当前学习空间。`);
  }

  async function syncCloud(snapshot: LearningArchive, revision: number, automatic = false) {
    if (cloudBusyRef.current || !cloud?.connected) return;
    if (!automatic && !cloudAutoSync && revision > 0 && !window.confirm("云端已有学习档案。上传当前浏览器的档案会替换云端版本；建议先从云端恢复或导出备份。确认上传吗？")) return;
    cloudBusyRef.current = true; setCloudBusy("准备同步…"); setError("");
    try {
      const result = await sendArchive(snapshot, revision, setCloudBusy);
      cloudSavedRef.current = JSON.stringify(snapshot);
      setCloud((previous) => previous ? { ...previous, revision: result.revision, archive: snapshot, updatedAt: new Date().toISOString() } : previous);
      if (result.cleanupPending) { localStorage.removeItem(CLOUD_SYNC_KEY); setCloudAutoSync(false); setError("档案已保存，但已删除资料的云端正文清理未完成。请稍后再次点击“上传当前档案”。"); }
      else if (!automatic) { setCloudAutoSync(true); setNotice("本机档案及完整逐页正文已保存到私人云端，后续改动会自动同步。"); }
      if (!result.cleanupPending && cloud.accountId) localStorage.setItem(CLOUD_SYNC_KEY, JSON.stringify({ accountId: cloud.accountId, revision: result.revision, digest: await archiveDigest(snapshot) }));
    } catch (cause) {
      setCloudAutoSync(false);
      setError(cause instanceof Error ? cause.message : "同步失败，本机档案仍保留。");
    } finally { cloudBusyRef.current = false; setCloudBusy(""); }
  }

  async function restoreCloudArchive() {
    if (cloudBusyRef.current || !cloud?.connected || !cloud.archive || busy) return;
    if (!window.confirm("将云端档案恢复到当前浏览器。网站会先下载本机档案备份，再替换本机学习空间。确定继续吗？")) return;
    if (!(await exportArchive())) return;
    cloudBusyRef.current = true; setCloudBusy("检查云端资料…"); setError("");
    try {
      const latest = await cloudGet() as CloudSnapshot;
      if (!latest.connected || !latest.archive) throw new Error("云端档案目前无法读取，本机档案未替换。");
      const remote = await receiveArchive(latest.archive, setCloudBusy);
      saveArchive(localStorage, remote);
      setArchive(remote); clearTransient();
      setCloud({ ...latest, signupAvailable: cloud.signupAvailable });
      cloudSavedRef.current = JSON.stringify(remote);
      if (latest.accountId) localStorage.setItem(CLOUD_SYNC_KEY, JSON.stringify({ accountId: latest.accountId, revision: latest.revision, digest: await archiveDigest(remote) }));
      setCloudAutoSync(true);
      setNotice("云端档案和逐页正文已完整恢复；本机旧档案已下载为备份。");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "云端恢复失败，本机档案未替换。"); }
    finally { cloudBusyRef.current = false; setCloudBusy(""); }
  }

  async function exportArchive(): Promise<boolean> {
    try {
      const ids = archive.spaces.flatMap((item) => item.materials.map((material) => material.id));
      const documentTexts = await documentsForExport(ids);
      const savedIds = new Set(documentTexts.map((item) => item.materialId));
      if (archive.spaces.some((item) => item.materials.some((material) => material.storedText && !savedIds.has(material.id)))) {
        throw new Error("逐页正文缺失");
      }
      const url = URL.createObjectURL(new Blob([JSON.stringify({ ...archive, documentTexts }, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url; link.download = "你的学霸同桌-全部学习空间.json";
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setNotice(`已导出学习档案，包含 ${documentTexts.length} 份资料的完整识别正文。上传原文件仍不包含在内。`);
      return true;
    } catch { setError("无法导出逐页正文。请检查浏览器存储权限后重试，避免只备份部分资料。"); return false; }
  }

  async function importArchive(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (file.size > 250_000_000) throw new Error("文件过大");
      const value: unknown = JSON.parse(await file.text());
      const imported = parseArchive(value);
      if (!window.confirm(`将导入 ${imported.spaces.length} 个学习空间，并替换当前浏览器中的全部学习空间。建议先导出当前档案。确认继续吗？`)) return;
      const documentTexts = value && typeof value === "object" && Array.isArray((value as { documentTexts?: unknown }).documentTexts)
        ? (value as { documentTexts: unknown[] }).documentTexts : [];
      const materialIds = new Set(imported.spaces.flatMap((item) => item.materials.map((material) => material.id)));
      if (documentTexts.length > 150 || documentTexts.some((item) => !validDocument(item) || !materialIds.has(item.materialId))) {
        throw new Error("逐页正文格式无效");
      }
      const documentsById = new Map((documentTexts as StoredDocument[]).map((item) => [item.materialId, item]));
      if (imported.spaces.some((item) => item.materials.some((material) => material.storedText &&
        (documentsById.get(material.id)?.sha256 !== material.coverage?.sha256 ||
          documentsById.get(material.id)?.pages.length !== material.coverage?.total)))) {
        throw new Error("档案中的资料正文缺失或与资料记录不符");
      }
      for (const document of documentTexts as StoredDocument[]) await saveDocument(document);
      localStorage.removeItem(CLOUD_SYNC_KEY);
      setCloudAutoSync(false); cloudSavedRef.current = "";
      setArchive(imported);
      setPersistenceReady(true);
      clearTransient();
      setNotice(`全部学习空间已导入，恢复 ${documentTexts.length} 份资料的逐页正文。旧版档案会自动迁移；云端自动同步已暂停，请核对后手动上传。`);
      setError("");
    } catch { setError("无法导入：请选择由 AI 教学页导出的有效学习档案。"); }
  }

  function openDiagnostic(record: DiagnosticRecord) {
    setQuestions(record.questions); setAnswers(record.answers); setAssessment(record.assessment);
    setSelectedAttemptByQuestion({}); setActiveDiagnosticId(record.id);
    setDiagnosticBasis(record.basis || "verified");
    setSection("diagnosis"); setNotice(`已打开 ${record.date} 的诊断记录，可继续逐题强化。`);
  }

  return <main className="app-shell">
    <header className="site-header">
      <div className="brand"><div className="brand-mark"><GraduationCap size={22}/></div><div><strong>你的学霸同桌</strong><span>AI 学习工作台</span></div></div>
      <a className="demo-link" href="/demo">查看界面演示 <ArrowRight size={14}/></a>
    </header>
    <div className="workspace live-workspace">
      <div className="live-heading">
        <div><span className="eyebrow">你的专属学习空间</span><h1>先诊断，再突破。</h1><p>根据目标或你提供的资料生成题目，找出薄弱点，强化后继续复测。</p></div>
        <span className={"connection-pill " + (configured ? "ready" : "pending")}>{configured === null ? "检查密钥中" : configured ? PROVIDER_NAMES[provider] + " 密钥已保存" : "等待配置 API 密钥"}</span>
      </div>

      <div className="provider-switcher">
        <div className="provider-field"><Label htmlFor="model-provider">模型服务商</Label><select id="model-provider" className="provider-select" value={provider} disabled={Boolean(busy)} onChange={(event) => { setProvider(event.target.value as Provider); setConfigured(null); setApiKeyInput(""); setError(""); setNotice(""); }}><option value="openai">OpenAI</option><option value="qwen">阿里云百炼 · 通义千问</option><option value="glm">智谱 GLM</option></select></div>
        {provider === "qwen" && <div className="provider-field"><Label htmlFor="qwen-region">百炼密钥地域</Label><select id="qwen-region" className="provider-select" value={qwenRegion} disabled={Boolean(busy)} onChange={(event) => { setQwenRegion(event.target.value as QwenRegion); setConfigured(null); setApiKeyInput(""); setError(""); setNotice(""); }}><option value="cn-beijing">华北 2（北京）</option><option value="ap-southeast-1">新加坡</option></select></div>}
        {provider === "glm" && <div className="provider-field"><Label htmlFor="glm-model">智谱模型</Label><select id="glm-model" className="provider-select" value={glmModel} disabled={Boolean(busy)} onChange={(event) => { setGlmModel(event.target.value as GLMModel); setError(""); setNotice(""); }} >{GLM_MODELS.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></div>}
        <div className="provider-field"><Label htmlFor="search-provider">GitHub 线索搜索方式</Label><select id="search-provider" className="provider-select" value={searchProvider} disabled={Boolean(busy)} onChange={(event) => { setSearchProvider(event.target.value as SearchProvider); setError(""); setNotice(""); }}><option value="github">GitHub 原生搜索</option><option value="tavily">Tavily 搜索 GitHub</option></select></div>
        <p>两种方式都只收录 GitHub 文件：先发现仓库，再从 GitHub 读取正文并核对科目。Tavily 只接收目标和科目等检索词，不接收上传资料、答题或聊天内容。</p>
      </div>

      {configured === false && <div className="setup-alert" role="status"><CircleHelp size={22}/><div><strong>请连接 {PROVIDER_NAMES[provider]} 的 API 密钥</strong><p>先到 <a href={PROVIDER_KEY_LINKS[provider]} target="_blank" rel="noopener noreferrer">{PROVIDER_NAMES[provider]} 平台创建密钥 ↗</a>，再在此处保存。{provider === "qwen" ? "创建密钥时请选择与上方一致的地域。" : provider === "glm" ? "请使用智谱开放平台的模型 API 密钥。" : "API 使用与 ChatGPT 订阅分别计费。"}</p>{keySetupAvailable ? <div className="key-setup"><Input type="password" autoComplete="off" spellCheck={false} value={apiKeyInput} onChange={(event) => setApiKeyInput(event.target.value)} placeholder="粘贴当前服务商的 API 密钥" aria-label={PROVIDER_NAMES[provider] + " API 密钥"}/><Button disabled={!apiKeyInput.trim() || Boolean(busy)} onClick={saveKey}>保存密钥</Button><small>密钥只发送到本站服务端，并加密存入此浏览器的 HttpOnly Cookie；不会写入网页代码或学习档案。首次教学请求会验证密钥与模型权限。</small></div> : <p>本站的安全密钥入口正在配置，请稍后刷新。</p>}</div></div>}
      {configured && <div className="connected-note"><Check size={16}/>{PROVIDER_NAMES[provider]} 密钥已保存。{provider === "glm" && <span>当前模型：{GLM_MODELS.find((item) => item.value === glmModel)?.label}</span>}<button type="button" disabled={Boolean(busy)} onClick={testConnection}>测试模型</button><button type="button" disabled={Boolean(busy)} onClick={removeKey}>移除此服务商密钥</button></div>}
      {searchProvider === "tavily" && searchConfigured === false && <div className="setup-alert" role="status"><CircleHelp size={22}/><div><strong>请连接 Tavily 搜索密钥</strong><p>到 <a href="https://app.tavily.com/" target="_blank" rel="noopener noreferrer">Tavily 创建 API 密钥 ↗</a>。选择 Tavily 时，每次检索最多发起三次 GitHub 域名搜索，请留意账户额度。</p>{keySetupAvailable ? <div className="key-setup"><Input type="password" autoComplete="off" spellCheck={false} value={searchKeyInput} onChange={(event) => setSearchKeyInput(event.target.value)} placeholder="粘贴 Tavily API 密钥" aria-label="Tavily API 密钥"/><Button disabled={!searchKeyInput.trim() || Boolean(busy)} onClick={saveSearchKey}>保存搜索密钥</Button><small>密钥加密保存于此浏览器的 HttpOnly Cookie，不写入学习档案。</small></div> : <p>本站的安全密钥入口正在配置，请稍后刷新。</p>}</div></div>}
      {searchProvider === "tavily" && searchConfigured && <div className="connected-note"><Check size={16}/>Tavily 密钥已保存，将只用于发现 GitHub 仓库。<button type="button" disabled={Boolean(busy)} onClick={removeSearchKey}>移除 Tavily 密钥</button></div>}
      <details className="github-token-settings"><summary>GitHub 访问令牌（可选，减少请求限制）{githubConfigured ? " · 已连接" : ""}</summary><p>GitHub 原生检索和仓库文件读取都会使用它。未设置时继续使用公共额度。可在 <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener noreferrer">GitHub 创建访问令牌 ↗</a>，只授予所需仓库的读取权限。</p>{githubConfigured ? <button type="button" disabled={Boolean(busy)} onClick={removeGithubKey}>移除 GitHub 访问令牌</button> : keySetupAvailable ? <div className="key-setup"><Input type="password" autoComplete="off" spellCheck={false} value={githubKeyInput} onChange={(event) => setGithubKeyInput(event.target.value)} placeholder="粘贴 GitHub 访问令牌" aria-label="GitHub 访问令牌"/><Button disabled={!githubKeyInput.trim() || Boolean(busy)} onClick={saveGithubKey}>保存访问令牌</Button><small>令牌加密保存在此浏览器的 HttpOnly Cookie，不写入学习档案。</small></div> : null}</details>
      <div className="live-grid">
        <aside className="live-sidebar">
          <section className="live-card cloud-card">
            <span className="eyebrow">私人云端账号</span>
            <h2>换设备继续学习</h2>
            {cloudBusy && <p role="status">{cloudBusy}</p>}
            {cloud === null ? <p>正在检查云端状态…</p> : cloud.unavailable ? <p>云端暂时无法连接。本机档案仍可使用，请稍后刷新页面重试。</p> : cloud.connected && cloud.legacy ? <>
              <p>检测到旧版云端档案。设置用户名和密码即可保留原有学习数据，并停止使用旧同步密钥。</p>
              <div className="live-field"><Label htmlFor="upgrade-username">新用户名</Label><Input id="upgrade-username" autoComplete="username" value={cloudUsername} onChange={(event) => setCloudUsername(event.target.value)} maxLength={32}/></div>
              <div className="live-field"><Label htmlFor="upgrade-password">新密码</Label><Input id="upgrade-password" type="password" autoComplete="new-password" value={cloudPassword} onChange={(event) => setCloudPassword(event.target.value)} maxLength={128}/></div>
              <div className="live-field"><Label htmlFor="upgrade-password-confirm">确认密码</Label><Input id="upgrade-password-confirm" type="password" autoComplete="new-password" value={cloudPasswordConfirm} onChange={(event) => setCloudPasswordConfirm(event.target.value)} maxLength={128}/></div>
              <small>用户名为 3～32 个字母、数字、下划线或短横线，也可以使用汉字；密码至少 12 个字符。请妥善保存密码，当前没有邮件找回功能。</small>
              <Button disabled={Boolean(cloudBusy) || !cloudUsername.trim() || cloudPassword.length < 12 || !cloudPasswordConfirm} onClick={upgradeLegacyCloud}>将旧档案迁移为账号</Button>
              <Button variant="ghost" disabled={Boolean(cloudBusy)} onClick={logoutCloudAccount}>暂不迁移并退出</Button>
            </> : cloud.connected ? <>
              <p>已登录：{cloud.username} · 云端版本 {cloud.revision || 0}{cloudAutoSync ? " · 自动同步已开启" : " · 尚未在本设备启用同步"}</p>
              {cloud.updatedAt && <small>云端上次更新：{new Date(cloud.updatedAt).toLocaleString("zh-CN")}</small>}
              {cloud.archive && !cloudAutoSync && <div className="cloud-restore-prompt" role="status"><strong>先把云端档案恢复到这台设备</strong><p>网站会先下载本机档案备份，再恢复学习空间和已读取的逐页正文。完成后可继续学习并自动同步。</p><Button disabled={Boolean(cloudBusy) || Boolean(busy)} onClick={restoreCloudArchive}>恢复到这台设备</Button></div>}
              <div className="cloud-actions">
                {(!cloud.archive || cloudAutoSync) && <Button variant="outline" disabled={Boolean(cloudBusy) || !persistenceReady || Boolean(busy)} onClick={() => void syncCloud(archive, cloud.revision || 0)}>{cloud.archive ? "立即上传本机改动" : "首次上传本机档案"}</Button>}
                {cloud.archive && cloudAutoSync && <Button variant="outline" disabled={Boolean(cloudBusy) || Boolean(busy)} onClick={restoreCloudArchive}>从云端恢复</Button>}
                <Button variant="ghost" disabled={Boolean(cloudBusy)} onClick={logoutCloudAccount}>退出账号</Button>
              </div>
              {cloud.archive && !cloudAutoSync && <details className="cloud-replace"><summary>改用本机档案覆盖云端</summary><p>只有确认本机内容应替换云端时才使用。上传前会再次确认；如云端被其他设备更新，将拒绝旧版本覆盖。</p><Button variant="outline" disabled={Boolean(cloudBusy) || !persistenceReady || Boolean(busy)} onClick={() => void syncCloud(archive, cloud.revision || 0)}>上传本机档案并替换云端</Button></details>}
              <small>资料默认仅自己可见。同步包含已读取资料的逐页正文；上传原文件和模型 API 密钥不会进入云端档案。换设备后需重新连接模型密钥。</small>
            </> : <>
              <p>登录后可保存自己的学习档案，并在其他设备继续。</p>
              <div className="cloud-auth-tabs"><button type="button" aria-pressed={cloudMode === "login"} onClick={() => { setCloudMode("login"); setError(""); }}>登录</button><button type="button" aria-pressed={cloudMode === "signup"} onClick={() => { setCloudMode("signup"); setError(""); }}>注册</button></div>
              <div className="live-field"><Label htmlFor="cloud-username">用户名</Label><Input id="cloud-username" autoComplete="username" value={cloudUsername} onChange={(event) => setCloudUsername(event.target.value)} maxLength={32}/></div>
              <div className="live-field"><Label htmlFor="cloud-password">密码</Label><Input id="cloud-password" type="password" autoComplete={cloudMode === "signup" ? "new-password" : "current-password"} value={cloudPassword} onChange={(event) => setCloudPassword(event.target.value)} maxLength={128}/></div>
              {cloudMode === "signup" && <div className="live-field"><Label htmlFor="cloud-password-confirm">确认密码</Label><Input id="cloud-password-confirm" type="password" autoComplete="new-password" value={cloudPasswordConfirm} onChange={(event) => setCloudPasswordConfirm(event.target.value)} maxLength={128}/></div>}
              <Button disabled={Boolean(cloudBusy) || !cloudUsername.trim() || !cloudPassword || (cloudMode === "signup" && !cloudPasswordConfirm)} onClick={cloudMode === "signup" ? createCloudAccount : loginCloudAccount}>{cloudMode === "signup" ? "创建账号" : "登录并查看云端档案"}</Button>
              {cloudMode === "signup" && <small>用户名为 3～32 个字母、数字、下划线或短横线，也可以使用汉字；密码至少 12 个字符。当前没有邮件找回功能，请妥善保存密码。</small>}
              <details><summary>已有旧同步密钥？迁移原档案</summary><p>旧密钥只用于取回已有档案。设置账号后，原密钥失效。</p><div className="live-field"><Label htmlFor="legacy-cloud-code">旧同步密钥</Label><Input id="legacy-cloud-code" type="password" autoComplete="off" value={legacyCodeInput} onChange={(event) => setLegacyCodeInput(event.target.value)} placeholder="粘贴原同步密钥"/></div><Button variant="outline" disabled={Boolean(cloudBusy) || !legacyCodeInput.trim()} onClick={connectLegacyCloud}>查找旧档案</Button></details>
            </>}
          </section>
          <section className="live-card space-card">
            <span className="eyebrow">学习空间</span>
            <div className="live-field"><Label htmlFor="space-picker">选择科目档案</Label><select id="space-picker" className="provider-select" value={archive.activeSpaceId} disabled={Boolean(busy)} onChange={(event) => switchStudySpace(event.target.value)}>{archive.spaces.map((item) => <option key={item.id} value={item.id}>{item.name || spaceName(item.profile, item.institution)}</option>)}</select></div>
            <div className="live-field"><Label htmlFor="space-name">空间名称</Label><Input id="space-name" value={space.name} maxLength={100} onChange={(event) => setSpace((previous) => ({ ...previous, name: event.target.value }))} onBlur={() => { if (!space.name.trim()) setSpace((previous) => ({ ...previous, name: spaceName(previous.profile, previous.institution) })); }}/></div>
            <div className="space-actions"><Button variant="outline" disabled={Boolean(busy)} onClick={createStudySpace}><Plus size={16}/>新建科目</Button><Button variant="ghost" disabled={Boolean(busy)} onClick={deleteStudySpace}><Trash2 size={16}/>删除空间</Button></div>
            <p className="space-help">切换已保存的空间会直接显示原有资料和学习进度。</p>
          </section>
          <section className="live-card">
            <span className="eyebrow">01 · 学习目标</span>
            <div className="live-field"><Label htmlFor="live-goal">考试或学习目标</Label><Input id="live-goal" value={profile.goal} maxLength={200} onChange={(event) => updateStudyTarget("goal", event.target.value)}/></div>
            <div className="live-field"><Label htmlFor="live-subject">科目</Label><Input id="live-subject" value={profile.subject} maxLength={200} onChange={(event) => updateStudyTarget("subject", event.target.value)}/></div>
            <div className="live-field"><Label htmlFor="live-year">目标年份</Label><Input id="live-year" value={profile.year} maxLength={30} onChange={(event) => updateStudyTarget("year", event.target.value)}/></div>
            <div className="live-field"><Label htmlFor="live-institution">目标院校（可选）</Label><Input id="live-institution" value={space.institution} maxLength={120} placeholder="例如：目标大学" onChange={(event) => updateStudyTarget("institution", event.target.value)}/></div>
            <small className="material-hint">不同考试或科目请新建空间；直接修改当前目标会清空本空间的资料和知识点。</small>
          </section>
          <section className="live-card">
            <span className="eyebrow">02 · 学习范围</span>
            <h2>由考纲建立知识点</h2>
            <p>可以先用教学模型生成待核对知识地图并开始初步诊断；读到考纲后，再确定正式考点。教材用于讲解，真题用于参考题型和难度。</p>
            {!space.preliminary && !eligibleTopics.length && <Button className="sidebar-button" variant="outline" disabled={!configured || Boolean(busy) || !profile.goal.trim() || !profile.subject.trim()} onClick={preparePreliminaryMap}><Sparkles size={16}/>生成初步知识地图</Button>}
            <div className="live-field"><Label htmlFor="upload-category">上传资料类型</Label><select id="upload-category" className="provider-select" value={uploadCategory} onChange={(event) => setUploadCategory(event.target.value as SourceCategory)}>{SOURCE_GROUPS.map((group) => <option key={group.category} value={group.category}>{group.label}</option>)}</select></div>
            <input ref={materialInput} className="sr-only" type="file" accept=".pdf,.docx,.txt,.md" aria-label="上传学习资料" onChange={addMaterial}/>
            <Button className="sidebar-button" variant="outline" disabled={!configured || Boolean(busy)} onClick={() => materialInput.current?.click()}><Upload size={16}/>上传学习资料</Button>
            <div className="live-field"><Label htmlFor="repository-url">GitHub 仓库地址</Label><Input id="repository-url" type="url" value={repositoryUrl} maxLength={500} placeholder="https://github.com/用户名/仓库名" onChange={(event) => setRepositoryUrl(event.target.value)}/></div>
            <Button className="sidebar-button" variant="outline" disabled={Boolean(busy) || !profile.goal.trim() || !profile.subject.trim() || !repositoryUrl.trim()} onClick={() => inspectRepository()}><BookOpen size={16}/>列出仓库全部文件</Button>
            {repositoryKey && space.catalogedRepositories?.includes(repositoryKey) && <button type="button" className="repository-refresh" disabled={Boolean(busy)} onClick={() => inspectRepository(true)}>仓库有更新？重新扫描目录</button>}
            <Button className="sidebar-button" variant="ghost" disabled={!configured || Boolean(busy) || (searchProvider === "tavily" && !searchConfigured)} onClick={makePlan}><FilePlus2 size={16}/>检索 GitHub 候选文件</Button>
            {space.materials.some((item) => item.repository && item.status === "discovered") && <Button className="sidebar-button" variant="outline" disabled={!configured || Boolean(busy)} onClick={readAllCandidates}><BookOpen size={16}/>逐份读取待处理文件</Button>}
            <small className="material-hint">只保存正文可读取、且经内容核对与当前目标相关的 GitHub 文件；仓库链接和未读取文件不会成为教学依据。</small>
            <small className="material-hint">支持 PDF、DOCX、TXT、MD；上传单份不超过 25 MB，GitHub 文件不超过 30 MB。扫描页使用你配置的智谱密钥调用 GLM-OCR，消耗 API 额度。所有页面或分段均成功读取并核对后，才会标记“已读取”；识别正文保存在当前浏览器。</small>
            {space.preliminary && !eligibleTopics.length && <small className="material-hint">当前保存了 {space.preliminary.topics.length} 个模型生成的候选知识点；可以进行初步诊断，范围尚待考纲核对。</small>}
            {space.materials.length > 0 && <details className="source-links">
              <summary>已保存的资料与候选文件 <span>共 {space.materials.length} 份</span></summary>
              {SOURCE_GROUPS.filter((group) => space.materials.some((item) => item.category === group.category)).map((group) => {
                const items = space.materials.filter((item) => item.category === group.category);
                return <details className="source-group" key={group.category}>
                  <summary><b>{group.label}</b><span>{items.length} 份</span></summary>
                  <div className="source-group-content">
                  {items.map((material) => <div className="material-row" key={material.id}>
                    <div className="material-heading">
                      {material.url ? <a href={material.url} target="_blank" rel="noopener noreferrer">{material.title} ↗</a> : <span>{material.title}</span>}
                      <span className={`source-badge ${material.reliability}`}>{material.origin === "upload" ? "我的上传" : material.origin === "library" ? "公共资料库" : material.reliability === "official" ? "官方来源" : material.reliability === "github" ? "社区整理" : "辅助来源"}</span>
                    </div>
                    <div className="material-meta">
                      <span className={`material-status ${material.status}`}>{MATERIAL_STATUS[material.status]}</span>
                      {material.coverage?.complete && <small>完整处理 {material.coverage.processed}/{material.coverage.total} {material.coverage.unit === "page" ? "页" : "段"} · OCR {material.coverage.ocr} 页 · 内容核对 {material.coverage.analyzedParts} 段</small>}
                      {(material.status === "read" || material.status === "verified") && !material.coverage && <small>旧版资料未记录完整度；建议重新读取，确认没有遗漏页面。</small>}
                      {material.note && <small>{material.note}</small>}
                    </div>
                    {material.summary && <small className="material-summary">{material.summary}</small>}
                    <div className="material-actions">
                      {material.repository && material.path && (material.status === "discovered" || material.status === "ocr_needed" || material.status === "read" || material.status === "verified" || material.status === "unreadable" && /Invalid redirect value|下载失败|文件无法解析/.test(material.note)) && <button type="button" disabled={Boolean(busy)} onClick={() => readCandidate(material)}>{material.status === "ocr_needed" ? "OCR 并完整读取" : material.status === "read" || material.status === "verified" ? "重新完整读取" : material.status === "discovered" ? "完整读取" : "重新读取"}</button>}
                      {(material.status === "read" || material.status === "verified") && material.storedText && <button type="button" disabled={Boolean(busy)} onClick={() => viewDocument(material)}>查看逐页正文</button>}
                      {material.origin === "upload" && material.storedText && material.coverage?.complete && <button type="button" disabled={Boolean(busy)} onClick={() => setShareTarget(material)}>自愿贡献</button>}
                      {material.status === "read" && <button type="button" disabled={Boolean(busy)} onClick={() => verifyMaterial(material.id)}>我已核对</button>}
                      <button type="button" disabled={Boolean(busy)} onClick={() => deleteMaterial(material.id)}>删除</button>
                    </div>
                  </div>)}
                  </div>
                </details>;
              })}
              <small>已读取的考纲建立知识点；从公共资料库加入的考纲需再点击“我已核对”。真题可用于出题参考，未读取的链接不参与教学。</small>
              {viewedDocument && viewedMaterial && <div className="document-viewer">
              <div className="document-viewer-heading"><strong>逐页正文 · {viewedMaterial.title}</strong><button type="button" onClick={() => setViewedDocument(null)}>关闭</button></div>
              <label htmlFor="document-page">选择{viewedMaterial.coverage?.unit === "segment" ? "分段" : "页码"}</label>
              <select id="document-page" className="provider-select" value={viewedPage} onChange={(event) => setViewedPage(Number(event.target.value))}>
                {viewedDocument.pages.map((page, index) => <option key={page.number} value={index}>第 {page.number} {viewedMaterial.coverage?.unit === "segment" ? "段" : "页"}{page.method === "ocr" ? " · OCR" : ""}</option>)}
              </select>
              <pre>{viewedDocument.pages[viewedPage]?.text}</pre>
              </div>}
            </details>}
            {profile.sourceNote && <p className="source-note">{profile.sourceNote}</p>}
            {(profile.topics.length > 0 || Boolean(space.preliminary) || space.materials.length > 0 || webSources.length > 0) && <Button className="sidebar-button" variant="ghost" disabled={Boolean(busy)} onClick={resetScope}><RotateCcw size={16}/>清空学习范围</Button>}
          </section>
          <section className="live-card progress-card">
            <span className="eyebrow">学习概况</span>
            <div><strong>{profile.rounds.length}</strong><span>诊断轮次</span></div>
            <div><strong>{covered}/{diagnosticTopics.length}</strong><span>{topicBasis === "preliminary" ? "初步已检验知识点" : "已检验知识点"}</span></div>
            <div><strong>{weak}</strong><span>{topicBasis === "preliminary" ? "初步待强化或复测" : "待强化或复测"}</span></div>
          </section>
        </aside>

        <div className="live-main">
          <div className="live-nav" role="tablist" aria-label="教学模式">
            <button type="button" role="tab" aria-selected={section === "diagnosis"} className={section === "diagnosis" ? "active" : ""} onClick={() => setSection("diagnosis")}><CircleHelp size={17}/>诊断与突破</button>
            <button type="button" role="tab" aria-selected={section === "guided"} className={section === "guided" ? "active" : ""} onClick={() => setSection("guided")}><MessageCircle size={17}/>向同桌提问</button>
            <button type="button" role="tab" aria-selected={section === "archive"} className={section === "archive" ? "active" : ""} onClick={() => setSection("archive")}><BookOpen size={17}/>知识点与档案</button>
            <button type="button" role="tab" aria-selected={section === "library"} className={section === "library" ? "active" : ""} onClick={() => setSection("library")}><BookOpen size={17}/>公共资料库</button>
          </div>

          {section === "diagnosis" && <div className="live-panel">
            <div className="panel-head"><div><span className="eyebrow">AI 诊断循环</span><h2>用作答找到下一步</h2></div><span>{questions.length ? "第 " + (profile.rounds.length + (assessment ? 0 : 1)) + " 轮" : profile.rounds.length ? `已完成 ${profile.rounds.length} 轮` : "准备开始"}</span></div>
              {!questions.length && <div className="live-intro"><div className="flow-icon"><Sparkles size={26}/></div><h3>{eligibleTopics.length ? "按考纲知识点生成正式诊断" : "先生成知识地图，再进行初步诊断"}</h3><p>每轮生成 6 道基础、进阶和综合题，以选择题、判断题和填空题为主。初步地图由模型根据目标和科目提出，取得考纲后再核对正式范围；真题不是出题的必要条件。</p>{dueReviews.length > 0 && <small>有 {dueReviews.length} 个知识点到期，本轮诊断会自动加入标注为“复测题”的新题。</small>}<Button disabled={!configured || Boolean(busy) || !profile.goal.trim() || !profile.subject.trim()} onClick={startDiagnosis}>{eligibleTopics.length ? "生成本轮正式诊断" : preliminaryTopics.length ? "生成本轮初步诊断" : "生成初步地图并诊断"} <ArrowRight size={16}/></Button>{!eligibleTopics.length && <small>初步诊断结果会单独保存，待考纲核对后才计入正式考点。</small>}</div>}
            {questions.length > 0 && !assessment && <div className="live-questions">
              {questions.map((question, index) => <div className="live-question" key={index}><span>第 {index + 1} 题 · {difficultyLabel(question.difficulty)} · {question.type === "single_choice" ? "单项选择题" : question.type === "true_false" ? "判断题" : "填空题"} · {question.topic}</span><QuestionBasis question={question} basis={diagnosticBasis} materials={space.materials}/><MathText as="h3">{question.prompt}</MathText>{question.type === "fill_blank" ? <Input value={answers[index] || ""} onChange={(event) => setAnswers(answers.map((answer, answerIndex) => answerIndex === index ? event.target.value : answer))} placeholder="填写答案；不会做可填写「不会」" aria-label={`第 ${index + 1} 题答案`}/> : <div className="live-choice-list" role="radiogroup" aria-label={`第 ${index + 1} 题选项`}>{question.options.map((option, optionIndex) => <button type="button" role="radio" aria-checked={answers[index] === option} className={answers[index] === option ? "selected" : ""} key={optionIndex} onClick={() => setAnswers(answers.map((answer, answerIndex) => answerIndex === index ? option : answer))}><b>{question.type === "true_false" ? optionIndex === 0 ? "√" : "×" : String.fromCharCode(65 + optionIndex)}</b><MathText>{option}</MathText></button>)}<button type="button" role="radio" aria-checked={answers[index] === "不会"} className={answers[index] === "不会" ? "selected unsure-choice" : "unsure-choice"} onClick={() => setAnswers(answers.map((answer, answerIndex) => answerIndex === index ? "不会" : answer))}><b>?</b>不会</button></div>}</div>)}
              <Button disabled={Boolean(busy)} onClick={submitDiagnosis}>提交并分析作答</Button>
            </div>}
            {assessment && <div className="live-results">
              <div className="result-summary"><Check size={22}/><div><strong>{diagnosticBasis === "preliminary" ? "初步诊断完成 · 待考纲核对" : "正式诊断完成"}</strong><MathText as="p">{assessment.summary}</MathText></div></div>
              {wrongResults.length > 0 && <div className="mistake-queue-head"><div><strong>错题强化清单</strong><span>每道错题都保留独立强化入口</span></div><b>{reinforcedQuestions.length}/{wrongResults.length} 已通过强化练习</b></div>}
              {assessment.results.map((item, index) => {
                const attempts = activeDiagnostic?.reinforcements?.[String(index)] || [];
                const selectedIndex = Math.min(selectedAttemptByQuestion[index] ?? attempts.length - 1, attempts.length - 1);
                const selectedAttempt = attempts[selectedIndex];
                return <div className="result-item" key={index}>
                  <div className="result-item-head"><strong>第 {index + 1} 题 · {item.topic}</strong><div className="result-badges"><span className={`difficulty ${questions[index]?.difficulty || "advanced"}`}>{difficultyLabel(questions[index]?.difficulty || "advanced")}</span><span className={item.verdict === "mastered" ? "success" : "attention"}>{item.verdict === "mastered" ? ((diagnosticBasis === "preliminary" ? space.preliminary?.mastery[questions[index]?.topic] : profile.mastery[questions[index]?.topic]) === "已掌握" ? diagnosticBasis === "preliminary" ? "初步掌握" : "已掌握" : "答对，待跨难度复测") : item.verdict === "partial" ? "部分正确" : "答错"}</span></div></div>
                  {questions[index] && <QuestionBasis question={questions[index]} basis={diagnosticBasis} materials={space.materials}/>}
                  <MathText as="p">{item.feedback}</MathText><small>参考解法：<MathText>{item.correctAnswer}</MathText></small>
                  {item.verdict !== "mastered" && <>
                    <div className="mistake-practice"><div><b>原题</b><MathText>{questions[index]?.prompt || ""}</MathText><small>你的答案：{answers[index]}</small></div><Button variant={attempts.length || reinforcedQuestions.includes(index) ? "outline" : "default"} disabled={Boolean(busy)} onClick={() => makeLesson(index)}>{attempts.length ? `生成强化 ${attempts.length + 1}` : "单独强化这道错题"}<ArrowRight size={15}/></Button></div>
                    {attempts.length > 0 && <div className="reinforcement-section">
                      <div className="reinforcement-tabs" role="tablist" aria-label={`第 ${index + 1} 题强化记录`}>{attempts.map((attempt, attemptIndex) => <button type="button" role="tab" aria-selected={selectedIndex === attemptIndex} className={selectedIndex === attemptIndex ? "active" : ""} key={attempt.id} onClick={() => setSelectedAttemptByQuestion((previous) => ({ ...previous, [index]: attemptIndex }))}>强化 {attemptIndex + 1}{attempt.passed ? " · 已通过" : ""}</button>)}</div>
                      {selectedAttempt && <ReinforcementCard key={selectedAttempt.id} attempt={selectedAttempt} attemptNumber={selectedIndex + 1} questionNumber={index + 1} topic={questions[index]?.topic || item.topic} busy={Boolean(busy)} onCheck={(answer) => checkLesson(index, selectedAttempt.id, answer)} onClarify={(target) => clarifyLesson(index, selectedAttempt.id, target)}/>}
                    </div>}
                  </>}
                </div>;
              })}
              <div className="live-actions"><Button variant="outline" disabled={Boolean(busy)} onClick={startDiagnosis}><RotateCcw size={16}/>再次诊断</Button></div>
            </div>}
          </div>}

          {section === "guided" && <div className="live-panel chat-panel">
            <div className="panel-head"><div><span className="eyebrow">引导学习</span><h2>向你的学霸同桌提问</h2></div></div>
            <p className="chat-intro">可以直接提问，也可以让同桌解释一个知识点。当前对话不会在其他网站搜索；涉及最新考试信息时，请上传正式文件核对。</p>
            <div className="chat-messages">{profile.messages.length === 0 && <div className="chat-empty"><MessageCircle size={27}/><strong>从一个问题开始</strong><span>例如：“我总分不清导数和变化率，能一步步教我吗？”</span></div>}{profile.messages.map((entry, index) => <div className={"chat-message " + entry.role} key={index}><span>{entry.role === "user" ? "我" : "学霸同桌"}</span><MathText as="p">{entry.content}</MathText>{entry.sources && entry.sources.length > 0 && <div className="chat-sources"><strong>参考来源</strong>{entry.sources.map((source, sourceIndex) => <a href={source.url} key={sourceIndex} target="_blank" rel="noopener noreferrer">{source.title} ↗</a>)}</div>}</div>)}<div ref={chatEnd}/></div>
            <div className="chat-compose"><Textarea value={message} onChange={(event) => setMessage(event.target.value)} placeholder="输入你想学的问题…" rows={3}/><Button disabled={!configured || Boolean(busy) || !message.trim()} onClick={askTeacher}>发送 <ArrowRight size={16}/></Button></div>
          </div>}

          {section === "archive" && <div className="live-panel">
            <div className="panel-head"><div><span className="eyebrow">你的学习地图</span><h2>知识点与学习档案</h2></div><span>{eligibleTopics.length} 个考纲知识点</span></div>
            <p className="archive-intro">{syllabusSummary || "正式知识点由已读取的考纲决定。初步地图可用于先行诊断，范围仍需考纲核对。"}</p>
            {!eligibleTopics.length && preliminaryMapView}
            {syllabusGroups.length > 0 && <div className="syllabus-groups">{syllabusGroups.map((group) => <section className="syllabus-topic-group" key={group.material.id}><h3>{group.material.title}<span>{group.topics.length} 个考点</span></h3><div className="live-topics">{group.topics.map((topic) => { const evidence = profile.evidence?.[topic]; return <div className={"topic-tile " + statusClass(profile.mastery[topic] || "未检验")} key={topic}><BookOpen size={17}/><strong>{topic}</strong><span>{profile.mastery[topic] || "未检验"}</span>{evidence?.attempted.length ? <small>已测：{evidence.attempted.map(difficultyLabel).join("、")}；通过：{evidence.passed.length ? evidence.passed.map(difficultyLabel).join("、") : "暂无"}</small> : null}</div>; })}</div></section>)}</div>}
            {eligibleTopics.length > 0 && preliminaryMapView && <details className="preliminary-archive"><summary>查看已收起的初步地图 · {space.preliminary?.topics.length} 个候选点，{matchedPreliminaryCount} 个已对应考纲</summary>{preliminaryMapView}</details>}
            {profile.rounds.length > 0 && <div className="live-history"><h3>历次诊断</h3>{profile.rounds.map((round, index) => { const record = space.diagnostics.find((item) => item.id === round.id); return <div key={round.id || index}><span>第 {index + 1} 轮 · {round.date} · {round.basis === "preliminary" ? "初步诊断" : "正式或旧版诊断"}</span><strong>{round.mastered}/{round.total} 题暂定掌握</strong>{record && <button type="button" onClick={() => openDiagnostic(record)}>查看错题与强化</button>}</div>; })}</div>}
            <div className="archive-tools"><Button variant="outline" onClick={exportArchive}><Download size={16}/>导出档案</Button><Button variant="outline" onClick={() => archiveInput.current?.click()}><Upload size={16}/>导入档案</Button><input ref={archiveInput} className="sr-only" type="file" accept=".json,application/json" onChange={importArchive} aria-label="导入 AI 学习档案"/></div>
            <p className="archive-privacy">学习空间始终保存在当前浏览器；连接私人云端后可同步到其他设备。导入和导出包含资料摘要、知识点、诊断记录与已读取正文；上传原文件不保存在档案中。</p>
          </div>}
          {section === "library" && <LibraryPanel key={cloud?.accountId || "anonymous"} subject={profile.subject} goal={profile.goal} connected={Boolean(cloud?.connected && !cloud.legacy)} refreshKey={libraryRefreshKey} onImport={importLibraryItem}/>}
          {busy && <p className="live-status" role="status">{busy}…</p>}
          {error && <p className="live-error" role="alert">{error}</p>}
          {notice && <p className="live-notice" role="status">{notice}</p>}
        </div>
      </div>
      {shareTarget && <ContributionDialog key={shareTarget.id} material={shareTarget} accountReady={Boolean(cloud?.connected && !cloud.legacy)} busy={Boolean(cloudBusy)} onClose={() => setShareTarget(null)} onSubmit={submitContribution}/>}
    </div>
  </main>;
}
