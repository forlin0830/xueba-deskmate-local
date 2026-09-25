export type Mastery = "已掌握" | "待加强" | "未检验" | "待复测";

export type Topic = { id: string; name: string; group: string };
export type DemoQuestion = { id: string; topicId: string; prompt: string; options: string[]; correct: number; explanation: string };
export type Round = { number: number; date: string; correct: number; total: number; covered: string[] };
export type LearningArchive = {
  version: 1;
  demo: true;
  goal: string;
  subject: string;
  year: string;
  attachments: { name: string; size: number }[];
  mastery: Record<string, Mastery>;
  rounds: Round[];
  practiceAttempts: number;
  guidedDone: boolean;
};

export const TOPICS: Topic[] = [
  { id: "sets", name: "集合与逻辑", group: "基础与函数" },
  { id: "functions", name: "函数与导数", group: "基础与函数" },
  { id: "trigonometry", name: "三角函数", group: "基础与函数" },
  { id: "sequences", name: "数列", group: "代数与应用" },
  { id: "vectors", name: "平面向量", group: "几何" },
  { id: "solid", name: "立体几何", group: "几何" },
  { id: "analytic", name: "解析几何", group: "几何" },
  { id: "probability", name: "概率", group: "统计与概率" },
  { id: "statistics", name: "统计", group: "统计与概率" },
  { id: "inequalities", name: "不等式", group: "代数与应用" },
  { id: "complex", name: "复数", group: "代数与应用" },
  { id: "algorithms", name: "算法与应用", group: "代数与应用" },
];

export const DIAGNOSIS_QUESTION_SETS: DemoQuestion[][] = [
  [
    { id: "d1", topicId: "functions", prompt: "若 f(x) = x²，那么 f′(2) 等于多少？", options: ["2", "4", "6", "8"], correct: 1, explanation: "f′(x) = 2x，因此 f′(2) = 4。" },
    { id: "d2", topicId: "sequences", prompt: "等差数列首项为 3，公差为 2，第 5 项是多少？", options: ["9", "10", "11", "13"], correct: 2, explanation: "第 5 项 = 3 + (5 − 1) × 2 = 11。" },
    { id: "d3", topicId: "analytic", prompt: "经过 (1, 2) 与 (3, 6) 两点的直线斜率是多少？", options: ["1", "2", "3", "4"], correct: 1, explanation: "斜率 = (6 − 2) ÷ (3 − 1) = 2。" },
    { id: "d4", topicId: "probability", prompt: "掷一枚均匀硬币两次，恰好出现一次正面的概率是多少？", options: ["1/4", "1/3", "1/2", "3/4"], correct: 2, explanation: "四种等可能结果中，有正反、反正两种符合条件，所以概率是 2/4 = 1/2。" },
  ],
  [
    { id: "d5", topicId: "functions", prompt: "若 f(x) = x³，那么 f′(1) 等于多少？", options: ["1", "2", "3", "4"], correct: 2, explanation: "f′(x) = 3x²，因此 f′(1) = 3。" },
    { id: "d6", topicId: "sequences", prompt: "等比数列首项为 2，公比为 3，第 3 项是多少？", options: ["6", "12", "18", "27"], correct: 2, explanation: "第 3 项 = 2 × 3² = 18。" },
    { id: "d7", topicId: "analytic", prompt: "经过 (0, 1) 与 (2, 5) 两点的直线斜率是多少？", options: ["1", "2", "3", "4"], correct: 1, explanation: "斜率 = (5 − 1) ÷ (2 − 0) = 2。" },
    { id: "d8", topicId: "probability", prompt: "袋中有 2 个红球和 3 个蓝球，随机取出 1 个，取到红球的概率是多少？", options: ["1/5", "2/5", "1/2", "3/5"], correct: 1, explanation: "5 个球中有 2 个红球，所以概率是 2/5。" },
  ],
];

export const PRACTICE_QUESTIONS: DemoQuestion[] = [
  { id: "p1", topicId: "functions", prompt: "若 g(x) = 3x²，则 g′(x) 是什么？", options: ["3x", "6x", "6x²", "x³"], correct: 1, explanation: "幂函数求导：3x² 的导数是 3 × 2x = 6x。" },
  { id: "p2", topicId: "functions", prompt: "若 h(x) = x³ + 2x，则 h′(1) 等于多少？", options: ["3", "4", "5", "6"], correct: 2, explanation: "h′(x) = 3x² + 2，所以 h′(1) = 5。" },
];

export const INITIAL_ARCHIVE: LearningArchive = {
  version: 1,
  demo: true,
  goal: "高考",
  subject: "数学",
  year: "2027",
  attachments: [],
  mastery: {
    sets: "已掌握", functions: "待加强", trigonometry: "已掌握", sequences: "待加强",
    vectors: "未检验", solid: "未检验", analytic: "待加强", probability: "未检验",
    statistics: "未检验", inequalities: "待加强", complex: "已掌握", algorithms: "未检验",
  },
  rounds: [{ number: 1, date: "演示记录", correct: 3, total: 6, covered: ["sets", "functions", "trigonometry", "sequences", "analytic", "inequalities"] }],
  practiceAttempts: 0,
  guidedDone: false,
};
