/** Comments list: every comment of the document with replies, filters, sorting and inline editing. */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Circle,
  Highlighter,
  ImageIcon,
  Minus,
  MessageSquareText,
  PenTool,
  Search,
  Spline,
  Square,
  Stamp,
  StickyNote,
  Strikethrough,
  Type,
  Underline,
  WavesHorizontal,
  Lock,
  Paperclip,
  type LucideIcon,
} from "lucide-react";
import type { DocumentController } from "../../document/DocumentController";
import { useAnnotState, shallowEqual } from "../../hooks/useDoc";
import { useT, useLocale } from "../../i18n";
import { formatRelativeTime } from "../../i18n/format";
import { isReply, kindLabelKey, rgbToCss, type Annotation, type ModelKind } from "../../annotations/model";
import { repliesOf } from "../../annotations/store";
import { Select } from "../common/controls";

const KIND_ICONS: Record<ModelKind, LucideIcon> = {
  highlight: Highlighter,
  underline: Underline,
  strikeout: Strikethrough,
  squiggly: WavesHorizontal,
  note: StickyNote,
  freetext: Type,
  ink: PenTool,
  square: Square,
  circle: Circle,
  line: Minus,
  polygon: Spline,
  polyline: Spline,
  stamp: Stamp,
  other: Paperclip,
};

type SortKey = "page" | "date" | "author" | "type";

const CommentCard = memo(function CommentCard({
  c,
  a,
  selected,
  replies,
}: {
  c: DocumentController;
  a: Annotation;
  selected: boolean;
  replies: Annotation[];
}) {
  const t = useT();
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(a.contents);
  const [reply, setReply] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const Icon = a.kind === "stamp" && a.stampImage ? ImageIcon : KIND_ICONS[a.kind];
  const state = c.reviewState(a.id);
  const readOnly = a.locked || !c.canAnnotate;
  const when = a.modified ?? a.created;

  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div
      ref={ref}
      className={`comment-card${selected ? " selected" : ""}`}
      onClick={() => {
        c.select([a.id]);
        c.scrollToRect(a.page, a.rect);
      }}
      onDoubleClick={() => !readOnly && (setDraft(a.contents), setEditing(true))}
    >
      <div className="head">
        <span className="kind-dot" style={{ background: rgbToCss(a.color ?? a.interiorColor, "var(--text-3)") }}>
          <Icon size={13} />
        </span>
        <span className="who">{a.author || t(kindLabelKey(a))}</span>
        {a.locked && <Lock size={12} className="faint" />}
        {state && state !== "None" && <span className={`status-chip ${state}`}>{t(`annots.status.${state.toLowerCase()}` as never)}</span>}
        <span className="spacer" />
        {when && <span className="when">{formatRelativeTime(new Date(when).getTime(), locale)}</span>}
      </div>
      {editing ? (
        <div className="col" onClick={(e) => e.stopPropagation()}>
          <textarea
            className="textarea"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                c.updateAnnotation(a.id, { contents: draft });
                setEditing(false);
              }
            }}
          />
          <div className="actions">
            <button type="button" className="btn small ghost" onClick={() => setEditing(false)}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="btn small primary"
              onClick={() => {
                c.updateAnnotation(a.id, { contents: draft });
                setEditing(false);
              }}
            >
              {t("common.save")}
            </button>
          </div>
        </div>
      ) : (
        <div className={`text${a.contents ? "" : " empty"}`}>{a.contents || t("annots.noText")}</div>
      )}
      {replies.length > 0 && (
        <div className="replies">
          {replies.map((r) => (
            <div key={r.id} className="reply">
              <div className="head">
                <span className="who">{r.author || "—"}</span>
                <span className="spacer" />
                {(r.created ?? r.modified) && <span className="when">{formatRelativeTime(new Date(r.created ?? r.modified!).getTime(), locale)}</span>}
              </div>
              <div className="text">{r.contents}</div>
            </div>
          ))}
        </div>
      )}
      {selected && !readOnly && (
        <form
          className="row"
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            if (reply.trim()) {
              c.addReply(a.id, reply);
              setReply("");
            }
          }}
        >
          <input
            className="input small"
            style={{ flex: 1 }}
            value={reply}
            placeholder={t("annots.addReply")}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
          />
          <button type="submit" className="btn small" disabled={!reply.trim()}>
            {t("annots.reply")}
          </button>
        </form>
      )}
    </div>
  );
});

