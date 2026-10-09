/** Bookmarks (document outline) tree with filter, expand/collapse and keyboard navigation. */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ChevronsDownUp, ChevronsUpDown, ExternalLink, ListTree, LocateFixed, Search } from "lucide-react";
import type { DocumentController } from "../../document/DocumentController";
import { useDocState } from "../../hooks/useDoc";
import { useT } from "../../i18n";
import { openExternalLink } from "../../document/externalLinks";

interface OutlineItem {
  title: string;
  bold: boolean;
  italic: boolean;
  color: Uint8ClampedArray | null;
  dest: string | unknown[] | null;
  url: string | null;
  count: number | undefined;
  items: OutlineItem[];
}

interface Node {
  key: string;
  item: OutlineItem;
  depth: number;
  parent: string | null;
  children: Node[];
  page: number | null;
}

function buildNodes(items: OutlineItem[], depth = 0, parent: string | null = null, prefix = ""): Node[] {
  return items.map((item, i) => {
    const key = `${prefix}${i}`;
    const node: Node = { key, item, depth, parent, children: [], page: null };
    node.children = buildNodes(item.items ?? [], depth + 1, key, `${key}.`);
    return node;
  });
}

function flatten(nodes: Node[], out: Node[] = []): Node[] {
  for (const n of nodes) {
    out.push(n);
    flatten(n.children, out);
  }
  return out;
}

async function resolvePage(c: DocumentController, dest: string | unknown[] | null): Promise<number | null> {
  const pdf = c.pdf;
  if (!pdf || !dest) return null;
  try {
    const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) return null;
    const ref = explicit[0];
    if (Number.isInteger(ref)) return (ref as number) + 1;
    if (ref && typeof ref === "object") return (await pdf.getPageIndex(ref as never)) + 1;
  } catch {
    // Broken destinations are common; ignore them.
  }
  return null;
}

function highlight(text: string, query: string) {
  if (!query) return text;
  const i = text.toLowerCase().indexOf(query.toLowerCase());
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}

