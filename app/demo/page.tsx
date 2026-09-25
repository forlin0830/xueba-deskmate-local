"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { ChangeEvent } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Check, ChevronRight, CircleHelp, Download, FilePlus2, FileText, GraduationCap, RotateCcw, Sparkles, Target, Upload, ChartNoAxesCombined } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Attachment, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "@/components/ui/attachment";
import { DIAGNOSIS_QUESTION_SETS, INITIAL_ARCHIVE, PRACTICE_QUESTIONS, TOPICS } from "../demo-data";
import type { DemoQuestion, LearningArchive, Mastery } from "../demo-data";
import { MathText } from "../math-text";

const STORAGE_KEY = "xueba-deskmate-demo-v1";

function isArchive(value: unknown): value is LearningArchive {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<LearningArchive>;
  const statuses: Mastery[] = ["已掌握", "待加强", "未检验", "待复测"];
  return item.version === 1 && item.demo === true
    && typeof item.goal === "string" && item.goal.length <= 200
    && typeof item.subject === "string" && item.subject.length <= 200
    && typeof item.year === "string" && item.year.length <= 30
    && Array.isArray(item.attachments) && item.attachments.length <= 100
    && item.attachments.every(file => file && typeof file.name === "string" && file.name.length <= 255 && Number.isSafeInteger(file.size) && file.size >= 0)
    && Array.isArray(item.rounds) && item.rounds.length <= 1000
    && item.rounds.every(round => round && Number.isSafeInteger(round.number) && round.number > 0 && typeof round.date === "string" && round.date.length <= 40 && Number.isSafeInteger(round.correct) && Number.isSafeInteger(round.total) && round.correct >= 0 && round.total >= round.correct && Array.isArray(round.covered) && round.covered.every(id => TOPICS.some(topic => topic.id === id)))
    && typeof item.mastery === "object" && item.mastery !== null
    && TOPICS.every(topic => statuses.includes(item.mastery![topic.id]))
    && typeof item.practiceAttempts === "number" && Number.isSafeInteger(item.practiceAttempts) && item.practiceAttempts >= 0
    && typeof item.guidedDone === "boolean";
}

function statusClass(status: Mastery) {
  if (status === "已掌握") return "mastered";
  if (status === "待加强") return "weak";
  if (status === "待复测") return "retest";
  return "untested";
}

function QuestionChoices({ question, value, onChange, disabled }: { question: DemoQuestion; value: number | null; onChange: (value: number) => void; disabled: boolean }) {
  return <RadioGroup value={value === null ? "" : String(value)} onValueChange={v => onChange(Number(v))} className="choice-list" aria-label="选择答案">
    {question.options.map((option, index) => <label key={index} className={`choice ${value === index ? "selected" : ""} ${disabled && index === question.correct ? "correct-choice" : ""}`}>
      <RadioGroupItem value={String(index)} disabled={disabled} /><span className="choice-letter">{String.fromCharCode(65 + index)}</span><MathText>{option}</MathText>
    </label>)}
  </RadioGroup>;
}

