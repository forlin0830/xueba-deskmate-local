import assert from "node:assert/strict";
import test from "node:test";
import { groundedTopics, initialProfile, newSpace, parseArchive, reconciledProgress } from "../lib/learning-store.ts";

const syllabus = (topics) => ({
  version: 1, id: "outline", title: "考试大纲", category: "syllabus", reliability: "official",
  status: "read", origin: "upload", note: "", summary: "", topics, excerpt: "", addedAt: "2026-09-24",
});

test("old knowledge points remain available as a preliminary map after migration", () => {
  const old = { ...initialProfile, topics: ["导数应用"], mastery: { 导数应用: "待复测" } };
  const archive = parseArchive(old);
  assert.deepEqual(archive.spaces[0].preliminary.topics, ["导数应用"]);
  assert.deepEqual(groundedTopics(archive.spaces[0]), []);
  assert.equal(archive.spaces[0].preliminary.mastery["导数应用"], "待复测");
});

test("only aligned preliminary progress enters the syllabus map", () => {
  const space = newSpace(initialProfile);
  space.preliminary = { version: 1, summary: "", note: "", createdAt: "2026-09-24",
    topics: ["导数应用", "复数运算"], mastery: { 导数应用: "已掌握", 复数运算: "待加强" }, evidence: {},
    reviewedTopics: ["导数的应用", "立体几何"], matches: { 导数应用: "导数的应用" } };
  const progress = reconciledProgress(space, [syllabus(["导数的应用", "立体几何"])]);
  assert.deepEqual(progress.topics, ["导数的应用", "立体几何"]);
  assert.equal(progress.mastery["导数的应用"], "待复测");
  assert.equal(progress.mastery["立体几何"], "未检验");
  assert.equal(progress.mastery["复数运算"], undefined);
});

test("community syllabus enters the formal map only after the learner verifies it", () => {
  const space = newSpace(initialProfile);
  const imported = { ...syllabus(["函数与极限"]), id: "shared-outline", origin: "library", reliability: "reference" };
  space.materials = [imported];
  assert.deepEqual(groundedTopics(space), []);
  assert.deepEqual(reconciledProgress(space, space.materials).topics, []);
  space.materials = [{ ...imported, status: "verified" }];
  assert.deepEqual(groundedTopics(space), ["函数与极限"]);
});

test("archive import preserves preliminary map and diagnosis basis", () => {
  const space = newSpace(initialProfile);
  space.preliminary = { version: 1, summary: "初步地图", note: "待核对", createdAt: "2026-09-24",
    topics: ["导数应用"], mastery: { 导数应用: "待加强" }, evidence: {},
    reviewedTopics: ["导数的应用"], matches: { 导数应用: "导数的应用" } };
  space.diagnostics = [{ version: 1, id: "round-1", date: "2026-09-24", questions: [], answers: [],
    assessment: { summary: "", focusTopic: "", results: [] }, reinforced: [], basis: "preliminary" }];
  const archive = parseArchive({ version: 2, activeSpaceId: space.id, spaces: [space] });
  assert.equal(archive.spaces[0].preliminary.matches["导数应用"], "导数的应用");
  assert.equal(archive.spaces[0].diagnostics[0].basis, "preliminary");
});

test("archive import keeps every reinforcement for one wrong question", () => {
  const space = newSpace(initialProfile);
  const question = { topic: "函数", difficulty: "foundation", prompt: "原题", type: "fill_blank", options: [], correctAnswer: "2", explanation: "" };
  const makeAttempt = (number, passed) => ({ id: `attempt-${number}`, lesson: { explanation: `讲解 ${number}`, example: "例子", checkQuestion: `练习 ${number}`, checkAnswer: "2" },
    answer: passed ? "2" : "不会", feedback: passed ? "正确" : "还需练习", passed,
    clarifications: [{ target: "为什么？", explanation: `补充讲解 ${number}` }] });
  space.diagnostics = [{ version: 1, id: "round-1", date: "2026-09-24", questions: [question], answers: ["不会"],
    assessment: { summary: "", focusTopic: "函数", results: [{ topic: "函数", verdict: "weak", feedback: "", correctAnswer: "2" }] },
    reinforced: [0], reinforcements: { 0: [makeAttempt(1, false), makeAttempt(2, true)] } }];
  const imported = parseArchive(JSON.parse(JSON.stringify({ version: 2, activeSpaceId: space.id, spaces: [space] })));
  assert.deepEqual(imported.spaces[0].diagnostics[0].reinforcements[0].map((item) => item.lesson.checkQuestion), ["练习 1", "练习 2"]);
  assert.equal(imported.spaces[0].diagnostics[0].reinforcements[0][0].clarifications[0].explanation, "补充讲解 1");
  assert.equal(imported.spaces[0].diagnostics[0].reinforcements[0][1].passed, true);
});
