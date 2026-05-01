// Schema-Pop docs — all UI components in one file. Tailwind utility classes only.
// Logo is the ONLY thing using Instrument Serif (.font-logo).

const { useState, useEffect, useMemo, useRef } = React;

// ── Lollipop logo ──────────────────────────────────────────────────────────
function Lollipop({ size = 18, accent = "#f7567c" }) {
  // Emoji lollipop — slightly smaller and overlapping the neighbouring letters
  // so it sits in the "o" slot of "schema-pop".
  return <span style={{ fontSize: size * 0.85, lineHeight: 1, display: "inline-block", transform: "translateY(0.22em)", marginLeft: "-0.08em", marginRight: "-0.08em" }}>🍭</span>;
}

function Wordmark({ size = 18 }) {
  return (
    <span className="inline-flex items-baseline gap-0.5 font-black tracking-tight whitespace-nowrap"
          style={{ fontSize: size, lineHeight: 1 }}>
      <span>schema-p</span>
      <Lollipop size={size} />
      <span>p</span>
    </span>
  );
}

// ── Kind glyph + colour helpers ────────────────────────────────────────────
const KIND = {
  struct: { glyph: "{ }", text: "text-dusk dark:text-blue-300" },
  enum:   { glyph: "| |", text: "text-accent" },
  alias:  { glyph: "≡",   text: "text-good dark:text-emerald-400" },
};

// ── Memory layout viz ──────────────────────────────────────────────────────
function MemBars({ type }) {
  const fields = type.fields || [];
  const total = fields.reduce((s,f) => s + f.size + (f.pad||0), 0) || type.size || 1;
  return (
    <div className="space-y-1">
      <div className="flex gap-0.5 h-12 p-1 bg-ink/5 dark:bg-paper/5 rounded">
        {fields.flatMap((f, i) => {
          const items = [];
          if (f.size > 0) {
            items.push(
              <div key={`f${i}`}
                   className="bg-accent/15 dark:bg-accent/25 border border-accent/40 rounded px-2 flex flex-col justify-center min-w-[6px] overflow-hidden"
                   style={{ width: `${(f.size/total)*100}%` }}
                   title={`${f.name} · ${f.size}b @ +${f.offset}`}>
                <span className="text-[11px] font-medium truncate">{f.name}</span>
                <span className="text-[9px] opacity-60">{f.size}b</span>
              </div>
            );
          }
          if (f.pad) {
            items.push(
              <div key={`p${i}`} className="border border-dashed border-current/20 rounded flex items-center justify-center text-[9px] opacity-50"
                   style={{ width: `${(f.pad/total)*100}%`, backgroundImage: 'repeating-linear-gradient(135deg, currentColor 0 1px, transparent 1px 6px)' }}
                   title={`pad · ${f.pad}b`}>pad</div>
            );
          }
          return items;
        })}
      </div>
      <div className="flex justify-between text-[10px] opacity-50 px-1"><span>+0</span><span>+{type.size}</span></div>
    </div>
  );
}

function MemGrid({ type }) {
  const fields = type.fields || [];
  const cells = [];
  fields.forEach((f) => {
    for (let b = 0; b < f.size; b++) cells.push({ field: f, byte: f.offset + b, isFirst: b === 0, isPad: false });
    for (let b = 0; b < (f.pad||0); b++) cells.push({ field: f, byte: f.offset + f.size + b, isPad: true });
  });
  while (cells.length < type.size) cells.push({ byte: cells.length, isPad: true });
  const cols = Math.min(8, Math.max(4, type.size));
  return (
    <div className="grid gap-0.5 p-1 bg-ink/5 dark:bg-paper/5 rounded" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {cells.map((c, i) => (
        <div key={i}
             className={`relative aspect-[1.6] min-h-[34px] rounded px-1.5 py-1 flex flex-col justify-between border ${
               c.isPad ? 'border-dashed border-current/15 opacity-60' : 'border-accent/30 bg-accent/10 dark:bg-accent/20'
             }`}
             title={c.field ? `${c.isPad ? 'pad' : c.field.name} @ +${c.byte}` : `pad @ +${c.byte}`}
             style={c.isPad ? { backgroundImage: 'repeating-linear-gradient(135deg, currentColor 0 1px, transparent 1px 6px)' } : {}}>
          <span className="text-[9px] opacity-50">{c.byte.toString(16).padStart(2,'0')}</span>
          {c.isFirst && !c.isPad && <span className="text-[10px] font-medium truncate">{c.field.name}</span>}
        </div>
      ))}
    </div>
  );
}

