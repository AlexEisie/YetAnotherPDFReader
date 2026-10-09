/** Find bar (Ctrl+F): incremental search with case / whole-word / diacritics options. */
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X, CaseSensitive, WholeWord, Highlighter } from "lucide-react";
import type { DocumentController } from "../../document/DocumentController";
import { useDocState } from "../../hooks/useDoc";
import { useT } from "../../i18n";
import { useUi } from "../../state/ui";

const NOT_FOUND = 1;
const PENDING = 3;

export function FindBar({ c }: { c: DocumentController }) {
  const t = useT();
  const find = useDocState(c, (s) => s.find, null);
  const focusToken = useUi((s) => s.findFocus);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(find?.query ?? "");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  // Selection-based searches update the query from outside.
  useEffect(() => {
    if (find && find.query !== query && document.activeElement !== inputRef.current) setQuery(find.query);
  }, [find?.query]);

  if (!find) return null;

  const run = (q: string, opts = {}, previous = false, again = false) => c.find(q, opts, previous, again);
  const close = () => {
    c.closeFind();
    useUi.setState({ findOpen: false });
    c.scrollContainer?.focus({ preventScroll: true });
  };

  const status =
    find.state === NOT_FOUND
      ? t("find.notFound")
      : find.total > 0
        ? t("find.count", { current: find.current, total: find.total })
        : find.state === PENDING && query
          ? "…"
          : "";

  return (
    <div className="findbar" role="search" data-keys="local">
      <input
        ref={inputRef}
        className={`input${find.state === NOT_FOUND && query ? " invalid" : ""}`}
        value={query}
        placeholder={t("find.placeholder")}
        aria-label={t("find.placeholder")}
        onChange={(e) => {
          const q = e.target.value;
          setQuery(q);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => run(q), 180);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (timer.current) clearTimeout(timer.current);
            if (query !== find.query) run(query);
            else run(query, {}, e.shiftKey, true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            close();
          }
        }}
      />
      <span className={`find-count${find.state === NOT_FOUND && query ? " notfound" : ""}`}>{status}</span>
      <button type="button" className="icon-btn small" data-tip={t("find.prev")} disabled={!query} onClick={() => run(query, {}, true, true)}>
        <ChevronUp size={16} />
      </button>
      <button type="button" className="icon-btn small" data-tip={t("find.next")} disabled={!query} onClick={() => run(query, {}, false, true)}>
        <ChevronDown size={16} />
      </button>
      <button
        type="button"
        className="icon-btn small"
        aria-pressed={find.caseSensitive}
        data-tip={t("find.matchCase")}
        onClick={() => run(query, { caseSensitive: !find.caseSensitive })}
      >
        <CaseSensitive size={16} />
      </button>
      <button
        type="button"
        className="icon-btn small"
        aria-pressed={find.entireWord}
        data-tip={t("find.wholeWords")}
        onClick={() => run(query, { entireWord: !find.entireWord })}
      >
        <WholeWord size={16} />
      </button>
      <button
        type="button"
        className="icon-btn small"
        aria-pressed={find.highlightAll}
        data-tip={t("find.highlightAll")}
        onClick={() => run(query, { highlightAll: !find.highlightAll })}
      >
        <Highlighter size={15} />
      </button>
      <button
        type="button"
        className="icon-btn small"
        aria-pressed={find.matchDiacritics}
        data-tip={t("find.diacritics")}
        onClick={() => run(query, { matchDiacritics: !find.matchDiacritics })}
        style={{ fontWeight: 600, fontSize: 12 }}
      >
        é
      </button>
      <button type="button" className="icon-btn small" data-tip={t("find.close")} onClick={close}>
        <X size={16} />
      </button>
    </div>
  );
}
