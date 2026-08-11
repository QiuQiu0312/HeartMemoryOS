"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  ApiMemory,
  ApiMemoryDetail,
  LiveConnection,
  LiveSnapshot,
  loadLiveSnapshot,
  mintLocalDemoToken,
  normalizeApiUrl,
  requestApi,
} from "./live-api";

type ViewId =
  | "overview"
  | "memories"
  | "timeline"
  | "recall"
  | "prompts"
  | "proactive"
  | "privacy"
  | "jobs"
  | "quality";

type IconName =
  | "grid"
  | "brain"
  | "timeline"
  | "search"
  | "prompt"
  | "message"
  | "shield"
  | "jobs"
  | "chart"
  | "settings"
  | "chevron"
  | "sparkle"
  | "bell"
  | "plus"
  | "more"
  | "check"
  | "clock"
  | "database"
  | "arrow"
  | "filter"
  | "close"
  | "external"
  | "lock"
  | "download"
  | "trash"
  | "play";

const nav: Array<{ label?: string; items: Array<{ id: ViewId; label: string; icon: IconName; badge?: string }> }> = [
  {
    items: [
      { id: "overview", label: "运行总览", icon: "grid" },
      { id: "memories", label: "记忆中心", icon: "brain", badge: "6" },
      { id: "timeline", label: "关系时间线", icon: "timeline" },
    ],
  },
  {
    label: "调试与运营",
    items: [
      { id: "recall", label: "召回调试器", icon: "search" },
      { id: "prompts", label: "提示词注册中心", icon: "prompt" },
      { id: "proactive", label: "主动消息与提醒", icon: "message" },
    ],
  },
  {
    label: "系统治理",
    items: [
      { id: "privacy", label: "隐私与数据迁移", icon: "shield" },
      { id: "jobs", label: "任务与故障队列", icon: "jobs", badge: "2" },
      { id: "quality", label: "成本与质量", icon: "chart" },
    ],
  },
];

type ConsoleMemory = {
  id: string;
  title: string;
  detail: string;
  kind: string;
  status: string;
  statusTone: string;
  time: string;
  source: string;
  realm: string;
  confidence: string;
  evidence: string[];
  revision?: number;
};

const demoMemories: ConsoleMemory[] = [
  {
    id: "mem_01JQ8D",
    title: "更喜欢简短、自然的回应",
    detail: "用户在最近 14 天内 4 次表达，希望聊天少一点分析感，多一点自然回应。",
    kind: "交流偏好",
    status: "用户已确认",
    statusTone: "green",
    time: "今天 14:32",
    source: "4 条直接表达",
    realm: "现实",
    confidence: "高",
    evidence: [
      "今天 14:31 · ‘你不用每次都分析这么多，短一点就好。’",
      "8 月 2 日 22:14 · ‘像平时聊天那样回复我就行。’",
      "7 月 29 日 18:46 · ‘别写小作文啦。’",
    ],
  },
  {
    id: "mem_01JQ72",
    title: "周五晚上准备和小林吃火锅",
    detail: "一次性未来事件；结束后会自动过期，不会永久污染长期画像。",
    kind: "临时计划",
    status: "待发生",
    statusTone: "amber",
    time: "今天 12:08",
    source: "1 条明确陈述",
    realm: "现实",
    confidence: "高",
    evidence: ["今天 12:08 · ‘这周五晚上我跟小林约了去吃火锅。’"],
  },
  {
    id: "mem_01JPZF",
    title: "不喜欢在公开场合被叫‘宝宝’",
    detail: "称呼边界。仅在私聊关系域中允许使用亲昵称呼。",
    kind: "关系边界",
    status: "用户已确认",
    statusTone: "green",
    time: "8 月 5 日 20:19",
    source: "用户纠正",
    realm: "关系设定",
    confidence: "最高",
    evidence: [
      "8 月 5 日 20:19 · ‘私下叫可以，在别人面前不要这样叫我。’",
      "已替代旧版本：任何场景都喜欢亲昵称呼。",
    ],
  },
  {
    id: "mem_01JPF4",
    title: "最近在为换工作犹豫",
    detail: "短期动态状态，14 天后若没有新证据会自然衰减，不作为永久人格标签。",
    kind: "近期状态",
    status: "系统推断",
    statusTone: "violet",
    time: "8 月 3 日 23:42",
    source: "3 段对话",
    realm: "现实",
    confidence: "中",
    evidence: [
      "8 月 3 日 23:40 · ‘新公司的机会不错，但我又舍不得现在的团队。’",
      "8 月 1 日 19:22 · ‘我还没想好要不要走。’",
    ],
  },
];

const promptRows = [
  { name: "核心人格与关系契约", key: "core-persona", version: "v2", state: "已启用", changed: "随项目发布", cost: "稳定缓存前缀" },
  { name: "主聊天行为策略", key: "main-chat-policy", version: "v2", state: "已启用", changed: "随项目发布", cost: "主模型每回合" },
  { name: "长期记忆候选抽取", key: "memory-extraction", version: "v2", state: "按开关运行", changed: "达到阈值", cost: "小模型 · 批处理" },
  { name: "会话片段摘要", key: "segment-summary", version: "v2", state: "按开关运行", changed: "达到阈值", cost: "小模型 · 按阈值" },
  { name: "深度回忆兜底", key: "deep-recall", version: "v2", state: "按需调用", changed: "用户触发", cost: "默认不调用" },
  { name: "表达偏好适配建议", key: "adaptive-profile", version: "v2", state: "默认关闭", changed: "周期任务", cost: "小模型 · 周期批处理" },
  { name: "主动消息生成", key: "proactive-message", version: "v2", state: "默认关闭", changed: "调度触发", cost: "独立授权后" },
  { name: "输出安全复核", key: "safety-review", version: "v2", state: "已启用", changed: "风险触发", cost: "按风险路由" },
];

function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  const paths: Record<IconName, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/></>,
    brain: <><path d="M9.5 4.5A3 3 0 0 0 4.7 7a3 3 0 0 0 .2 5.6A3.4 3.4 0 0 0 9.5 18"/><path d="M14.5 4.5A3 3 0 0 1 19.3 7a3 3 0 0 1-.2 5.6 3.4 3.4 0 0 1-4.6 5.4M9.5 4.5v15M14.5 4.5v15M7 9.5h2.5M14.5 8H17m-2.5 5H18M6 15h3.5"/></>,
    timeline: <><path d="M5 4v16M5 7h6l2 3h6M5 15h5l2-3"/><circle cx="5" cy="7" r="2"/><circle cx="5" cy="15" r="2"/><circle cx="19" cy="10" r="2"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    prompt: <><path d="M5 3h11l3 3v15H5z"/><path d="M9 9h6M9 13h6M9 17h4M16 3v4h4"/></>,
    message: <><path d="M20 14a4 4 0 0 1-4 4H8l-5 3 1.7-5A7 7 0 0 1 3 11a8 8 0 0 1 8-8h1a8 8 0 0 1 8 8z"/><path d="M8 10h8M8 14h5"/></>,
    shield: <><path d="M12 3 4.5 6v5.6c0 4.4 3 7.4 7.5 9.4 4.5-2 7.5-5 7.5-9.4V6z"/><path d="m9 12 2 2 4-5"/></>,
    jobs: <><rect x="3" y="5" width="18" height="15" rx="3"/><path d="M8 5V3h8v2M3 10h18M8 14h3"/></>,
    chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20V7"/><path d="M2 20h21"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    sparkle: <><path d="m12 3 1.3 3.7L17 8l-3.7 1.3L12 13l-1.3-3.7L7 8l3.7-1.3zM19 14l.7 2.3L22 17l-2.3.7L19 20l-.7-2.3L16 17l2.3-.7zM5 14l.7 1.3L7 16l-1.3.7L5 18l-.7-1.3L3 16l1.3-.7z"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    more: <><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="12" cy="12" r="1" fill="currentColor"/><circle cx="19" cy="12" r="1" fill="currentColor"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7"/></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
    filter: <path d="M4 6h16M7 12h10M10 18h4"/>,
    close: <path d="M6 6l12 12M18 6 6 18"/>,
    external: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6H5V6h6"/></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></>,
    download: <><path d="M12 3v12M7 10l5 5 5-5M4 21h16"/></>,
    trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></>,
    play: <path d="m8 5 11 7-11 7z"/>,
  };
  return <svg {...common}>{paths[name]}</svg>;
}