export default function Home() {
  const [archive, setArchive] = useState<LearningArchive>(INITIAL_ARCHIVE);
  const [hydrated, setHydrated] = useState(false);
  const [tab, setTab] = useState("overview");
  const [goal, setGoal] = useState(INITIAL_ARCHIVE.goal);
  const [subject, setSubject] = useState(INITIAL_ARCHIVE.subject);
  const [year, setYear] = useState(INITIAL_ARCHIVE.year);
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const archiveInput = useRef<HTMLInputElement>(null);

  const [diagRunning, setDiagRunning] = useState(false);
  const [diagFinished, setDiagFinished] = useState(false);
  const [diagIndex, setDiagIndex] = useState(0);
  const [diagChoice, setDiagChoice] = useState<number | null>(null);
  const [diagSubmitted, setDiagSubmitted] = useState(false);
  const [diagAnswers, setDiagAnswers] = useState<number[]>([]);

  const [practiceRunning, setPracticeRunning] = useState(false);
  const [practiceFinished, setPracticeFinished] = useState(false);
  const [practiceIndex, setPracticeIndex] = useState(0);
  const [practiceChoice, setPracticeChoice] = useState<number | null>(null);
  const [practiceSubmitted, setPracticeSubmitted] = useState(false);
  const [practiceAnswers, setPracticeAnswers] = useState<number[]>([]);
  const [practiceScore, setPracticeScore] = useState(0);

  const [guideChoice, setGuideChoice] = useState<number | null>(null);
  const [guideSubmitted, setGuideSubmitted] = useState(false);

  useEffect(() => {
    let active = true;
    let restored: LearningArchive | null = null;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed: unknown = JSON.parse(stored);
        if (isArchive(parsed)) restored = parsed;
      }
    } catch { /* Ignore unreadable local demo data. */ }
    queueMicrotask(() => {
      if (!active) return;
      if (restored) {
        setArchive(restored);
        setGoal(restored.goal);
        setSubject(restored.subject);
        setYear(restored.year);
      }
      setHydrated(true);
    });
    return () => { active = false; };
  }, []);
  useEffect(() => { if (hydrated) localStorage.setItem(STORAGE_KEY, JSON.stringify(archive)); }, [archive, hydrated]);

  const mastered = TOPICS.filter(t => archive.mastery[t.id] === "已掌握").length;
  const needsWork = TOPICS.filter(t => archive.mastery[t.id] === "待加强" || archive.mastery[t.id] === "待复测").length;
  const untested = TOPICS.filter(t => archive.mastery[t.id] === "未检验").length;
  const covered = TOPICS.length - untested;
  const latestRound = archive.rounds.at(-1);
  const focusTopic = TOPICS.find(t => archive.mastery[t.id] === "待复测") ?? TOPICS.find(t => archive.mastery[t.id] === "待加强");
  const diagnosisQuestions = DIAGNOSIS_QUESTION_SETS[Math.max(0, archive.rounds.length - 1) % DIAGNOSIS_QUESTION_SETS.length];

  function startDiagnosis() {
    setDiagRunning(true); setDiagFinished(false); setDiagIndex(0); setDiagChoice(null); setDiagSubmitted(false); setDiagAnswers([]); setTab("diagnosis");
  }
  function submitDiagnosis() {
    if (diagChoice === null) return;
    setDiagAnswers([...diagAnswers, diagChoice]); setDiagSubmitted(true);
  }
  function finishDiagnosis(answers: number[]) {
    const correct = answers.filter((answer, index) => answer === diagnosisQuestions[index].correct).length;
    const nextNumber = archive.rounds.length + 1;
    setArchive(previous => {
      const mastery = { ...previous.mastery };
      diagnosisQuestions.forEach((question, index) => { mastery[question.topicId] = answers[index] === question.correct ? "已掌握" : "待加强"; });
      return { ...previous, mastery, rounds: [...previous.rounds, { number: nextNumber, date: new Date().toLocaleDateString("zh-CN"), correct, total: diagnosisQuestions.length, covered: diagnosisQuestions.map(q => q.topicId) }] };
    });
    setDiagRunning(false); setDiagFinished(true);
  }
  function nextDiagnosis() {
    if (diagIndex + 1 < diagnosisQuestions.length) { setDiagIndex(diagIndex + 1); setDiagChoice(null); setDiagSubmitted(false); }
    else finishDiagnosis(diagAnswers);
  }

  function startPractice() {
    setPracticeRunning(true); setPracticeFinished(false); setPracticeIndex(0); setPracticeChoice(null); setPracticeSubmitted(false); setPracticeAnswers([]); setTab("practice");
  }
  function submitPractice() {
    if (practiceChoice === null) return;
    setPracticeAnswers([...practiceAnswers, practiceChoice]); setPracticeSubmitted(true);
  }
  function nextPractice() {
    if (practiceIndex + 1 < PRACTICE_QUESTIONS.length) { setPracticeIndex(practiceIndex + 1); setPracticeChoice(null); setPracticeSubmitted(false); return; }
    const correct = practiceAnswers.filter((answer, index) => answer === PRACTICE_QUESTIONS[index].correct).length;
    setPracticeScore(correct);
    setArchive(previous => ({ ...previous, practiceAttempts: previous.practiceAttempts + 1, mastery: { ...previous.mastery, functions: correct === PRACTICE_QUESTIONS.length ? "待复测" : "待加强" } }));
    setPracticeRunning(false); setPracticeFinished(true);
  }

  function saveGoal() {
    if (!goal.trim() || !subject.trim()) { setNotice("请填写学习目标和科目。"); return; }
    setArchive(previous => ({ ...previous, goal: goal.trim(), subject: subject.trim(), year: year.trim() }));
    setNotice("学习目标已保存。当前题目和知识点仍是高考数学演示内容。");
  }
  function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;
    setArchive(previous => ({ ...previous, attachments: [...previous.attachments, ...files.map(file => ({ name: file.name, size: file.size }))] }));
    setNotice("已记录文件名称；此原型不会读取或上传文件内容。");
    event.target.value = "";
  }
  function exportArchive() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(archive, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "你的学霸同桌-学习档案.json";
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setNotice("已触发学习档案下载，请查看浏览器下载记录。");
  }
  async function importArchive(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      if (file.size > 1_000_000) throw new Error("文件过大");
      const parsed: unknown = JSON.parse(await file.text());
      if (!isArchive(parsed)) throw new Error("档案格式不符");
      setArchive(parsed); setGoal(parsed.goal); setSubject(parsed.subject); setYear(parsed.year);
      setNotice("学习档案已导入。你可以查看知识点地图和诊断记录。"); setTab("overview");
    } catch { setNotice("无法导入：请选择由此网站导出的有效学习档案。"); }
    event.target.value = "";
  }

  const diagnosisQuestion = diagnosisQuestions[diagIndex];
  const practiceQuestion = PRACTICE_QUESTIONS[practiceIndex];

  return <main className="app-shell">
    <header className="site-header"><div className="brand"><div className="brand-mark"><GraduationCap size={22}/></div><div><strong>你的学霸同桌</strong><span>学习诊断工作台</span></div></div><div className="demo-header-actions"><Link className="demo-link" href="/"><ArrowLeft size={14}/>返回 AI 教学主页</Link><span className="demo-pill"><i/>界面演示</span></div></header>
    <div className="workspace">
      <div className="workspace-top"><div><span className="eyebrow">当前学习目标</span><h1>{archive.year ? `${archive.year} ` : ""}{archive.goal}{archive.subject} <em>·</em> 演示题库</h1><p>从诊断到专题强化，用每一轮的结果看见进步。</p></div><Button variant="outline" onClick={()=>setTab("materials")}>调整目标 <ArrowRight size={15}/></Button></div>
      <Tabs value={tab} onValueChange={setTab} className="learning-tabs"><TabsList className="nav-tabs" variant="line">
        <TabsTrigger value="overview"><ChartNoAxesCombined/>学习概览</TabsTrigger>
        <TabsTrigger value="diagnosis"><CircleHelp/>考纲诊断</TabsTrigger>
        <TabsTrigger value="practice"><Sparkles/>专题突破</TabsTrigger>
        <TabsTrigger value="guided"><BookOpen/>引导学习</TabsTrigger>
        <TabsTrigger value="materials"><FileText/>资料与档案</TabsTrigger>
      </TabsList>

      <TabsContent value="overview" className="tab-panel"><div className="dashboard-grid">
        <section className="banner"><div><span className="banner-kicker"><RotateCcw size={14}/> 已完成 {archive.rounds.length} 轮演示诊断</span><h2>知识点掌握，一眼看清</h2><p>反复诊断，找到薄弱点；专题强化后用新题复测。</p><Button onClick={startDiagnosis}>开始新一轮诊断 <ArrowRight size={16}/></Button></div><div className="progress-ring" aria-label={`已检验 ${covered} 个知识点，共 ${TOPICS.length} 个`}><div><strong>{covered}<small>/{TOPICS.length}</small></strong><span>知识点已检验</span></div></div></section>
        <section className="stat-card"><span>已掌握</span><strong>{mastered} <small>个知识点</small></strong><i className="bar blue" style={{"--bar-width":`${mastered/TOPICS.length*100}%`} as React.CSSProperties}/><p>经演示诊断判定</p></section>
        <section className="stat-card"><span>需要强化或复测</span><strong>{needsWork} <small>个知识点</small></strong><i className="bar amber" style={{"--bar-width":`${needsWork/TOPICS.length*100}%`} as React.CSSProperties}/><p>专题练习后再做新题</p></section>
        <section className="stat-card"><span>尚未检验</span><strong>{untested} <small>个知识点</small></strong><i className="bar gray" style={{"--bar-width":`${untested/TOPICS.length*100}%`} as React.CSSProperties}/><p>不会推定为已掌握</p></section>
        <section className="topic-panel"><div className="panel-head"><div><span className="eyebrow">考纲覆盖示意</span><h2>知识点地图</h2></div><span>演示数据 · 非正式考纲</span></div><div className="topic-grid">{TOPICS.map(topic => <div className={`topic-tile ${statusClass(archive.mastery[topic.id] ?? "未检验")}`} key={topic.id}><BookOpen size={17}/><strong>{topic.name}</strong><span>{archive.mastery[topic.id] ?? "未检验"}</span></div>)}</div></section>
        <aside className="next-panel"><span className="eyebrow">下一步建议</span><div className="next-icon"><Target size={20}/></div><h2>{focusTopic ? `从「${focusTopic.name}」开始` : "继续检验新知识点"}</h2><p>{focusTopic?.id === "functions" ? "演示专题提供两道新练习题。做对后会标记为待复测，再进入下一轮诊断。" : "学习档案会保留每轮结果，帮助你对比专题强化前后的变化。"}</p><Button variant="outline" onClick={focusTopic?.id === "functions" ? startPractice : startDiagnosis}>{focusTopic?.id === "functions" ? "开始专题练习" : "开始诊断"} <ArrowRight size={15}/></Button></aside>
        <section className="history-panel"><div className="panel-head"><div><span className="eyebrow">多轮对比</span><h2>诊断记录</h2></div><span>得分仅代表演示题目</span></div><div className="round-list">{archive.rounds.map(round => <div className="round-row" key={round.number}><span>第 {round.number} 轮</span><div className="round-track"><i style={{width:`${round.correct/round.total*100}%`}}/></div><strong>{round.correct}/{round.total}</strong><small>{round.date}</small></div>)}</div></section>
      </div><p className="demo-disclaimer">此网站是界面原型，知识点、题目和掌握情况均为演示；目前不提供真实考纲分析或 AI 教学判断。</p></TabsContent>

      <TabsContent value="diagnosis" className="tab-panel"><div className="flow-grid"><section className="flow-main"><div className="panel-head"><div><span className="eyebrow">模式一 · 考纲诊断与专题突破</span><h2>分轮诊断</h2></div><span>高考数学示例题库</span></div>
        {!diagRunning && !diagFinished && <div className="flow-intro"><div className="flow-icon"><CircleHelp size={25}/></div><h3>开始第 {archive.rounds.length + 1} 轮演示诊断</h3><p>本轮有 4 道示例选择题，覆盖 4 个知识点。正式版本将依据真实考纲进行更全面的问答与解题诊断。</p><Button onClick={startDiagnosis}>开始答题 <ArrowRight size={16}/></Button></div>}
        {diagRunning && <div className="question-area"><div className="question-top"><span>第 {diagIndex + 1} / {diagnosisQuestions.length} 题</span><span>{TOPICS.find(t=>t.id===diagnosisQuestion.topicId)?.name}</span></div><Progress value={(diagIndex + (diagSubmitted ? 1 : 0))/diagnosisQuestions.length*100} className="question-progress"/><MathText as="h3">{diagnosisQuestion.prompt}</MathText><QuestionChoices question={diagnosisQuestion} value={diagChoice} onChange={setDiagChoice} disabled={diagSubmitted}/>{diagSubmitted && <div className={`feedback ${diagChoice === diagnosisQuestion.correct ? "good" : "needs-work"}`} role="status"><strong>{diagChoice === diagnosisQuestion.correct ? "回答正确" : "这题还需要练习"}</strong><MathText as="p">{diagnosisQuestion.explanation}</MathText></div>}<div className="question-actions">{!diagSubmitted ? <Button onClick={submitDiagnosis} disabled={diagChoice===null}>提交答案</Button> : <Button onClick={nextDiagnosis}>{diagIndex + 1 === diagnosisQuestions.length ? "查看本轮结果" : "下一题"} <ChevronRight size={16}/></Button>}</div></div>}
        {diagFinished && <div className="flow-intro"><div className="flow-icon done"><Check size={26}/></div><h3>第 {latestRound?.number} 轮诊断已完成</h3><p>本轮答对 {latestRound?.correct}/{latestRound?.total} 题。知识点地图已更新；你可以进行专题强化，之后再次诊断。</p><div className="action-row"><Button onClick={()=>setTab("overview")}>查看掌握情况</Button><Button variant="outline" onClick={startDiagnosis}>再次诊断</Button></div></div>}
      </section><aside className="flow-side"><span className="eyebrow">诊断方式</span><h3>先覆盖，再深入</h3><p>真实产品会依据考纲建立知识点清单，并根据作答继续追问。未检验内容始终单独标示。</p><div className="side-note">当前仅有 4 道演示题，不构成全面能力评估。</div></aside></div></TabsContent>

      <TabsContent value="practice" className="tab-panel"><div className="flow-grid"><section className="flow-main"><div className="panel-head"><div><span className="eyebrow">模式一 · 专题强化</span><h2>函数与导数</h2></div><span>演示专题</span></div>
        {!practiceRunning && !practiceFinished && <div className="flow-intro"><div className="flow-icon"><Sparkles size={25}/></div><h3>从错误原因开始</h3><p>求导时先识别每一项，再分别使用规则。例：x² 的导数是 2x，因此在 x = 2 处的导数是 4。</p><div className="learning-note"><strong>练习目标</strong><span>连续完成两道新题后标记为「待复测」，再用下一轮诊断检验迁移能力。</span></div><Button onClick={startPractice}>开始专题练习 <ArrowRight size={16}/></Button></div>}
        {practiceRunning && <div className="question-area"><div className="question-top"><span>强化练习 {practiceIndex + 1} / {PRACTICE_QUESTIONS.length}</span><span>函数与导数</span></div><Progress value={(practiceIndex+(practiceSubmitted?1:0))/PRACTICE_QUESTIONS.length*100} className="question-progress"/><MathText as="h3">{practiceQuestion.prompt}</MathText><QuestionChoices question={practiceQuestion} value={practiceChoice} onChange={setPracticeChoice} disabled={practiceSubmitted}/>{practiceSubmitted && <div className={`feedback ${practiceChoice === practiceQuestion.correct ? "good" : "needs-work"}`} role="status"><strong>{practiceChoice === practiceQuestion.correct ? "回答正确" : "再看一下这一步"}</strong><MathText as="p">{practiceQuestion.explanation}</MathText></div>}<div className="question-actions">{!practiceSubmitted ? <Button onClick={submitPractice} disabled={practiceChoice===null}>提交答案</Button> : <Button onClick={nextPractice}>{practiceIndex+1===PRACTICE_QUESTIONS.length?"完成专题":"下一题"} <ChevronRight size={16}/></Button>}</div></div>}
        {practiceFinished && <div className="flow-intro"><div className="flow-icon done"><Check size={26}/></div><h3>本次专题练习完成</h3><p>答对 {practiceScore}/{PRACTICE_QUESTIONS.length} 题。{practiceScore===PRACTICE_QUESTIONS.length?"知识点已标记为待复测，请用新一轮诊断验证。":"还可以再练一轮，继续巩固求导规则。"}</p><div className="action-row"><Button onClick={startDiagnosis}>再次诊断 <RotateCcw size={16}/></Button><Button variant="outline" onClick={startPractice}>重新练习</Button></div></div>}
      </section><aside className="flow-side"><span className="eyebrow">突破循环</span><h3>强化之后，重新诊断</h3><p>同一套题做对不等于彻底掌握。原型会把专题练习结果标记为「待复测」，等待新一轮诊断。</p><div className="side-note">已完成 {archive.practiceAttempts} 次演示专题练习。</div></aside></div></TabsContent>

      <TabsContent value="guided" className="tab-panel"><div className="flow-grid"><section className="flow-main"><div className="panel-head"><div><span className="eyebrow">模式二 · 引导学习</span><h2>一小步，一次弄懂</h2></div><span>示例课程</span></div><div className="guided-lesson"><div className="lesson-label">示例概念 · 导数</div><h3>导数在描述什么？</h3><p>可以把导数理解为某一点附近的变化快慢。例如路程随时间变化，某一刻的瞬时速度就是这一刻的变化率。</p><div className="lesson-example"><strong>试试看</strong><span>若 f(x) = x²，那么在 x = 3 时，导数是多少？</span></div><RadioGroup value={guideChoice===null?"":String(guideChoice)} onValueChange={v=>setGuideChoice(Number(v))} className="choice-list" aria-label="引导学习练习"><label className={`choice ${guideChoice===0?"selected":""}`}><RadioGroupItem value="0" disabled={guideSubmitted}/><span className="choice-letter">A</span><span>3</span></label><label className={`choice ${guideChoice===1?"selected":""} ${guideSubmitted?"correct-choice":""}`}><RadioGroupItem value="1" disabled={guideSubmitted}/><span className="choice-letter">B</span><span>6</span></label><label className={`choice ${guideChoice===2?"selected":""}`}><RadioGroupItem value="2" disabled={guideSubmitted}/><span className="choice-letter">C</span><span>9</span></label></RadioGroup>{guideSubmitted && <div className={`feedback ${guideChoice===1?"good":"needs-work"}`} role="status"><strong>{guideChoice===1?"答对了":"再试着想想求导规则"}</strong><p>f′(x) = 2x，因此 f′(3) = 6。</p></div>}<div className="question-actions">{!guideSubmitted?<Button disabled={guideChoice===null} onClick={()=>{setGuideSubmitted(true);setArchive(prev=>({...prev,guidedDone:true}));}}>检查答案</Button>:<Button variant="outline" onClick={()=>{setGuideChoice(null);setGuideSubmitted(false);}}>再练一次</Button>}</div></div></section><aside className="flow-side"><span className="eyebrow">引导学习</span><h3>讲解、练习、反馈</h3><p>这一模式适合探索新内容。实际 AI 版本会根据学科和学习者水平生成讲解与练习。</p><div className="side-note">{archive.guidedDone?"你已体验过这节演示课。":"完成一道示例题，体验教学反馈。"}</div></aside></div></TabsContent>

      <TabsContent value="materials" className="tab-panel"><div className="materials-grid"><section className="material-panel"><div className="panel-head"><div><span className="eyebrow">起点设置</span><h2>学习目标与资料</h2></div><span>仅用于界面演示</span></div><div className="form-grid"><div><Label htmlFor="goal">考试或学习目标</Label><Input id="goal" value={goal} onChange={e=>setGoal(e.target.value)} placeholder="例如：高考、考研、学习编程"/></div><div><Label htmlFor="subject">科目</Label><Input id="subject" value={subject} onChange={e=>setSubject(e.target.value)} placeholder="例如：数学"/></div><div><Label htmlFor="year">目标年份（可选）</Label><Input id="year" value={year} onChange={e=>setYear(e.target.value)} placeholder="例如：2027"/></div></div><Button onClick={saveGoal}>保存目标</Button><div className="upload-box"><div className="upload-icon"><FilePlus2 size={22}/></div><div><strong>添加教材、考纲或试卷</strong><p>此阶段仅记录文件名称，不读取或上传内容。</p></div><Button variant="outline" onClick={()=>fileInput.current?.click()}>选择文件 <Upload size={15}/></Button><input ref={fileInput} type="file" multiple accept=".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg" onChange={addFiles} className="sr-only" aria-label="选择教材、考纲或试卷"/></div>{archive.attachments.length>0 && <AttachmentGroup className="file-list">{archive.attachments.map((file,index)=><Attachment key={`${file.name}-${index}`}><AttachmentMedia><FileText size={17}/></AttachmentMedia><AttachmentContent><AttachmentTitle>{file.name}</AttachmentTitle><AttachmentDescription>{Math.max(1,Math.round(file.size/1024))} KB · 仅名称</AttachmentDescription></AttachmentContent></Attachment>)}</AttachmentGroup>}</section><aside className="material-panel archive-panel"><span className="eyebrow">学习档案</span><h2>下次从这里继续</h2><p>导出当前目标、演示诊断轮次和知识点状态。下次打开时可以导入同一份档案。</p><div className="archive-actions"><Button onClick={exportArchive}><Download size={16}/>导出档案</Button><Button variant="outline" onClick={()=>archiveInput.current?.click()}><Upload size={16}/>导入档案</Button><input ref={archiveInput} type="file" accept=".json,application/json" onChange={importArchive} className="sr-only" aria-label="导入学习档案"/></div><div className="archive-summary"><div><span>诊断轮次</span><strong>{archive.rounds.length}</strong></div><div><span>已检验知识点</span><strong>{covered}</strong></div><div><span>专题练习</span><strong>{archive.practiceAttempts}</strong></div></div><p className="privacy-note">演示状态保存在此浏览器；导出的档案由你自行保存。文件内容不会被读取。</p></aside></div>{notice && <p className="inline-notice" role="status">{notice}</p>}</TabsContent>
      </Tabs>
    </div>
  </main>;
}