// ── Type card ─────────────────────────────────────────────────────────────
function StatusPill({ status }) {
  const map = {
    added:     "text-good border-good/40 bg-good/10",
    modified:  "text-warn border-warn/40 bg-warn/10",
    removed:   "text-bad border-bad/40 bg-bad/10",
    unchanged: "text-ink/50 dark:text-paper/40 border-current/20",
  };
  return <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] uppercase tracking-wider ${map[status]}`}>{status}</span>;
}

function CopyBtn({ text, label = "copy" }) {
  const [done, setDone] = useState(false);
  return (
    <button onClick={(e) => { e.stopPropagation(); navigator.clipboard?.writeText(text); setDone(true); setTimeout(() => setDone(false), 1100); }}
            className="px-2 py-0.5 text-[10px] uppercase tracking-wider rounded border border-current/15 hover:border-current/40 transition-colors">
      {done ? "copied" : label}
    </button>
  );
}

function Pill({ tone = "muted", children }) {
  const map = {
    added: "text-good bg-good/10",
    mod:   "text-warn bg-warn/10",
    muted: "text-ink/60 dark:text-paper/50 bg-ink/5 dark:bg-paper/5",
  };
  return <span className={`inline-block px-2 py-0.5 rounded text-[10px] uppercase tracking-wider ${map[tone]}`}>{children}</span>;
}

function TypeCard({ type, version, memMode, onAnchor }) {
  const id = `t-${version.id.replace(".","_")}-${type.name}`;
  const k = KIND[type.kind];
  return (
    <article id={id} className="group border border-ink/10 dark:border-paper/10 rounded-lg bg-paper/40 dark:bg-paper/[0.02] hover:border-ink/20 dark:hover:border-paper/20 transition-colors scroll-mt-20">
      <header className="flex items-center gap-3 px-5 py-4 border-b border-ink/5 dark:border-paper/5 flex-wrap">
        <span className={`text-[10px] uppercase tracking-[0.18em] ${k.text}`}>{k.glyph} {type.kind}</span>
        <h3 className="text-base font-bold tracking-tight">{type.name}</h3>
        {type.added && <Pill tone="added">new in {version.id}</Pill>}
        <div className="flex-1" />
        <span className="text-[10px] opacity-50 uppercase tracking-wider">{type.size}b · align {type.align}</span>
        <button onClick={() => onAnchor(`${version.id}/${type.name}`)} className="text-[11px] opacity-40 hover:opacity-100 hover:text-accent" title="Copy permalink">#</button>
        <CopyBtn text={`${version.id}/${type.name}`} label="link" />
      </header>

      <div className="px-5 py-4 space-y-4">
        {type.docstring && (
          <p className="italic text-ink/70 dark:text-paper/60 border-l-2 border-accent/60 pl-3 text-[12px] leading-relaxed">
            {type.docstring}
          </p>
        )}

        {type.kind === "struct" && (
          <>
            <Section label="memory layout">
              {memMode === "grid" ? <MemGrid type={type} /> : <MemBars type={type} />}
            </Section>
            <Section label="fields">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider opacity-50">
                    <th className="text-left font-normal py-1.5 w-10">+</th>
                    <th className="text-left font-normal py-1.5">field</th>
                    <th className="text-left font-normal py-1.5">type</th>
                    <th className="text-left font-normal py-1.5">size</th>
                    <th className="text-left font-normal py-1.5">range</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink/5 dark:divide-paper/5">
                  {type.fields.map((f, i) => (
                    <tr key={i} className={f.name === "_pad" ? "opacity-50 italic" : ""}>
                      <td className="py-2 opacity-50">+{f.offset}</td>
                      <td className="py-2 font-medium">
                        {f.name}{f.widened && <span className="ml-2"><Pill tone="mod">widened</Pill></span>}
                      </td>
                      <td className="py-2 text-accent">{f.type}</td>
                      <td className="py-2">{f.size}{f.pad ? ` (+${f.pad}p)` : ""}</td>
                      <td className="py-2 opacity-60">{f.range || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>
          </>
        )}

        {type.kind === "enum" && (
          <Section label="variants">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
              {type.variants.map((v) => (
                <div key={v.tag} className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-ink/5 dark:border-paper/5 bg-ink/[0.02] dark:bg-paper/[0.02]">
                  <span className="text-[10px] w-5 h-5 rounded-full bg-ink text-paper dark:bg-paper dark:text-night flex items-center justify-center">{v.tag}</span>
                  <span className="text-[12px] font-medium flex-1">{v.name}</span>
                  {v.added && <Pill tone="added">new</Pill>}
                </div>
              ))}
            </div>
          </Section>
        )}

        {type.kind === "alias" && (
          <div className="flex items-baseline gap-3 p-3 rounded bg-ink/[0.03] dark:bg-paper/[0.03]">
            <span className="font-bold">{type.name}</span>
            <span className="opacity-40">≡</span>
            <span className="text-accent">{type.aliasOf}</span>
          </div>
        )}
      </div>
    </article>
  );
}

function Section({ label, children }) {
  return (
    <section className="space-y-2">
      <h4 className="text-[10px] uppercase tracking-[0.2em] opacity-50">{label}</h4>
      {children}
    </section>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────
function ThemeSwitch({ value, onChange }) {
  const opts = [
    { v: "light",  l: "☀", title: "Light" },
    { v: "system", l: "◐", title: "System" },
    { v: "dark",   l: "☾", title: "Dark" },
  ];
  return (
    <div className="inline-flex rounded border border-ink/15 dark:border-paper/15 p-0.5 text-[11px]">
      {opts.map((o) => (
        <button key={o.v} onClick={() => onChange(o.v)} title={o.title}
          className={`px-2 py-0.5 rounded-sm leading-none ${
            value === o.v
              ? "bg-ink text-paper dark:bg-paper dark:text-night"
              : "opacity-60 hover:opacity-100"
          }`}>{o.l}</button>
      ))}
    </div>
  );
}

function Sidebar({ data, activeVersion, onVersion, onJump, onSearch, onCompare, themeMode, onThemeMode }) {
  const v = data.versions.find((x) => x.id === activeVersion);
  return (
    <aside className="w-64 border-r border-ink/10 dark:border-paper/10 sticky top-0 h-screen overflow-y-auto bg-paper/70 dark:bg-night/70 backdrop-blur p-5 space-y-5 shrink-0">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Wordmark size={17} />
          {onThemeMode && <ThemeSwitch value={themeMode} onChange={onThemeMode} />}
        </div>
        <div className="text-[10px] opacity-50 uppercase tracking-wider px-1">{data.meta.project} · {data.meta.layout.toLowerCase()}</div>
      </div>

      <button onClick={onSearch}
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded border border-ink/10 dark:border-paper/10 hover:border-accent text-left text-[12px] opacity-70 hover:opacity-100 transition-colors">
        <span className="opacity-60">⌕</span>
        <span>Search types…</span>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 border border-current/20 rounded">⌘K</span>
      </button>

      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-[0.18em] opacity-50">version</div>
        <div className="flex gap-1.5">
          {data.versions.map((vv) => (
            <button key={vv.id} onClick={() => onVersion(vv.id)}
                    className={`flex-1 px-2.5 py-1.5 rounded border text-left transition-colors ${
                      vv.id === activeVersion
                        ? 'border-ink dark:border-paper bg-ink text-paper dark:bg-paper dark:text-night'
                        : 'border-ink/15 dark:border-paper/15 hover:border-current/40'
                    }`}>
              <div className="text-[13px] font-bold">{vv.id}</div>
              <div className="text-[10px] opacity-60">{vv.released}</div>
            </button>
          ))}
        </div>
        <button onClick={onCompare}
                className="w-full flex items-center justify-between px-2.5 py-1.5 rounded border border-dashed border-ink/15 dark:border-paper/15 text-[11px] opacity-70 hover:opacity-100 hover:border-accent hover:text-accent">
          <span>compare versions</span><span>→</span>
        </button>
      </div>

      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-[0.18em] opacity-50">{v.label.toLowerCase()} · {v.types.length} types</div>
        <ul className="space-y-px">
          {v.types.map((t) => (
            <li key={t.name}>
              <a href={`#t-${v.id.replace(".","_")}-${t.name}`}
                 onClick={(e) => { e.preventDefault(); onJump(t.name); }}
                 className="flex items-center gap-2 px-2 py-1.5 rounded text-[12px] hover:bg-accent/10 hover:text-accent">
                <span className={`w-4 text-center text-[10px] ${KIND[t.kind].text}`}>
                  {t.kind === "struct" ? "{" : t.kind === "enum" ? "|" : "≡"}
                </span>
                <span className="flex-1 truncate">{t.name}</span>
                <span className="text-[10px] opacity-50">{t.size}b</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