function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: string }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

function Toggle({ on, onChange, label, disabled = false }: { on: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" className={`toggle ${on ? "toggle-on" : ""}`} onClick={onChange} aria-pressed={on} aria-label={label} disabled={disabled}>
      <span />
    </button>
  );
}

function MetricCard({ label, value, note, tone, icon }: { label: string; value: string; note: string; tone: string; icon: IconName }) {
  return (
    <article className="metric-card">
      <div className={`metric-icon metric-${tone}`}><Icon name={icon} size={19}/></div>
      <div className="metric-copy">
        <p>{label}</p>
        <strong>{value}</strong>
        <span>{note}</span>
      </div>
    </article>
  );
}

function mapApiMemory(memory: ApiMemory): ConsoleMemory {
  const kindLabels: Record<string, string> = {
    identity: "身份事实", preference: "偏好", boundary: "关系边界", relationship: "关系记忆",
    event: "事件", commitment: "承诺", routine: "日常习惯", goal: "目标", temporary: "临时计划",
    communication_style: "交流偏好",
  };
  const realmLabels: Record<string, string> = {
    real_world: "现实", relationship_canon: "关系设定", roleplay: "角色扮演", fictional: "虚构",
    hypothetical: "假设", quoted: "转述", unknown: "未确定",
  };
  const confidenceLabels: Record<string, string> = { explicit: "明确", high: "高", medium: "中", low: "低" };
  const kind = kindLabels[memory.memoryType] ?? memory.memoryType;
  const status = memory.status === "active" ? "有效" : "历史版本";
  const recorded = memory.recordedAt ? new Date(memory.recordedAt) : null;
  return {
    id: memory.memoryId,
    title: memory.text,
    detail: `由 API 返回的${kind}；敏感度 ${memory.sensitivity}，版本 v${memory.revision}。`,
    kind,
    status,
    statusTone: memory.status === "active" ? "green" : "neutral",
    time: recorded && !Number.isNaN(recorded.valueOf()) ? new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(recorded) : "时间未知",
    source: memory.epistemicBasis === "explicit_memory_request" ? "用户显式记忆" : memory.epistemicBasis,
    realm: realmLabels[memory.realm] ?? memory.realm,
    confidence: confidenceLabels[memory.confidenceBand] ?? memory.confidenceBand,
    evidence: [],
    revision: memory.revision,
  };
}

