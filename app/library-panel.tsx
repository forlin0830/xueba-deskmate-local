"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { libraryGet, libraryPost } from "@/lib/library-client";
import type { LibraryDetail, LibraryItem } from "@/lib/library-client";
import type { Material, SourceCategory } from "@/lib/learning-store";

const CATEGORIES: Record<SourceCategory, string> = { syllabus: "考试大纲", textbook: "教材与笔记", past_exam: "往年真题" };
const STATES: Record<LibraryItem["status"], string> = { pending: "待审核", approved: "已公开", rejected: "未通过" };

export function ContributionDialog({ material, accountReady, busy, onClose, onSubmit }: {
  material: Material; accountReady: boolean; busy: boolean; onClose: () => void;
  onSubmit: (materialId: string, sourceNote: string, sourceUrl: string) => Promise<void>;
}) {
  const [sourceNote, setSourceNote] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [consent, setConsent] = useState(false);
  const [submitError, setSubmitError] = useState("");
  async function submit() {
    setSubmitError("");
    try { await onSubmit(material.id, sourceNote.trim(), sourceUrl.trim()); }
    catch (cause) { setSubmitError(cause instanceof Error ? cause.message : "投稿失败。"); }
  }
  return <div className="library-dialog-backdrop" role="presentation">
    <section className="library-dialog" role="dialog" aria-modal="true" aria-labelledby="library-dialog-title">
      <span className="eyebrow">自愿贡献</span>
      <h2 id="library-dialog-title">愿意分享「{material.title}」吗？</h2>
      <p>资料目前只属于你。投稿前会将当前档案同步到你的私人云端；只有这份资料的完整识别正文、页码和下方来源信息会送审。原始文件、答题记录和模型密钥不会公开。</p>
      <p>审核员核对后才会公开。你可以撤回投稿；其他人已经加入自己学习空间的副本无法随之删除。</p>
      <div className="live-field"><Label htmlFor="library-source-note">来源说明</Label><Textarea id="library-source-note" value={sourceNote} onChange={(event) => setSourceNote(event.target.value)} rows={3} maxLength={300} placeholder="例如：我自行整理的笔记；或文件发布单位、版本与取得方式"/></div>
      <div className="live-field"><Label htmlFor="library-source-url">来源链接（可选）</Label><Input id="library-source-url" type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} maxLength={500} placeholder="https://…"/></div>
      <label className="library-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)}/><span>我有权公开分享这份识别正文，并已检查其中没有他人的个人信息。</span></label>
      {!accountReady && <small>投稿需要先登录云端账号；你仍可先保留这份私人资料。</small>}
      {submitError && <p className="live-error" role="alert">{submitError}</p>}
      <div className="library-dialog-actions"><Button variant="outline" disabled={busy} onClick={onClose}>暂时不分享</Button><Button disabled={busy || !accountReady || !consent || sourceNote.trim().length < 10} onClick={() => void submit()}>提交审核</Button></div>
    </section>
  </div>;
}
export function LibraryPanel({ subject, goal, connected, refreshKey, onImport }: {
  subject: string; goal: string; connected: boolean; refreshKey: number;
  onImport: (detail: LibraryDetail) => Promise<void>;
}) {
  const [currentOnly, setCurrentOnly] = useState(true);
  const [category, setCategory] = useState("");
  const [publicItems, setPublicItems] = useState<LibraryItem[]>([]);
  const [mine, setMine] = useState<LibraryItem[]>([]);
  const [pending, setPending] = useState<LibraryItem[]>([]);
  const [isReviewer, setIsReviewer] = useState(false);
  const [detail, setDetail] = useState<LibraryDetail | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [reviewNote, setReviewNote] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams();
    if (currentOnly && subject.trim()) params.set("subject", subject.trim());
    if (category) params.set("category", category);
    libraryGet(`?${params}`).then((result) => { if (active) { setPublicItems(result.items as LibraryItem[]); setError(""); } })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "公共资料库无法读取。"); });
    if (connected) {
      libraryGet("?action=mine").then(async (result) => {
        if (!active) return;
        setMine(result.items as LibraryItem[]); setIsReviewer(result.reviewer === true);
        if (result.reviewer === true) {
          const queue = await libraryGet("?action=review-queue");
          if (active) setPending(queue.items as LibraryItem[]);
        }
      }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "投稿状态无法读取。"); });
    }
    return () => { active = false; };
  }, [subject, category, currentOnly, connected, refreshKey, refresh]);

  async function openDetail(id: string) {
    setBusy("正在读取完整正文…"); setError("");
    try {
      const result = await libraryGet(`?${new URLSearchParams({ action: "item", id })}`) as LibraryDetail;
      setDetail(result); setPageIndex(0); setReviewNote("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "正文无法读取。"); }
    finally { setBusy(""); }
  }
  async function importItem() {
    if (!detail) return;
    setBusy("正在加入当前学习空间…"); setError("");
    try { await onImport(detail); setNotice(`已将「${detail.item.title}」加入当前学习空间。`); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "无法加入学习空间。"); }
    finally { setBusy(""); }
  }
  async function withdraw(id: string) {
    if (!window.confirm("撤回后将立即从公共资料库删除这份正文。已被其他人加入学习空间的副本仍会保留。确定撤回吗？")) return;
    setBusy("正在撤回投稿…"); setError("");
    try { await libraryPost({ action: "withdraw", id }); if (detail?.item.id === id) setDetail(null); setRefresh((value) => value + 1); setNotice("投稿已撤回，公共资料库不再提供该正文。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "撤回失败。"); }
    finally { setBusy(""); }
  }
  async function review(id: string, decision: "approve" | "reject") {
    if (decision === "approve" && !window.confirm("确认已核对完整正文、科目相关性和分享权限，并公开这份资料吗？")) return;
    setBusy("正在保存审核结果…"); setError("");
    try { await libraryPost({ action: "review", id, decision, note: reviewNote }); setDetail(null); setRefresh((value) => value + 1); setNotice(decision === "approve" ? "资料已公开。" : "投稿已退回，投稿人可查看原因。"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "审核失败。"); }
    finally { setBusy(""); }
  }
  const relevant = (item: LibraryItem) => item.subject.trim().toLowerCase() === subject.trim().toLowerCase()
    && item.goal.trim().toLowerCase() === goal.trim().toLowerCase();
  return <div className="live-panel library-panel">
    <div className="panel-head"><div><span className="eyebrow">自愿贡献 · 人工审核</span><h2>公共资料库</h2></div><span>{publicItems.length} 份可浏览</span></div>
    <p>这里只展示已审核的完整识别正文。原始 PDF/DOCX 不会公开；请核对来源与适用年份。加入资料不会自动改变你的私人云端档案，需要正常同步。</p>
    <div className="library-filters"><label><input type="checkbox" checked={currentOnly} onChange={(event) => setCurrentOnly(event.target.checked)}/>只看当前科目</label><select aria-label="公共资料类别" className="provider-select" value={category} onChange={(event) => setCategory(event.target.value)}><option value="">全部类型</option>{Object.entries(CATEGORIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><Button variant="outline" disabled={Boolean(busy)} onClick={() => setRefresh((value) => value + 1)}>刷新</Button></div>
    <div className="library-list">{publicItems.length ? publicItems.map((item) => <article className="library-item" key={item.id}><strong>{item.title}</strong><span>{CATEGORIES[item.category]} · {item.goal} / {item.subject}{item.year ? ` · ${item.year}` : ""} · {item.coverage.total} {item.coverage.unit === "page" ? "页" : "段"}</span><p>{item.summary || item.sourceNote}</p><small>来源：{item.sourceNote}{item.sourceUrl && <> · <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">查看来源 ↗</a></>}</small><Button variant="outline" disabled={Boolean(busy)} onClick={() => void openDetail(item.id)}>查看完整正文</Button></article>) : <p>当前筛选下暂无已公开资料。</p>}</div>
    {connected && <section className="library-submissions"><h3>我的投稿</h3>{mine.length ? mine.map((item) => <article className="library-item" key={item.id}><strong>{item.title}</strong><span>{STATES[item.status]} · {new Date(item.createdAt).toLocaleString("zh-CN")}</span>{item.reviewNote && <small>审核意见：{item.reviewNote}</small>}<div className="library-item-actions"><Button variant="outline" disabled={Boolean(busy)} onClick={() => void openDetail(item.id)}>查看正文</Button><Button variant="ghost" disabled={Boolean(busy)} onClick={() => void withdraw(item.id)}>撤回并删除</Button></div></article>) : <p>你还没有投稿。已完整读取的本人上传资料，可在“已保存的资料”中选择投稿。</p>}</section>}
    {connected && isReviewer && <section className="library-submissions"><h3>待审核 · {pending.length}</h3>{pending.length ? pending.map((item) => <article className="library-item" key={item.id}><strong>{item.title}</strong><span>{item.goal} / {item.subject} · {item.coverage.total} {item.coverage.unit === "page" ? "页" : "段"}</span><small>来源：{item.sourceNote}</small><Button variant="outline" disabled={Boolean(busy)} onClick={() => void openDetail(item.id)}>查看并审核</Button></article>) : <p>暂无待审核投稿。</p>}</section>}
    {detail && <section className="library-detail"><div className="library-detail-head"><h3>{detail.item.title}</h3><Button variant="ghost" onClick={() => setDetail(null)}>关闭正文</Button></div><p>{detail.item.summary}</p><small>来源：{detail.item.sourceNote}{detail.item.sourceUrl && <> · <a href={detail.item.sourceUrl} target="_blank" rel="noopener noreferrer">来源链接 ↗</a></>}</small><div className="live-field"><Label htmlFor="library-page">选择{detail.item.coverage.unit === "page" ? "页码" : "分段"}</Label><select id="library-page" className="provider-select" value={pageIndex} onChange={(event) => setPageIndex(Number(event.target.value))}>{detail.pages.map((page, index) => <option key={page.number} value={index}>第 {page.number} {detail.item.coverage.unit === "page" ? "页" : "段"}{page.method === "ocr" ? " · OCR" : ""}</option>)}</select></div><pre>{detail.pages[pageIndex]?.text}</pre>
      {detail.item.status === "approved" && <><Button disabled={Boolean(busy) || !relevant(detail.item)} onClick={() => void importItem()}>加入当前学习空间</Button>{!relevant(detail.item) && <small>目标或科目与当前学习空间不一致；请先切换到对应学习空间。</small>}</>}
      {isReviewer && detail.item.status === "pending" && <div className="library-review"><Label htmlFor="library-review-note">审核说明（拒绝时必填）</Label><Textarea id="library-review-note" value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} rows={2} maxLength={500}/><div><Button disabled={Boolean(busy)} onClick={() => void review(detail.item.id, "approve")}>审核通过并公开</Button><Button variant="outline" disabled={Boolean(busy) || !reviewNote.trim()} onClick={() => void review(detail.item.id, "reject")}>退回投稿</Button></div></div>}
    </section>}
    {busy && <p role="status">{busy}</p>}{error && <p className="live-error" role="alert">{error}</p>}{notice && <p className="live-notice" role="status">{notice}</p>}
  </div>;
}
