"use client";

import Link from "next/link";
import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  ChatMessage,
  connectLocal,
  discoverProviderModels,
  getLocalConfig,
  LocalConfig,
  LocalSession,
  loadLocalMessages,
  patchLocalConfig,
  sendLocalMessage,
  startLocalSession,
  testLocalProvider,
} from "./chat-api";
import { ApiProblem } from "./live-api";

const DEFAULT_API_URL = "http://127.0.0.1:8787";
type SettingsTab = "persona" | "models" | "memory";
type ProviderSlot = "main" | "background" | "embedding";
type BootFailure = { title: string; detail: string; serviceUnavailable: boolean };

function Glyph({ name, size = 20 }: { name: "settings" | "brain" | "send" | "spark" | "close" | "server" | "check" | "search" | "back"; size?: number }) {
  const paths = {
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    brain: <><path d="M9.6 4.7A3.2 3.2 0 0 0 4.8 7a3.1 3.1 0 0 0 .1 5.7A3.5 3.5 0 0 0 9.6 18V4.7ZM14.4 4.7A3.2 3.2 0 0 1 19.2 7a3.1 3.1 0 0 1-.1 5.7 3.5 3.5 0 0 1-4.7 5.3V4.7Z"/><path d="M7 10h2.6M14.4 8H17m-2.6 5H18M6 15h3.6"/></>,
    send: <><path d="m21 3-7.2 18-4.1-7.7L2 9.2 21 3Z"/><path d="m9.7 13.3 4.8-4.8"/></>,
    spark: <><path d="M12 2.5 13.7 8l5.5 1.7-5.5 1.7L12 17l-1.7-5.6-5.5-1.7L10.3 8 12 2.5Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/></>,
    close: <><path d="m6 6 12 12M18 6 6 18"/></>,
    server: <><rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01M11 7h7M11 17h7"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    back: <><path d="m15 18-6-6 6-6"/><path d="M9 12h11"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{paths[name]}</svg>;
}

function cloneConfig(config: LocalConfig) {
  return JSON.parse(JSON.stringify(config)) as LocalConfig;
}

export function CompanionChat() {
  const [session, setSession] = useState<LocalSession | null>(null);
  const [config, setConfig] = useState<LocalConfig | null>(null);
  const [draft, setDraft] = useState<LocalConfig | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [bootState, setBootState] = useState<"loading" | "ready" | "error">("loading");
  const [bootFailure, setBootFailure] = useState<BootFailure | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("models");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState("");
  const [keys, setKeys] = useState<Record<ProviderSlot, string>>({ main: "", background: "", embedding: "" });
  const [modelLists, setModelLists] = useState<Record<ProviderSlot, string[]>>({ main: [], background: [], embedding: [] });
  const [deepRecall, setDeepRecall] = useState(false);
  const [archiveConsent, setArchiveConsent] = useState(true);
  const [greetingConsent, setGreetingConsent] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  const companionName = config?.persona.companionName ?? "心忆";
  const configured = Boolean(config?.status.configured);
  const totalTokens = useMemo(() => messages.reduce((sum, message) => sum + Number(message.metadata?.inputTokens ?? 0) + Number(message.metadata?.outputTokens ?? 0), 0), [messages]);

  useEffect(() => {
    let cancelled = false;
    async function boot() {
      let lastFailure: unknown = new Error("无法连接本地服务");
      for (let attempt = 0; attempt < 12 && !cancelled; attempt += 1) {
        try {
          const nextSession = await connectLocal(DEFAULT_API_URL);
          const nextConfig = await getLocalConfig(nextSession);
          if (cancelled) return;
          setSession(nextSession);
          setConfig(nextConfig);
          setDraft(cloneConfig(nextConfig));
          setArchiveConsent(nextConfig.features.archiveEnabled);
          setGreetingConsent(nextConfig.features.firstGreetingEnabled);
          if (nextConfig.firstRunComplete) {
            const history = await startLocalSession(nextSession);
            if (!cancelled) setMessages(history.items);
          } else {
            const history = await loadLocalMessages(nextSession);
            if (!cancelled) setMessages(history.items);
            setWelcomeOpen(true);
          }
          if (!cancelled) {
            setBootFailure(null);
            setBootState("ready");
          }
          return;
        } catch (cause) {
          lastFailure = cause;
          if (!isConnectionFailure(cause) || attempt === 11) break;
          await waitFor(Math.min(400 + attempt * 150, 1_200));
        }
      }
      if (cancelled) return;
      setBootFailure(describeBootFailure(lastFailure));
      setBootState("error");
    }
    boot();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  const acceptWelcome = async () => {
    if (!session) return;
    setSettingsBusy(true); setError("");
    try {
      const next = await patchLocalConfig(session, {
        firstRunComplete: true,
        features: { archiveEnabled: archiveConsent, firstGreetingEnabled: greetingConsent },
      });
      setConfig(next); setDraft(cloneConfig(next));
      const history = await startLocalSession(session);
      setMessages(history.items); setWelcomeOpen(false);
      if (!next.status.configured) { setSettingsTab("models"); setSettingsOpen(true); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "首次设置未完成"); }
    finally { setSettingsBusy(false); }
  };

  const openSettings = (tab: SettingsTab = "models") => {
    if (config) setDraft(cloneConfig(config));
    setSettingsNotice(""); setSettingsTab(tab); setSettingsOpen(true);
  };

  const submitMessage = async (event?: FormEvent) => {
    event?.preventDefault();
    const content = text.trim();
    if (!content || !session || sending) return;
    if (!configured) { openSettings("models"); setSettingsNotice("先配置主模型，保存后就可以聊天了。"); return; }
    const clientMessageId = `web_${crypto.randomUUID()}`;
    const optimistic: ChatMessage = { messageId: clientMessageId, role: "user", content, createdAt: new Date().toISOString(), pending: true };
    setMessages((rows) => [...rows, optimistic]); setText(""); setSending(true); setError("");
    try {
      const result = await sendLocalMessage(session, { content, clientMessageId, deepRecall });
      setMessages((rows) => [
        ...rows.map((row) => row.messageId === clientMessageId ? { ...row, messageId: result.userMessageId, pending: false } : row),
        { ...result.assistantMessage, metadata: {
          ...result.assistantMessage.metadata,
          inputTokens: result.recall?.usage?.inputTokens,
          outputTokens: result.recall?.usage?.outputTokens,
          deepRecallTriggered: result.recall?.deepRecall?.triggered,
        } },
      ]);
      setDeepRecall(false);
      const latest = await getLocalConfig(session);
      setConfig(latest);
    } catch (cause) {
      setMessages((rows) => rows.map((row) => row.messageId === clientMessageId ? { ...row, pending: false } : row));
      setError(cause instanceof Error ? cause.message : "消息发送失败");
    } finally { setSending(false); }
  };

  const onComposerKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitMessage(); }
  };

  const patchDraftPersona = (key: keyof LocalConfig["persona"], value: string) => setDraft((current) => current ? ({ ...current, persona: { ...current.persona, [key]: value } }) : current);
  const patchDraftFeature = (key: keyof LocalConfig["features"], value: boolean) => setDraft((current) => current ? ({ ...current, features: { ...current.features, [key]: value } }) : current);
  const patchDraftProvider = (slot: ProviderSlot, key: string, value: unknown) => setDraft((current) => current ? ({ ...current, providers: { ...current.providers, [slot]: { ...current.providers[slot], [key]: value } } }) : current);

  const providerInput = (slot: ProviderSlot) => {
    const provider = draft?.providers[slot];
    return { slot, baseUrl: provider?.baseUrl ?? "", model: provider?.model ?? "", apiKey: keys[slot], ...(slot === "embedding" ? { dimensions: provider?.dimensions } : {}) };
  };

  const discover = async (slot: ProviderSlot) => {
    if (!session) return;
    setSettingsBusy(true); setSettingsNotice("");
    try {
      const result = await discoverProviderModels(session, providerInput(slot));
      setModelLists((current) => ({ ...current, [slot]: result.models }));
      setSettingsNotice(result.models.length ? `已读取 ${result.models.length} 个模型，请直接选择。` : (result.note ?? "未读取到模型，请手动填写。"));
    } catch (cause) { setSettingsNotice(cause instanceof Error ? cause.message : "读取模型失败"); }
    finally { setSettingsBusy(false); }
  };

  const testProvider = async (slot: ProviderSlot) => {
    if (!session) return;
    setSettingsBusy(true); setSettingsNotice("");
    try {
      const result = await testLocalProvider(session, providerInput(slot));
      setSettingsNotice(`连接成功 · ${result.model} · ${result.latencyMs} ms。此次测试可能产生极小费用。`);
    } catch (cause) { setSettingsNotice(cause instanceof Error ? cause.message : "连接测试失败"); }
    finally { setSettingsBusy(false); }
  };

  const saveSettings = async () => {
    if (!session || !draft) return;
    setSettingsBusy(true); setSettingsNotice("");
    try {
      const next = await patchLocalConfig(session, {
        persona: draft.persona,
        providers: {
          main: { baseUrl: draft.providers.main.baseUrl, model: draft.providers.main.model, temperature: draft.providers.main.temperature, maxOutputTokens: draft.providers.main.maxOutputTokens, apiKey: keys.main },
          background: { useMain: draft.providers.background.useMain, baseUrl: draft.providers.background.baseUrl, model: draft.providers.background.model, apiKey: keys.background },
          embedding: { enabled: draft.providers.embedding.enabled, baseUrl: draft.providers.embedding.baseUrl, model: draft.providers.embedding.model, dimensions: draft.providers.embedding.dimensions, apiKey: keys.embedding },
        },
        features: draft.features,
      });
      setConfig(next); setDraft(cloneConfig(next)); setKeys({ main: "", background: "", embedding: "" });
      setSettingsNotice("已安全保存。API Key 不会回传到这个页面。");
    } catch (cause) { setSettingsNotice(cause instanceof Error ? cause.message : "保存失败"); }
    finally { setSettingsBusy(false); }
  };

  if (bootState === "loading") return <main className="companion-shell companion-boot"><div className="boot-orbit"><i/><i/><i/></div><h1>正在唤醒心忆</h1><p>连接本地记忆引擎，不会因为打开页面而调用模型。</p></main>;

  if (bootState === "error") return <main className="companion-shell companion-boot"><span className="brand-gem"><Glyph name="brain"/></span><h1>{bootFailure?.title ?? "暂时无法打开本地体验页"}</h1><p>{bootFailure?.detail ?? "请重新连接。"}</p><div className="boot-help"><strong>{bootFailure?.serviceUnavailable ? "请确认启动窗口仍在运行" : "本地服务已响应，但页面初始化没有完成"}</strong>{bootFailure?.serviceUnavailable ? <><span>macOS：双击启动心忆.command</span><span>Windows：双击启动心忆-Windows.bat</span></> : <><span>先点击“重新连接”；若仍出现，请把上方原始错误发给维护者。</span><span>打开或刷新页面本身不会调用大模型，也不会消耗 Token。</span></>}</div><button onClick={() => location.reload()} className="soft-button">重新连接</button></main>;

  return (
    <main className="companion-shell">
      <header className="chat-header">
        <div className="chat-brand"><span className="brand-gem"><Glyph name="brain" size={22}/></span><div><strong>{companionName}</strong><small><i/>本地测试陪伴空间</small></div></div>
        <div className="test-ribbon"><Glyph name="spark" size={15}/><span>本页用于体验记忆架构</span><em>建议正式项目通过 API 融合</em></div>
        <div className="chat-actions"><Link href="/console" className="header-link"><Glyph name="server" size={18}/><span>记忆后台</span></Link><button onClick={() => openSettings("models")} className="header-button" aria-label="打开设置"><Glyph name="settings" size={19}/><span>设置</span></button></div>
      </header>

      <section className="chat-stage">
        <aside className="memory-rail">
          <div className="rail-card companion-card"><span className="companion-orb">忆<i/></span><strong>{companionName}</strong><p>一段会慢慢长出共同细节的关系。</p><span className={`provider-state ${configured ? "online" : ""}`}><i/>{configured ? "模型已连接" : "等待配置模型"}</span></div>
          <div className="rail-card"><div className="rail-title"><Glyph name="brain" size={17}/><strong>这次聊天会用到</strong></div><dl><div><dt>近期上下文</dt><dd>最近 20 条内按预算裁剪</dd></div><div><dt>长期记忆</dt><dd>程序先检索，命中才注入</dd></div><div><dt>较早摘要</dt><dd>{config?.status.summaryCount ?? 0} 个片段</dd></div><div><dt>普通查看</dt><dd className="free">0 Token</dd></div></dl></div>
          <button className={`deep-recall-card ${deepRecall ? "active" : ""}`} onClick={() => setDeepRecall((value) => !value)}><Glyph name="search"/><span><strong>下条消息深度回忆</strong><small>只在普通召回不够时手动开启</small></span><i/></button>
        </aside>

        <section className="conversation-panel">
          {!configured && <button className="setup-banner" onClick={() => openSettings("models")}><Glyph name="server"/><span><strong>再完成一步就能聊天</strong><small>填写主模型 API、读取模型并保存。只填一套也可以，后台整理会自动共用。</small></span><em>去设置</em></button>}
          <div className="message-list" ref={listRef} aria-live="polite">
            {messages.length === 0 && <div className="empty-conversation"><span className="brand-gem large"><Glyph name="spark" size={28}/></span><h2>一段关系，可以从一句“你好”开始。</h2><p>近期对话、长期记忆和较早摘要会各守各的位置，不需要把全部历史都塞给模型。</p></div>}
            {messages.map((message) => <article className={`chat-message ${message.role} ${message.pending ? "pending" : ""}`} key={message.messageId}><div className="message-avatar">{message.role === "assistant" ? companionName.slice(0, 1) : "你"}</div><div className="message-stack"><div className="message-bubble">{message.content}</div><small>{formatTime(message.createdAt)}{message.metadata?.deepRecallTriggered ? " · 已启动深度回忆" : ""}{message.metadata?.inputTokens ? ` · 本次输入 ${message.metadata.inputTokens} tokens` : ""}</small></div></article>)}
            {sending && <article className="chat-message assistant thinking"><div className="message-avatar">{companionName.slice(0, 1)}</div><div className="message-stack"><div className="message-bubble"><i/><i/><i/></div><small>正在结合人设、近期对话和命中的记忆</small></div></article>}
          </div>
          {error && <div className="chat-error"><span>{error}</span><button onClick={() => setError("")}><Glyph name="close" size={16}/></button></div>}
          <form className="composer" onSubmit={submitMessage}>
            <textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onComposerKey} placeholder={configured ? `和${companionName}说点什么…` : "请先在设置中连接主模型"} rows={1} disabled={!configured || sending}/>
            <div className="composer-foot"><span>{deepRecall ? "深度回忆将在下条消息临时开启" : "Enter 发送 · Shift + Enter 换行"}</span><button type="submit" disabled={!text.trim() || !configured || sending} aria-label="发送消息"><Glyph name="send" size={19}/></button></div>
          </form>
          <footer className="chat-footnote"><span>本地存储 · 密钥不进入浏览器</span><span>本次页面累计显示 {totalTokens.toLocaleString()} Tokens</span></footer>
        </section>
      </section>

      {welcomeOpen && <div className="modal-layer"><section className="welcome-modal" role="dialog" aria-modal="true" aria-labelledby="welcome-title"><span className="welcome-mark"><Glyph name="spark" size={28}/></span><div className="modal-kicker">开始之前，先说清楚</div><h1 id="welcome-title">这是记忆架构的本地体验页。</h1><p className="welcome-lead">它让没有现成网站或 APP 的人也能直接聊天、观察记忆是否真的生效；项目真正的核心仍是可迁移的记忆后端，你可以把它接进自己的产品。</p><div className="welcome-points"><div><span>01</span><p><strong>聊天会保存在你的电脑</strong>默认保留较早原话，才能查看证据和使用深度回忆；你可以关闭。</p></div><div><span>02</span><p><strong>调用模型才会产生 Token</strong>浏览记忆、修改人设和程序检索不调用模型；测试 API 会产生一次极小调用。</p></div><div><span>03</span><p><strong>不是公开商用前端</strong>对外服务前，请把后端接入你自己的账号、鉴权、支付和 APP/网页前端。</p></div></div><label className="consent-line"><input type="checkbox" checked={archiveConsent} onChange={(event) => setArchiveConsent(event.target.checked)}/><span><strong>在本机保留较早聊天原话</strong><small>用于证据查看和深度回忆，不会因此额外消耗 Token。</small></span></label><label className="consent-line"><input type="checkbox" checked={greetingConsent} onChange={(event) => setGreetingConsent(event.target.checked)}/><span><strong>允许伴侣先发第一条站内欢迎</strong><small>使用固定模板，0 Token；以后可在设置里关闭。</small></span></label><button className="welcome-primary" onClick={acceptWelcome} disabled={settingsBusy}>{settingsBusy ? "正在准备…" : "我明白了，进入体验"}</button><small className="welcome-legal">点击进入仅代表保存本机体验设置，不会授权站外主动消息。</small></section></div>}

      {settingsOpen && draft && <div className="drawer-layer"><button className="drawer-scrim" onClick={() => setSettingsOpen(false)} aria-label="关闭设置"/><aside className="settings-drawer" role="dialog" aria-modal="true" aria-label="伴侣与模型设置"><header><div><span>LOCAL COMPANION</span><h2>设置</h2></div><button onClick={() => setSettingsOpen(false)} aria-label="关闭"><Glyph name="close"/></button></header><nav><button className={settingsTab === "persona" ? "active" : ""} onClick={() => setSettingsTab("persona")}>伴侣人设</button><button className={settingsTab === "models" ? "active" : ""} onClick={() => setSettingsTab("models")}>模型 API</button><button className={settingsTab === "memory" ? "active" : ""} onClick={() => setSettingsTab("memory")}>记忆与主动消息</button></nav><div className="drawer-content">
        {settingsTab === "persona" && <section className="settings-section"><div className="section-intro"><h3>默认人设可以改，安全边界不能被覆盖。</h3><p>下面是从你提供的角色原稿中提炼出的可编辑部分。防止欺骗、控制和伪造能力的规则由系统单独锁定。</p></div><Field label="伴侣名字"><input value={draft.persona.companionName} onChange={(event) => patchDraftPersona("companionName", event.target.value)}/></Field><Field label="核心性格"><textarea rows={5} value={draft.persona.personaTraits} onChange={(event) => patchDraftPersona("personaTraits", event.target.value)}/></Field><Field label="关系表达"><textarea rows={6} value={draft.persona.relationshipStyle} onChange={(event) => patchDraftPersona("relationshipStyle", event.target.value)}/></Field><Field label="说话方式"><textarea rows={6} value={draft.persona.voiceRules} onChange={(event) => patchDraftPersona("voiceRules", event.target.value)}/></Field><Field label="第一条欢迎"><textarea rows={4} value={draft.persona.firstGreeting} onChange={(event) => patchDraftPersona("firstGreeting", event.target.value)}/></Field><Field label="能力透明原则"><textarea rows={4} value={draft.persona.transparencyRule} onChange={(event) => patchDraftPersona("transparencyRule", event.target.value)}/></Field></section>}
        {settingsTab === "models" && <section className="settings-section"><div className="section-intro"><h3>只填主模型，也能完整运行。</h3><p>后台整理默认共用主模型。只有想分开计费或使用更便宜的小模型时，才配置第二套。Embedding 是可选增强，不填就使用免费的程序检索。</p></div><ProviderEditor slot="main" title="主模型 · 负责聊天" provider={draft.providers.main} apiKey={keys.main} models={modelLists.main} busy={settingsBusy} onKey={(value) => setKeys((current) => ({ ...current, main: value }))} onChange={(key, value) => patchDraftProvider("main", key, value)} onDiscover={() => discover("main")} onTest={() => testProvider("main")}/><div className="provider-block"><div className="provider-heading"><span className="provider-number">02</span><div><strong>后台整理模型</strong><small>提取零散记忆、生成滚动摘要</small></div></div><SwitchLine label="直接共用主模型" note="推荐新手开启；无需重复填写 API" checked={Boolean(draft.providers.background.useMain)} onChange={(value) => patchDraftProvider("background", "useMain", value)}/>{!draft.providers.background.useMain && <ProviderFields slot="background" provider={draft.providers.background} apiKey={keys.background} models={modelLists.background} busy={settingsBusy} onKey={(value) => setKeys((current) => ({ ...current, background: value }))} onChange={(key, value) => patchDraftProvider("background", key, value)} onDiscover={() => discover("background")} onTest={() => testProvider("background")}/>}</div><div className="provider-block"><div className="provider-heading"><span className="provider-number">03</span><div><strong>Embedding · 可选增强</strong><small>把文字转换成数字向量，帮助理解近义表达</small></div></div><SwitchLine label="启用外部 Embedding" note="不启用时自动使用本机关键词与全文检索" checked={Boolean(draft.providers.embedding.enabled)} onChange={(value) => { patchDraftProvider("embedding", "enabled", value); patchDraftFeature("externalEmbeddingConsent", value); }}/>{draft.providers.embedding.enabled && <><div className="embedding-warning">开启后，获准的记忆文本和每次查询会发送给你配置的 Embedding 平台。它不会偷偷共用聊天模型。</div><ProviderFields slot="embedding" provider={draft.providers.embedding} apiKey={keys.embedding} models={modelLists.embedding} busy={settingsBusy} onKey={(value) => setKeys((current) => ({ ...current, embedding: value }))} onChange={(key, value) => patchDraftProvider("embedding", key, value)} onDiscover={() => discover("embedding")} onTest={() => testProvider("embedding")}/></>}</div></section>}
        {settingsTab === "memory" && <section className="settings-section"><div className="section-intro"><h3>每项能力都能单独关闭。</h3><p>开关只决定程序是否运行，并不会靠修改人设来偷偷获得权限。</p></div><div className="switch-list"><SwitchLine label="长期记忆" note="保存可查看、可纠正、可删除的记忆 Claim" checked={draft.features.memoryEnabled} onChange={(value) => patchDraftFeature("memoryEnabled", value)}/><SwitchLine label="自动整理零散信息" note="明确说“记住”时立即排队；普通聊天达到阈值后批量处理" checked={draft.features.autoExtractionEnabled} onChange={(value) => patchDraftFeature("autoExtractionEnabled", value)}/><SwitchLine label="较早聊天滚动摘要" note="达到消息数或 Token 阈值才调用后台模型" checked={draft.features.rollingSummaryEnabled} onChange={(value) => patchDraftFeature("rollingSummaryEnabled", value)}/><SwitchLine label="表达偏好自动适配" note="只采纳“以后短一点”等直接要求，不改核心人设，60 天可自然过期" checked={draft.features.adaptiveProfileEnabled} onChange={(value) => patchDraftFeature("adaptiveProfileEnabled", value)}/><SwitchLine label="本机原话归档" note="支持证据查看和深度回忆；存储不消耗模型 Token" checked={draft.features.archiveEnabled} onChange={(value) => patchDraftFeature("archiveEnabled", value)}/><SwitchLine label="深度回忆保险" note="用户质疑遗忘或手动开启时，限定扫描较早记录" checked={draft.features.deepRecallEnabled} onChange={(value) => patchDraftFeature("deepRecallEnabled", value)}/><SwitchLine label="首次站内欢迎" note="允许伴侣发送第一条模板消息，0 Token" checked={draft.features.firstGreetingEnabled} onChange={(value) => patchDraftFeature("firstGreetingEnabled", value)}/><SwitchLine label="关系型主动消息" note="预留开关；默认关闭，当前测试页不会站外发送" checked={draft.features.relationshipProactiveEnabled} onChange={(value) => patchDraftFeature("relationshipProactiveEnabled", value)}/></div><div className="memory-status-grid"><div><span>已生成摘要</span><strong>{config?.status.summaryCount ?? 0}</strong></div><div><span>待用户确认候选</span><strong>{config?.status.pendingCandidateCount ?? 0}</strong></div><div><span>当前召回路径</span><strong>{config?.status.retrievalMode === "program_and_embedding" ? "程序 + Embedding" : "仅程序"}</strong></div></div></section>}
      </div>{settingsNotice && <div className="settings-notice">{settingsNotice}</div>}<footer><button className="drawer-secondary" onClick={() => setSettingsOpen(false)}>取消</button><button className="drawer-primary" onClick={saveSettings} disabled={settingsBusy}>{settingsBusy ? "处理中…" : "保存设置"}</button></footer></aside></div>}
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="settings-field"><span>{label}</span>{children}</label>;
}

function SwitchLine({ label, note, checked, onChange }: { label: string; note: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="switch-line"><span><strong>{label}</strong><small>{note}</small></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)}/><i/></label>;
}