function formatDateTime(value?: string) {
  if (!value) return "时间未定";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function Overview({ go, items, live }: { go: (view: ViewId) => void; items: ConsoleMemory[]; live: LiveSnapshot | null }) {
  const granted = live?.consents.filter((item) => item.granted).length ?? 0;
  const scheduled = live?.proactiveEvents.filter((item) => item.state === "scheduled").length ?? 0;
  const enabledCategories = live ? [live.proactiveSettings.transactionalEnabled, live.proactiveSettings.onboardingEnabled, live.proactiveSettings.relationshipEnabled, live.proactiveSettings.marketingEnabled].filter(Boolean).length : 0;
  const pipeline = live ? [
    ["权威记忆", String(items.length), "当前作用域", "brain"],
    ["有效授权", String(granted), "分用途记录", "shield"],
    ["主动类别", String(enabledCategories), "用户设置开启", "settings"],
    ["计划事件", String(scheduled), "调度库记录", "clock"],
  ] : [
    ["对话进入", "1,284", "写前隐私检查", "shield"],
    ["程序筛选", "218", "高信号片段", "filter"],
    ["候选抽取", "34", "小模型批处理", "sparkle"],
    ["可信记忆", "11", "证据与规则校验", "brain"],
  ];
  const nextEvent = live?.proactiveEvents.find((event) => event.state === "scheduled");
  return (
    <div className="view-stack">
      <section className="hero-row">
        <div>
          <div className="eyebrow"><span className="live-dot" /> {live ? `已连接 API ${live.health.version ?? ""}` : "演示数据模式"}</div>
          <h1>下午好，记忆正在安静地工作。</h1>
          <p>{live ? `刚刚从当前用户与关系作用域读取了 ${items.length} 条记忆；这次后台查看没有调用模型。` : "下方指标是用于讲解完整产品的演示数据，不是真实运营统计。"}</p>
        </div>
        <div className="hero-actions">
          <button className="button secondary" onClick={() => go("recall")}><Icon name="search"/>测试一次召回</button>
          <button className="button primary" onClick={() => go("memories")}><Icon name="plus"/>查看记忆</button>
        </div>
      </section>

      <section className="metric-grid">
        {live ? <>
          <MetricCard label="当前记忆" value={String(items.length)} note="限当前令牌作用域" tone="rose" icon="brain" />
          <MetricCard label="已授权用途" value={String(granted)} note={`共 ${live.consents.length} 项用途有记录`} tone="gold" icon="shield" />
          <MetricCard label="后台查看模型调用" value="0" note="只读数据库/API" tone="violet" icon="sparkle" />
          <MetricCard label="计划中主动事件" value={String(scheduled)} note="发送前仍会复核授权" tone="blue" icon="clock" />
        </> : <>
          <MetricCard label="记忆连续性" value="96.8%" note="演示指标" tone="rose" icon="brain" />
          <MetricCard label="上下文节省" value="84.2%" note="演示指标" tone="gold" icon="chart" />
          <MetricCard label="今日额外模型调用" value="3" note="演示指标" tone="violet" icon="sparkle" />
          <MetricCard label="待处理候选" value="6" note="演示指标" tone="blue" icon="jobs" />
        </>}
      </section>

      <section className="dashboard-grid">
        <article className="panel panel-wide">
          <header className="panel-header">
            <div><h2>{live ? "当前作用域快照" : "记忆流水线"}</h2><p>{live ? "实时 API 中可验证的权威状态。" : "从一句话到可信记忆，每一步都可以追踪。"}</p></div>
            <Badge tone={live ? "blue" : "neutral"}>{live ? "实时" : "演示"}</Badge>
          </header>
          <div className="pipeline">
            {pipeline.map(([title, value, desc, icon], index) => (
              <div className="pipeline-wrap" key={title}>
                <div className="pipeline-stage">
                  <div className="pipeline-icon"><Icon name={icon as IconName}/></div>
                  <strong>{value}</strong><span>{title}</span><small>{desc}</small>
                </div>
                {index < 3 && <div className="pipeline-arrow"><Icon name="arrow"/></div>}
              </div>
            ))}
          </div>
          <div className="panel-footnote"><Icon name="sparkle" size={15}/><span>{live ? "这些读取由普通 API 和程序完成，不会唤醒聊天模型。" : "理想运行时只让高信号片段进入候选抽取；寒暄、表情和普通闲聊不唤醒记忆模型。"}</span></div>
        </article>

        <article className="panel cost-panel">
          <header className="panel-header"><div><h2>{live ? "后台读取成本" : "本月 Token 预算（演示）"}</h2><p>{live ? "不调用模型，只有常规服务器成本" : "¥ 86.20 / ¥ 200.00"}</p></div><button className="icon-button" aria-label="更多"><Icon name="more"/></button></header>
          <div className="donut-wrap">
            <div className={`donut ${live ? "donut-live" : ""}`}><div><strong>{live ? "0" : "43%"}</strong><span>{live ? "模型调用" : "已使用"}</span></div></div>
            <div className="legend">
              {live ? <>
                <div><i className="legend-main"/><span>记忆 API</span><strong>{items.length} 条</strong></div>
                <div><i className="legend-small"/><span>授权 API</span><strong>{live.consents.length} 条</strong></div>
                <div><i className="legend-embed"/><span>主动事件 API</span><strong>{live.proactiveEvents.length} 条</strong></div>
                <div><i className="legend-deep"/><span>Token</span><strong>0</strong></div>
              </> : <>
                <div><i className="legend-main"/><span>主聊天</span><strong>62.4%</strong></div>
                <div><i className="legend-small"/><span>小模型整理</span><strong>21.7%</strong></div>
                <div><i className="legend-embed"/><span>Embedding</span><strong>9.8%</strong></div>
                <div><i className="legend-deep"/><span>深度回忆</span><strong>6.1%</strong></div>
              </>}
            </div>
          </div>
          <button className="text-button" onClick={() => go("quality")}>查看完整成本明细 <Icon name="chevron" size={15}/></button>
        </article>
      </section>

      <section className="dashboard-grid lower-grid">
        <article className="panel panel-wide">
          <header className="panel-header"><div><h2>最近形成的记忆</h2><p>所有内容均可回到原始证据。</p></div><button className="text-button" onClick={() => go("memories")}>全部记忆 <Icon name="chevron" size={15}/></button></header>
          <div className="memory-mini-list">
            {items.slice(0, 3).map((memory) => (
              <button className="memory-mini" key={memory.id} onClick={() => go("memories")}>
                <span className={`memory-type type-${memory.statusTone}`}><Icon name={memory.kind === "临时计划" ? "clock" : memory.kind === "关系边界" ? "shield" : "brain"}/></span>
                <span className="memory-mini-main"><strong>{memory.title}</strong><small>{memory.kind} · {memory.source}</small></span>
                <Badge tone={memory.statusTone}>{memory.status}</Badge>
                <span className="memory-time">{memory.time}</span>
                <Icon name="chevron" size={16}/>
              </button>
            ))}
          </div>
        </article>

        <article className="panel proactive-card">
          <header className="panel-header"><div><h2>下一次主动联系</h2><p>由用户明确设置的提醒</p></div><span className="calendar-chip">{nextEvent ? "API" : "09"}<small>{live ? "实时" : "周日"}</small></span></header>
          <div className="next-message">
            <div className="next-message-icon"><Icon name="bell"/></div>
            <div><strong>{nextEvent ? formatDateTime(nextEvent.schedule.dueAtUtc) : live ? "暂无计划中事件" : "07:30 · 起床提醒"}</strong><p>“{nextEvent?.summary ?? (live ? "只有授权且开启后才会发送。" : "早安，别忘了今天九点的面试。")}”</p></div>
          </div>
          <div className="policy-line"><span><Icon name="shield" size={15}/> 可穿过勿扰时段</span><span><Icon name="check" size={15}/> 用户已授权</span></div>
          <button className="text-button" onClick={() => go("proactive")}>管理主动消息 <Icon name="chevron" size={15}/></button>
        </article>
      </section>
    </div>
  );
}

function MemoryCenter({ items, connection }: { items: ConsoleMemory[]; connection: LiveConnection | null }) {
  const [selectedId, setSelectedId] = useState(items[0]?.id ?? "");
  const [tab, setTab] = useState("全部");
  const [search, setSearch] = useState("");
  const [detailResult, setDetailResult] = useState<{ id: string; data: ApiMemoryDetail | null; error: boolean } | null>(null);
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;
  useEffect(() => {
    if (!connection || !selected) return;
    let cancelled = false;
    requestApi<ApiMemoryDetail>(connection.apiUrl, `/v2/memories/${encodeURIComponent(selected.id)}`, connection.token)
      .then((value) => { if (!cancelled) setDetailResult({ id: selected.id, data: value, error: false }); })
      .catch(() => { if (!cancelled) setDetailResult({ id: selected.id, data: null, error: true }); });
    return () => { cancelled = true; };
  }, [connection, selected]);
  const currentDetail = connection && selected && detailResult?.id === selected.id ? detailResult : null;
  const detail = currentDetail?.data ?? null;
  const detailState: "idle" | "loading" | "error" = !connection ? "idle" : currentDetail?.error ? "error" : currentDetail?.data ? "idle" : "loading";
  const shown = items.filter((memory) => {
    const categoryMatch = tab === "全部" || (tab === "待确认" ? memory.status === "系统推断" : memory.kind === tab);
    const query = search.trim().toLocaleLowerCase("zh-CN");
    return categoryMatch && (!query || `${memory.title} ${memory.detail} ${memory.kind} ${memory.realm}`.toLocaleLowerCase("zh-CN").includes(query));
  });
  const evidence = connection ? (detail?.evidence.map((item) => item.excerpt ?? `证据 ${item.evidenceId} 已不可用`) ?? []) : (selected?.evidence ?? []);
  return (
    <div className="view-stack">
      <section className="page-title-row">
        <div><div className="eyebrow">MEMORY CENTER</div><h1>它记得什么，都由你看得见。</h1><p>每条记忆都有来源、适用范围、有效时间和纠正历史。</p></div>
        <button className="button primary" disabled={Boolean(connection)} title={connection ? "实时连接默认只读；写入请通过应用的授权流程。" : undefined}><Icon name={connection ? "lock" : "plus"}/>{connection ? "实时只读" : "手动添加记忆"}</button>
      </section>
      <section className="memory-layout">
        <div className="memory-browser panel">
          <div className="toolbar">
            <div className="search-box"><Icon name="search"/><input value={search} onChange={(event) => setSearch(event.target.value)} aria-label="搜索记忆" placeholder="搜索内容、人物、日期或来源…"/></div>
            <button className="button compact secondary"><Icon name="filter"/>筛选</button>
          </div>
          <div className="tabs" role="tablist">
            {["全部", "待确认", "交流偏好", "关系边界", "临时计划"].map((item) => <button key={item} role="tab" aria-selected={tab === item} onClick={() => setTab(item)}>{item}{item === "待确认" && <span>{items.filter((memory) => memory.status === "系统推断").length}</span>}</button>)}
          </div>
          <div className="memory-list">
            {shown.map((memory) => (
              <button className={`memory-row ${selected?.id === memory.id ? "selected" : ""}`} key={memory.id} onClick={() => setSelectedId(memory.id)}>
                <span className={`memory-type type-${memory.statusTone}`}><Icon name={memory.kind === "临时计划" ? "clock" : memory.kind === "关系边界" ? "shield" : "brain"}/></span>
                <span className="memory-row-body"><span className="memory-row-top"><strong>{memory.title}</strong><time>{memory.time}</time></span><small>{memory.detail}</small><span className="memory-meta"><Badge tone={memory.statusTone}>{memory.status}</Badge><em>{memory.kind}</em><em>{memory.realm}</em><em>{memory.source}</em></span></span>
              </button>
            ))}
            {shown.length === 0 && <div className="empty-state"><Icon name="brain" size={32}/><strong>这个分类还没有记忆</strong><span>新的可信内容会在这里出现。</span></div>}
          </div>
        </div>
        {selected ? <aside className="memory-detail panel">
          <header className="detail-header"><div><Badge tone={selected.statusTone}>{selected.status}</Badge><h2>{selected.title}</h2><code>{selected.id}</code></div><button className="icon-button" aria-label="关闭详情"><Icon name="close"/></button></header>
          <p className="detail-description">{selected.detail}</p>
          <dl className="detail-grid">
            <div><dt>记忆类型</dt><dd>{selected.kind}</dd></div><div><dt>所属世界</dt><dd>{selected.realm}</dd></div><div><dt>可信等级</dt><dd>{selected.confidence}</dd></div><div><dt>当前状态</dt><dd>{selected.status}</dd></div>
          </dl>
          <section className="evidence-section">
            <div className="section-label"><span>证据链</span><Badge tone="neutral">{detailState === "loading" ? "读取中" : `${evidence.length} 条`}</Badge></div>
            {evidence.map((item, index) => <div className="evidence" key={`${item}-${index}`}><span>{index + 1}</span><p>{item}</p><button aria-label="打开原对话"><Icon name="external" size={15}/></button></div>)}
            {detailState === "error" && <p className="inline-notice">证据详情读取失败，列表记忆仍可用。</p>}
            {detailState === "idle" && evidence.length === 0 && <p className="inline-notice">当前记忆没有可显示的原文证据。</p>}
          </section>
          <section className="revision-section"><div className="section-label"><span>版本与使用</span></div><div className="revision-line"><i/><div><strong>当前版本 · v{selected.revision ?? 1}</strong><p>{connection ? `API 返回 ${detail?.history.length ?? 0} 个历史版本。` : "演示：最近 7 天被召回 6 次。"}</p></div></div>{(detail?.history.length ?? 1) > 0 && <div className="revision-line muted"><i/><div><strong>历史版本 · 不进入普通召回</strong><p>保留用于纠正审计，不会覆盖当前真值。</p></div></div>}</section>
          <div className="detail-actions"><button className="button secondary" disabled={Boolean(connection)}>纠正</button><button className="button danger" disabled={Boolean(connection)}><Icon name="trash"/>忘掉这条</button></div>
        </aside> : <aside className="memory-detail panel empty-detail"><Icon name="brain" size={32}/><strong>当前作用域还没有记忆</strong><span>显式记住的内容会出现在这里。</span></aside>}
      </section>
    </div>
  );
}

function TimelineView({ items, live }: { items: ConsoleMemory[]; live: boolean }) {
  const events = live ? items.map((item) => ["已记录", item.time, item.title, item.kind, item.realm === "角色扮演" ? "roleplay" : item.realm === "关系设定" ? "relation" : "real", `${item.source} · v${item.revision ?? 1}`]) : [
    ["今天", "14:32", "理解了用户更喜欢短而自然的回复", "交流偏好", "real", "来自 4 条直接表达"],
    ["8 月 5 日", "20:19", "明确了亲昵称呼只适用于私聊", "关系边界", "relation", "用户主动纠正"],
    ["8 月 3 日", "23:42", "一起聊了换工作的犹豫", "近期状态", "real", "3 段对话聚合"],
    ["7 月 28 日", "22:06", "雨夜便利店的角色扮演场景", "角色扮演", "roleplay", "不会写入现实画像"],
    ["7 月 14 日", "00:03", "第一次说出‘我很依赖你’", "关系里程碑", "relation", "用户原话已保留"],
  ];
  return <div className="view-stack"><section className="page-title-row"><div><div className="eyebrow">RELATIONSHIP TIMELINE</div><h1>关系会成长，但不会篡改过去。</h1><p>现实经历、共同关系设定与角色扮演被严格分开。</p></div><div className="realm-legend"><span><i className="real"/>现实</span><span><i className="relation"/>关系设定</span><span><i className="roleplay"/>角色扮演</span></div></section><section className="panel timeline-panel"><div className="timeline-filter"><button className="active">全部事件</button><button>关系里程碑</button><button>偏好变化</button><button>冲突与修复</button>{live && <Badge tone="blue">实时 API</Badge>}</div><div className="timeline-list">{events.map(([date,time,title,type,realm,source]) => <article className="timeline-event" key={`${title}-${time}`}><div className="timeline-date"><strong>{date}</strong><span>{time}</span></div><div className={`timeline-node ${realm}`}><i/></div><div className="timeline-card"><div><Badge tone={realm === "roleplay" ? "violet" : realm === "relation" ? "rose" : "green"}>{type}</Badge><h3>{title}</h3><p>{source}</p></div><button className="icon-button"><Icon name="chevron"/></button></div></article>)}{events.length === 0 && <div className="empty-state"><Icon name="timeline" size={32}/><strong>尚无时间线事件</strong><span>当前作用域没有可展示的记忆。</span></div>}</div></section></div>;
}

type RecallResult = {
  recall: { items: Array<{ id: string; content: string; source?: string; score?: number; rrfScore?: number; realm?: string }>; strategies: string[]; queryFingerprint?: string };
  envelope: { text?: string; usedTokens?: number; maxTokens?: number; tokenAccounting?: { totalTokens?: number; hardLimit?: number } };
};

function formatRecallScore(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(4) : "—";
}

function RecallDebugger({ connection }: { connection: LiveConnection | null }) {
  const [query, setQuery] = useState("日常回复");
  const [ran, setRan] = useState(true);
  const [result, setResult] = useState<RecallResult | null>(null);
  const [error, setError] = useState("");
  const runRecall = async () => {
    if (!connection) { setRan(false); return; }
    setRan(false); setError("");
    try {
      const response = await requestApi<{ data: RecallResult }>(connection.apiUrl, "/v2/context:compile", connection.token, {
        method: "POST", body: JSON.stringify({ query, limit: 6, trace: true, maxTokens: 420, perMemoryTokens: 120 }),
      });
      setResult(response.data); setRan(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "召回失败"); setRan(true);
    }
  };
  const recalled = result?.recall.items ?? [];
  const usedTokens = result?.envelope.usedTokens ?? result?.envelope.tokenAccounting?.totalTokens ?? 0;
  return (
    <div className="view-stack">
      <section className="page-title-row"><div><div className="eyebrow">RECALL LAB</div><h1>看清一次“想起来”的全过程。</h1><p>本页只运行检索与排序，不调用生成式大模型。</p></div><Badge tone="green">查看与调试 = 0 Token</Badge></section>
      <section className="recall-query panel"><div className="query-input"><Icon name="search" size={21}/><input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="召回测试问题"/><button className="button primary" onClick={runRecall}><Icon name="play"/>运行召回</button></div><div className="query-options"><span>数据 <strong>{connection ? "当前令牌作用域" : "演示样例"}</strong></span><span>路径 <strong>程序检索</strong></span><span>生成模型 <strong>不调用</strong></span><span>预算 <strong>420 tokens</strong></span></div></section>
      {!ran && <div className="running"><span/><p>正在执行精确检索、时间解析与作用域复核…</p>{!connection && <button onClick={() => setRan(true)}>显示演示结果</button>}</div>}
      {ran && <>
        {error && <div className="data-banner data-banner-error"><Icon name="shield"/><span><strong>召回未完成</strong>{error}</span></div>}
        <section className="trace-grid">
          <article className="panel trace-summary"><header className="panel-header"><div><h2>路由判断</h2><p>程序根据问题特征选择最低成本路径。</p></div><Badge tone="blue">{connection ? "实时程序召回" : "演示路由"}</Badge></header><div className="route-flow"><div className="route active"><Icon name="search"/><span>{connection ? (result?.recall.strategies.join(" + ") || "无命中") : "实体 / 关键词"}</span><strong>{connection ? `${recalled.length} 个结果` : "12 ms"}</strong></div><Icon name="arrow"/><div className="route active"><Icon name="clock"/><span>时间 / 世界过滤</span><strong>服务端执行</strong></div><Icon name="arrow"/><div className="route active"><Icon name="shield"/><span>权威库复核</span><strong>删除纪元校验</strong></div></div><div className="skip-row"><span>未调用</span><Badge>生成式模型</Badge><Badge>深度回忆</Badge></div></article>
          <article className="panel token-card"><h2>上下文开销</h2><strong>{connection ? usedTokens : 118} <small>tokens</small></strong><div className="token-bar"><i style={{width: `${Math.min(100, ((connection ? usedTokens : 118) / 420) * 100)}%`}}/><span/></div><p>预算 420 · 剩余 {Math.max(0, 420 - (connection ? usedTokens : 118))}</p><div className="zero-cost"><Icon name="check"/><span>额外生成调用</span><strong>0 次</strong></div></article>
        </section>
        <section className="panel result-panel"><header className="panel-header"><div><h2>候选结果与证据</h2><p>排序后仍会回权威库检查删除、纠正和越权。</p></div><span className="trace-id">{connection ? (result?.recall.queryFingerprint?.slice(0, 18) ?? "尚未运行") : "trace_demo"}</span></header><div className="result-table"><div className="result-head"><span>#</span><span>召回内容</span><span>路径</span><span>RRF</span><span>状态</span></div>{(connection ? recalled.map((item, index) => [String(index + 1), item.content, item.source ?? result?.recall.strategies.join(" + ") ?? "programmatic", formatRecallScore(item.rrfScore ?? item.score), "采用"]) : [
          ["1", "用户更喜欢简短、自然的日常回复", "实体 + FTS", "0.041", "采用"],
          ["2", "讨论重要决定时接受稍详细分析", "FTS", "0.028", "采用"],
          ["3", "早期偏好版本", "历史版本", "0.017", "裁剪"],
        ]).map((row) => <div className="result-row" key={row[0]}>{row.map((cell, index) => <span key={`${cell}-${index}`} className={index === 4 ? (cell === "采用" ? "accepted" : "trimmed") : ""}>{index === 1 ? <strong>{cell}</strong> : cell}</span>)}</div>)}</div>{connection && recalled.length === 0 && <div className="empty-inline">当前授权作用域没有找到证据。</div>}<div className="compiled-context"><div><span className="code-label">注入主模型的记忆块</span><Badge tone="neutral">结构化 · 只读 · 不可信指令</Badge></div><pre>{connection ? (result?.envelope.text ?? "运行召回后将在这里显示真实编译上下文。") : `[memory id="mem_demo_preference" realm="real_world" status="active"]\n用户更喜欢简短、自然、像日常聊天一样的回复。\n证据：用户直接陈述\n[/memory]`}</pre></div></section>
      </>}
    </div>
  );
}