export function AnnotationsPanel({ c }: { c: DocumentController }) {
  const t = useT();
  const items = useAnnotState(c, (s) => s.items, {} as Record<string, Annotation>);
  const loaded = useAnnotState(c, (s) => s.loaded, false);
  const selection = useAnnotState(c, (s) => s.selection, [] as string[], shallowEqual);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("page");
  const [kind, setKind] = useState<string>("all");
  const [author, setAuthor] = useState<string>("all");

  const top = useMemo(() => Object.values(items).filter((a) => !isReply(a) && a.replyType !== "Group"), [items]);
  const authors = useMemo(() => [...new Set(top.map((a) => a.author).filter(Boolean))].sort(), [top]);
  const kinds = useMemo(() => [...new Set(top.map((a) => a.kind))], [top]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = top.filter(
      (a) =>
        (kind === "all" || a.kind === kind) &&
        (author === "all" || a.author === author) &&
        (!q || a.contents.toLowerCase().includes(q) || a.author.toLowerCase().includes(q)),
    );
    const byPos = (a: Annotation, b: Annotation) => a.page - b.page || b.rect[3] - a.rect[3] || a.rect[0] - b.rect[0];
    switch (sort) {
      case "date":
        return list.sort((a, b) => (b.modified ?? b.created ?? "").localeCompare(a.modified ?? a.created ?? ""));
      case "author":
        return list.sort((a, b) => a.author.localeCompare(b.author) || byPos(a, b));
      case "type":
        return list.sort((a, b) => a.kind.localeCompare(b.kind) || byPos(a, b));
      default:
        return list.sort(byPos);
    }
  }, [top, query, kind, author, sort]);

  const state = c.annotations.getState();

  return (
    <div className="col" style={{ height: "100%", gap: 0 }}>
      <div className="panel-toolbar wrap">
        <div className="search-box">
          <Search size={13} />
          <input className="input small" value={query} placeholder={t("annots.filter")} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <Select
          className="input small"
          ariaLabel={t("annots.sortBy")}
          value={sort}
          onChange={setSort}
          options={[
            { value: "page", label: `${t("annots.sortBy")}: ${t("annots.sort.page")}` },
            { value: "date", label: `${t("annots.sortBy")}: ${t("annots.sort.date")}` },
            { value: "author", label: `${t("annots.sortBy")}: ${t("annots.sort.author")}` },
            { value: "type", label: `${t("annots.sortBy")}: ${t("annots.sort.type")}` },
          ]}
        />
        {kinds.length > 1 && (
          <Select
            className="input small"
            ariaLabel={t("annots.filterType")}
            value={kind}
            onChange={setKind}
            options={[{ value: "all", label: t("annots.allTypes") }, ...kinds.map((k) => ({ value: k, label: t(kindLabelKey({ kind: k, subtype: "", stampImage: null })) }))]}
          />
        )}
        {authors.length > 1 && (
          <Select
            className="input small"
            ariaLabel={t("annots.filterAuthor")}
            value={author}
            onChange={setAuthor}
            options={[{ value: "all", label: t("annots.allAuthors") }, ...authors.map((x) => ({ value: x, label: x }))]}
          />
        )}
      </div>
      <div className="sidebar-body" data-keys="local">
        {!loaded && (
          <div className="empty-state">
            <div className="spinner" />
            {t("annots.loading")}
          </div>
        )}
        {loaded && top.length === 0 && (
          <div className="empty-state">
            <MessageSquareText size={32} />
            {t("annots.empty")}
          </div>
        )}
        <div className="comment-list">
          {loaded && top.length > 0 && <div className="faint" style={{ fontSize: "var(--fs-xs)", padding: "2px 4px" }}>{t("annots.count", { count: filtered.length })}</div>}
          {filtered.map((a, i) => (
            <div key={a.id}>
              {sort === "page" && (i === 0 || filtered[i - 1].page !== a.page) && (
                <div className="comment-page-header">{t("common.page", { page: a.page + 1 })}</div>
              )}
              <CommentCard c={c} a={a} selected={selection.includes(a.id)} replies={repliesOf(state, a.id)} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
