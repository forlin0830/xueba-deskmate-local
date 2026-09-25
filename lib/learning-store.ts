export type TopicStatus = "未检验" | "已掌握" | "待加强" | "待复测";
export type QuestionType = "single_choice" | "true_false" | "fill_blank";
export type Difficulty = "foundation" | "advanced" | "integrated";
export type TopicEvidence = { attempted: Difficulty[]; passed: Difficulty[] };
export type QuestionSource = { kind: "original" | "adapted"; syllabusId?: string; syllabusTitle?: string; pastExamId?: string; pastExamTitle?: string };
export type Question = { topic: string; difficulty: Difficulty; prompt: string; type: QuestionType; options: string[]; correctAnswer: string; explanation: string;
  purpose?: "diagnostic" | "review"; source?: QuestionSource };
export type ReviewSchedule = { topic: string; basis: "preliminary" | "verified"; difficulty: Difficulty;
  dueAt: string; intervalIndex: number; status: "scheduled" | "needs_reinforcement"; updatedAt: string };
export type Assessment = {
  summary: string;
  focusTopic: string;
  results: { topic: string; verdict: "mastered" | "partial" | "weak"; feedback: string; correctAnswer: string }[];
};
export type ReinforcementAttempt = {
  id: string;
  lesson: { explanation: string; example: string; checkQuestion: string; checkAnswer: string };
  answer: string;
  feedback: string;
  passed: boolean;
  clarifications: { target: string; explanation: string }[];
};
export type SourceCategory = "textbook" | "syllabus" | "past_exam";
export type SourceReliability = "official" | "github" | "reference";
export type Source = { title: string; url: string; category?: SourceCategory; reliability?: SourceReliability };
export type MaterialStatus = "discovered" | "read" | "verified" | "ocr_needed" | "unreadable" | "excluded";
export type DocumentCoverage = { total: number; processed: number; ocr: number; unit: "page" | "segment";
  analyzedParts: number; sha256: string; complete: boolean; checkedAt: string };
export type Material = {
  version: 1;
  id: string;
  title: string;
  url?: string;
  category: SourceCategory;
  reliability: SourceReliability;
  status: MaterialStatus;
  origin: "upload" | "github" | "web" | "library";
  libraryId?: string;
  note: string;
  summary: string;
  topics: string[];
  excerpt: string;
  coverage?: DocumentCoverage;
  storedText?: boolean;
  repository?: string;
  path?: string;
  revision?: string;
  blobSha?: string;
  fileSize?: number;
  addedAt: string;
};
export type Message = { role: "user" | "assistant"; content: string; sources?: Source[] };
export type Round = { id?: string; date: string; covered: number; mastered: number; total: number; basis?: "preliminary" | "verified" };
export type Profile = {
  version: 1;
  goal: string;
  subject: string;
  year: string;
  sourceSummary: string;
  sourceNote: string;
  sourceNames: string[];
  sourceLinks?: Source[];
  topics: string[];
  mastery: Record<string, TopicStatus>;
  evidence?: Record<string, TopicEvidence>;
  previousQuestions: string[];
  rounds: Round[];
  messages: Message[];
};
export type DiagnosticRecord = {
  version: 1;
  id: string;
  date: string;
  questions: Question[];
  answers: string[];
  assessment: Assessment;
  reinforced: number[];
  reinforcements?: Record<string, ReinforcementAttempt[]>;
  basis?: "preliminary" | "verified";
};
export type PreliminaryMap = {
  version: 1;
  summary: string;
  note: string;
  topics: string[];
  mastery: Record<string, TopicStatus>;
  evidence: Record<string, TopicEvidence>;
  matches?: Record<string, string>;
  reviewedTopics?: string[];
  createdAt: string;
};
export type LearningSpace = {
  version: 1;
  id: string;
  name: string;
  institution: string;
  profile: Profile;
  materials: Material[];
  diagnostics: DiagnosticRecord[];
  reviews?: ReviewSchedule[];
  catalogedRepositories?: string[];
  preliminary?: PreliminaryMap;
  createdAt: string;
  updatedAt: string;
};
export type LearningArchive = { version: 2; activeSpaceId: string; spaces: LearningSpace[] };

export const ARCHIVE_KEY = "xueba-deskmate-spaces-v2";
export const LEGACY_KEY = "xueba-deskmate-live-v1";