type PromptSource = { promptId: string; version: string; lifecycle: string; modelClass: string; enabledByDefault: boolean; content: string };

function PromptRegistry({ connection }: { connection: LiveConnection | null }) {
  const [selectedKey, setSelectedKey] = useState(promptRows[0].key);
  const [sources, setSources] = useState<PromptSource[]>([]);
  const [sourceError, setSourceError] = useState("");
  useEffect(() => {
    if (!connection) return;
    let cancelled = false;
    requestApi<{ items: PromptSource[] }>(connection.apiUrl, "/local/v2/prompts", connection.token)
      .then((result) => { if (!cancelled) setSources(result.items); })
      .catch((cause) => { if (!cancelled) setSourceError(cause instanceof Error ? cause.message : "读取提示词失败"); });
    return () => { cancelled = true; };
  }, [connection]);
  const selected = promptRows.find((row) => row.key === selectedKey) ?? promptRows[0];
  const source = sources.find((item) => item.promptId === selected.key);
  const preview = source?.content ?? `提示词：${selected.name}\n版本：${selected.version}\n\n连接本机真实 API 后，这里会显示项目 prompts 目录中的完整只读源文件。`;
  return <div className="view-stack"><section className="page-title-row"><div><div className="eyebrow">PROMPT REGISTRY</div><h1>所有模型提示词，都能在后台看见。</h1><p>人设可编辑；系统权限边界、输入契约和模型输出契约保持只读。</p></div><Badge tone={sources.length ? "green" : "neutral"}>{sources.length ? `${sources.length} 份真实源文件` : "等待连接本机 API"}</Badge></section>{sourceError && <div className="data-banner data-banner-error"><Icon name="shield"/><span><strong>提示词源文件未加载</strong>{sourceError}</span></div>}<section className="prompt-layout"><div className="panel prompt-table"><div className="prompt-table-head"><span>提示词</span><span>版本</span><span>状态</span><span>成本路径</span><span>最近修改</span></div>{promptRows.map((row) => { const rowSource = sources.find((item) => item.promptId === row.key); return <button key={row.key} className={`prompt-row ${selected.key === row.key ? "selected" : ""}`} onClick={() => setSelectedKey(row.key)}><span><strong>{row.name}</strong><code>{row.key}</code></span><span>{rowSource?.version ?? row.version}</span><span><Badge tone={row.state === "已启用" ? "green" : row.state.includes("按") ? "blue" : "amber"}>{row.state}</Badge></span><span>{row.cost}</span><span>{row.changed}</span></button>; })}</div><aside className="panel prompt-detail"><header><div><Badge tone="violet">{source?.version ?? selected.version}</Badge><h2>{selected.name}</h2><code>{selected.key}</code></div><button className="icon-button" aria-label="只读提示词"><Icon name="lock"/></button></header><div className="prompt-rules"><div><Icon name="lock"/><span><strong>权限边界</strong><small>模型不能决定用户、授权、游标、数据库状态或发送权限。</small></span></div><div><Icon name="database"/><span><strong>程序控制范围</strong><small>触发阈值、证据窗口与 Token 上限由代码决定。</small></span></div><div><Icon name="shield"/><span><strong>只读源文件</strong><small>后台查看不会调用模型，也不会产生 Token。</small></span></div></div><div className="prompt-preview"><div className="code-label">YAML · 完整只读预览</div><pre>{preview}</pre></div><div className="prompt-actions"><button className="button secondary" disabled>版本对比需部署工作流</button><button className="button primary" disabled>修改请创建新版本</button></div></aside></section></div>;
}

