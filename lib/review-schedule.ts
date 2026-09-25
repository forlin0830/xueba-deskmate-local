import type { Difficulty, ReviewSchedule, TopicEvidence } from "./learning-store";

type Basis = ReviewSchedule["basis"];
const intervals = [1, 3, 7, 14, 30];

function nextLocalDay(now: Date, days: number): string {
  const due = new Date(now);
  due.setHours(0, 0, 0, 0);
  due.setDate(due.getDate() + days);
  return due.toISOString();
}

function replaceReview(reviews: ReviewSchedule[], next: ReviewSchedule): ReviewSchedule[] {
  return [...reviews.filter((item) => item.topic !== next.topic || item.basis !== next.basis), next];
}

export function startReview(reviews: ReviewSchedule[], topic: string, basis: Basis, difficulty: Difficulty, now = new Date()): ReviewSchedule[] {
  const previous = reviews.find((item) => item.topic === topic && item.basis === basis);
  if (previous?.status === "scheduled") return reviews;
  return replaceReview(reviews, { topic, basis, difficulty, dueAt: nextLocalDay(now, intervals[0]), intervalIndex: 0,
    status: "scheduled", updatedAt: now.toISOString() });
}

export function passReview(reviews: ReviewSchedule[], topic: string, basis: Basis, difficulty: Difficulty, now = new Date()): ReviewSchedule[] {
  const previous = reviews.find((item) => item.topic === topic && item.basis === basis);
  const intervalIndex = Math.min((previous?.intervalIndex ?? 0) + 1, intervals.length - 1);
  return replaceReview(reviews, { topic, basis, difficulty, dueAt: nextLocalDay(now, intervals[intervalIndex]), intervalIndex,
    status: "scheduled", updatedAt: now.toISOString() });
}

export function failReview(reviews: ReviewSchedule[], topic: string, basis: Basis, difficulty: Difficulty, now = new Date()): ReviewSchedule[] {
  return replaceReview(reviews, { topic, basis, difficulty, dueAt: "", intervalIndex: 0,
    status: "needs_reinforcement", updatedAt: now.toISOString() });
}

export function restartReviewAfterReinforcement(reviews: ReviewSchedule[], topic: string, basis: Basis, difficulty: Difficulty, now = new Date()): ReviewSchedule[] {
  return replaceReview(reviews, { topic, basis, difficulty, dueAt: nextLocalDay(now, intervals[0]), intervalIndex: 0,
    status: "scheduled", updatedAt: now.toISOString() });
}

export function dueReviewTargets(reviews: ReviewSchedule[], topics: string[], basis: Basis,
  evidence: Record<string, TopicEvidence>, now = new Date()): ReviewSchedule[] {
  const hasUntested = topics.some((topic) => !evidence[topic]?.attempted.length);
  const limit = hasUntested ? 2 : 4;
  const difficultyCounts: Record<Difficulty, number> = { foundation: 0, advanced: 0, integrated: 0 };
  const selected: ReviewSchedule[] = [];
  for (const review of reviews.filter((item) => item.basis === basis && item.status === "scheduled"
    && topics.includes(item.topic) && Number.isFinite(Date.parse(item.dueAt)) && Date.parse(item.dueAt) <= now.getTime())
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt))) {
    if (selected.length >= limit) break;
    if (difficultyCounts[review.difficulty] >= 2) continue;
    difficultyCounts[review.difficulty] += 1;
    selected.push(review);
  }
  return selected;
}
