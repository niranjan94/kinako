import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { EditorState, Compartment } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import {
  autocompletion,
  completionKeymap,
  closeCompletion,
  acceptCompletion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { sql, keywordCompletionSource } from "@codemirror/lang-sql";
import { sqlDialect } from "./sqlDialect";
import type { DatabaseEngine } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useImperativeHandle, useMemo, useRef, type Ref } from "react";
import { sqlStatements } from "./sqlStatements";
import { sqlFunctionCompletion } from "./sqlCompletion";

const sqlHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--info-foreground)", fontWeight: "500" },
  { tag: tags.string, color: "var(--success-foreground)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--warning-foreground)" },
  { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: tags.operator, color: "var(--muted-foreground)" },
  { tag: tags.typeName, color: "var(--info-foreground)" },
]);

export type DatabaseSqlEditorHandle = { run: () => void };

export function DatabaseSqlEditor({
  ref,
  value,
  engine,
  completionSource,
  onChange,
  onRun,
  onCancel,
}: {
  ref?: Ref<DatabaseSqlEditorHandle>;
  value: string;
  engine: DatabaseEngine;
  completionSource: CompletionSource | undefined;
  onChange: (value: string) => void;
  onRun: (statements: string[]) => void;
  onCancel: () => void;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const changed = useEffectEvent(onChange);
  const run = useEffectEvent(onRun);
  const cancel = useEffectEvent(onCancel);
  const completion = useMemo(
    () =>
      autocompletion({
        override: [
          ...(completionSource ? [completionSource] : []),
          keywordCompletionSource(sqlDialect(engine), true),
          sqlFunctionCompletion,
        ],
        maxRenderedOptions: 12,
      }),
    [completionSource, engine],
  );
  const initial = useEffectEvent(() => ({ value, completion }));
  const suggestions = useRef(new Compartment());
  const runSelection = useEffectEvent((view: EditorView) => {
    const selection = view.state.selection.main;
    run(
      selection.empty
        ? sqlStatements(view.state.doc.toString(), engine, selection.head)
        : sqlStatements(view.state.sliceDoc(selection.from, selection.to), engine),
    );
  });
  useImperativeHandle(ref, () => ({
    run: () => {
      if (editor.current) runSelection(editor.current);
    },
  }));
  useEffect(() => {
    if (!parent.current) return;
    const view = new EditorView({
      parent: parent.current,
      state: EditorState.create({
        doc: initial().value,
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          drawSelection(),
          EditorView.contentAttributes.of({
            "aria-label": "SQL query",
            "aria-description":
              "Ctrl Space for SQL suggestions. Ctrl or Command Enter runs the current statement or selection.",
          }),
          history(),
          suggestions.current.of(initial().completion),
          syntaxHighlighting(sqlHighlightStyle),
          language.current.of(
            sql({
              dialect: sqlDialect(engine),
              upperCaseKeywords: true,
            }),
          ),
          keymap.of([
            {
              key: "Mod-Enter",
              run: (view) => {
                runSelection(view);
                return true;
              },
            },
            {
              key: "Escape",
              run: (view) => {
                if (closeCompletion(view)) return true;
                cancel();
                return false;
              },
            },
            ...completionKeymap,
            { key: "Tab", run: acceptCompletion },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) changed(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": { backgroundColor: "var(--background)", color: "var(--foreground)" },
            ".cm-content": { caretColor: "var(--foreground)", padding: "12px 0" },
            ".cm-line": { padding: "0 12px" },
            ".cm-activeLine, .cm-activeLineGutter": { backgroundColor: "var(--muted)" },
            ".cm-gutters": {
              backgroundColor: "var(--background)",
              color: "var(--muted-foreground)",
              borderRight: "1px solid var(--border)",
              minWidth: "40px",
            },
            ".cm-cursor": { borderLeftColor: "var(--foreground)" },
            ".cm-tooltip": {
              backgroundColor: "var(--popover)",
              color: "var(--popover-foreground)",
              borderColor: "var(--border)",
            },
            ".cm-tooltip.cm-tooltip-autocomplete": {
              fontFamily: "var(--font-mono)",
              fontSize: "12px",
              borderRadius: "4px",
              boxShadow: "0 4px 16px #0002",
              maxWidth: "min(480px, 90vw)",
            },
            ".cm-tooltip.cm-tooltip-autocomplete > ul": {
              maxHeight: "240px",
              maxWidth: "min(480px, 80vw)",
              minWidth: "min(250px, 80vw)",
            },
            ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
              padding: "3px 8px",
              lineHeight: "20px",
            },
            ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
              backgroundColor: "var(--accent)",
              color: "var(--accent-foreground)",
            },
            ".cm-completionDetail": {
              color: "var(--muted-foreground)",
              fontStyle: "normal",
              marginLeft: "16px",
            },
            ".cm-completionIcon": { color: "var(--muted-foreground)", opacity: "1" },
            ".cm-completionInfo": { padding: "6px 8px", fontSize: "12px", maxWidth: "320px" },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
              backgroundColor: "var(--accent)",
            },
          }),
        ],
      }),
    });
    editor.current = view;
    return () => {
      view.destroy();
      editor.current = null;
    };
  }, [engine]);
  useEffect(() => {
    editor.current?.dispatch({
      effects: language.current.reconfigure(
        sql({
          dialect: sqlDialect(engine),
          upperCaseKeywords: true,
        }),
      ),
    });
  }, [engine]);
  useEffect(() => {
    editor.current?.dispatch({ effects: suggestions.current.reconfigure(completion) });
  }, [completion]);
  useEffect(() => {
    const view = editor.current;
    if (view && view.state.doc.toString() !== value)
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);
  return (
    <div
      ref={parent}
      data-database-sql-editor
      className="h-full min-h-28"
      aria-label="SQL editor"
    />
  );
}