export const initialProfile: Profile = {
  version: 1, goal: "高考", subject: "数学", year: "2027", sourceSummary: "", sourceNote: "",
  sourceNames: [], sourceLinks: [], topics: [], mastery: {}, evidence: {}, previousQuestions: [], rounds: [], messages: [],
};

export function newId(): string {
  return globalThis.crypto?.randomUUID?.() || `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function spaceName(profile: Profile, institution = ""): string {
  return [profile.goal, institution, profile.subject, profile.year].filter(Boolean).join(" · ").slice(0, 100);
}

export function newSpace(profile: Profile = initialProfile, name?: string, institution = ""): LearningSpace {
  const now = new Date().toISOString();
  return { version: 1, id: newId(), name: name?.trim().slice(0, 100) || spaceName(profile, institution), institution, profile: { ...profile }, materials: [], diagnostics: [], reviews: [], catalogedRepositories: [], createdAt: now, updatedAt: now };
}

export function newArchive(): LearningArchive {
  const first = newSpace();
  return { version: 2, activeSpaceId: first.id, spaces: [first] };
}

export function groundedTopics(space: LearningSpace): string[] {
  return Array.from(new Set(space.materials.filter((material) => material.category === "syllabus" && (material.status === "verified" || (material.status === "read" && material.origin !== "library")))
    .flatMap((material) => material.topics))).slice(0, 300);
}

function topicKey(topic: string): string {
  return topic.replace(/^.{1,30}[：:]/, "").replace(/[\s，,。；;：:（）()\-—·]/g, "").toLowerCase();
}

export function matchingPreliminaryTopic(topic: string, candidates: string[]): string | undefined {
  const key = topicKey(topic);
  if (key.length < 4) return candidates.find((candidate) => topicKey(candidate) === key);
  return candidates.find((candidate) => {
    const candidateKey = topicKey(candidate);
    return candidateKey === key || (candidateKey.length >= 4 && (key.includes(candidateKey) || candidateKey.includes(key)));
  });
}

export function matchedPreliminaryTopic(space: LearningSpace, topic: string): string | undefined {
  const preliminary = space.preliminary;
  if (!preliminary) return undefined;
  if (preliminary.reviewedTopics) return Object.entries(preliminary.matches || {}).find(([, syllabus]) => syllabus === topic)?.[0];
  return matchingPreliminaryTopic(topic, preliminary.topics);
}

export function reconciledProgress(space: LearningSpace, materials: Material[]): Pick<Profile, "topics" | "mastery" | "evidence"> {
  const topics = groundedTopics({ ...space, materials });
  const mastery: Record<string, TopicStatus> = {};
  const evidence: Record<string, TopicEvidence> = {};
  for (const topic of topics) {
    const candidate = matchedPreliminaryTopic(space, topic);
    const previous = groundedTopics(space).includes(topic) ? space.profile.mastery[topic] : undefined;
    const provisional = candidate ? space.preliminary?.mastery[candidate] : undefined;
    mastery[topic] = previous && previous !== "未检验" ? previous
      : provisional === "已掌握" || provisional === "待复测" ? "待复测"
        : provisional === "待加强" ? "待加强" : "未检验";
    if (space.profile.evidence?.[topic]) evidence[topic] = space.profile.evidence[topic];
  }
  return { topics, mastery, evidence };
}

export function withoutMaterial(space: LearningSpace, id: string): LearningSpace {
  const materials = space.materials.filter((item) => item.id !== id);
  const progress = reconciledProgress(space, materials);
  return { ...space, materials, reviews: (space.reviews || []).filter((review) => review.basis === "preliminary" || progress.topics.includes(review.topic)), profile: { ...space.profile, ...progress,
    sourceNames: materials.filter((item) => item.origin === "upload").map((item) => item.title),
    sourceLinks: safeWebSources(materials.filter((item) => item.url).map((item) => ({ title: item.title, url: item.url, category: item.category, reliability: item.reliability }))),
    sourceSummary: materials.filter((item) => item.status === "read" || item.status === "verified").map((item) => item.summary).filter(Boolean).join("\n").slice(0, 12000),
  } };
}

export function validProfile(value: unknown): value is Profile {
  if (!value || typeof value !== "object") return false;
  const p = value as Partial<Profile>;
  return p.version === 1 && typeof p.goal === "string" && typeof p.subject === "string"
    && typeof p.year === "string" && typeof p.sourceSummary === "string" && typeof p.sourceNote === "string"
    && Array.isArray(p.sourceNames) && Array.isArray(p.topics) && !!p.mastery && typeof p.mastery === "object"
    && Array.isArray(p.previousQuestions) && Array.isArray(p.rounds) && Array.isArray(p.messages)
    && (p.sourceLinks === undefined || Array.isArray(p.sourceLinks));
}

export function safeWebSources(value: unknown): Source[] {
  if (!Array.isArray(value)) return [];
  const found: Source[] = [];
  for (const item of value) {
    if (!item || typeof item.title !== "string" || typeof item.url !== "string") continue;
    try {
      const url = new URL(item.url);
      const host = url.hostname.toLowerCase();
      const blocked = /^(?:360docs\.net|www\.360docs\.net|wenke99\.com|www\.wenke99\.com|m\.wenke99\.com|wenwen\.sogou\.com|lunwen881\.com|www\.lunwen881\.com|zhihu\.com|www\.zhihu\.com|zhuanlan\.zhihu\.com)$/.test(host);
      if (url.protocol !== "https:" || blocked || found.some((source) => source.url === url.href)) continue;
      const category = item.category === "textbook" || item.category === "syllabus" || item.category === "past_exam" ? item.category : undefined;
      const reliability = item.reliability === "official" || item.reliability === "github" || item.reliability === "reference" ? item.reliability : undefined;
      found.push({ title: item.title.slice(0, 140), url: url.href, category, reliability });
    } catch { /* Invalid imported URL. */ }
  }
  return found.slice(0, 40);
}

function migratedMaterials(profile: Profile): Material[] {
  const now = new Date().toISOString();
  const uploads: Material[] = profile.sourceNames.map((title) => ({
    version: 1, id: newId(), title: title.slice(0, 180), category: /真题|试卷|试题/.test(title) ? "past_exam" : /大纲|考点|考试范围/.test(title) ? "syllabus" : "textbook", reliability: "reference", status: "read",
    origin: "upload", note: "旧档案中的上传资料；已保存摘要，原文件未保存。原知识点无法确认是否来自考纲，请重新上传考纲建立学习地图。", summary: profile.sourceSummary.slice(0, 1200), topics: [], excerpt: "", addedAt: now,
  }));
  const links: Material[] = safeWebSources(profile.sourceLinks).map((source) => ({
    version: 1, id: newId(), title: source.title, url: source.url, category: source.category || "textbook",
    reliability: source.reliability || "reference", status: "discovered", origin: source.reliability === "github" ? "github" : "web",
    note: "旧档案中的链接，尚未确认是否读取正文。", summary: "", topics: [], excerpt: "", addedAt: now,
  }));
  return [...uploads, ...links];
}

function legacyPreliminary(profile: Profile): PreliminaryMap | undefined {
  const topics = Array.from(new Set(profile.topics.filter((topic) => typeof topic === "string" && !!topic.trim()))).slice(0, 40);
  return topics.length ? { version: 1, summary: "旧版学习档案中的知识点", note: "来源尚未核对，请用考纲验证。", topics,
    mastery: Object.fromEntries(topics.map((topic) => [topic, profile.mastery[topic] || "未检验"])) as Record<string, TopicStatus>,
    evidence: Object.fromEntries(topics.filter((topic) => profile.evidence?.[topic]).map((topic) => [topic, profile.evidence![topic]])),
    createdAt: new Date().toISOString() } : undefined;
}

export function parseArchive(value: unknown): LearningArchive {
  if (validProfile(value)) {
    const profile = { ...value, sourceLinks: safeWebSources(value.sourceLinks), evidence: value.evidence || {}, rounds: value.rounds.map((round) => ({ ...round, id: round.id || newId() })) };
    const first = newSpace(profile);
    first.materials = migratedMaterials(profile);
    first.preliminary = legacyPreliminary(profile);
    first.profile.topics = groundedTopics(first);
    first.profile.mastery = {};
    first.profile.evidence = {};
    return { version: 2, activeSpaceId: first.id, spaces: [first] };
  }
  if (!value || typeof value !== "object") throw new Error("档案格式不正确");
  const archive = value as Partial<LearningArchive>;
  if (archive.version !== 2 || !Array.isArray(archive.spaces) || !archive.spaces.length || archive.spaces.length > 100) throw new Error("档案版本或学习空间无效");
  const spaces = archive.spaces.map((item) => {
    if (!item || item.version !== 1 || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.institution !== "string" || !validProfile(item.profile)
      || !Array.isArray(item.materials) || !Array.isArray(item.diagnostics)) throw new Error("学习空间格式不正确");
    const materials = item.materials.map((material) => {
      if (!material || material.version !== 1 || typeof material.id !== "string" || typeof material.title !== "string" || !["discovered", "read", "verified", "ocr_needed", "unreadable", "excluded"].includes(material.status)
        || !["textbook", "syllabus", "past_exam"].includes(material.category) || !["official", "github", "reference"].includes(material.reliability)
        || !["upload", "github", "web", "library"].includes(material.origin) || !Array.isArray(material.topics) || typeof material.summary !== "string" || typeof material.excerpt !== "string") throw new Error("资料记录格式不正确");
      let url: string | undefined;
      if (typeof material.url === "string") {
        try { const parsed = new URL(material.url); if (parsed.protocol === "https:") url = parsed.href; }
        catch { /* Invalid imported link. */ }
      }
      const rawCoverage = material.coverage;
      const coverage = rawCoverage && Number.isSafeInteger(rawCoverage.total) && rawCoverage.total > 0 && rawCoverage.total <= 10_000
        && rawCoverage.processed === rawCoverage.total && Number.isSafeInteger(rawCoverage.ocr) && rawCoverage.ocr >= 0
        && rawCoverage.ocr <= rawCoverage.total && (rawCoverage.unit === "page" || rawCoverage.unit === "segment")
        && Number.isSafeInteger(rawCoverage.analyzedParts) && rawCoverage.analyzedParts > 0
        && typeof rawCoverage.sha256 === "string" && /^[0-9a-f]{64}$/.test(rawCoverage.sha256)
        && rawCoverage.complete === true && typeof rawCoverage.checkedAt === "string"
        ? { ...rawCoverage } : undefined;
      return { ...material, url, coverage, storedText: material.storedText === true,
        topics: material.topics.filter((topic): topic is string => typeof topic === "string").slice(0, 300),
        excerpt: material.excerpt.slice(0, 16000) };
    }).slice(0, 150);
    const diagnostics = item.diagnostics.map((record) => {
      if (!record || record.version !== 1 || typeof record.id !== "string" || !Array.isArray(record.questions) || !Array.isArray(record.answers)
        || !record.assessment || !Array.isArray(record.assessment.results) || !Array.isArray(record.reinforced)) throw new Error("诊断记录格式不正确");
      const reinforcements: Record<string, ReinforcementAttempt[]> = {};
      if (record.reinforcements && typeof record.reinforcements === "object") {
        for (const [questionIndex, attempts] of Object.entries(record.reinforcements)) {
          if (!/^(0|[1-9]\d*)$/.test(questionIndex) || Number(questionIndex) >= record.questions.length || !Array.isArray(attempts)) continue;
          reinforcements[questionIndex] = attempts.filter((attempt) => attempt && typeof attempt.id === "string"
            && attempt.lesson && typeof attempt.lesson.explanation === "string" && typeof attempt.lesson.example === "string"
            && typeof attempt.lesson.checkQuestion === "string" && typeof attempt.lesson.checkAnswer === "string"
            && typeof attempt.answer === "string" && typeof attempt.feedback === "string" && typeof attempt.passed === "boolean"
            && Array.isArray(attempt.clarifications)).map((attempt) => ({
              id: attempt.id.slice(0, 100),
              lesson: { explanation: attempt.lesson.explanation.slice(0, 10000), example: attempt.lesson.example.slice(0, 6000),
                checkQuestion: attempt.lesson.checkQuestion.slice(0, 4000), checkAnswer: attempt.lesson.checkAnswer.slice(0, 4000) },
              answer: attempt.answer.slice(0, 3000), feedback: attempt.feedback.slice(0, 4000), passed: attempt.passed,
              clarifications: attempt.clarifications.filter((item) => item && typeof item.target === "string" && typeof item.explanation === "string")
                .map((item) => ({ target: item.target.slice(0, 500), explanation: item.explanation.slice(0, 6000) })),
            }));
        }
      }
      const questions = record.questions.map((question) => {
        if (!question || typeof question !== "object") return question;
        const source = question.source && (question.source.kind === "original" || question.source.kind === "adapted")
          ? { kind: question.source.kind,
            syllabusId: typeof question.source.syllabusId === "string" ? question.source.syllabusId.slice(0, 100) : undefined,
            syllabusTitle: typeof question.source.syllabusTitle === "string" ? question.source.syllabusTitle.slice(0, 180) : undefined,
            pastExamId: typeof question.source.pastExamId === "string" ? question.source.pastExamId.slice(0, 100) : undefined,
            pastExamTitle: typeof question.source.pastExamTitle === "string" ? question.source.pastExamTitle.slice(0, 180) : undefined } : undefined;
        return { ...question, purpose: question.purpose === "review" ? "review" as const : "diagnostic" as const, source };
      });
      return { ...record, questions, reinforcements };
    }).slice(-30);
    const reviews: ReviewSchedule[] = Array.isArray(item.reviews) ? item.reviews.filter((review) => review && typeof review.topic === "string"
      && (review.basis === "preliminary" || review.basis === "verified")
      && (review.difficulty === "foundation" || review.difficulty === "advanced" || review.difficulty === "integrated")
      && (review.status === "scheduled" || review.status === "needs_reinforcement")
      && typeof review.dueAt === "string" && (review.dueAt === "" || Number.isFinite(Date.parse(review.dueAt)))
      && Number.isInteger(review.intervalIndex) && review.intervalIndex >= 0 && review.intervalIndex <= 4
      && typeof review.updatedAt === "string").slice(0, 80).map((review) => ({
        topic: review.topic.slice(0, 80), basis: review.basis, difficulty: review.difficulty,
        dueAt: review.dueAt, intervalIndex: review.intervalIndex, status: review.status,
        updatedAt: review.updatedAt,
      })) : [];
    const suppliedPreliminary = item.preliminary;
    const preliminary = suppliedPreliminary && suppliedPreliminary.version === 1 && typeof suppliedPreliminary.summary === "string"
      && typeof suppliedPreliminary.note === "string" && Array.isArray(suppliedPreliminary.topics)
      && suppliedPreliminary.mastery && typeof suppliedPreliminary.mastery === "object"
      && suppliedPreliminary.evidence && typeof suppliedPreliminary.evidence === "object"
      && typeof suppliedPreliminary.createdAt === "string"
      ? { ...suppliedPreliminary,
        topics: suppliedPreliminary.topics.filter((topic): topic is string => typeof topic === "string").slice(0, 40),
        reviewedTopics: Array.isArray(suppliedPreliminary.reviewedTopics)
          ? suppliedPreliminary.reviewedTopics.filter((topic): topic is string => typeof topic === "string").slice(0, 40) : undefined,
        matches: suppliedPreliminary.matches && typeof suppliedPreliminary.matches === "object"
          ? Object.fromEntries(Object.entries(suppliedPreliminary.matches).filter(([candidate, syllabus]) => suppliedPreliminary.topics.includes(candidate) && typeof syllabus === "string" && syllabus.length <= 80))
          : undefined }
      : undefined;
    const space = { ...item, materials, diagnostics, reviews,
      catalogedRepositories: Array.isArray(item.catalogedRepositories)
        ? item.catalogedRepositories.filter((name): name is string => typeof name === "string" && /^[A-Za-z0-9_.-]{1,100}\/[-A-Za-z0-9_.]{1,100}$/.test(name)).slice(0, 100) : [],
      preliminary: preliminary || legacyPreliminary({ ...item.profile,
      topics: item.profile.topics.filter((topic) => !groundedTopics({ ...item, materials }).includes(topic)) }) };
    const progress = reconciledProgress(space, materials);
    return { ...space, profile: { ...item.profile, ...progress, sourceLinks: safeWebSources(item.profile.sourceLinks) } };
  });
  if (new Set(spaces.map((item) => item.id)).size !== spaces.length) throw new Error("学习空间 ID 重复");
  const materialIds = spaces.flatMap((item) => item.materials.map((material) => material.id));
  if (new Set(materialIds).size !== materialIds.length) throw new Error("资料 ID 重复，逐页正文无法可靠对应");
  return { version: 2, activeSpaceId: spaces.some((item) => item.id === archive.activeSpaceId) ? archive.activeSpaceId! : spaces[0].id, spaces };
}

export function loadArchive(storage: Storage): LearningArchive {
  const current = storage.getItem(ARCHIVE_KEY);
  if (current) return parseArchive(JSON.parse(current) as unknown);
  const legacy = storage.getItem(LEGACY_KEY);
  return legacy ? parseArchive(JSON.parse(legacy) as unknown) : newArchive();
}

export function saveArchive(storage: Storage, archive: LearningArchive): void {
  storage.setItem(ARCHIVE_KEY, JSON.stringify(archive));
}
