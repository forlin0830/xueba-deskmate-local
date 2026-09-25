"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ReinforcementAttempt } from "@/lib/learning-store";
import { MathText } from "./math-text";

export function ReinforcementCard({ attempt, attemptNumber, questionNumber, topic, busy, onCheck, onClarify }:
  { attempt: ReinforcementAttempt; attemptNumber: number; questionNumber: number; topic: string; busy: boolean;
    onCheck: (answer: string) => void; onClarify: (target: string) => void }) {
  const [answer, setAnswer] = useState(attempt.answer);
  const [target, setTarget] = useState("");
  const explanationRef = useRef<HTMLDivElement>(null);

  function captureSentence() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !explanationRef.current?.contains(selection.getRangeAt(0).commonAncestorContainer)) return;
    const selected = selection.toString().trim().slice(0, 500);
    if (selected) setTarget(selected);
  }

  return <div className="lesson-card">
    <span className="eyebrow">错题 {questionNumber} · 强化 {attemptNumber} · {topic}</span>
    <h3>先弄懂，再做一道新题</h3>
    <div ref={explanationRef} onMouseUp={captureSentence} onTouchEnd={captureSentence}><MathText as="p">{attempt.lesson.explanation}</MathText></div>
    <div className="lesson-example"><strong>示例</strong><MathText>{attempt.lesson.example}</MathText></div>
    <div className="lesson-clarify">
      <strong>有哪句没看懂？</strong>
      <p>选中上方的一句话会自动填入，也可以自己输入。留空则请同桌重讲整个知识点。</p>
      <Textarea value={target} onChange={(event) => setTarget(event.target.value)} placeholder="例如：为什么这里要先移项？" aria-label={`错题 ${questionNumber} 强化 ${attemptNumber} 需要讲清楚的内容`} rows={2}/>
      <Button variant="outline" disabled={busy} onClick={() => onClarify(target.trim())}>请讲得更简单</Button>
      {attempt.clarifications.map((item, index) => <div className="lesson-clarification" key={index}>
        <strong>{item.target ? `针对：${item.target}` : "整个知识点的简明讲解"}</strong>
        <MathText as="p">{item.explanation}</MathText>
      </div>)}
    </div>
    <strong>试着独立完成</strong>
    <MathText as="p">{attempt.lesson.checkQuestion}</MathText>
    <Textarea value={answer} onChange={(event) => setAnswer(event.target.value)} placeholder="写下你的解题思路；不会做可以填写「不会」" aria-label={`错题 ${questionNumber} 强化 ${attemptNumber} 的练习答案`} rows={4}/>
    <Button disabled={!answer.trim() || busy || Boolean(attempt.feedback)} onClick={() => onCheck(answer)}>检查这道题</Button>
    {attempt.feedback && <div className="lesson-feedback"><MathText>{attempt.feedback}</MathText><p>{attempt.passed
      ? "本次强化练习已通过。请在下一轮诊断中确认是否真正掌握。"
      : "本次还没有通过，可以点击原题旁的按钮生成下一次强化；此前练习会保留。"}</p></div>}
  </div>;
}
