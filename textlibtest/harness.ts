// 文字庫對照測試的 TS 端（Swift 端＝ref/main.swift）：讀 fixtures.json，用 core/textmemo.ts 算一遍輸出 JSON。
import { readFileSync } from "node:fs";
import {
  cellsPerRowFor, characterCount, conflictCopy, decodeMemo, displayTitle, encodeMemo, fileStem, isBlankMemo,
  manuscriptCells, memoPreview, paragraphCount, placementFit, sentenceCount, type TextMemo,
} from "../src/core/textmemo";

type MemoFixture = { id: string; title: string; body: string; created: number; updated: number; cells: number | null; used: number; usedIn: string[] };
const fx = JSON.parse(readFileSync(process.argv[2], "utf8")) as {
  texts: string[]; memos: MemoFixture[]; decodes: { fileID: string; text: string; now: number }[];
  placements: { cells: number; fontSize: number; available: number }[]; widths: { width: number; fontSize: number }[]; stems: string[];
};

const memoJSON = (m: TextMemo) => ({ id: m.id, title: m.title, body: m.body, created: m.created / 1000, updated: m.updated / 1000,
                                     cells: m.cellsPerRow ?? null, used: m.usedCount, usedIn: m.usedIn });
const tb = (title: string, body: string) => ({ title, body });

const out = {
  texts: fx.texts.map((s) => ({
    chars: characterCount(s), sentences: sentenceCount(s), paragraphs: paragraphCount(s),
    cells: manuscriptCells(s).map((c) => ({ t: c.text, u: c.units })),
    titleNone: displayTitle(tb("", s)), previewNone: memoPreview(tb("", s)),
    titleT: displayTitle(tb("T", s)), previewT: memoPreview(tb("T", s)),
    titleBlank: displayTitle(tb(" \n ", s)),
    isBlank: isBlankMemo(tb("", s)), asTitleBlank: isBlankMemo(tb(s, "")), asTitle: displayTitle(tb(s, "")),
    stem: fileStem(s),
  })),
  memos: fx.memos.map((f) => {
    const m: TextMemo = { id: f.id, title: f.title, body: f.body, created: f.created * 1000, updated: f.updated * 1000,
                          cellsPerRow: f.cells ?? undefined, usedCount: f.used, usedIn: f.usedIn };
    const enc = encodeMemo(m);
    return { encoded: enc, back: memoJSON(decodeMemo(enc, m.id, Date.now())), conflictTitle: conflictCopy(m, "衝突副本", "copy").title,
             displayTitle: displayTitle(m), preview: memoPreview(m) };
  }),
  decodes: fx.decodes.map((f) => memoJSON(decodeMemo(f.text, f.fileID, f.now * 1000))),
  placements: fx.placements.map((f) => placementFit(f.cells, f.fontSize, f.available)),
  widths: fx.widths.map((f) => cellsPerRowFor(f.width, f.fontSize) ?? null),
  stems: fx.stems.map((s) => fileStem(s)),
};
process.stdout.write(JSON.stringify(out));