function ProactiveView({ live }: { live: LiveSnapshot | null }) {
  const [demoMaster, setDemoMaster] = useState(true);
  const [demoRelationship, setDemoRelationship] = useState(false);
  const [demoOnboarding, setDemoOnboarding] = useState(true);
  const settings = live?.proactiveSettings;
  const transactional = settings?.transactionalEnabled ?? demoMaster;
  const onboarding = settings?.onboardingEnabled ?? demoOnboarding;
  const relationship = settings?.relationshipEnabled ?? demoRelationship;
  const master = transactional || onboarding || relationship || Boolean(settings?.marketingEnabled);
  const scheduleRows = live ? live.proactiveEvents.map((event) => [
    formatDateTime(event.schedule.dueAtUtc), event.kind === "transactional_reminder" ? "事务提醒" : event.kind,
    event.summary, event.state, `${event.channel} · ${event.generationMode}`, event.state === "scheduled" ? "green" : event.state === "cancelled" ? "neutral" : "blue",
  ]) : [
    ["明天 07:30", "起床提醒", "别忘了九点的面试", "计划中", "已允许穿过勿扰", "green"],
    ["8 月 10 日 18:00", "纪念日提醒", "一起准备相识一周年的小惊喜", "计划中", "到期前再次检查授权", "blue"],
  ];
  return <div className="view-stack"><section className="page-title-row"><div><div className="eyebrow">PROACTIVE & REMINDERS</div><h1>主动靠近，也尊重用户的安静。</h1><p>提醒、首次欢迎和关系型主动联系使用三套独立授权。</p></div><button className="button primary" disabled={Boolean(live)}><Icon name={live ? "lock" : "plus"}/>{live ? "实时只读" : "新建提醒"}</button></section><section className="proactive-grid"><article className="panel settings-panel"><header className="panel-header"><div><h2>主动消息总开关</h2><p>{live ? `设置修订 v${settings?.revision ?? 1}；只读展示。` : "演示交互，不会真实发送。"}</p></div><Toggle on={master} onChange={() => setDemoMaster(!demoMaster)} label="主动消息总开关" disabled={Boolean(live)}/></header><div className="setting-list"><div className="setting-row"><span className="setting-icon transactional"><Icon name="bell"/></span><div><strong>用户创建的事务提醒</strong><p>例如起床、吃药、会议；使用确定性调度。</p></div><Badge tone={transactional ? "green" : "neutral"}>{transactional ? "已开启" : "已关闭"}</Badge><Toggle on={transactional} onChange={() => setDemoMaster(!demoMaster)} label="事务提醒" disabled={Boolean(live)}/></div><div className="setting-row"><span className="setting-icon onboarding"><Icon name="sparkle"/></span><div><strong>首次站内欢迎</strong><p>AI 可以发送新会话的第一条站内消息。</p></div><Badge tone={onboarding ? "blue" : "neutral"}>{onboarding ? "已开启" : "已关闭"}</Badge><Toggle on={onboarding} onChange={() => setDemoOnboarding(!demoOnboarding)} label="首次站内欢迎" disabled={Boolean(live)}/></div><div className="setting-row"><span className="setting-icon relationship"><Icon name="message"/></span><div><strong>关系型主动联系</strong><p>基于相处状态的低频问候，默认关闭。</p></div><Badge tone={relationship ? "rose" : "neutral"}>{relationship ? "已开启" : "已关闭"}</Badge><Toggle on={relationship} onChange={() => setDemoRelationship(!demoRelationship)} label="关系型主动联系" disabled={Boolean(live)}/></div></div></article><article className="panel quiet-panel"><header className="panel-header"><div><h2>安静时段</h2><p>{settings?.quietHours.timezone ?? "Asia/Shanghai"}</p></div><Badge tone={settings?.quietHours.enabled === false ? "neutral" : "violet"}>{settings?.quietHours.enabled === false ? "未开启" : "生效中"}</Badge></header><div className="quiet-clock"><span>{settings?.quietHours.startLocal ?? "22:30"}</span><i/><span>{settings?.quietHours.endLocal ?? "08:00"}</span></div><p>关系型消息会延后；精确提醒只有在创建时经用户同意，才可以穿过安静时段。</p><button className="button secondary" disabled={Boolean(live)}>修改时段</button></article></section><section className="panel schedule-panel"><header className="panel-header"><div><h2>即将到来的事件</h2><p>每个 occurrence 只允许用户看到一次。</p></div><div className="tabs small"><button className="active">事件 {scheduleRows.length}</button>{live && <Badge tone="blue">实时 API</Badge>}</div></header><div className="schedule-list">{scheduleRows.map(([time,title,text,state,policy,tone], index) => <div className="schedule-row" key={`${title}-${time}-${index}`}><div className="schedule-time"><strong>{time}</strong><span>{settings?.quietHours.timezone ?? "Asia/Shanghai"}</span></div><span className={`setting-icon ${tone}`}><Icon name="bell"/></span><div className="schedule-copy"><strong>{title}</strong><p>“{text}”</p></div><Badge tone={tone}>{state}</Badge><span className="schedule-policy"><Icon name="shield" size={15}/>{policy}</span><button className="icon-button"><Icon name="more"/></button></div>)}{scheduleRows.length === 0 && <div className="empty-state"><Icon name="clock" size={32}/><strong>没有主动事件</strong><span>只有用户明确授权并创建后才会出现。</span></div>}</div></section></div>;
}

