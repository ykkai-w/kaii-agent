import { Clock, LoaderCircle, Play, Plus, Trash2, Wand2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Schedule } from "../types";

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function describe(schedule: Schedule): string {
  const time = `${String(schedule.hour).padStart(2, "0")}:${String(schedule.minute).padStart(2, "0")}`;
  if (schedule.every === "hour") return `每小时的第 ${schedule.minute} 分钟`;
  if (schedule.every === "day") return `每天 ${time}`;
  if (schedule.every === "month") return `每月 ${schedule.dayOfMonth || 1} 号 ${time}`;
  return `每${WEEKDAYS[schedule.weekday]} ${time}`;
}

function whenNext(at: number): string {
  if (!at) return "已停用";
  const minutes = Math.round((at - Date.now()) / 60_000);
  if (minutes < 1) return "马上";
  if (minutes < 60) return `${minutes} 分钟后`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时后`;
  return `${Math.round(hours / 24)} 天后`;
}

export default function SchedulePanel({
  schedules,
  onClose,
  onChange,
  modelChoices,
  onResultToChat,
}: {
  schedules: Schedule[];
  onClose: () => void;
  onChange: (schedules: Schedule[]) => void;
  modelChoices: { provider: string; model: string; label: string }[];
  onResultToChat: (schedule: Schedule, resultText: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [prompt, setPrompt] = useState("");
  const [every, setEvery] = useState<Schedule["every"]>("day");
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [weekday, setWeekday] = useState(1);
  const [dayOfMonth, setDayOfMonth] = useState(1);
  const [runModel, setRunModel] = useState("|");
  const [useWeb, setUseWeb] = useState(false);
  const [notifyKeyword, setNotifyKeyword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [sentence, setSentence] = useState("");
  const [parsing, setParsing] = useState(false);

  // 抽出来只是填表单，不直接落盘。用户看一眼再点「加上」。
  const parseSentence = async () => {
    const text = sentence.trim();
    if (!text || parsing) return;
    setParsing(true);
    setError(null);
    try {
      const outcome = await window.kaiLocal.parseSchedule(text);
      if (!outcome.ok || !outcome.draft) {
        setError(outcome.message || "没听懂这句话");
        return;
      }
      const draft = outcome.draft;
      setLabel(draft.label);
      setPrompt(draft.prompt);
      setEvery(draft.every as Schedule["every"]);
      setHour(draft.hour);
      setMinute(draft.minute);
      setWeekday(draft.weekday);
      setSentence("");
    } finally {
      setParsing(false);
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const guard = async (action: () => Promise<Schedule[]>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await action());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "这一步没成功");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="schedule-panel" role="dialog" aria-modal="true" aria-label="定时任务">
        <header>
          <div>
            <h2>定时任务</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭定时任务" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="schedule-quick">
          <input
            value={sentence}
            placeholder="直接说：每天早上九点提醒我看今天的日程"
            disabled={parsing || busy}
            onChange={(event) => setSentence(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void parseSentence(); }}
          />
          <button type="button" disabled={parsing || !sentence.trim()} onClick={() => void parseSentence()}>
            {parsing ? <LoaderCircle className="spin" size={13} /> : <Wand2 size={13} />} 变成任务
          </button>
        </div>
        <p className="schedule-quick-note">
          识别结果只会填入表单，点「加上」后才会创建。
        </p>

        <div className="schedule-templates">
          {[
            ["每天早报", "帮我列今天要留意的三件事：天气趋势、我最近在忙的事的下一步、一句提醒。", "day", 9],
            ["每周回顾", "帮我回顾这一周：我都在问什么、有没有反复出现的题目、下周该先做什么。", "week", 18],
          ].map(([name, body, kind, at]) => (
            <button
              type="button"
              key={String(name)}
              onClick={() => {
                setLabel(String(name));
                setPrompt(String(body));
                setEvery(kind as Schedule["every"]);
                setHour(Number(at));
                setMinute(0);
              }}
            >
              {String(name)}
            </button>
          ))}
        </div>

        <div className="schedule-create">
          <input value={label} maxLength={40} placeholder="给它起个名，比如「每天早报」" onChange={(event) => setLabel(event.target.value)} />
          <textarea
            value={prompt}
            maxLength={2000}
            placeholder="到点了让它做什么？和平时提问一样写就行。"
            onChange={(event) => setPrompt(event.target.value)}
          />
          <div className="schedule-when">
            <select value={every} onChange={(event) => setEvery(event.target.value as Schedule["every"])}>
              <option value="day">每天</option>
              <option value="week">每周</option>
              <option value="month">每月</option>
              <option value="hour">每小时</option>
            </select>
            {every === "month" && (
              <select value={dayOfMonth} onChange={(event) => setDayOfMonth(Number(event.target.value))}>
                {Array.from({ length: 28 }, (_, index) => (
                  <option value={index + 1} key={index}>{index + 1} 号</option>
                ))}
              </select>
            )}
            {every === "week" && (
              <select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))}>
                {WEEKDAYS.map((name, index) => <option value={index} key={name}>{name}</option>)}
              </select>
            )}
            {every !== "hour" && (
              <select value={hour} onChange={(event) => setHour(Number(event.target.value))}>
                {Array.from({ length: 24 }, (_, index) => (
                  <option value={index} key={index}>{String(index).padStart(2, "0")} 点</option>
                ))}
              </select>
            )}
            <select value={minute} onChange={(event) => setMinute(Number(event.target.value))}>
              {[0, 10, 15, 20, 30, 40, 45, 50].map((value) => (
                <option value={value} key={value}>{String(value).padStart(2, "0")} 分</option>
              ))}
            </select>
            <select value={runModel} aria-label="用哪个模型跑" onChange={(event) => setRunModel(event.target.value)}>
              <option value="|">用本机模型跑</option>
              {modelChoices.filter((choice) => choice.provider !== "local").map((choice) => (
                <option key={`${choice.provider}|${choice.model}`} value={`${choice.provider}|${choice.model}`}>
                  用{choice.label}跑
                </option>
              ))}
            </select>
            <label className="schedule-flag">
              <input type="checkbox" checked={useWeb} onChange={(event) => setUseWeb(event.target.checked)} />
              联网
            </label>
            <input
              className="schedule-keyword"
              value={notifyKeyword}
              maxLength={40}
              placeholder="出现这个词才通知（空=每次）"
              onChange={(event) => setNotifyKeyword(event.target.value)}
            />
            <button
              type="button"
              disabled={busy || !prompt.trim()}
              onClick={() => guard(async () => {
                const [provider, model] = runModel.split("|");
                const result = await window.kaiLocal.addSchedule({
                  label, prompt, every, hour, minute, weekday, dayOfMonth,
                  provider, model, useWeb, notifyKeyword,
                });
                setLabel("");
                setPrompt("");
                setNotifyKeyword("");
                return result;
              })}
            >
              <Plus size={13} /> 加上
            </button>
          </div>
        </div>

        {error && <p className="schedule-error" role="alert">{error}</p>}

        <div className="schedule-list">
          {/* 停用的沉到底部：开着的才是每天要看的，别让停用的插在中间占视线。 */}
          {schedules.length ? [...schedules].sort((a, b) => Number(b.enabled) - Number(a.enabled)).map((schedule) => {
            const unread = schedule.results.filter((item) => item.unread).length;
            const lastRun = schedule.results.at(-1);
            return (
              <article key={schedule.id} className={schedule.enabled ? "" : "off"}>
                <div className="schedule-head">
                  {/* 上次跑的结果一眼可见：绿=成了，红=没成，灰=还没跑过 */}
                  <i
                    className={`schedule-dot ${lastRun ? (lastRun.ok ? "ok" : "bad") : ""}`}
                    title={lastRun ? (lastRun.ok ? "上次跑成了" : `上次没跑成：${lastRun.error}`) : "还没跑过"}
                  />
                  <Clock size={14} />
                  <div>
                    <strong>{schedule.label}{unread ? <b> {unread} 条新的</b> : null}</strong>
                    <small>
                      {describe(schedule)}
                      {" · "}
                      {!schedule.enabled
                        ? "已停用"
                        : schedule.pausedUntil && schedule.pausedUntil > Date.now()
                          ? `暂停到 ${new Date(schedule.pausedUntil).toLocaleDateString("zh-CN")}`
                          : `${whenNext(schedule.nextRunAt)}跑`}
                      {schedule.results.length > 0 && (
                        <i className="schedule-dots" title="最近几次：绿=成，红=败">
                          {schedule.results.slice(-10).map((result) => (
                            <b key={result.at} className={result.ok ? "ok" : "bad"} />
                          ))}
                        </i>
                      )}
                    </small>
                  </div>
                  <label className="schedule-switch">
                    <input
                      type="checkbox"
                      checked={schedule.enabled}
                      onChange={(event) => guard(() => window.kaiLocal.updateSchedule(schedule.id, { enabled: event.target.checked }))}
                    />
                    <span>开着</span>
                  </label>
                </div>

                <p className="schedule-prompt">{schedule.prompt}</p>

                <div className="schedule-actions">
                  <button type="button" disabled={busy} onClick={() => guard(() => window.kaiLocal.runScheduleNow(schedule.id))}>
                    <Play size={12} /> 现在跑一次
                  </button>
                  {schedule.results.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setOpen(open === schedule.id ? null : schedule.id);
                        if (unread) void guard(() => window.kaiLocal.markScheduleRead(schedule.id));
                      }}
                    >
                      {open === schedule.id ? "收起结果" : `看结果（${schedule.results.length}）`}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    title="休假一周不想让它白跑？停到明天/下周，到点自动恢复"
                    onClick={() => {
                      const days = window.prompt("暂停几天？（1-30）", "1");
                      if (days === null) return;
                      const count = Number(days);
                      if (!Number.isInteger(count) || count < 1 || count > 30) return;
                      void guard(() => window.kaiLocal.pauseSchedule(schedule.id, Date.now() + count * 86_400_000));
                    }}
                  >
                    停几天
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    title="照这个任务再建一个（时间和内容都可以改）"
                    onClick={() => guard(async () => window.kaiLocal.addSchedule({
                      label: `${schedule.label} 副本`.slice(0, 40),
                      prompt: schedule.prompt,
                      every: schedule.every,
                      hour: schedule.hour,
                      minute: schedule.minute,
                      weekday: schedule.weekday,
                      dayOfMonth: schedule.dayOfMonth,
                      provider: schedule.provider,
                      model: schedule.model,
                      useWeb: schedule.useWeb,
                      notifyKeyword: schedule.notifyKeyword,
                    }))}
                  >
                    照着建一个
                  </button>
                  {schedule.results.length > 1 && (
                    <button
                      type="button"
                      title="把这个任务跑出来的全部结果导成一份 Markdown"
                      onClick={() => {
                        const body = [
                          `# ${schedule.label}`,
                          "",
                          ...[...schedule.results].reverse().flatMap((item) => [
                            `## ${new Date(item.at).toLocaleString("zh-CN")}`,
                            "",
                            item.ok ? item.text : `没跑成：${item.error}`,
                            "",
                          ]),
                        ].join("\n");
                        const anchor = document.createElement("a");
                        anchor.href = URL.createObjectURL(new Blob([body], { type: "text/markdown" }));
                        anchor.download = `${schedule.label.replace(/[\\/:*?"<>|]/g, "_").slice(0, 50)}.md`;
                        anchor.click();
                        URL.revokeObjectURL(anchor.href);
                      }}
                    >
                      导出结果
                    </button>
                  )}
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => {
                      // 删任务会连带删掉它跑出来的全部结果，删之前把这句说清楚。
                      const history = schedule.results.length
                        ? `，连同 ${schedule.results.length} 条历史结果`
                        : "";
                      if (!window.confirm(`删掉「${schedule.label}」${history}？删了不进回收站。`)) return;
                      void guard(() => window.kaiLocal.removeSchedule(schedule.id));
                    }}
                  >
                    <Trash2 size={12} /> 删掉
                  </button>
                </div>

                {open === schedule.id && (
                  <div className="schedule-results">
                    {[...schedule.results].reverse().map((result) => (
                      <div key={result.at} className={result.ok ? "" : "failed"}>
                        <span>{new Date(result.at).toLocaleString("zh-CN", { hour12: false })}</span>
                        <p>{result.ok ? result.text : `没跑成：${result.error}`}</p>
                        {result.ok && result.text.trim() && (
                          <>
                            <button
                              type="button"
                              className="schedule-to-chat"
                              title="把这条结果放进一段新对话接着问"
                              onClick={() => onResultToChat(schedule, result.text)}
                            >
                              接着问
                            </button>
                            <button
                              type="button"
                              className="schedule-to-chat"
                              title="复制这条结果"
                              onClick={() => void navigator.clipboard.writeText(result.text)}
                            >
                              复制
                            </button>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </article>
            );
          }) : (
            <div className="schedule-blank">
              <Clock size={26} />
              <strong>还没有定时任务</strong>
            </div>
          )}
        </div>

        <footer>
          <small>kaii-agent 关闭时不会运行；忙碌时会等当前回答结束。</small>
          <div className="schedule-io">
            <button
              type="button"
              disabled={!schedules.length}
              onClick={() => {
                const payload = schedules.map(({ id, results, nextRunAt, lastRunAt, ...rest }) => rest);
                const blob = new Blob([JSON.stringify({ app: "kaii-schedules", version: 1, items: payload }, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = "kaii-定时任务.json";
                anchor.click();
                URL.revokeObjectURL(url);
              }}
            >
              导出
            </button>
            <label className="schedule-import">
              导入
              <input
                type="file"
                accept="application/json,.json"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (!file) return;
                  try {
                    const parsed = JSON.parse(await file.text());
                    if (parsed?.app !== "kaii-schedules" || !Array.isArray(parsed.items)) {
                      setError("请选择 kaii-agent 导出的定时任务文件。");
                      return;
                    }
                    // 逐条走正常校验；坏的跳过，最后告知成了几条。
                    let added = 0;
                    for (const item of parsed.items.slice(0, 20)) {
                      try {
                        // eslint-disable-next-line no-await-in-loop
                        const result = await window.kaiLocal.addSchedule(item);
                        onChange(result);
                        added += 1;
                      } catch {
                        // 单条坏了不挡别的。
                      }
                    }
                    setError(added ? null : "一条都没导入成，文件里的任务可能都不完整。");
                  } catch {
                    setError("这个文件读不了。");
                  }
                }}
              />
            </label>
          </div>
        </footer>
      </section>
    </div>
  );
}