// ── Command palette ───────────────────────────────────────────────────────
function CommandPalette({ open, data, onClose, onPick }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);

  const items = useMemo(() => {
    const all = [];
    data.versions.forEach((v) => v.types.forEach((t) => all.push({ version: v, type: t })));
    if (!q.trim()) return all;
    const n = q.toLowerCase();
    return all.filter((it) => it.type.name.toLowerCase().includes(n) || it.type.kind.includes(n) || it.version.id.includes(n));
  }, [q, data]);

  useEffect(() => { if (open) { setQ(""); setIdx(0); setTimeout(() => inputRef.current?.focus(), 30); } }, [open]);
  useEffect(() => { setIdx(0); }, [q]);

  if (!open) return null;
  const onKey = (e) => {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") { e.preventDefault(); setIdx((i) => Math.min(items.length - 1, i + 1)); }
    else if (e.key === "ArrowUp")   { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === "Enter" && items[idx]) onPick(items[idx]);
  };
  return (
    <div className="fixed inset-0 z-50 bg-night/40 backdrop-blur-sm flex items-start justify-center pt-[12vh]" onClick={onClose}>
      <div className="w-[540px] max-w-[92vw] bg-paper dark:bg-night border border-ink/15 dark:border-paper/15 rounded-lg shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-ink/10 dark:border-paper/10">
          <span className="opacity-50">⌕</span>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey}
                 placeholder="Find a type, kind, or version…"
                 className="flex-1 bg-transparent outline-none text-[14px] placeholder:opacity-50" />
          <span className="text-[10px] opacity-50 px-1.5 py-0.5 border border-current/20 rounded">esc</span>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-1">
          {items.length === 0 && <div className="p-6 text-center opacity-50 text-[12px]">no matches</div>}
          {items.map((it, i) => (
            <div key={`${it.version.id}-${it.type.name}`}
                 onMouseEnter={() => setIdx(i)}
                 onClick={() => onPick(it)}
                 className={`flex items-center gap-2.5 px-3 py-2 rounded text-[12px] cursor-pointer ${i === idx ? 'bg-accent/10' : ''}`}>
              <span className={`w-6 text-center text-[10px] ${KIND[it.type.kind].text}`}>{KIND[it.type.kind].glyph}</span>
              <span className="font-medium">{it.type.name}</span>
              <span className="text-[10px] opacity-50 uppercase tracking-wider">{it.type.kind}</span>
              <span className="flex-1" />
              <span className="text-[10px] opacity-60 px-1.5 py-0.5 rounded bg-ink/5 dark:bg-paper/5">{it.version.id}</span>
              <span className="text-[10px] opacity-50">{it.type.size}b</span>
            </div>
          ))}
        </div>
        <div className="flex gap-3 px-4 py-2 border-t border-ink/10 dark:border-paper/10 text-[10px] opacity-60">
          <span><kbd className="px-1 border border-current/20 rounded">↑↓</kbd> nav</span>
          <span><kbd className="px-1 border border-current/20 rounded">↵</kbd> jump</span>
          <span><kbd className="px-1 border border-current/20 rounded">esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}

