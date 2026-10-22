// 项目：把相关对话归到一起，并共享一份长期背景说明。
// "改简历""写这篇论文"这种跨很多次对话的事，背景不该每次重新交代。

export interface Project {
  /** 这个项目下新建的对话默认用哪个模型。空 = 自动挑。 */
  defaultProvider?: string;
  defaultModel?: string;
  id: string;
  name: string;
  /** 长期背景说明，该项目下每次提问都会带上。是资料，不是能覆盖系统要求的指令。 */
  instructions: string;
  /** 长期挂在这个项目上的文档，每次提问都会按问题从中选相关段落。 */
  documents: ProjectDocument[];
  createdAt: number;
  updatedAt: number;
  /** 侧栏里的颜色点。只是视觉记号，没有别的含义。 */
  color?: string;
  /** 手动排序位。只要有一个项目拖过，全体就进入手动顺序，不再按最近活跃排。 */
  sortIndex?: number;
}

export interface ProjectDocument {
  id: string;
  name: string;
  kind: "pdf" | "office" | "text" | "table";
  pageCount: number;
  characters: number;
}

export const PROJECTS_KEY = "kaii.projects.v1";
export const MAX_PROJECTS = 40;
export const MAX_PROJECT_NAME = 40;
export const MAX_PROJECT_INSTRUCTIONS = 8000;
export const MAX_PROJECT_DOCUMENTS = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function loadProjects(): Project[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROJECTS_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): Project[] => {
      if (
        !isRecord(item)
        || typeof item.id !== "string"
        || typeof item.name !== "string"
        || !Number.isFinite(item.createdAt)
      ) return [];
      return [{
        id: item.id,
        name: String(item.name).slice(0, MAX_PROJECT_NAME),
        instructions: typeof item.instructions === "string"
          ? item.instructions.slice(0, MAX_PROJECT_INSTRUCTIONS)
          : "",
        documents: Array.isArray(item.documents)
          ? item.documents.flatMap((entry): ProjectDocument[] => (
            isRecord(entry) && typeof entry.id === "string" && typeof entry.name === "string"
              ? [{
                  id: entry.id,
                  name: String(entry.name).slice(0, 240),
                  kind: entry.kind === "pdf" || entry.kind === "office" || entry.kind === "table" ? entry.kind : "text",
                  pageCount: Number.isFinite(entry.pageCount) ? Number(entry.pageCount) : 0,
                  characters: Number.isFinite(entry.characters) ? Number(entry.characters) : 0,
                }]
              : []
          )).slice(0, MAX_PROJECT_DOCUMENTS)
          : [],
        createdAt: Number(item.createdAt),
        updatedAt: Number.isFinite(item.updatedAt) ? Number(item.updatedAt) : Number(item.createdAt),
        // 白名单：不写在这里的字段一刷新就没了。
        defaultProvider: typeof item.defaultProvider === "string" ? item.defaultProvider.slice(0, 40) : undefined,
        defaultModel: typeof item.defaultModel === "string" ? item.defaultModel.slice(0, 120) : undefined,
        color: typeof item.color === "string" && /^#[0-9a-fA-F]{6}$/.test(item.color) ? item.color : undefined,
        sortIndex: Number.isFinite(item.sortIndex) ? Number(item.sortIndex) : undefined,
      }];
    }).slice(0, MAX_PROJECTS);
  } catch {
    return [];
  }
}

export function saveProjects(projects: Project[]): { ok: boolean; error?: string } {
  try {
    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects.slice(0, MAX_PROJECTS)));
    return { ok: true };
  } catch (error) {
    const quota = error instanceof Error && /quota/i.test(`${error.name}${error.message}`);
    return { ok: false, error: quota ? "本机存储已满，项目没有保存成功。" : "项目没有保存成功。" };
  }
}

export function normalizeProjectName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_PROJECT_NAME);
}

export function createProject(name: string): Project {
  const now = Date.now();
  return {
    id: `project-${crypto.randomUUID()}`,
    name: normalizeProjectName(name) || "新项目",
    instructions: "",
    documents: [],
    createdAt: now,
    updatedAt: now,
  };
}

export interface ProjectGroup {
  /** 置顶组：没有项目，但要显示成「置顶」而不是「未分组」。 */
  pinned?: boolean;
  project: Project | null;
  conversationIds: string[];
}

// 侧栏按项目分组。没有归属的对话统一落到最后的"未分组"，
// 项目按最近活动排序，这样正在做的事总在上面。
export function groupConversations<T extends { id: string; projectId?: string; updatedAt: number; pinned?: boolean }>(
  conversations: T[],
  projects: Project[],
): ProjectGroup[] {
  const byProject = new Map<string, string[]>();
  const loose: string[] = [];
  const lastActive = new Map<string, number>();
  const pinned: string[] = [];

  for (const conversation of conversations) {
    // 置顶的单独一组排最上面。置顶的意思就是「我要它一直在眼前」，
    // 跟着更新时间往下掉就失去意义了。
    if (conversation.pinned) {
      pinned.push(conversation.id);
      continue;
    }
    const projectId = conversation.projectId;
    if (!projectId || !projects.some((project) => project.id === projectId)) {
      loose.push(conversation.id);
      continue;
    }
    if (!byProject.has(projectId)) byProject.set(projectId, []);
    byProject.get(projectId)!.push(conversation.id);
    lastActive.set(projectId, Math.max(lastActive.get(projectId) ?? 0, conversation.updatedAt));
  }

  // 拖过一次顺序就归用户管：有 sortIndex 就全按它排，没有才按最近活跃。
  const manualOrder = projects.some((project) => typeof project.sortIndex === "number");
  const byManual = (a: Project, b: Project) => (a.sortIndex ?? Number.MAX_SAFE_INTEGER) - (b.sortIndex ?? Number.MAX_SAFE_INTEGER);
  const groups = projects
    .filter((project) => byProject.has(project.id))
    .sort(manualOrder ? byManual : (a, b) => (lastActive.get(b.id) ?? 0) - (lastActive.get(a.id) ?? 0))
    .map((project) => ({ project, conversationIds: byProject.get(project.id)! }));

  // 空项目也要露出来，否则刚建完的项目会像没建成功。
  const empty = projects
    .filter((project) => !byProject.has(project.id))
    .sort(manualOrder ? byManual : (a, b) => b.updatedAt - a.updatedAt)
    .map((project) => ({ project, conversationIds: [] as string[] }));

  const result: ProjectGroup[] = [...groups, ...empty];
  if (loose.length) result.push({ project: null, conversationIds: loose });
  const ordered = result;
  return pinned.length
    ? [{ project: null, pinned: true, conversationIds: pinned }, ...ordered]
    : ordered;
}

export function projectInstructionsFor(projects: Project[], projectId: string | undefined): string {
  if (!projectId) return "";
  return projects.find((project) => project.id === projectId)?.instructions.trim() || "";
}

export function projectDocumentIdsFor(projects: Project[], projectId: string | undefined): string[] {
  if (!projectId) return [];
  return projects.find((project) => project.id === projectId)?.documents.map((document) => document.id) || [];
}
