// Schema-Pop docs — main app. Wires everything; minimal, Tailwind-only.

const TWEAKS = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "memMode": "proportional",
  "accent": "#f7567c"
}/*EDITMODE-END*/;

function App() {
  const data = window.SCHEMA_DATA;
  const [tweaks, setTweak] = useTweaks(TWEAKS);
  const [activeVersion, setActiveVersion] = React.useState(data.versions[data.versions.length - 1].id);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [compareOpen, setCompareOpen] = React.useState(false);
  const [systemDark, setSystemDark] = React.useState(() =>
    typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
  // theme: "system" | "light" | "dark"
  const [themeMode, setThemeMode] = React.useState("system");

  React.useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (e) => setSystemDark(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const isDark = themeMode === "system" ? systemDark : themeMode === "dark";
  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", isDark);
  }, [isDark]);

  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setSearchOpen((s) => !s); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const jumpTo = (typeName, versionId) => {
    const vId = versionId || activeVersion;
    const el = document.getElementById(`t-${vId.replace(".","_")}-${typeName}`);
    if (el) {
      const y = el.getBoundingClientRect().top + window.scrollY - 24;
      window.scrollTo({ top: y, behavior: "smooth" });
    }
  };

  const handlePick = (it) => {
    setActiveVersion(it.version.id);
    setSearchOpen(false);
    setTimeout(() => jumpTo(it.type.name, it.version.id), 100);
  };

  const handleAnchor = (anchor) => {
    const url = new URL(window.location.href);
    url.hash = anchor;
    navigator.clipboard?.writeText(url.toString());
  };

  const lastDiff = data.diffs[data.diffs.length - 1];
  const totalTypes = Array.from(new Set(data.versions.flatMap((v) => v.types.map((t) => t.name)))).length;

  return (
    <div className="flex min-h-screen" style={{ "--tw-prose": tweaks.accent }}>
      <Sidebar
        data={data}
        activeVersion={activeVersion}
        onVersion={setActiveVersion}
        onJump={(name) => jumpTo(name)}
        onSearch={() => setSearchOpen(true)}
        onCompare={() => setCompareOpen(true)}
        themeMode={themeMode}
        onThemeMode={setThemeMode}
      />

      <main className="flex-1 px-10 py-10 max-w-5xl space-y-12">
        {/* Hero */}
        <header className="space-y-3 pb-8 border-b border-ink/10 dark:border-paper/10">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.2em] opacity-60">
            <span className="w-1.5 h-1.5 rounded-full bg-good" />
            <span>schema-pop report</span>
            <span className="opacity-40">/</span>
            <span>{data.meta.layout.toLowerCase()}</span>
            <span className="opacity-40">/</span>
            <span>{data.versions.length} versions</span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">{data.meta.project}</h1>
          <p className="text-[13px] opacity-70 max-w-2xl">
            Tracking <b>{totalTypes} unique types</b> across versions <b>{data.versions[0].id}</b> through <b>{data.versions[data.versions.length - 1].id}</b>.
            Generated {new Date(data.meta.generated).toLocaleString()}.
          </p>
        </header>

        {/* Versions */}
        {data.versions.map((v) => (
          <section key={v.id} id={`v-${v.id.replace(".","_")}`} className="space-y-6">
            <header className="flex items-baseline gap-4 sticky top-0 bg-paper/90 dark:bg-night/90 backdrop-blur py-3 -mx-2 px-2 z-10 border-b border-ink/15 dark:border-paper/15">
              <div className="text-2xl font-bold tracking-tight">
                <span className="text-accent text-base mr-1 font-normal">v</span>{v.id}
              </div>
              <div className="text-[11px] opacity-60">
                <div><b>{v.label}</b></div>
                <div>released {v.released}</div>
              </div>
              <div className="flex-1" />
              <div className="text-[10px] uppercase tracking-wider opacity-50">{v.types.length} types · {v.types.reduce((s, t) => s + t.size, 0)}b total</div>
            </header>

            {v.summary && (
              <p className="italic opacity-70 border-l-2 border-ink/10 dark:border-paper/10 pl-3 max-w-2xl text-[12px]">
                {v.summary}
              </p>
            )}

            <div className="space-y-6">
              {v.types.map((t) => (
                <TypeCard key={t.name} type={t} version={v} memMode={tweaks.memMode} onAnchor={handleAnchor} />
              ))}
            </div>
          </section>
        ))}

        <DiffSummary diff={lastDiff} onJump={(name) => jumpTo(name, lastDiff.to)} />

        <footer className="pt-6 mt-10 border-t border-dashed border-ink/15 dark:border-paper/15 flex justify-between text-[10px] uppercase tracking-[0.15em] opacity-50">
          <span>schema-pop · independent design</span>
          <a href="#" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: "smooth" }); }} className="hover:text-accent">↑ top</a>
        </footer>
      </main>

      <CommandPalette open={searchOpen} data={data} onClose={() => setSearchOpen(false)} onPick={handlePick} />
      <CompareOverlay open={compareOpen} data={data} onClose={() => setCompareOpen(false)} memMode={tweaks.memMode} />

      <TweaksPanel title="Tweaks">
        <TweakSection title="theme">
          <TweakRadio value={tweaks.theme} onChange={(v) => setTweak("theme", v)}
            options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }]} />
        </TweakSection>
        <TweakSection title="memory layout">
          <TweakRadio value={tweaks.memMode} onChange={(v) => setTweak("memMode", v)}
            options={[{ value: "proportional", label: "Bars" }, { value: "grid", label: "Grid" }]} />
        </TweakSection>
        <TweakSection title="accent">
          <div style={{ display: "flex", gap: 6 }}>
            {["#f7567c", "#404e7c", "#1f8a5a", "#c47a08", "#9b5de5"].map((c) => (
              <button key={c} onClick={() => setTweak("accent", c)}
                style={{ width: 24, height: 24, borderRadius: "50%", background: c,
                         border: tweaks.accent === c ? "2px solid currentColor" : "1px solid rgba(0,0,0,0.15)",
                         cursor: "pointer" }} />
            ))}
          </div>
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
