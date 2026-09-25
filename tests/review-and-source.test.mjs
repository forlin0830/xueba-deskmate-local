import assert from "node:assert/strict";
import test from "node:test";
import { initialProfile, newSpace, parseArchive } from "../lib/learning-store.ts";
import { dueReviewTargets, failReview, passReview, restartReviewAfterReinforcement, startReview } from "../lib/review-schedule.ts";
import { verifiedExamReference } from "../lib/question-reference.ts";

test("reviews enter later diagnoses only when due, and leave room for untested topics", () => {
  const now = new Date("2026-09-24T08:00:00+08:00");
  let reviews = [];
  for (const topic of ["函数", "极限", "导数"]) reviews = startReview(reviews, topic, "verified", "foundation", now);
  assert.equal(dueReviewTargets(reviews, ["函数", "极限", "导数", "积分"], "verified", {}, now).length, 0);
  const later = new Date("2026-09-25T08:00:00+08:00");
  assert.deepEqual(dueReviewTargets(reviews, ["函数", "极限", "导数", "积分"], "verified", {}, later).map((item) => item.topic), ["函数", "极限"]);
  reviews = passReview(reviews, "函数", "verified", "advanced", later);
  assert.equal(dueReviewTargets(reviews, ["函数", "极限", "导数"], "verified", {}, later).some((item) => item.topic === "函数"), false);
  assert.equal(reviews.find((item) => item.topic === "函数").intervalIndex, 1);
  reviews = failReview(reviews, "极限", "verified", "foundation", later);
  assert.equal(dueReviewTargets(reviews, ["极限"], "verified", {}, new Date("2026-10-01T08:00:00+08:00")).length, 0);
  reviews = restartReviewAfterReinforcement(reviews, "极限", "verified", "foundation", later);
  assert.equal(dueReviewTargets(reviews, ["极限"], "verified", {}, new Date("2026-09-26T08:00:00+08:00")).length, 1);
});

test("a past-paper label requires a quote found in the read file", () => {
  const references = [{ id: "paper-1", title: "2025 数学一真题", excerpt: "第 1 题：设函数 f(x) 在区间内连续，求下列极限。" }];
  assert.deepEqual(verifiedExamReference("paper-1", "设函数 f(x) 在区间内连续", references),
    { kind: "adapted", pastExamId: "paper-1", pastExamTitle: "2025 数学一真题" });
  assert.deepEqual(verifiedExamReference("paper-1", "这句话不在文件正文中", references), { kind: "original" });
  assert.deepEqual(verifiedExamReference("unknown", "设函数 f(x) 在区间内连续", references), { kind: "original" });
});

test("archive import preserves review schedule and question basis", () => {
  const space = newSpace(initialProfile);
  space.materials = [{ version: 1, id: "outline", title: "考纲", category: "syllabus", reliability: "reference", status: "read", origin: "upload",
    note: "", summary: "", topics: ["函数"], excerpt: "", addedAt: "2026-09-24" }];
  space.reviews = startReview([], "函数", "verified", "advanced", new Date("2026-09-24T08:00:00+08:00"));
  space.diagnostics = [{ version: 1, id: "round", date: "2026-09-24", answers: ["2"], reinforced: [],
    questions: [{ topic: "函数", difficulty: "advanced", prompt: "题目", type: "fill_blank", options: [], correctAnswer: "2", explanation: "",
      purpose: "review", source: { kind: "adapted", syllabusId: "outline", syllabusTitle: "考纲", pastExamId: "paper", pastExamTitle: "真题" } }],
    assessment: { summary: "", focusTopic: "函数", results: [{ topic: "函数", verdict: "mastered", feedback: "", correctAnswer: "2" }] } }];
  const archive = parseArchive(JSON.parse(JSON.stringify({ version: 2, activeSpaceId: space.id, spaces: [space] })));
  assert.equal(archive.spaces[0].reviews[0].topic, "函数");
  assert.equal(archive.spaces[0].diagnostics[0].questions[0].purpose, "review");
  assert.equal(archive.spaces[0].diagnostics[0].questions[0].source.syllabusTitle, "考纲");
});