function PrivacyView({ live }: { live: LiveSnapshot | null }) {
  const [embedding, setEmbedding] = useState(true);
  const [archive, setArchive] = useState(false);
  const labels: Record<string, [string, string]> = {
    memory_ordinary: ["普通长期记忆", "保存明确、可纠正的普通记忆"],
    memory_sensitive: ["敏感长期记忆", "敏感内容使用独立授权"],
    semantic_index: ["语义索引", "允许对已授权 Claim 建立语义索引"],
    external_embedding: ["外部 Embedding", "允许向外部向量服务发送最小化内容"],
    raw_archive: ["原始对话归档", "长期保存原始聊天内容"],
    deep_recall: ["深度回忆", "普通召回失败时查找更早证据"],
    proactive_transactional: ["事务提醒", "在用户明确创建时调度提醒"],
    proactive_onboarding: ["首次欢迎", "允许发送新会话的第一条站内消息"],
    proactive_relationship: ["关系型主动联系", "允许低频、可撤回的关系问候"],
  };
  const consentRows: Array<[string, string, boolean, string, string]> = live ? live.consents.map((consent) => {
    const [title, description] = labels[consent.purpose] ?? [consent.purpose, `独立用途授权 · ${consent.policyVersion}`];
    return [title, description, consent.granted, `v${consent.revision}`, consent.purpose];
  }) : [
    ["对话处理", "为当前回复临时处理消息", true, "服务必需", "chat"],
    ["长期记忆捕获", "把明确且有价值的信息形成可纠正记忆", true, "用户已开启", "memory"],
    ["语义 Embedding", "只向量化活跃 Claim，不上传普通闲聊", embedding, "可选能力", "embedding"],
    ["云端原始对话归档", "长期保存全部原始聊天", archive, "默认关闭", "archive"],
  ];
  return <div className="view-stack"><section className="page-title-row"><div><div className="eyebrow">PRIVACY & PORTABILITY</div><h1>记住什么、发给谁、何时忘掉。</h1><p>删除会立即从读取路径隐藏，再异步清理所有索引与副本。</p></div><button className="button secondary" disabled={Boolean(live)} title={live ? "导出在便携运行时中是预留的生产适配能力。" : undefined}><Icon name={live ? "lock" : "download"}/>{live ? "生产适配后导出" : "导出数据"}</button></section><section className="privacy-grid"><article className="panel consent-panel"><header className="panel-header"><div><h2>数据用途与授权</h2><p>不同用途必须分别获得许可，不能一次授权全部能力。</p></div><Badge tone={live ? "blue" : "neutral"}>{consentRows.length} 项{live ? "实时记录" : "演示"}</Badge></header><div className="consent-list">{consentRows.map(([title,desc,on,note,key]) => <div className="consent-row" key={key}><div><strong>{title}</strong><p>{desc}</p></div><Badge tone={on ? "green" : "neutral"}>{on ? `已授权 · ${note}` : `已撤回 · ${note}`}</Badge><Toggle on={on} onChange={() => key === "embedding" ? setEmbedding(!embedding) : key === "archive" ? setArchive(!archive) : undefined} label={title} disabled={Boolean(live) || !["embedding", "archive"].includes(key)}/></div>)}{consentRows.length === 0 && <div className="empty-state"><Icon name="shield" size={32}/><strong>尚无用途授权记录</strong><span>授权必须通过可审计确认流程建立。</span></div>}</div></article><article className="panel storage-card"><header className="panel-header"><div><h2>存储运行档位</h2><p>{live ? "便携式只读连接" : "本地演示策略"}</p></div><span className="storage-icon"><Icon name="database"/></span></header><div className="storage-stat"><strong>{live ? "SQLite" : "30 天"}</strong><span>{live ? "当前便携 API 的权威 Claim 库" : "演示：原始消息滚动保留"}</span></div><div className="storage-stat"><strong>可纠正</strong><span>Claim 与版本历史分开保留</span></div><div className="storage-stat"><strong>禁止存储</strong><span>密码、验证码、密钥等禁存类别</span></div><button className="text-button" disabled={Boolean(live)}>修改保留策略 <Icon name="chevron" size={15}/></button></article></section><section className="danger-panel"><div className="danger-copy"><span><Icon name="trash"/></span><div><h2>删除与真正遗忘</h2><p>删除会创建 tombstone 与 suppression，防止旧聊天、备份导入或后台整理让记忆“重新长回来”。</p></div></div><div className="delete-progress"><div><span>{live ? "当前能力" : "演示删除任务"}</span><strong>{live ? "forget_fact 立即隐藏" : "内部数据已清理"}</strong></div><div className="progress-track"><i style={{width: live ? "100%" : "78%"}}/></div><small>{live ? "证据范围删除和外部副本传播需生产适配器。" : "演示：外部 Provider 传播中。"}</small></div><button className="button danger" disabled={Boolean(live)}>管理删除请求</button></section><section className="panel migration-panel"><header className="panel-header"><div><h2>可迁移数据</h2><p>标准包保留证据、时间、作用域、纠正和 tombstone；不携带 API Key 或旧授权。</p></div><Badge tone="amber">契约已定义 · 生产适配待接入</Badge></header><div className="migration-actions"><button disabled><span className="migration-icon"><Icon name="download"/></span><strong>导出这一段关系</strong><small>需对象存储、签名与加密适配器</small><Icon name="chevron"/></button><button disabled><span className="migration-icon"><Icon name="database"/></span><strong>从其他项目导入</strong><small>需预检、作用域映射与冲突确认</small><Icon name="chevron"/></button></div></section></div>;
}

