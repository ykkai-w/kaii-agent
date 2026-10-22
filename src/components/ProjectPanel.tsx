import { FileText, FolderOpen, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Project } from "../lib/projects.ts";
import { MAX_PROJECT_INSTRUCTIONS, normalizeProjectName } from "../lib/projects.ts";

export default function ProjectPanel({
  projects,
  counts,
  onClose,
  onCreate,
  onRename,
  onInstructions,
  onDefaultModel,
  modelChoices,
  onAddDocument,
  onRemoveDocument,
  onDelete,
}: {
  projects: Project[];
  counts: Record<string, number>;
  onClose: () => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onInstructions: (id: string, instructions: string) => void;
  /** 项目下新建对话默认用哪个模型。传空字符串 = 回到自动挑。 */
  onDefaultModel: (id: string, provider: string, model: string) => void;
  modelChoices: { provider: string; model: string; label: string }[];
  onAddDocument: (id: string) => void;
  onRemoveDocument: (id: string, documentId: string) => void;
  onDelete: (id: string) => void;
}) {
  const [newName, setNewName] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(projects[0]?.id ?? null);
  const selected = projects.find((project) => project.id === selectedId) || null;
  const [draft, setDraft] = useState(selected?.instructions ?? "");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    setDraft(selected?.instructions ?? "");
    setConfirmDelete(null);
  }, [selected?.id, selected?.instructions]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="project-panel" role="dialog" aria-modal="true" aria-label="项目">
        <header>
          <div>
            <h2>项目</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭项目" onClick={onClose}><X size={18} /></button>
        </header>

        <div className="project-create">
          <input
            value={newName}
            maxLength={40}
            placeholder="新项目名字，例如：改简历"
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !normalizeProjectName(newName)) return;
              event.preventDefault();
              onCreate(newName);
              setNewName("");
            }}
          />
          <button
            type="button"
            disabled={!normalizeProjectName(newName)}
            onClick={() => {
              onCreate(newName);
              setNewName("");
            }}
          >
            <Plus size={14} /> 建项目
          </button>
        </div>

        {projects.length === 0 ? (
          <div className="project-blank">
            <FolderOpen size={30} />
            <strong>还没有项目</strong>
          </div>
        ) : (
        <div className="project-body">
          <div className="project-list">
            {projects.map((project) => (
              <button
                type="button"
                key={project.id}
                className={project.id === selectedId ? "active" : ""}
                onClick={() => setSelectedId(project.id)}
              >
                <FolderOpen size={14} />
                <span>
                  <strong>{project.name}</strong>
                  <small>{counts[project.id] ? `${counts[project.id]} 段对话` : "还没有对话"}</small>
                </span>
              </button>
            ))}
          </div>

          {selected ? (
            <div className="project-detail">
              <label>
                <span>项目名字</span>
                <input
                  value={selected.name}
                  maxLength={40}
                  onChange={(event) => onRename(selected.id, event.target.value)}
                />
              </label>

              <label className="grow">
                <span>背景说明</span>
                <textarea
                  value={draft}
                  maxLength={MAX_PROJECT_INSTRUCTIONS}
                  placeholder={"每次提问都会附带这段背景。\n例如：我在准备量化岗求职，简历用中文、一页，突出数据和结果。"}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => {
                    if (draft !== selected.instructions) onInstructions(selected.id, draft);
                  }}
                />
              <div className="project-default-model">
                <span>这个项目下新建的对话默认用：</span>
                <select
                  value={`${selected.defaultProvider || ""}|${selected.defaultModel || ""}`}
                  aria-label="项目默认模型"
                  onChange={(event) => {
                    const [provider, model] = event.target.value.split("|");
                    onDefaultModel(selected.id, provider, model);
                  }}
                >
                  <option value="|">自动挑（跟全局一样）</option>
                  {modelChoices.map((choice) => (
                    <option key={`${choice.provider}|${choice.model}`} value={`${choice.provider}|${choice.model}`}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </div>
                <small>
                  {draft.trim()
                    ? `${draft.trim().length} 字；过长时会截短。`
                    : "不填则不附加项目背景。"}
                </small>
              </label>

              <div className="project-documents">
                <div className="project-documents-head">
                  <span>常驻资料（{selected.documents.length}/8）</span>
                  <button type="button" disabled={selected.documents.length >= 8} onClick={() => onAddDocument(selected.id)}>
                    <Plus size={12} /> 加文档
                  </button>
                </div>
                {selected.documents.length ? (
                  <ul>
                    {selected.documents.map((document) => (
                      <li key={document.id}>
                        <FileText size={13} />
                        <span>
                          <strong>{document.name}</strong>
                          <small>{document.kind === "pdf" ? `${document.pageCount} 页` : `${document.characters} 字`}</small>
                        </span>
                        <button type="button" aria-label={`移除${document.name}`} onClick={() => onRemoveDocument(selected.id, document.id)}>
                          <X size={12} />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="project-documents-empty">
                    每次提问会选取相关段落。使用云端模型时，这些段落会发送给对应服务。
                  </p>
                )}
              </div>

              <div className="project-danger">
                {confirmDelete === selected.id ? (
                  <>
                    <span>删掉项目后，里面的对话会变成未分组，不会丢。</span>
                    <button type="button" className="danger" onClick={() => onDelete(selected.id)}>确认删除</button>
                    <button type="button" onClick={() => setConfirmDelete(null)}>算了</button>
                  </>
                ) : (
                  <button type="button" onClick={() => setConfirmDelete(selected.id)}>
                    <Trash2 size={13} /> 删除这个项目
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="project-detail project-detail-empty">
              <span>从左边选一个项目</span>
            </div>
          )}
        </div>
        )}
      </section>
    </div>
  );
}
