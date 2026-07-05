"use client";

import { useState, useRef, useEffect } from "react";

type Message = { role: "user" | "otto"; text: string; time: string };
type Stats = { tasks: number; saved: number; tokens: number };

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([{
    role: "otto", text: "你好！我是Otto，你的AI办公助手。输入指令或点击左侧工具。",
    time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
  }]);
  const [input, setInput] = useState("");
  const [task, setTask] = useState("空闲");
  const [stats, setStats] = useState<Stats>({ tasks: 0, saved: 0, tokens: 0 });
  const [loading, setLoading] = useState(false);
  const [suggOpen, setSuggOpen] = useState(true);
  const [logOpen, setLogOpen] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => { chatRef.current?.scrollTo(0, chatRef.current.scrollHeight); }, [messages]);

  const addMsg = (role: "user" | "otto", text: string) => {
    setMessages(prev => [...prev, { role, text, time: new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) }]);
  };

  const addLog = (msg: string) => {
    setLogs(prev => [...prev.slice(-50), `[${new Date().toLocaleTimeString("zh-CN")}] ${msg}`]);
  };

  const send = async (text?: string) => {
    const msg = text || input;
    if (!msg || loading) return;
    setInput(""); setLoading(true); setTask("处理中...");
    addMsg("user", msg); addLog(`用户: ${msg}`);

    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: msg }) });
      const data = await res.json();
      addMsg("otto", data.reply || "处理完成");
      setTask("空闲");
      setStats(data.stats || { tasks: stats.tasks + 1, saved: stats.saved, tokens: stats.tokens + (data.tokens || 0) });
      addLog(`Otto: ${(data.reply || "").slice(0, 60)}`);
    } catch {
      addMsg("otto", "连接失败，请检查服务。");
      setTask("空闲");
    }
    setLoading(false);
  };

  const sidebarAction = (action: string) => {
    const prompts: Record<string, string> = {
      ppt: "帮我做一个PPT",
      doc: "帮我写一份文档",
      pdf: "PDF拆分与编辑",
      media: "帮我把音视频转成文本",
      excel: "帮我把Excel数据可视化",
      research: "帮我收集资料",
      repair: "系统诊断",
      server: "启动企业管理服务",
      dashboard: "打开管理看板",
      invite: "创建邀请码",
      join: "员工加入",
    };
    send(prompts[action] || action);
  };

  return (
    <div className="flex h-screen bg-white text-[#1a1a1a]">
      {/* LEFT SIDEBAR */}
      <aside className="w-60 bg-[#f7f7f8] border-r border-[#e5e5e8] flex flex-col shrink-0">
        <div className="p-5 pb-3">
          <h1 className="text-[22px] font-bold text-[#d97757]">Otto</h1>
        </div>
        <SidebarSection title="办公工具" items={[
          { label: "PPT制作", action: "ppt" },
          { label: "文档写作", action: "doc" },
          { label: "PDF编辑", action: "pdf" },
          { label: "音视频转文本", action: "media" },
          { label: "Excel可视化", action: "excel" },
          { label: "资料收集", action: "research" },
          { label: "系统故障修复", action: "repair" },
        ]} onClick={sidebarAction} />
        <SidebarSection title="企业管理" items={[
          { label: "启动服务", action: "server" },
          { label: "管理看板", action: "dashboard" },
          { label: "邀请码", action: "invite" },
          { label: "员工加入", action: "join" },
        ]} onClick={sidebarAction} />
        <div className="flex-1" />
        <div className="p-3">
          <button onClick={() => window.open("http://localhost:7777/enterprise/dashboard")} className="w-full text-left px-3 py-2 rounded-lg text-sm text-[#6b6b70] hover:bg-[#ececee] hover:text-[#1a1a1a] transition">
            设置
          </button>
        </div>
      </aside>

      {/* CENTER CHAT */}
      <main className="flex-1 flex flex-col min-w-0">
        <header className="px-6 py-4 border-b border-[#e5e5e8] flex items-center gap-2">
          <h2 className="text-[15px] font-semibold">Otto 助手</h2>
          <span className={`w-2 h-2 rounded-full ${task === "空闲" ? "bg-green-500" : "bg-orange-500"}`} />
          <span className={`text-xs ${task === "空闲" ? "text-green-500" : "text-orange-500"}`}>{task === "空闲" ? "就绪" : "执行中"}</span>
        </header>
        <div ref={chatRef} className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          {messages.map((m, i) => (
            <div key={i}>
              <div className={`text-[13px] font-semibold mb-0.5 ${m.role === "user" ? "text-[#d97757]" : "text-[#1a1a1a]"}`}>
                {m.role === "user" ? "You" : "Otto"} <span className="text-[11px] text-[#9b9ba0] ml-1.5 font-normal">{m.time}</span>
              </div>
              <div className="text-sm leading-relaxed text-[#333] whitespace-pre-wrap">{m.text}</div>
            </div>
          ))}
        </div>
        <div className="px-6 py-4 border-t border-[#e5e5e8] flex gap-2.5">
          <input
            value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === "Enter" && send()}
            placeholder="输入指令..."
            className="flex-1 px-4 py-3 border border-[#e5e5e8] rounded-[10px] text-sm outline-none bg-[#f7f7f8] focus:border-[#d97757] focus:bg-white"
          />
          <button onClick={() => send()} disabled={loading}
            className="px-6 py-3 bg-[#d97757] text-white rounded-[10px] text-[13px] font-semibold hover:bg-[#b85a3e] disabled:opacity-50">
            发送
          </button>
        </div>
      </main>

      {/* RIGHT STATUS */}
      <aside className="w-[300px] bg-[#f7f7f8] border-l border-[#e5e5e8] flex flex-col shrink-0 overflow-y-auto">
        <div className="px-5 py-4 border-b border-[#e5e5e8]">
          <h2 className="text-[15px] font-semibold">工作状态</h2>
        </div>
        <div className="p-5 flex-1">
          <div className="text-[10px] font-bold text-[#9b9ba0] uppercase mb-1.5">当前任务</div>
          <div className="text-[15px] font-semibold mb-3.5">{task}</div>
          <div className="flex gap-1.5 mb-4">
            {[{ label: "任务数", val: stats.tasks, color: "#d97757" }, { label: "省时", val: `${stats.saved}h`, color: "#16a34a" }, { label: "Token", val: stats.tokens, color: "#ea580c" }].map(s => (
              <div key={s.label} className="flex-1 bg-white border border-[#efeff1] rounded-[10px] py-2.5 px-2 text-center">
                <div className="text-[9px] font-bold text-[#9b9ba0]">{s.label}</div>
                <div className="text-xl font-bold mt-0.5" style={{ color: s.color }}>{s.val}</div>
              </div>
            ))}
          </div>
          <Collapse title="工作建议" open={suggOpen} onToggle={() => setSuggOpen(!suggOpen)}>
            {["做PPT", "写周报", "系统诊断", "拆分PDF", "音频转文字"].map(s => (
              <div key={s} onClick={() => send(s)} className="bg-white border border-[#efeff1] rounded-lg px-3 py-2.5 mb-1 text-xs text-[#6b6b70] cursor-pointer hover:bg-[#ececee] hover:text-[#1a1a1a] transition">
                {s}
              </div>
            ))}
          </Collapse>
          <div className="h-3" />
          <Collapse title="活动日志" open={logOpen} onToggle={() => setLogOpen(!logOpen)}>
            <div className="bg-white border border-[#efeff1] rounded-lg p-2.5 font-mono text-[10px] text-[#6b6b70] max-h-40 overflow-y-auto">
              {logs.map((l, i) => <div key={i}>{l}</div>)}
            </div>
          </Collapse>
        </div>
      </aside>
    </div>
  );
}

function SidebarSection({ title, items, onClick }: { title: string; items: { label: string; action: string }[]; onClick: (a: string) => void }) {
  return (
    <div className="px-3 py-2">
      <h3 className="text-[10px] font-bold text-[#9b9ba0] uppercase px-2 py-2 tracking-[0.5px]">{title}</h3>
      {items.map(item => (
        <button key={item.action} onClick={() => onClick(item.action)}
          className="w-full text-left px-3 py-2.5 rounded-lg text-[13px] text-[#6b6b70] hover:bg-[#ececee] hover:text-[#1a1a1a] transition">
          {item.label}
        </button>
      ))}
    </div>
  );
}

function Collapse({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 cursor-pointer py-1.5" onClick={onToggle}>
        <span className="text-[10px] text-[#9b9ba0]">{open ? "v" : ">"}</span>
        <span className="text-[10px] font-bold text-[#9b9ba0] uppercase">{title}</span>
      </div>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}