// ── Diff summary + Compare overlay ────────────────────────────────────────
function DiffSummary({ diff, onJump }) {
  const stats = useMemo(() => {
    const s = { added:0, removed:0, modified:0, unchanged:0 };
    diff.changes.forEach((c) => s[c.status]++);
    return s;
  }, [diff]);
  return (
    <section className="border border-ink/10 dark:border-paper/10 rounded-lg p-5 mt-12 space-y-4">
      <div className="flex items-baseline gap-3 flex-wrap">
        <h2 className="text-base font-bold tracking-tight">changes</h2>
        <span className="opacity-50">{diff.from}</span>
        <span className="opacity-40">→</span>
        <span className="text-accent font-bold">{diff.to}</span>
        <div className="flex-1" />
        <div className="flex gap-3 text-[11px] opacity-70">
          <span><b className="text-good">{stats.added}</b> added</span>
          <span><b className="text-warn">{stats.modified}</b> modified</span>
          <span><b className="text-bad">{stats.removed}</b> removed</span>
          <span className="opacity-60"><b>{stats.unchanged}</b> unchanged</span>
        </div>
      </div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-wider opacity-50">
            <th className="text-left font-normal py-1.5">type</th>
            <th className="text-left font-normal py-1.5">status</th>
            <th className="text-left font-normal py-1.5">note</th>
            <th></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-ink/5 dark:divide-paper/5">
          {diff.changes.map((c) => (
            <tr key={c.type}>
              <td className="py-2 font-medium">{c.type}</td>
              <td className="py-2"><StatusPill status={c.status} /></td>
              <td className="py-2 opacity-70">{c.note}</td>
              <td className="py-2 text-right">
                <button onClick={() => onJump(c.type)} className="text-[11px] opacity-60 hover:opacity-100 hover:text-accent">view →</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function CompareOverlay({ open, data, onClose, memMode }) {
  if (!open) return null;
  const a = data.versions[0], b = data.versions[data.versions.length - 1];
  const allNames = Array.from(new Set([...a.types.map((t) => t.name), ...b.types.map((t) => t.name)]));
  const find = (v, name) => v.types.find((t) => t.name === name);

  return (
    <div className="fixed inset-0 z-40 bg-night/50 backdrop-blur-sm flex p-[3vh]" onClick={onClose}>
      <div className="flex-1 bg-paper dark:bg-night border border-ink/15 dark:border-paper/15 rounded-xl flex flex-col overflow-hidden shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between px-6 py-4 border-b border-ink/10 dark:border-paper/10">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] opacity-50">side-by-side</div>
            <h2 className="text-base font-bold tracking-tight">{a.label} <span className="text-accent mx-2">→</span> {b.label}</h2>
          </div>
          <button onClick={onClose} className="px-3 py-1 rounded border border-current/20 text-[11px] uppercase tracking-wider hover:text-accent hover:border-accent">close ✕</button>
        </header>
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {allNames.map((name) => {
            const ta = find(a, name), tb = find(b, name);
            const status = !ta ? "added" : !tb ? "removed" : (JSON.stringify(ta) !== JSON.stringify(tb)) ? "modified" : "unchanged";
            return (
              <div key={name} className={`border border-ink/10 dark:border-paper/10 rounded-lg overflow-hidden ${
                status === "modified" ? "border-l-2 border-l-warn" :
                status === "added" ? "border-l-2 border-l-good" :
                status === "removed" ? "border-l-2 border-l-bad" : ""
              }`}>
                <div className="flex items-center gap-3 px-4 py-2.5 border-b border-ink/5 dark:border-paper/5">
                  <h3 className="font-bold">{name}</h3>
                  <StatusPill status={status} />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 divide-x divide-dashed divide-ink/10 dark:divide-paper/10">
                  <CompareCol label={a.id} type={ta} memMode={memMode} />
                  <CompareCol label={b.id} type={tb} memMode={memMode} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CompareCol({ label, type, memMode }) {
  return (
    <div className="p-4 space-y-3">
      <div className="text-[10px] uppercase tracking-[0.2em] opacity-50">{label}</div>
      {!type ? <div className="py-6 text-center italic opacity-50 text-[12px]">— not present —</div> : (
        <>
          <div className="text-[11px] opacity-60">{type.size}b · align {type.align} · {type.kind}</div>
          {type.fields && (memMode === "grid" ? <MemGrid type={type} /> : <MemBars type={type} />)}
          {type.fields && (
            <ul className="text-[12px] divide-y divide-ink/5 dark:divide-paper/5">
              {type.fields.filter((f) => f.size > 0).map((f) => (
                <li key={f.name} className="flex justify-between py-1.5"><b>{f.name}</b><span className="text-accent">{f.type}</span></li>
              ))}
            </ul>
          )}
          {type.variants && (
            <ul className="text-[12px] divide-y divide-ink/5 dark:divide-paper/5">
              {type.variants.map((v) => (
                <li key={v.tag} className="flex items-center gap-2 py-1.5">
                  <span className="opacity-50 w-4">{v.tag}</span><b className="flex-1">{v.name}</b>
                  {v.added && <Pill tone="added">new</Pill>}
                </li>
              ))}
            </ul>
          )}
          {type.aliasOf && <div className="text-[12px]"><span className="opacity-50">≡</span> <span className="text-accent">{type.aliasOf}</span></div>}
        </>
      )}
    </div>
  );
}

Object.assign(window, { Lollipop, Wordmark, TypeCard, Sidebar, CommandPalette, DiffSummary, CompareOverlay, StatusPill });
