/** Renders the stack of promise-based dialogs requested through `openDialog`. */
import { useUi, type DialogEntry, type DialogMap } from "../../state/ui";
import { ConfirmDialog, ErrorDialog, GoToPageDialog, LinkDialog, PasswordDialog, PromptDialog } from "./BasicDialogs";
import { DocPropsDialog } from "./DocPropsDialog";
import { ExportImageDialog, PageOpsDialog, PrintDialog } from "./DocumentDialogs";
import { SignatureDialog, StampEditorDialog } from "./SignatureDialog";

function render(entry: DialogEntry) {
  const done = entry.resolve as (v: unknown) => void;
  switch (entry.type) {
    case "password": {
      const p = entry.props as DialogMap["password"]["props"];
      return <PasswordDialog fileName={p.fileName} reason={p.reason} done={done} />;
    }
    case "confirm":
      return <ConfirmDialog props={entry.props as DialogMap["confirm"]["props"]} done={done} />;
    case "prompt":
      return <PromptDialog props={entry.props as DialogMap["prompt"]["props"]} done={done} />;
    case "error": {
      const p = entry.props as DialogMap["error"]["props"];
      return <ErrorDialog title={p.title} error={p.error} done={() => done(undefined)} />;
    }
    case "link":
      return <LinkDialog url={(entry.props as DialogMap["link"]["props"]).url} done={done} />;
    case "goToPage":
      return <GoToPageDialog tabId={(entry.props as DialogMap["goToPage"]["props"]).tabId} done={() => done(undefined)} />;
    case "docProps":
      return <DocPropsDialog tabId={(entry.props as DialogMap["docProps"]["props"]).tabId} done={() => done(undefined)} />;
    case "print":
      return <PrintDialog tabId={(entry.props as DialogMap["print"]["props"]).tabId} done={() => done(undefined)} />;
    case "pageOps": {
      const p = entry.props as DialogMap["pageOps"]["props"];
      return <PageOpsDialog tabId={p.tabId} mode={p.mode} pages={p.pages} done={() => done(undefined)} />;
    }
    case "exportImage":
      return <ExportImageDialog tabId={(entry.props as DialogMap["exportImage"]["props"]).tabId} done={() => done(undefined)} />;
    case "signature":
      return <SignatureDialog initials={(entry.props as DialogMap["signature"]["props"]).initials} done={() => done(undefined)} />;
    case "stampEditor":
      return <StampEditorDialog done={() => done(undefined)} />;
    default:
      return null;
  }
}

export function DialogHost() {
  const dialogs = useUi((s) => s.dialogs);
  return (
    <>
      {dialogs.map((d) => (
        <div key={d.id}>{render(d)}</div>
      ))}
    </>
  );
}
