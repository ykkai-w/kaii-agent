import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, FileText, Layers, LoaderCircle, MessageSquareText } from "lucide-react";
import { onboardingKeyError } from "../lib/onboarding";
import "../welcome.css";

const services = [
  { id: "deepseek", label: "DeepSeek", company: "深度求索" },
  { id: "zhipu", label: "GLM", company: "智谱" },
  { id: "moonshot", label: "Kimi", company: "月之暗面" },
];

export default function WelcomePanel({ onSave, onSkip, onLocalSettings }: {
  onSave: (provider: string, key: string) => Promise<void>;
  onSkip: () => void;
  onLocalSettings: () => void;
}) {
  const [provider, setProvider] = useState("deepseek");
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const savingRef = useRef(false);
  useEffect(() => { heading.current?.focus(); }, []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (savingRef.current) return;
    const invalid = onboardingKeyError(key);
    if (invalid) { setError(invalid); return; }
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      await onSave(provider, key.trim());
      setKey("");
    } catch {
      // 存储或 IPC 的原始错误可能带输入值，界面只显示固定提示。
      setError("这次设置没有保存完成。可以重试，或先浏览界面。已保存的 key 可在设置里查看状态。");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <main className="welcome-screen" onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape" && !saving) onSkip();
    }}>
      <div className="welcome-sheet">
        <header className="welcome-brand"><img src="./logos/kaii-k-a.svg" alt="" /><span>kaii-agent</span><small>桌面 AI 工作台</small></header>
        <section className="welcome-intro">
          <span className="welcome-eyebrow">欢迎使用</span>
          <h1 ref={heading} tabIndex={-1}>把常用的 AI 工作放在一起。</h1>
          <p>在一个窗口里提问、读资料、改文章，也可以把任务交给 Agent。<br />接入你自己的模型账号，聊天和任务记录保存在这台电脑。</p>
        </section>
        <div className="welcome-features" aria-label="主要功能">
          <article><MessageSquareText size={22} /><h2>对话与比较</h2><p>切换模型，把回答并排看。</p></article>
          <article><FileText size={22} /><h2>资料与画布</h2><p>读文件，修改正文，导出成稿。</p></article>
          <article><Layers size={22} /><h2>任务与记录</h2><p>批量处理，定时运行，查看结果。</p></article>
        </div>
        <form className="welcome-setup" onSubmit={(event) => void save(event)}>
          <div className="welcome-setup-title"><h2>接入一个模型</h2><span>任选一家即可</span></div>
          <fieldset className="welcome-services" disabled={saving}>
            <legend className="welcome-sr-only">选择模型服务</legend>
            {services.map((service) => <label key={service.id} className={provider === service.id ? "selected" : ""}>
              <input type="radio" name="welcome-provider" value={service.id} checked={provider === service.id} onChange={() => { setProvider(service.id); setKey(""); setError(null); }} />
              <span><strong>{service.label}</strong><small>{service.company}</small></span>
              {provider === service.id && <Check size={16} aria-hidden="true" />}
            </label>)}
          </fieldset>
          <label className="welcome-key-label" htmlFor="welcome-api-key">{services.find((service) => service.id === provider)?.label} API key</label>
          <div className="welcome-key-row">
            <input id="welcome-api-key" type="password" autoComplete="off" spellCheck={false} value={key} maxLength={400} disabled={saving} placeholder="粘贴你的 API key" aria-describedby="welcome-key-note" aria-invalid={Boolean(error)} onChange={(event) => { setKey(event.target.value); setError(null); }} />
            <button type="submit" className="welcome-primary" disabled={saving}>{saving ? <LoaderCircle size={16} className="spin" /> : <ArrowRight size={16} />} {saving ? "正在保存" : "保存并进入"}</button>
          </div>
          <p id="welcome-key-note" className="welcome-note">Key 保存在本机凭据文件中。调用费用由模型服务商按你的 API 账户计费，使用云端模型时，对话内容会发送给所选服务商。</p>
          {error && <p className="welcome-error" role="alert">{error}</p>}
        </form>
        <footer className="welcome-footer">
          <button type="button" disabled={saving} onClick={onSkip}>先浏览，稍后设置 <ArrowRight size={15} /></button>
          <button type="button" disabled={saving} onClick={onLocalSettings}>配置本机模型</button>
        </footer>
        <p className="welcome-edition">早期版本，持续完善中。欢迎使用，也欢迎一起改进。</p>
      </div>
    </main>
  );
}