function ProviderEditor(props: Omit<Parameters<typeof ProviderFields>[0], "slot"> & { slot: ProviderSlot; title: string }) {
  return <div className="provider-block"><div className="provider-heading"><span className="provider-number">01</span><div><strong>{props.title}</strong><small>每次生成伴侣回复时调用</small></div></div><ProviderFields {...props}/></div>;
}

function ProviderFields({ slot, provider, apiKey, models, busy, onKey, onChange, onDiscover, onTest }: { slot: ProviderSlot; provider: LocalConfig["providers"][ProviderSlot]; apiKey: string; models: string[]; busy: boolean; onKey: (value: string) => void; onChange: (key: string, value: unknown) => void; onDiscover: () => void; onTest: () => void; title?: string }) {
  const keyPlaceholder = provider.apiKeySet ? "已安全保存；不修改可留空" : "填写平台提供的 API Key";
  return <div className="provider-fields"><Field label="API 根地址"><input value={provider.baseUrl} onChange={(event) => onChange("baseUrl", event.target.value)} placeholder="https://平台地址/v1"/></Field><Field label="API Key"><input type="password" autoComplete="off" value={apiKey} onChange={(event) => onKey(event.target.value)} placeholder={keyPlaceholder}/></Field><div className="model-row"><Field label="模型"><input list={`models-${slot}`} value={provider.model} onChange={(event) => onChange("model", event.target.value)} placeholder="先读取列表，或手动填写"/><datalist id={`models-${slot}`}>{models.map((model) => <option value={model} key={model}/>)}</datalist></Field><button type="button" onClick={onDiscover} disabled={busy}><Glyph name="search" size={16}/>读取模型</button></div>{slot === "embedding" && <Field label="向量维度（通常留空）"><input inputMode="numeric" value={provider.dimensions ?? ""} onChange={(event) => onChange("dimensions", event.target.value ? Number(event.target.value) : null)} placeholder="由平台默认决定"/></Field>}{slot === "main" && <div className="model-tuning"><Field label="温度 0—2"><input type="number" min="0" max="2" step="0.05" value={provider.temperature ?? 0.85} onChange={(event) => onChange("temperature", Number(event.target.value))}/></Field><Field label="最大输出 Token"><input type="number" min="64" max="8192" step="64" value={provider.maxOutputTokens ?? 900} onChange={(event) => onChange("maxOutputTokens", Number(event.target.value))}/></Field></div>}<button type="button" className="test-provider" onClick={onTest} disabled={busy || !provider.model}><Glyph name="check" size={16}/>测试连通性（会产生一次极小调用）</button></div>;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function isConnectionFailure(cause: unknown) {
  if (cause instanceof ApiProblem) return false;
  return cause instanceof TypeError || (cause instanceof Error && /fetch|network|connection|ECONNREFUSED/i.test(cause.message));
}

function describeBootFailure(cause: unknown): BootFailure {
  if (cause instanceof ApiProblem) {
    if (cause.code === "ORIGIN_FORBIDDEN") return {
      title: "当前浏览器地址未被本地服务允许",
      detail: "请使用启动窗口自动打开的地址，或重新启动新版心忆。",
      serviceUnavailable: false,
    };
    return {
      title: "本地服务已启动，但页面初始化失败",
      detail: cause.message,
      serviceUnavailable: false,
    };
  }
  return {
    title: "暂时无法连接本地服务",
    detail: cause instanceof Error ? cause.message : "连接请求失败",
    serviceUnavailable: true,
  };
}

function waitFor(milliseconds: number) {
  return new Promise((resolvePromise) => window.setTimeout(resolvePromise, milliseconds));
}
