/** "What's new" after an update: a few lines per version since the one the user had. */
import { CircleHelp, ExternalLink, PartyPopper } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Dialog } from "../common/Dialog";
import { currentLocale, useT } from "../../i18n";
import { noteLines, type ReleaseNote } from "../../help/releaseNotes";
import { toAppError } from "../../lib/errors";
import { appInfo } from "../../state/app";
import { toast, useUi } from "../../state/ui";

const CHANGELOG_URL = "https://github.com/AlexEisie/YetAnotherPDFReader/blob/main/CHANGELOG.md";

export function WhatsNewDialog({ notes, updated, done }: { notes: ReleaseNote[]; updated: boolean; done: () => void }) {
  const t = useT();
  const locale = currentLocale();
  const version = appInfo()?.version ?? notes[0]?.version ?? "";
  const footer = (
    <>
      <button type="button" className="btn ghost" onClick={() => void openUrl(CHANGELOG_URL).catch((err) => toast("error", toAppError(err).message))}>
        <ExternalLink size={15} /> {t("whatsNew.changelog")}
      </button>
      <span className="spacer" />
      <button
        type="button"
        className="btn"
        onClick={() => {
          done();
          useUi.setState({ help: "start", settings: null });
        }}
      >
        <CircleHelp size={15} /> {t("cmd.help.guide")}
      </button>
      <button type="button" className="btn primary" data-autofocus onClick={done}>
        {t("whatsNew.ok")}
      </button>
    </>
  );
  return (
    <Dialog title={t("whatsNew.title")} icon={PartyPopper} onClose={done} footer={footer}>
      <p className="whats-new-lead">{updated ? t("whatsNew.updated", { version }) : t("whatsNew.lead", { version })}</p>
      <div className="whats-new">
        {notes.map((note) => (
          <section key={note.version}>
            <h4>v{note.version}</h4>
            <ul>
              {noteLines(note, locale).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
