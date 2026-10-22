import { Check, CircleStop, LoaderCircle, Play, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CatalogSection } from "../types";
import MarkdownLite from "./MarkdownLite";

// 每一列的 side 用下标命名（c0/c1/c2），最多三列。
type Side = string;

interface SideState {
  text: string;
  reasoning: string;
  elapsedMs: number;
  error: string;
  running: boolean;
}

const EMPTY: SideState = { text: "", reasoning: "", elapsedMs: 0, error: "", running: false };

interface Choice {
  provider: string;
  model: string;
  label: string;
}

function flatten(catalog: CatalogSection[]): Choice[] {
  const list: Choice[] = [{ provider: "local", model: "", label: "本机 Qwen3-8B" }];
  for (const section of catalog) {
    for (const item of section.items) {
      if (!item.configured) continue;
      if (item.provider === "local") continue;
      list.push({ provider: item.provider, model: item.model, label: item.label });
    }
  }
  return list;
}

// 同一个问题同时问两个模型，并排看。
// 用户手上有四个模型之后，"这题该用哪个"是个天天遇到的问题，
// 与其凭印象猜，不如让它们当场比一次。
export default function ComparePanel({
  catalog,
  initialQuestion,
  onClose,
  onKeep,
}: {
  catalog: CatalogSection[];
  initialQuestion: string;
  onClose: () => void;
  onKeep: (question: string, answer: string, label: string) => void;
}) {
  const choices = flatten(catalog);
  const [question, setQuestion] = useState(initialQuestion);
  // 列的选择：默认两列，可加到三列。三个模型对一道题，
  // 差异一眼就看出来了，四个以上屏幕摆不下也没必要。
  const [columns, setColumns] = useState<Choice[]>([choices[0], choices[1] || choices[0]].filter(Boolean));
  const [state, setState] = useState<Record<Side, SideState>>({ c0: EMPTY, c1: EMPTY, c2: EMPTY });
  const [notice, setNotice] = useState("");
  const running = Object.values(state).some((item) => item.running);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const patch = (side: Side, next: Partial<SideState>) => {
      setState((current) => ({ ...current, [side]: { ...current[side], ...next } }));
    };
    const offChunk = window.kaiLocal.onCompareChunk(({ side, content }) => {
      setState((current) => ({ ...current, [side]: { ...current[side], text: current[side].text + content } }));
    });
    const offReasoning = window.kaiLocal.onCompareReasoning(({ side, reasoning }) => {
      setState((current) => ({ ...current, [side]: { ...current[side], reasoning: current[side].reasoning + reasoning } }));
    });
    const offDone = window.kaiLocal.onCompareDone(({ side, elapsedMs }) => {
      patch(side, { running: false, elapsedMs });
    });
    const offError = window.kaiLocal.onCompareError(({ side, message }) => {
      patch(side, { running: false, error: message });
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !running) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      offChunk();
      offReasoning();
      offDone();
      offError();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, running]);

  const start = async () => {
    if (!question.trim() || running) return;
    setNotice("");
    const fresh: Record<Side, SideState> = { c0: EMPTY, c1: EMPTY, c2: EMPTY };
    columns.forEach((_, index) => { fresh[`c${index}`] = { ...EMPTY, running: true }; });
    setState(fresh);
    const outcome = await window.kaiLocal.runCompare({
      question: question.trim(),
      targets: columns.map((choice) => ({ provider: choice.provider, model: choice.model })),
    });
    if (!outcome.ok) {
      setState({ c0: EMPTY, c1: EMPTY, c2: EMPTY });
      setNotice(outcome.message || "没跑起来");
    }
  };

  const column = (side: Side, choice: Choice, setChoice: (value: Choice) => void) => {
    const data = state[side];
    return (
      <div className="compare-column" key={side}>
        <select
          value={`${choice.provider}|${choice.model}`}
          disabled={running}
          aria-label={`第 ${Number(side.slice(1)) + 1} 列的模型`}
          onChange={(event) => {
            const [provider, model] = event.target.value.split("|");
            const found = choices.find((item) => item.provider === provider && item.model === model);
            if (found) setChoice(found);
          }}
        >
          {choices.map((item) => (
            <option key={`${item.provider}|${item.model}`} value={`${item.provider}|${item.model}`}>
              {item.label}
            </option>
          ))}
        </select>

        <div className="compare-body">
          {data.reasoning && (
            <details className="compare-reasoning">
              <summary>思考过程</summary>
              <p>{data.reasoning}</p>
            </details>
          )}
          {data.error
            ? <p className="compare-error">{data.error}</p>
            : data.text
              ? <MarkdownLite content={data.text} />
              : data.running
                ? <p className="compare-waiting"><LoaderCircle className="spin" size={13} /> 正在答</p>
                : <p className="compare-waiting">还没开始</p>}
        </div>

        <div className="compare-foot">
          <span>
            {data.elapsedMs ? `${(data.elapsedMs / 1000).toFixed(1)} 秒 · ${data.text.length} 字` : ""}
          </span>
          <button
            type="button"
            disabled={!data.text || data.running}
            onClick={() => onKeep(question.trim(), data.text, choice.label)}
          >
            <Check size={12} /> 用这个
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !running && onClose()}>
      <section className="compare-panel" role="dialog" aria-modal="true" aria-label="比一比">
        <header>
          <div>
            <h2>模型对比</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose} disabled={running}>
            <X size={18} />
          </button>
        </header>

        <div className="compare-ask">
          <textarea
            value={question}
            placeholder="想让它们一起答的问题"
            disabled={running}
            onChange={(event) => setQuestion(event.target.value)}
          />
          {running ? (
            <button type="button" className="danger" onClick={() => void window.kaiLocal.cancelCompare()}>
              <CircleStop size={13} /> 停下
            </button>
          ) : (
            <button type="button" className="primary" disabled={!question.trim()} onClick={() => void start()}>
              <Play size={13} /> 开始
            </button>
          )}
        </div>

        {notice && <p className="compare-notice" role="alert">{notice}</p>}

        <div className="compare-grid" ref={box}>
          {columns.map((choice, index) => column(
            `c${index}`,
            choice,
            (next) => setColumns((current) => current.map((item, at) => (at === index ? next : item))),
          ))}
          {columns.length < 3 && choices.length > 2 && !running && (
            <button
              type="button"
              className="compare-add"
              title="再加一个模型一起比"
              onClick={() => setColumns((current) => [...current, choices.find((item) =>
                !current.some((chosen) => chosen.provider === item.provider && chosen.model === item.model)) || choices[0]])}
            >
              <Plus size={15} /> 加一列
            </button>
          )}
        </div>

        <footer>
          <small>独立比较，不带当前对话。</small>
        </footer>
      </section>
    </div>
  );
}