export function OutlinePanel({ c }: { c: DocumentController }) {
  const t = useT();
  const page = useDocState(c, (s) => s.page, 1);
  const [nodes, setNodes] = useState<Node[] | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [pagesVersion, setPagesVersion] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    c.pdf
      ?.getOutline()
      .then(async (outline) => {
        if (!alive) return;
        const built = buildNodes((outline ?? []) as unknown as OutlineItem[]);
        setNodes(built);
        // Items with a positive count are open by default (PDF semantics).
        const open = new Set<string>();
        for (const n of flatten(built)) if ((n.item.count ?? 0) > 0) open.add(n.key);
        setExpanded(open);
        // Resolve page numbers in the background for "current bookmark" tracking.
        const all = flatten(built);
        for (let i = 0; i < all.length; i += 50) {
          await Promise.all(all.slice(i, i + 50).map(async (n) => (n.page = await resolvePage(c, n.item.dest))));
          if (!alive) return;
          setPagesVersion((v) => v + 1);
        }
      })
      .catch(() => alive && setNodes([]));
    return () => {
      alive = false;
    };
  }, [c]);

  const all = useMemo(() => (nodes ? flatten(nodes) : []), [nodes]);

  const currentKey = useMemo(() => {
    let best: Node | null = null;
    for (const n of all) {
      if (n.page !== null && n.page <= page && (!best || n.page >= (best.page ?? 0))) best = n;
    }
    return best?.key ?? null;
    // pagesVersion changes when page numbers were resolved.
  }, [all, page, pagesVersion]);

  const visible = useMemo(() => {
    if (!nodes) return [];
    if (filter.trim()) {
      const q = filter.trim().toLowerCase();
      return all.filter((n) => n.item.title.toLowerCase().includes(q));
    }
    const out: Node[] = [];
    const walk = (list: Node[]) => {
      for (const n of list) {
        out.push(n);
        if (expanded.has(n.key)) walk(n.children);
      }
    };
    walk(nodes);
    return out;
  }, [nodes, all, expanded, filter]);

  // The current bookmark may sit inside a collapsed branch: mark its nearest visible ancestor.
  const shownCurrent = useMemo(() => {
    if (!currentKey) return null;
    const visibleKeys = new Set(visible.map((n) => n.key));
    let key: string | null = currentKey;
    while (key && !visibleKeys.has(key)) key = all.find((n) => n.key === key)?.parent ?? null;
    return key;
  }, [currentKey, visible, all]);

  const activate = (n: Node) => {
    setFocusKey(n.key);
    if (n.item.url) void openExternalLink(n.item.url);
    else if (n.item.dest) c.goToDestination(n.item.dest);
  };

  const toggle = (key: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const revealCurrent = () => {
    if (!currentKey) return;
    const node = all.find((n) => n.key === currentKey);
    const next = new Set(expanded);
    let p = node?.parent ?? null;
    while (p) {
      next.add(p);
      p = all.find((n) => n.key === p)?.parent ?? null;
    }
    setExpanded(next);
    setFocusKey(currentKey);
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-key="${currentKey}"]`)?.scrollIntoView({ block: "center" }));
  };

  if (nodes === null) {
    return (
      <div className="empty-state">
        <div className="spinner" />
      </div>
    );
  }
  if (nodes.length === 0) {
    return (
      <div className="empty-state">
        <ListTree size={32} />
        {t("outline.empty")}
      </div>
    );
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = visible.findIndex((n) => n.key === focusKey);
    const cur = visible[i];
    switch (e.key) {
      case "ArrowDown":
        setFocusKey(visible[Math.min(visible.length - 1, i + 1)]?.key ?? null);
        break;
      case "ArrowUp":
        setFocusKey(visible[Math.max(0, i - 1)]?.key ?? null);
        break;
      case "ArrowRight":
        if (cur && cur.children.length && !expanded.has(cur.key)) toggle(cur.key);
        else if (cur?.children[0]) setFocusKey(cur.children[0].key);
        break;
      case "ArrowLeft":
        if (cur && expanded.has(cur.key)) toggle(cur.key);
        else if (cur?.parent) setFocusKey(cur.parent);
        break;
      case "Enter":
      case " ":
        if (cur) activate(cur);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div className="col" style={{ height: "100%", gap: 0 }}>
      <div className="panel-toolbar">
        <div className="search-box">
          <Search size={13} />
          <input className="input small" value={filter} placeholder={t("outline.filter")} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <button type="button" className="icon-btn small" data-tip={t("outline.findCurrent")} onClick={revealCurrent}>
          <LocateFixed size={14} />
        </button>
        <button type="button" className="icon-btn small" data-tip={t("outline.expandAll")} onClick={() => setExpanded(new Set(all.filter((n) => n.children.length).map((n) => n.key)))}>
          <ChevronsUpDown size={14} />
        </button>
        <button type="button" className="icon-btn small" data-tip={t("outline.collapseAll")} onClick={() => setExpanded(new Set())}>
          <ChevronsDownUp size={14} />
        </button>
      </div>
      <div className="sidebar-body outline-tree" ref={listRef} tabIndex={0} data-keys="local" role="tree" onKeyDown={onKeyDown}>
        {visible.length === 0 && <div className="empty-state">{t("outline.noMatch")}</div>}
        {visible.map((n) => {
          const color = n.item.color && (n.item.color[0] || n.item.color[1] || n.item.color[2]) ? `rgb(${n.item.color[0]} ${n.item.color[1]} ${n.item.color[2]})` : undefined;
          return (
            <div
              key={n.key}
              data-key={n.key}
              role="treeitem"
              aria-expanded={n.children.length ? expanded.has(n.key) : undefined}
              className={`outline-row${shownCurrent === n.key ? " current" : ""}${focusKey === n.key ? " focused" : ""}`}
              style={{ paddingLeft: filter ? 6 : 4 + n.depth * 14 }}
              onClick={() => activate(n)}
            >
              <span
                className={`twisty${expanded.has(n.key) ? " open" : ""}`}
                style={{ visibility: n.children.length && !filter ? "visible" : "hidden" }}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(n.key);
                }}
              >
                <ChevronRight size={14} />
              </span>
              <span className={`title${n.item.bold ? " bold" : ""}${n.item.italic ? " italic" : ""}`} style={{ color }}>
                {highlight(n.item.title, filter.trim())}
              </span>
              {n.item.url && <ExternalLink size={12} className="faint" style={{ marginTop: 3 }} />}
              {n.page !== null && <span className="faint" style={{ fontSize: "var(--fs-xs)", marginTop: 2 }}>{n.page}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