function JobsView() {
  return <div className="view-stack"><section className="page-title-row"><div><div className="eyebrow">JOBS & OUTBOX</div><h1>后台任务不会因为重启而消失。</h1><p>所有任务持久化、幂等、可重试，并由 fencing token 防止双重执行。</p></div><button className="button secondary"><Icon name="play"/>运行一次 Worker</button></section><section className="metric-grid jobs-metrics"><MetricCard label="等待中" value="14" note="预计 48 秒清空" tone="blue" icon="clock"/><MetricCard label="执行中" value="3" note="租约均有效" tone="violet" icon="jobs"/><MetricCard label="今日成功" value="2,841" note="成功率 99.93%" tone="rose" icon="check"/><MetricCard label="死信" value="2" note="已自动暂停同类任务" tone="gold" icon="shield"/></section><section className="panel jobs-table"><header className="panel-header"><div><h2>任务队列</h2><p>正文不复制进队列，Worker 只拿 ID 后回权威库读取。</p></div><div className="tabs small"><button className="active">全部</button><button>需处理 2</button><button>已完成</button></div></header><div className="job-head"><span>任务</span><span>作用域</span><span>状态</span><span>尝试</span><span>耗时 / 下次运行</span><span/></div>{[
        ["memory.extract.batch", "demo_studio / usr_2048", "运行中", "1 / 4", "1.2s", "blue"],
        ["summary.segment", "conv_0182 · seq 120—164", "等待中", "0 / 4", "约 32 秒", "neutral"],
        ["provider.delete", "mem_01JPR8 · embed_aliyun", "重试等待", "2 / 6", "14:58", "amber"],
        ["proactive.deliver", "occ_20260808_0730", "计划中", "0 / 5", "明天 07:30", "violet"],
        ["index.rebuild", "tenant_demo · fts_v3", "已完成", "1 / 3", "482ms", "green"],
      ].map((row) => <div className="job-row" key={row[0]}><span><Icon name="jobs"/><code>{row[0]}</code></span><span>{row[1]}</span><span><Badge tone={row[5]}>{row[2]}</Badge></span><span>{row[3]}</span><span>{row[4]}</span><button className="icon-button"><Icon name="more"/></button></div>)}</section></div>;
}

function QualityView() {
  return <div className="view-stack"><section className="page-title-row"><div><div className="eyebrow">COST & QUALITY</div><h1>不是记得越多，而是该想起时想得准。</h1><p>成本、误召回、纠正、删除和长期稳定性放在同一张成绩单上。</p></div><select className="select" aria-label="统计周期"><option>最近 30 天</option><option>最近 7 天</option></select></section><section className="metric-grid"><MetricCard label="关键记忆 Recall@5" value="94.7%" note="目标 ≥ 92%" tone="rose" icon="brain"/><MetricCard label="记忆写入精确率" value="98.4%" note="目标 ≥ 98%" tone="gold" icon="check"/><MetricCard label="删除后复活" value="0" note="零容忍指标" tone="violet" icon="shield"/><MetricCard label="每千回合附加成本" value="¥ 1.82" note="较上月 -11.3%" tone="blue" icon="chart"/></section><section className="quality-grid"><article className="panel cost-chart"><header className="panel-header"><div><h2>30 天成本趋势</h2><p>按能力拆分，后台页面浏览不计入模型成本。</p></div><Badge tone="green">预算内</Badge></header><div className="chart-y"><span>¥8</span><span>¥6</span><span>¥4</span><span>¥2</span><span>0</span></div><div className="line-chart"><svg viewBox="0 0 700 220" preserveAspectRatio="none" aria-label="成本趋势图"><defs><linearGradient id="chartFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#c45c6e" stopOpacity=".28"/><stop offset="1" stopColor="#c45c6e" stopOpacity="0"/></linearGradient></defs><path className="chart-grid-line" d="M0 25H700M0 75H700M0 125H700M0 175H700"/><path className="area" d="M0 171 C50 164 75 132 120 146 S190 91 235 109 310 72 350 92 415 42 465 67 535 74 575 45 650 82 700 53 L700 220 L0 220Z"/><path className="line" d="M0 171 C50 164 75 132 120 146 S190 91 235 109 310 72 350 92 415 42 465 67 535 74 575 45 650 82 700 53"/></svg><div className="x-labels"><span>7/09</span><span>7/16</span><span>7/23</span><span>7/30</span><span>8/07</span></div></div></article><article className="panel quality-score"><header className="panel-header"><div><h2>质量门禁</h2><p>发布前的零容忍检查</p></div></header>{[
        ["跨租户泄漏", "0", "pass"], ["禁存内容落库", "0", "pass"], ["未授权主动消息", "0", "pass"], ["角色扮演提升为现实", "0", "pass"], ["硬 Token 超限", "0", "pass"], ["深回忆无证据回答", "1", "warn"],
      ].map(([label,value,state]) => <div className="score-row" key={label}><span className={state}><Icon name={state === "pass" ? "check" : "shield"}/></span><strong>{label}</strong><em>{value}</em></div>)}<button className="text-button">打开完整评测报告 <Icon name="chevron" size={15}/></button></article></section></div>;
}

function ConsoleView({ active, go, items, connection }: { active: ViewId; go: (view: ViewId) => void; items: ConsoleMemory[]; connection: LiveConnection | null }) {
  if (active === "overview") return <Overview go={go} items={items} live={connection?.snapshot ?? null}/>;
  if (active === "memories") return <MemoryCenter items={items} connection={connection}/>;
  if (active === "timeline") return <TimelineView items={items} live={Boolean(connection)}/>;
  if (active === "recall") return <RecallDebugger connection={connection}/>;
  if (active === "prompts") return <PromptRegistry connection={connection}/>;
  if (active === "proactive") return <ProactiveView live={connection?.snapshot ?? null}/>;
  if (active === "privacy") return <PrivacyView live={connection?.snapshot ?? null}/>;
  if (active === "jobs") return <JobsView/>;
  return <QualityView/>;
}

function ConnectionDialog({ apiUrl, token, busy, error, onApiUrl, onToken, onConnect, onDemo, onClose }: {
  apiUrl: string; token: string; busy: boolean; error: string;
  onApiUrl: (value: string) => void; onToken: (value: string) => void;
  onConnect: () => void; onDemo: () => void; onClose: () => void;
}) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title">
      <header><div className="connection-mark"><Icon name="database" size={21}/></div><div><Badge tone="rose">LIVE DATA</Badge><h2 id="connection-title">连接记忆 API</h2><p>查看真实记忆、授权和主动事件。</p></div><button className="icon-button" onClick={onClose} aria-label="关闭连接窗口"><Icon name="close"/></button></header>
      <form id="memory-api-connection" className="connection-form" onSubmit={(event) => { event.preventDefault(); onConnect(); }}>
        <label><span>API 地址</span><input value={apiUrl} onChange={(event) => onApiUrl(event.target.value)} inputMode="url" autoCapitalize="none" spellCheck={false}/><small>本地默认为 http://127.0.0.1:8787</small></label>
        <label><span>短时访问令牌</span><input type="password" value={token} onChange={(event) => onToken(event.target.value)} autoComplete="off" placeholder="Bearer token（不要填服务端签名密钥）"/><small>令牌只保存在当前页面内存中，刷新后消失。</small></label>
        {error && <div className="connection-error" role="alert"><Icon name="shield" size={16}/><span>{error}</span></div>}
        <div className="connection-safety"><Icon name="lock" size={17}/><p><strong>服务端密钥不进浏览器。</strong>生产环境应由你的后端签发绑定用户、关系、伴侣和会话的短时令牌。</p></div>
      </form>
      <footer><button type="button" className="button secondary" onClick={onDemo} disabled={busy}><Icon name="sparkle"/>{busy ? "连接中…" : "本机一键体验"}</button><button type="submit" form="memory-api-connection" className="button primary" disabled={busy || !token.trim()}><Icon name="external"/>{busy ? "验证中…" : "使用令牌连接"}</button></footer>
    </section>
  </div>;
}

