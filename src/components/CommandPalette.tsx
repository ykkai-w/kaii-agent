import { CornerDownLeft, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PaletteCommand } from "../lib/palette.ts";
import { applyRecency, filterCommands, groupCommands, moveSelection } from "../lib/palette.ts";

const RECENT_KEY = "kaii.paletteRecent.v1";

function readRecent(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

// ⌘K：不用记功能藏在哪个角落，敲一下直接到。
export default function CommandPalette({
  commands,
  onClose,
}: {
  commands: PaletteCommand[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const recent = useMemo(readRecent, []);
  // 有查询词时按匹配分排；没查询词时把最近用过的提到前面。
  const visible = useMemo(() => (
    query.trim() ? filterCommands(commands, query) : filterCommands(applyRecency(commands, recent), query)
  ), [commands, query, recent]);
  const groups = useMemo(() => groupCommands(visible), [visible]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 换了搜索词就回到第一条，否则选中项会停在一个已经被筛掉的位置上。
  useEffect(() => {
    setSelected(visible.findIndex((item) => !item.disabled) === -1 ? 0 : visible.findIndex((item) => !item.disabled));
  }, [query, visible]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[data-selected='true']")
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const runAt = (index: number) => {
    const command = visible[index];
    if (!command || command.disabled) return;
    // 记一笔"最近用过"。只记 id，不记参数、不记内容。
    try {
      const next = [command.id, ...readRecent().filter((id) => id !== command.id)].slice(0, 8);
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // 记不上不影响执行。
    }
    onClose();
    command.run();
  };

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            setSelected((current) => moveSelection(visible, current, 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setSelected((current) => moveSelection(visible, current, -1));
          } else if (event.key === "Enter") {
            event.preventDefault();
            runAt(selected);
          }
        }}
      >
        <div className="palette-search">
          <Search size={16} />
          <input
            ref={inputRef}
            value={query}
            placeholder="想做什么？敲几个字就行"
            aria-label="搜索命令"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="palette-list" ref={listRef}>
          {visible.length ? groups.map((group) => (
            <div className="palette-group" key={group.group}>
              <div className="palette-group-head">{group.group}<b>{group.items.length}</b></div>
              {group.items.map((item) => {
                const index = visible.indexOf(item);
                return (
                  <button
                    type="button"
                    key={item.id}
                    data-selected={index === selected}
                    className={item.disabled ? "disabled" : ""}
                    onMouseMove={() => !item.disabled && setSelected(index)}
                    onClick={() => runAt(index)}
                  >
                    <span className="palette-label">{item.label}</span>
                    {item.hint && <span className="palette-hint">{item.hint}</span>}
                    {index === selected && <CornerDownLeft size={12} />}
                  </button>
                );
              })}
            </div>
          )) : (
            <div className="palette-blank">没有匹配的。换个说法试试，比如「新建」「模型」「定时」。</div>
          )}
        </div>

        <footer>
          <span>↑↓ 选</span>
          <span>↵ 执行</span>
          <span>esc 关掉</span>
        </footer>
      </section>
    </div>
  );
}
