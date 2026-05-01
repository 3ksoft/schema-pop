// Inline JSX bundle delivered to the browser via Babel standalone.
// Kept as a TS template literal so it ships through bun build into one HTML.

export function htmlAppScript(): string {
	return APP_SOURCE;
}

const APP_SOURCE = `
const { useState, useEffect, useMemo, useRef } = React;

const KIND = {
  struct: { glyph: "{ }", text: "text-dusk dark:text-blue-300" },
  enum:   { glyph: "| |", text: "text-accent" },
  union:  { glyph: "+/+", text: "text-warn dark:text-amber-300" },
  alias:  { glyph: "≡",   text: "text-good dark:text-emerald-400" },
};

function Wordmark({ size = 18 }) {
  return (
    <span className="inline-flex items-baseline font-black tracking-tight whitespace-nowrap" style={{ fontSize: size, lineHeight: 1 }}>
      <span>schema-pop</span>
      <span className="ml-1 inline-block w-1.5 h-1.5 rounded-full bg-accent" style={{ transform: "translateY(-0.05em)" }} />
    </span>
  );
}

function StatusPill({ status }) {
  const map = {
    added:     "text-good border-good/40 bg-good/10",
    modified:  "text-warn border-warn/40 bg-warn/10",
    removed:   "text-bad border-bad/40 bg-bad/10",
    renamed:   "text-dusk border-dusk/40 bg-dusk/10",
    unchanged: "text-ink/50 dark:text-paper/40 border-current/20",
  };
  return <span className={"inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[10px] uppercase tracking-wider " + (map[status] || map.unchanged)}>{status}</span>;
}

function Pill({ tone = "muted", children }) {
  const map = {
    added: "text-good bg-good/10",
    mod:   "text-warn bg-warn/10",
    muted: "text-ink/60 dark:text-paper/50 bg-ink/5 dark:bg-paper/5",
  };
  return <span className={"inline-block px-2 py-0.5 rounded text-[10px] uppercase tracking-wider " + map[tone]}>{children}</span>;
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

function Section({ label, right, children }) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-[10px] uppercase tracking-[0.2em] opacity-50">{label}</h4>
        {right}
      </div>
      {children}
    </section>
  );
}

function ModeToggle({ value, onChange }) {
  const opts = [{v:"bars",l:"Bars"},{v:"grid",l:"Grid"}];
  return (
    <div className="inline-flex rounded border border-current/15 p-0.5 text-[10px]">
      {opts.map(o => (
        <button key={o.v} onClick={() => onChange(o.v)}
          className={"px-2 py-0.5 rounded-sm leading-none uppercase tracking-wider " +
            (value === o.v ? "bg-ink text-paper dark:bg-paper dark:text-night" : "opacity-60 hover:opacity-100")}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

function SvgEmbed({ markup }) {
  if (!markup) return <div className="text-[11px] italic opacity-50">— no viz —</div>;
  return <div className="sp-viz-host overflow-x-auto" dangerouslySetInnerHTML={{ __html: markup }} />;
}

function TypeCard({ type, version, mode, onAnchor, onJump }) {
  const id = "t-" + version.id.split(".").join("_") + "-" + type.name;
  const k = KIND[type.kind] || KIND.struct;
  const totalSize = type.paddedSize || type.size;
  const svgMarkup = mode === "grid" ? type.svgGrid : type.svgBars;
  return (
    <article id={id} className="group border border-ink/10 dark:border-paper/10 rounded-lg bg-paper/40 dark:bg-paper/[0.02] hover:border-ink/20 dark:hover:border-paper/20 transition-colors scroll-mt-24">
      <header className="flex items-center gap-3 px-5 py-4 border-b border-ink/5 dark:border-paper/5 flex-wrap">
        <span className={"text-[10px] uppercase tracking-[0.18em] " + k.text}>{k.glyph} {type.kind}</span>
        <h3 className={"text-base font-bold tracking-tight " + (type.obsolete ? "line-through opacity-60" : "")}>{type.name}</h3>
        {type.obsolete && (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] uppercase tracking-wider text-warn bg-warn/10 border border-warn/40" title={type.obsoleteReason || "deprecated"}>
            obsolete
          </span>
        )}
        <div className="flex-1" />
        <span className="text-[10px] opacity-50 uppercase tracking-wider">{totalSize}b · align {type.align}</span>
        <button onClick={() => onAnchor(version.id + "/" + type.name)} className="text-[11px] opacity-40 hover:opacity-100 hover:text-accent" title="Copy permalink">#</button>
        <CopyBtn text={version.id + "/" + type.name} label="link" />
      </header>

      <div className="px-5 py-4 space-y-4">
        {type.obsolete && type.obsoleteReason && (
          <p className="italic text-warn border-l-2 border-warn/60 pl-3 text-[12px] leading-relaxed">DEPRECATED · {type.obsoleteReason}</p>
        )}
        {type.docstring && (
          <p className="italic text-ink/70 dark:text-paper/60 border-l-2 border-accent/60 pl-3 text-[12px] leading-relaxed">{type.docstring}</p>
        )}

        {(type.kind === "struct" || type.kind === "union") && (
          <Section label="memory layout">
            <SvgEmbed markup={svgMarkup} />
          </Section>
        )}

        {type.kind === "struct" && (
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
                  <tr key={i} className={f.obsolete ? "opacity-60" : ""}>
                    <td className="py-2 opacity-50 font-mono">+{f.offset}</td>
                    <td className={"py-2 font-medium " + (f.obsolete ? "line-through" : "")}>
                      {f.name}
                      {f.obsolete && (
                        <span className="ml-2 inline-flex items-center px-1.5 py-0.5 rounded text-[9px] uppercase tracking-wider text-warn bg-warn/10 border border-warn/40 no-underline" title={f.obsoleteReason || "deprecated"}>
                          obsolete
                        </span>
                      )}
                    </td>
                    <td className="py-2 text-accent font-mono" dangerouslySetInnerHTML={{ __html: f.type }} />
                    <td className="py-2 font-mono">{f.size}{f.pad ? " (+" + f.pad + "p)" : ""}</td>
                    <td className="py-2 opacity-60">{f.obsolete && f.obsoleteReason ? f.obsoleteReason : (f.range || "—")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
        )}

        {type.kind === "union" && (
          <Section label={"variants · tag " + type.tagType + " @ +" + type.tagOffset}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
              {type.variants.map((v, i) => (
                <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-ink/5 dark:border-paper/5 bg-ink/[0.02] dark:bg-paper/[0.02]">
                  <span className="text-[10px] w-5 h-5 rounded-full bg-ink text-paper dark:bg-paper dark:text-night flex items-center justify-center font-mono">{i}</span>
                  <span className="text-[12px] font-medium flex-1">{v.name}</span>
                  <span className="text-[11px] opacity-60 font-mono" dangerouslySetInnerHTML={{ __html: v.type }} />
                </div>
              ))}
            </div>
          </Section>
        )}

        {type.kind === "enum" && (
          <Section label={"variants · " + (type.underlyingType || "u8")}>
            <SvgEmbed markup={svgMarkup} />
            <div className="grid grid-cols-2 md:grid-cols-3 gap-1.5">
              {type.variants.map((v) => (
                <div key={v.name} className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-ink/5 dark:border-paper/5 bg-ink/[0.02] dark:bg-paper/[0.02]">
                  <span className="text-[10px] w-5 h-5 rounded-full bg-ink text-paper dark:bg-paper dark:text-night flex items-center justify-center font-mono">{v.value}</span>
                  <span className="text-[12px] font-medium flex-1">{v.name}</span>
                </div>
              ))}
            </div>
          </Section>
        )}

        {type.kind === "alias" && (
          <div className="flex items-baseline gap-3 p-3 rounded bg-ink/[0.03] dark:bg-paper/[0.03]">
            <span className="font-bold">{type.name}</span>
            <span className="opacity-40">≡</span>
            <span className="text-accent font-mono" dangerouslySetInnerHTML={{ __html: type.aliasOf }} />
          </div>
        )}
      </div>
    </article>
  );
}

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
          className={"px-2 py-0.5 rounded-sm leading-none " +
            (value === o.v ? "bg-ink text-paper dark:bg-paper dark:text-night" : "opacity-60 hover:opacity-100")}>{o.l}</button>
      ))}
    </div>
  );
}

function Sidebar({ data, activeVersion, onVersion, onJump, onSearch, onCompare, themeMode, onThemeMode, mode, onMode }) {
  const v = data.versions.find((x) => x.id === activeVersion) || data.versions[0];
  if (!v) return null;
  return (
    <aside className="w-64 border-r border-ink/10 dark:border-paper/10 sticky top-0 h-screen overflow-y-auto bg-paper/70 dark:bg-night/70 backdrop-blur p-5 space-y-5 shrink-0">
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Wordmark size={17} />
          <ThemeSwitch value={themeMode} onChange={onThemeMode} />
        </div>
        <div className="text-[10px] opacity-50 uppercase tracking-wider px-1">{(data.meta && data.meta.layout) || ""}</div>
      </div>

      <button onClick={onSearch} className="w-full flex items-center gap-2 px-2.5 py-2 rounded border border-ink/10 dark:border-paper/10 hover:border-accent text-left text-[12px] opacity-70 hover:opacity-100 transition-colors">
        <span className="opacity-60">⌕</span><span>Search types…</span>
        <span className="ml-auto text-[10px] px-1.5 py-0.5 border border-current/20 rounded">⌘K</span>
      </button>

      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-[0.18em] opacity-50">version</div>
        <div className="flex flex-wrap gap-1.5">
          {data.versions.map((vv) => (
            <button key={vv.id} onClick={() => onVersion(vv.id)}
              className={"flex-1 min-w-[72px] px-2.5 py-1.5 rounded border text-left transition-colors " +
                (vv.id === activeVersion ? "border-ink dark:border-paper bg-ink text-paper dark:bg-paper dark:text-night" : "border-ink/15 dark:border-paper/15 hover:border-current/40")}>
              <div className="text-[13px] font-bold truncate">{vv.id}</div>
              <div className="text-[10px] opacity-60">{vv.types.length} types</div>
            </button>
          ))}
        </div>
        {data.versions.length > 1 && (
          <button onClick={onCompare} className="w-full flex items-center justify-between px-2.5 py-1.5 rounded border border-dashed border-ink/15 dark:border-paper/15 text-[11px] opacity-70 hover:opacity-100 hover:border-accent hover:text-accent">
            <span>compare versions</span><span>→</span>
          </button>
        )}
      </div>

      <div className="space-y-2">
        <div className="text-[10px] uppercase tracking-[0.18em] opacity-50">layout</div>
        <ModeToggle value={mode} onChange={onMode} />
      </div>

      <div className="space-y-1">
        <div className="text-[10px] uppercase tracking-[0.18em] opacity-50">{v.id} · {v.types.length} types</div>
        <ul className="space-y-px">
          {v.types.map((t) => (
            <li key={t.name}>
              <a href={"#t-" + v.id.split(".").join("_") + "-" + t.name}
                 onClick={(e) => { e.preventDefault(); onJump(t.name, v.id); }}
                 className="flex items-center gap-2 px-2 py-1.5 rounded text-[12px] hover:bg-accent/10 hover:text-accent">
                <span className={"w-4 text-center text-[10px] " + ((KIND[t.kind] || KIND.struct).text)}>
                  {t.kind === "struct" ? "{" : t.kind === "enum" ? "|" : t.kind === "union" ? "+" : "≡"}
                </span>
                <span className={"flex-1 truncate font-mono " + (t.obsolete ? "line-through opacity-60" : "")}>{t.name}</span>
                <span className="text-[10px] opacity-50 font-mono">{(t.paddedSize || t.size)}b</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

function CommandPalette({ open, data, onClose, onPick }) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);

  const items = useMemo(() => {
    const all = [];
    data.versions.forEach((v) => v.types.forEach((t) => all.push({ version: v, type: t })));
    if (!q.trim()) return all;
    const n = q.toLowerCase();
    return all.filter((it) => it.type.name.toLowerCase().includes(n) || it.type.kind.includes(n) || it.version.id.toLowerCase().includes(n));
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
            <div key={it.version.id + "-" + it.type.name}
                 onMouseEnter={() => setIdx(i)} onClick={() => onPick(it)}
                 className={"flex items-center gap-2.5 px-3 py-2 rounded text-[12px] cursor-pointer " + (i === idx ? "bg-accent/10" : "")}>
              <span className={"w-6 text-center text-[10px] " + (KIND[it.type.kind] || KIND.struct).text}>{(KIND[it.type.kind] || KIND.struct).glyph}</span>
              <span className="font-medium">{it.type.name}</span>
              <span className="text-[10px] opacity-50 uppercase tracking-wider">{it.type.kind}</span>
              <span className="flex-1" />
              <span className="text-[10px] opacity-60 px-1.5 py-0.5 rounded bg-ink/5 dark:bg-paper/5 font-mono">{it.version.id}</span>
              <span className="text-[10px] opacity-50 font-mono">{(it.type.paddedSize || it.type.size)}b</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FunctionsList({ functions }) {
  return (
    <section className="border border-ink/10 dark:border-paper/10 rounded-lg p-5 mt-6">
      <header className="flex items-baseline gap-3 mb-4">
        <h2 className="text-base font-bold tracking-tight">functions</h2>
        <span className="text-[11px] opacity-60">{functions.length}</span>
        <span className="flex-1" />
      </header>
      <div className="space-y-3">
        {functions.map((fn) => (
          <article key={fn.symbol} className="border-l-2 border-accent/40 pl-3 py-1">
            <div className="flex items-baseline gap-2 flex-wrap">
              <code className="font-mono text-[13px] font-semibold">{fn.name}</code>
              {fn.abi && (
                <span className="text-[10px] uppercase tracking-wider opacity-60 font-mono">extern "{fn.abi}"</span>
              )}
              {fn.symbol && fn.symbol !== fn.name && (
                <span className="text-[10px] opacity-50 font-mono">{fn.symbol}</span>
              )}
              {fn.obsolete && (
                <span className="text-[10px] uppercase tracking-wider text-bad font-mono">deprecated{fn.obsoleteReason ? ": " + fn.obsoleteReason : ""}</span>
              )}
            </div>
            <div className="font-mono text-[12px] opacity-80 mt-0.5">
              <span className="opacity-50">{fn.name}(</span>
              {fn.args.length === 0 ? null : fn.args.map((a, i) => (
                <span key={i}>
                  {a.name && <span className="opacity-70">{a.name}: </span>}
                  <span dangerouslySetInnerHTML={{ __html: a.label }} />
                  {i < fn.args.length - 1 && <span className="opacity-50">, </span>}
                </span>
              ))}
              <span className="opacity-50">) → </span>
              <span dangerouslySetInnerHTML={{ __html: fn.returnLabel }} />
            </div>
            {fn.description && (
              <p className="text-[11px] opacity-70 mt-1">{fn.description}</p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function DiffSummary({ diff, onJump }) {
  const stats = useMemo(() => {
    const s = { added:0, removed:0, modified:0, renamed:0, unchanged:0 };
    diff.changes.forEach((c) => { s[c.status] = (s[c.status] || 0) + 1; });
    return s;
  }, [diff]);
  return (
    <section className="border border-ink/10 dark:border-paper/10 rounded-lg p-5 mt-12 space-y-4">
      <div className="flex items-baseline gap-3 flex-wrap">
        <h2 className="text-base font-bold tracking-tight">changes</h2>
        <span className="opacity-50 font-mono">{diff.from}</span>
        <span className="opacity-40">→</span>
        <span className="text-accent font-bold font-mono">{diff.to}</span>
        <div className="flex-1" />
        <div className="flex gap-3 text-[11px] opacity-70">
          <span><b className="text-good">{stats.added}</b> added</span>
          <span><b className="text-warn">{stats.modified}</b> modified</span>
          <span><b className="text-bad">{stats.removed}</b> removed</span>
          {stats.renamed > 0 && <span><b className="text-dusk">{stats.renamed}</b> renamed</span>}
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
              <td className="py-2 font-medium font-mono">{c.type}</td>
              <td className="py-2"><StatusPill status={c.status} /></td>
              <td className="py-2 opacity-70">{c.note}</td>
              <td className="py-2 text-right">
                <button onClick={() => onJump(c.type, diff.to)} className="text-[11px] opacity-60 hover:opacity-100 hover:text-accent">view →</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function CompareCol({ label, type, mode }) {
  return (
    <div className="p-4 space-y-3">
      <div className="text-[10px] uppercase tracking-[0.2em] opacity-50 font-mono">{label}</div>
      {!type ? <div className="py-6 text-center italic opacity-50 text-[12px]">— not present —</div> : (
        <>
          <div className="text-[11px] opacity-60">{(type.paddedSize || type.size)}b · align {type.align} · {type.kind}</div>
          <SvgEmbed markup={mode === "grid" ? type.svgGrid : type.svgBars} />
          {type.kind === "struct" && (
            <ul className="text-[12px] divide-y divide-ink/5 dark:divide-paper/5 font-mono">
              {type.fields.map((f) => (
                <li key={f.name} className="flex justify-between py-1.5"><b>{f.name}</b><span className="text-accent">{f.type}</span></li>
              ))}
            </ul>
          )}
          {(type.kind === "enum" || type.kind === "union") && (
            <ul className="text-[12px] divide-y divide-ink/5 dark:divide-paper/5">
              {type.variants.map((v, i) => (
                <li key={i} className="flex items-center gap-2 py-1.5">
                  <span className="opacity-50 w-4 font-mono">{v.value !== undefined ? v.value : i}</span>
                  <b className="flex-1">{v.name}</b>
                  {v.type && <span className="text-accent font-mono text-[11px]" dangerouslySetInnerHTML={{ __html: v.type }} />}
                </li>
              ))}
            </ul>
          )}
          {type.kind === "alias" && <div className="text-[12px]"><span className="opacity-50">≡</span> <span className="text-accent font-mono" dangerouslySetInnerHTML={{ __html: type.aliasOf }} /></div>}
        </>
      )}
    </div>
  );
}

function CompareOverlay({ open, data, onClose, mode }) {
  if (!open) return null;
  const a = data.versions[0];
  const b = data.versions[data.versions.length - 1];
  const allNames = Array.from(new Set([...a.types.map((t) => t.name), ...b.types.map((t) => t.name)]));
  const find = (v, name) => v.types.find((t) => t.name === name);

  return (
    <div className="fixed inset-0 z-40 bg-night/50 backdrop-blur-sm flex p-[3vh]" onClick={onClose}>
      <div className="flex-1 bg-paper dark:bg-night border border-ink/15 dark:border-paper/15 rounded-xl flex flex-col overflow-hidden shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between px-6 py-4 border-b border-ink/10 dark:border-paper/10">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] opacity-50">side-by-side</div>
            <h2 className="text-base font-bold tracking-tight font-mono">{a.id} <span className="text-accent mx-2">→</span> {b.id}</h2>
          </div>
          <button onClick={onClose} className="px-3 py-1 rounded border border-current/20 text-[11px] uppercase tracking-wider hover:text-accent hover:border-accent">close ✕</button>
        </header>
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {allNames.map((name) => {
            const ta = find(a, name), tb = find(b, name);
            const status = !ta ? "added" : !tb ? "removed" : (JSON.stringify(ta) !== JSON.stringify(tb)) ? "modified" : "unchanged";
            return (
              <div key={name} className={"border border-ink/10 dark:border-paper/10 rounded-lg overflow-hidden " + (
                status === "modified" ? "border-l-2 border-l-warn" :
                status === "added" ? "border-l-2 border-l-good" :
                status === "removed" ? "border-l-2 border-l-bad" : ""
              )}>
                <div className="flex items-center gap-3 px-4 py-2.5 border-b border-ink/5 dark:border-paper/5">
                  <h3 className="font-bold font-mono">{name}</h3>
                  <StatusPill status={status} />
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 divide-x divide-dashed divide-ink/10 dark:divide-paper/10">
                  <CompareCol label={a.id} type={ta} mode={mode} />
                  <CompareCol label={b.id} type={tb} mode={mode} />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function App() {
  const data = window.SCHEMA_POP_DATA;
  const [activeVersion, setActiveVersion] = useState(data.versions.length ? data.versions[data.versions.length - 1].id : "");
  const [mode, setMode] = useState("bars");
  const [searchOpen, setSearchOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [systemDark, setSystemDark] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  const [themeMode, setThemeMode] = useState("system");

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e) => setSystemDark(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const isDark = themeMode === "system" ? systemDark : themeMode === "dark";
  useEffect(() => { document.documentElement.classList.toggle("dark", isDark); }, [isDark]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearchOpen((s) => !s); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const jumpTo = (typeName, versionId) => {
    const vId = versionId || activeVersion;
    if (vId !== activeVersion) setActiveVersion(vId);
    setTimeout(() => {
      const el = document.getElementById("t-" + vId.split(".").join("_") + "-" + typeName);
      if (el) {
        const y = el.getBoundingClientRect().top + window.scrollY - 24;
        window.scrollTo({ top: y, behavior: "smooth" });
      }
    }, 60);
  };

  const handlePick = (it) => {
    setActiveVersion(it.version.id);
    setSearchOpen(false);
    setTimeout(() => jumpTo(it.type.name, it.version.id), 80);
  };

  const handleAnchor = (anchor) => {
    const url = new URL(window.location.href);
    url.hash = anchor;
    navigator.clipboard?.writeText(url.toString());
  };

  if (!data.versions.length) {
    return <main className="p-12 text-[13px] opacity-60">No versions in schema-pop data.</main>;
  }

  const lastDiff = data.diffs[data.diffs.length - 1];
  const totalTypes = Array.from(new Set(data.versions.flatMap((v) => v.types.map((t) => t.name)))).length;
  const activeV = data.versions.find((v) => v.id === activeVersion) || data.versions[0];

  return (
    <div className="flex min-h-screen">
      <Sidebar
        data={data}
        activeVersion={activeVersion}
        onVersion={setActiveVersion}
        onJump={(name, vid) => jumpTo(name, vid)}
        onSearch={() => setSearchOpen(true)}
        onCompare={() => setCompareOpen(true)}
        themeMode={themeMode}
        onThemeMode={setThemeMode}
        mode={mode}
        onMode={setMode}
      />

      <main className="flex-1 px-10 py-10 max-w-5xl space-y-12">
        <header className="space-y-3 pb-8 border-b border-ink/10 dark:border-paper/10">
          <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.2em] opacity-60">
            <img
              src="https://raw.githubusercontent.com/3ksoft/schema-pop/main/docs/logo/schema-pop-wordmark.svg"
              alt="schema-pop"
              className="h-4"
              style={{ width: "auto" }}
            />
            <span className="opacity-40">/</span>
            <span className="w-1.5 h-1.5 rounded-full bg-good" />
            <span>report</span>
            <span className="opacity-40">/</span>
            <span>{(data.meta && data.meta.layout) || "little endian"}</span>
            <span className="opacity-40">/</span>
            <span>{data.versions.length} version{data.versions.length === 1 ? "" : "s"}</span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">{(data.meta && data.meta.project) || "schema"}</h1>
          <p className="text-[13px] opacity-70 max-w-2xl">
            Tracking <b>{totalTypes} unique types</b> across versions <b className="font-mono">{data.versions[0].id}</b> through <b className="font-mono">{data.versions[data.versions.length - 1].id}</b>.
          </p>
        </header>

        <section key={activeV.id} id={"v-" + activeV.id.split(".").join("_")} className="space-y-6">
          <header className="flex items-baseline gap-4 sticky top-0 bg-paper/90 dark:bg-night/90 backdrop-blur py-3 -mx-2 px-2 z-10 border-b border-ink/15 dark:border-paper/15">
            <div className="text-2xl font-bold tracking-tight font-mono">
              <span className="text-accent text-base mr-1 font-normal">v</span>{activeV.id}
            </div>
            <div className="text-[11px] opacity-60">{activeV.types.length} types</div>
            <div className="flex-1" />
            <div className="text-[10px] uppercase tracking-wider opacity-50">{activeV.types.reduce((s, t) => s + (t.paddedSize || t.size), 0)}b total</div>
          </header>

          <div className="space-y-6">
            {activeV.types.map((t) => (
              <TypeCard key={t.name} type={t} version={activeV} mode={mode} onAnchor={handleAnchor} onJump={jumpTo} />
            ))}
          </div>

          {activeV.functions && activeV.functions.length > 0 && (
            <FunctionsList functions={activeV.functions} />
          )}
        </section>

        {lastDiff && <DiffSummary diff={lastDiff} onJump={(name, vid) => jumpTo(name, vid)} />}

        <footer className="pt-6 mt-10 border-t border-dashed border-ink/15 dark:border-paper/15 flex justify-between text-[10px] uppercase tracking-[0.15em] opacity-50">
          <span>schema-pop · auto-generated report</span>
          <a href="#" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }} className="hover:text-accent">↑ top</a>
        </footer>
      </main>

      <CommandPalette open={searchOpen} data={data} onClose={() => setSearchOpen(false)} onPick={handlePick} />
      <CompareOverlay open={compareOpen} data={data} onClose={() => setCompareOpen(false)} mode={mode} />
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
`;