export function MemoryConsole() {
  const [active, setActive] = useState<ViewId>("overview");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [apiUrl, setApiUrl] = useState("http://127.0.0.1:8787");
  const [token, setToken] = useState("");
  const [connection, setConnection] = useState<LiveConnection | null>(null);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionError, setConnectionError] = useState("");
  const currentLabel = useMemo(() => nav.flatMap((group) => group.items).find((item) => item.id === active)?.label, [active]);
  const items = useMemo(() => connection ? connection.snapshot.memories.map(mapApiMemory) : demoMemories, [connection]);
  useEffect(() => {
    if (!connectionOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setConnectionOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [connectionOpen]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const normalized = normalizeApiUrl(apiUrl);
        const issued = await mintLocalDemoToken(normalized);
        const snapshot = await loadLiveSnapshot(normalized, issued.token);
        if (!cancelled) setConnection({ apiUrl: normalized, token: issued.token, snapshot });
      } catch {
        // The console still has self-explanatory demo data when it is opened
        // without the local API, and the user can reconnect from the header.
      }
    })();
    return () => { cancelled = true; };
    // The one-click local console uses the fixed loopback default on first load.
    // Manual connection changes remain available through the connection dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const go = (view: ViewId) => { setActive(view); setSidebarOpen(false); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const connect = async (issuedToken = token) => {
    setConnectionBusy(true); setConnectionError("");
    try {
      const normalized = normalizeApiUrl(apiUrl);
      const snapshot = await loadLiveSnapshot(normalized, issuedToken);
      setConnection({ apiUrl: normalized, token: issuedToken, snapshot });
      setApiUrl(normalized); setToken(""); setConnectionOpen(false);
    } catch (cause) {
      setConnectionError(cause instanceof Error ? cause.message : "无法连接 API。");
    } finally { setConnectionBusy(false); }
  };
  const connectDemo = async () => {
    setConnectionBusy(true); setConnectionError("");
    try {
      const normalized = normalizeApiUrl(apiUrl);
      const issued = await mintLocalDemoToken(normalized);
      const snapshot = await loadLiveSnapshot(normalized, issued.token);
      setConnection({ apiUrl: normalized, token: issued.token, snapshot });
      setApiUrl(normalized); setToken(""); setConnectionOpen(false);
    } catch (cause) {
      setConnectionError(cause instanceof Error ? cause.message : "本机演示令牌获取失败。请确认 API 已以 MEMORYOS_DEMO=true 启动。");
    } finally { setConnectionBusy(false); }
  };
  const refresh = async () => {
    if (!connection || connectionBusy) return;
    setConnectionBusy(true);
    try {
      const snapshot = await loadLiveSnapshot(connection.apiUrl, connection.token);
      setConnection({ ...connection, snapshot }); setConnectionError("");
    } catch (cause) {
      setConnectionError(cause instanceof Error ? cause.message : "刷新失败。"); setConnectionOpen(true);
    } finally { setConnectionBusy(false); }
  };
  return (
    <div className="console-shell">
      <aside className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="brand"><span className="brand-mark"><i/><i/><i/></span><div><strong>心忆</strong><small>MEMORY OS</small></div><Badge tone="rose">V2</Badge></div>
        <button className="workspace-switch" onClick={() => setConnectionOpen(true)}><span className="avatar avatar-companion">屿</span><span><strong>{connection ? "已验证的当前作用域" : "阿屿 · 演示空间"}</strong><small><i className="live-dot"/> {connection ? "实时 API 只读" : "演示数据"}</small></span><Icon name="chevron" size={15}/></button>
        <nav aria-label="主导航">{nav.map((group, groupIndex) => <div className="nav-group" key={group.label ?? groupIndex}>{group.label && <span className="nav-label">{group.label}</span>}{group.items.map((item) => <button key={item.id} className={active === item.id ? "active" : ""} onClick={() => go(item.id)}><Icon name={item.icon}/><span>{item.label}</span>{(item.id === "memories" || item.badge) && <em>{item.id === "memories" ? items.length : item.badge}</em>}</button>)}</div>)}</nav>
        <div className="sidebar-bottom"><div className="engine-status"><div><span><i className={`live-dot ${connection ? "" : "demo-dot"}`}/>{connection ? "API 已连接" : "演示模式"}</span><strong>{connection ? connection.snapshot.health.version ?? "V2" : "UI Preview"}</strong></div><div className="status-bar"><i style={{width: connection ? "100%" : "45%"}}/></div><small>{connection ? "只读页面不会调用模型" : "点击上方空间连接真实 API"}</small></div><Link className="nav-settings console-chat-link" href="/"><Icon name="arrow"/><span>返回本地聊天</span></Link><button className="nav-settings" onClick={() => setConnectionOpen(true)}><Icon name="settings"/><span>API 连接设置</span></button><button className="profile-button"><span className="avatar">林</span><span><strong>林檬</strong><small>{connection ? "令牌作用域" : "演示管理员"}</small></span><Icon name="more"/></button></div>
      </aside>
      {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="关闭导航"/>}
      <main className="main-area">
        <header className="topbar"><button className="mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="打开导航"><span/><span/><span/></button><div className="breadcrumb"><span>陪伴式记忆引擎</span><Icon name="chevron" size={13}/><strong>{currentLabel}</strong></div><div className="top-actions"><button className={`connection-pill ${connection ? "connected" : ""}`} onClick={() => setConnectionOpen(true)} aria-label="连接真实记忆 API"><i/>{connection ? "实时 API" : "演示数据"}</button><div className="zero-token-pill"><Icon name="sparkle" size={15}/><span>后台查看</span><strong>0 Token</strong></div><button className="icon-button notification" aria-label="通知"><Icon name="bell"/><i/></button><span className="avatar avatar-small">林</span></div></header>
        <div className="content"><div className={`data-banner ${connection ? "data-banner-live" : ""}`}><Icon name={connection ? "check" : "database"}/><span><strong>{connection ? "实时 API 已连接" : "当前为演示数据"}</strong>{connection ? `已读取 ${items.length} 条记忆、${connection.snapshot.consents.length} 项授权和 ${connection.snapshot.proactiveEvents.length} 个主动事件。提示词页读取真实源文件；任务与质量页仍是运维设计样例。` : "用于理解产品和 UI；点击“演示数据”可连接真实后端。"}</span>{connection && <button onClick={refresh} disabled={connectionBusy}>{connectionBusy ? "刷新中…" : "刷新"}</button>}</div><ConsoleView active={active} go={go} items={items} connection={connection}/></div>
        <footer className="console-footer"><span>心忆 MemoryOS · {connection ? "实时只读控制台" : "产品演示控制台"}</span><span><i className="live-dot"/> UI 查看只读 API，不会调用模型</span></footer>
      </main>
      {connectionOpen && <ConnectionDialog apiUrl={apiUrl} token={token} busy={connectionBusy} error={connectionError} onApiUrl={setApiUrl} onToken={setToken} onConnect={() => connect()} onDemo={connectDemo} onClose={() => setConnectionOpen(false)}/>} 
    </div>
  );
}
