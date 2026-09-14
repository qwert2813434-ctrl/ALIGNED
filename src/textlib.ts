// 文字庫的存取（桌面版，2026-09-14）。資料夾＝iCloud 雲碟「ALIGNED/TextLibrary」——手機同步的同一個，
// 直接讀寫、不另存本機副本（為什麼見 src-tauri/src/textlib.rs 檔頭）。格式在 core/textmemo.ts。
//
// 跟手機同時改同一篇（規則照 iOS TextMemoSync，一個字都不丟）：
// - 存檔前讀回磁碟上那份，跟打開時讀到的比：沒人動過＝直接寫；
// - 別台只動了排進紀錄（次數／專案名）＝合併再寫；
// - 別台改了內容＝修改時間新的留在原篇，另一份存成「衝突副本」；
// - 別台刪了、這邊正在改＝改的贏，寫回去（墓碑一起拿掉）。
// 刪除留墓碑 .deleted/<id>，手機看到墓碑才刪自己那份；整篇清空＝刪除（同 iOS）。
// 所有讀寫排成一條隊：重新整理讀到一半、存檔插進來，不會把剛存的蓋回舊的。

import {
  conflictCopy, decodeMemo, encodeMemo, fileStem, isBlankMemo, makeMemoID, markMemoUsed, newestFirst, planCollect,
  type TextMemo,
} from "./core/textmemo";

export interface TextLibListing {
  exists: boolean;
  files: { name: string; modifiedMs: number; size: number }[];
  /** 還沒下載的 iCloud 佔位檔（舊版 macOS）→ 名字。 */
  placeholders: string[];
}

/** 檔案 IO：App＝Rust textlib.rs（tauriTextLibBackend），瀏覽器預覽與自測＝memoryTextLibBackend。 */
export interface TextLibBackend {
  locate(): Promise<{ icloudRoot: string | null; aligned: string | null }>;
  list(dir: string): Promise<TextLibListing>;
  /** 檔案不在＝null。 */
  read(dir: string, stem: string): Promise<string | null>;
  write(dir: string, stem: string, contents: string): Promise<void>;
  /** 刪檔並留墓碑 .deleted/<stem>。 */
  remove(dir: string, stem: string): Promise<void>;
  ensureDir(dir: string): Promise<void>;
  download(dir: string, stem: string): Promise<void>;
}

export interface TextLibPrefs {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

export const localTextLibPrefs: TextLibPrefs = {
  get: (key) => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => {
    try {
      if (value == null) localStorage.removeItem(key); else localStorage.setItem(key, value);
    } catch { /* 存不了就只記在這次 */ }
  },
};

export const TEXT_LIBRARY_FOLDER = "TextLibrary";
const DIR_KEY = "align.textLibrary.dir";
const CELLS_KEY = "align.textLibrary.lastCells";

export type FolderState =
  | { kind: "unknown" }
  /** exists=false：位置找到了但 TextLibrary 還沒建（手機還沒同步過）——第一次存檔會建。chosen＝自己選的。 */
  | { kind: "ready"; dir: string; exists: boolean; chosen: boolean }
  /** 自動找不到 iCloud 雲碟裡的 ALIGNED、也沒選過位置。 */
  | { kind: "missing"; icloudRoot: string | null }
  | { kind: "error"; dir: string; chosen: boolean; message: string };

export interface SaveResult {
  /** 存完原篇裡的內容：kept="disk"＝別台的比較新、留在原篇，這邊的另存副本。 */
  memo: TextMemo;
  raw: string;
  /** 衝突時另存的那一份。 */
  copy?: TextMemo;
  kept: "draft" | "disk";
}

interface Entry { memo: TextMemo; raw: string; modifiedMs: number; size: number }

export function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.replace(/[\\/]+$/, "") + sep + name;
}

export function pathBaseName(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
}

const sameContent = (a: TextMemo, b: TextMemo): boolean =>
  a.title === b.title && a.body === b.body && a.cellsPerRow === b.cellsPerRow;

export class TextLibraryStore {
  folder: FolderState = { kind: "unknown" };
  /** 新改的在前。 */
  memos: TextMemo[] = [];
  placeholders: string[] = [];
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private refreshing: Promise<boolean> | null = null;
  private downloadAsked = new Set<string>();

  constructor(
    private backend: TextLibBackend,
    private prefs: TextLibPrefs,
    private conflictMarker: string,
    private clock: () => number = Date.now,
  ) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private emit(): void { for (const fn of this.listeners) fn(); }

  /** 稿紙「每排幾格」上次用的值——新的一篇、沒設過的一篇都從這裡起（出廠 14，同 iOS）。 */
  get lastCellsPerRow(): number {
    const v = Number(this.prefs.get(CELLS_KEY));
    return Number.isInteger(v) && v >= 4 && v <= 40 ? v : 14;
  }
  set lastCellsPerRow(n: number) {
    this.prefs.set(CELLS_KEY, String(Math.min(Math.max(Math.round(n), 4), 40)));
  }

  get dir(): string | null {
    const f = this.folder;
    return f.kind === "ready" || f.kind === "error" ? f.dir : null;
  }

  memo(id: string): TextMemo | undefined { return this.entries.get(id)?.memo; }

  /** 這篇上次讀到／寫出去的檔案原文——存檔時拿來比「打開之後別台有沒有動過」。 */
  raw(id: string): string | null { return this.entries.get(id)?.raw ?? null; }

  /** 排隊：讀寫一次一件。 */
  private run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private setFolder(f: FolderState): void {
    const before = this.dir;
    this.folder = f;
    if (this.dir !== before) {
      this.entries.clear();
      this.memos = [];
      this.placeholders = [];
      this.downloadAsked.clear();
    }
    this.emit();
  }

  /** 找位置：自己選過的優先；否則 iCloud 雲碟裡手機建的 ALIGNED／TextLibrary。 */
  resolveFolder(): Promise<FolderState> { return this.run(() => this.doResolve()); }

  private async doResolve(): Promise<FolderState> {
    const chosen = this.prefs.get(DIR_KEY);
    if (chosen) {
      if (this.dir !== chosen) this.setFolder({ kind: "ready", dir: chosen, exists: true, chosen: true });
      return this.folder;
    }
    try {
      const loc = await this.backend.locate();
      const dir = loc.aligned ? joinPath(loc.aligned, TEXT_LIBRARY_FOLDER) : null;
      if (!dir) this.setFolder({ kind: "missing", icloudRoot: loc.icloudRoot });
      else if (this.dir !== dir) this.setFolder({ kind: "ready", dir, exists: true, chosen: false });
    } catch {
      this.setFolder({ kind: "missing", icloudRoot: null });
    }
    return this.folder;
  }

  /** 選資料夾：選到 TextLibrary 本身就用它，否則用裡面的 TextLibrary（手機也是這樣找）。 */
  chooseFolder(picked: string): Promise<boolean> {
    return this.run(async () => {
      const dir = pathBaseName(picked) === TEXT_LIBRARY_FOLDER ? picked : joinPath(picked, TEXT_LIBRARY_FOLDER);
      this.prefs.set(DIR_KEY, dir);
      this.setFolder({ kind: "ready", dir, exists: true, chosen: true });
      return this.doRefresh();
    });
  }

  /** 回到自動找（清掉自己選的位置）。 */
  useAutomaticFolder(): Promise<boolean> {
    return this.run(async () => {
      this.prefs.set(DIR_KEY, null);
      await this.doResolve();
      return this.doRefresh();
    });
  }

  /** iCloud 雲碟裡還沒有 ALIGNED：建 ALIGNED/TextLibrary（手機傳輸資料夾選 iCloud 雲碟就對上）。 */
  createInICloud(): Promise<boolean> {
    return this.run(async () => {
      const f = this.folder;
      if (f.kind !== "missing" || !f.icloudRoot) return false;
      const dir = joinPath(joinPath(f.icloudRoot, "ALIGNED"), TEXT_LIBRARY_FOLDER);
      await this.backend.ensureDir(dir);
      this.setFolder({ kind: "ready", dir, exists: true, chosen: false });
      return this.doRefresh();
    });
  }

  /** 重新列一次資料夾（修改時間或大小變了的才重讀）。有變化＝true。 */
  refresh(): Promise<boolean> {
    if (!this.refreshing) {
      this.refreshing = this.run(() => this.doRefresh()).finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  private async doRefresh(): Promise<boolean> {
    if (this.folder.kind === "unknown") await this.doResolve();
    const f = this.folder;
    if (f.kind !== "ready" && f.kind !== "error") return false;
    const dir = f.dir;
    let listing: TextLibListing;
    try {
      listing = await this.backend.list(dir);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const changed = f.kind !== "error" || f.message !== message;
      if (changed) this.setFolder({ kind: "error", dir, chosen: f.chosen, message });
      return changed;
    }
    let changed = false;
    if (f.kind !== "ready" || f.exists !== listing.exists) {
      this.folder = { kind: "ready", dir, exists: listing.exists, chosen: f.chosen };
      changed = true;
    }
    const seen = new Set<string>();
    for (const file of listing.files) {
      const stem = file.name.replace(/\.md$/i, "");
      if (fileStem(stem) !== stem) continue;   // 手機存不回同一個檔名的不收，兩邊篇目才一致
      seen.add(stem);
      const hit = this.entries.get(stem);
      if (hit && hit.modifiedMs === file.modifiedMs && hit.size === file.size) continue;
      let raw: string | null;
      try {
        raw = await this.backend.read(dir, stem);
      } catch {
        continue;   // 讀不到（還在下載、不是 UTF-8）：舊的留著，下次再試
      }
      if (raw == null) { seen.delete(stem); continue; }
      if (hit && hit.raw === raw) { hit.modifiedMs = file.modifiedMs; hit.size = file.size; continue; }
      this.entries.set(stem, { memo: decodeMemo(raw, stem, file.modifiedMs), raw, modifiedMs: file.modifiedMs, size: file.size });
      changed = true;
    }
    for (const stem of [...this.entries.keys()]) {
      if (!seen.has(stem)) { this.entries.delete(stem); changed = true; }
    }
    const placeholders = listing.placeholders.filter((s) => fileStem(s) === s && !seen.has(s)).sort();
    if (placeholders.join("\n") !== this.placeholders.join("\n")) { this.placeholders = placeholders; changed = true; }
    for (const stem of placeholders) {
      if (this.downloadAsked.has(stem)) continue;
      this.downloadAsked.add(stem);
      void this.backend.download(dir, stem).catch(() => undefined);
    }
    if (changed) { this.resort(); this.emit(); }
    return changed;
  }

  private resort(): void {
    this.memos = [...this.entries.values()].map((e) => e.memo).sort(newestFirst);
  }

  private requireDir(): string {
    const dir = this.dir;
    if (!dir) throw new Error("文字庫還沒有位置");
    return dir;
  }

  private async writeMemo(dir: string, m: TextMemo): Promise<string> {
    const stem = fileStem(m.id);
    const raw = encodeMemo(m);
    await this.backend.write(dir, stem, raw);
    if (this.folder.kind === "ready" && !this.folder.exists) this.folder = { ...this.folder, exists: true };
    // 修改時間記 -1：下次重新整理會讀回來比一次（內容一樣就只記時間，不算變化）
    this.entries.set(stem, { memo: decodeMemo(raw, stem, m.updated), raw, modifiedMs: -1, size: -1 });
    this.resort();
    this.emit();
    return raw;
  }

  /** 存一篇。`baseRaw`＝打開這篇時讀到的檔案原文（新的一篇＝null）。整篇清空＝刪除，回 null。 */
  save(draft: TextMemo, baseRaw: string | null): Promise<SaveResult | null> {
    return this.run(() => this.doSave(draft, baseRaw));
  }

  private async doSave(input: TextMemo, baseRaw: string | null): Promise<SaveResult | null> {
    const dir = this.requireDir();
    const stem = fileStem(input.id);
    let draft = stem === input.id ? input : { ...input, id: stem };
    if (isBlankMemo(draft)) {
      if (baseRaw != null || this.entries.has(stem)) await this.doDelete(stem);
      return null;
    }
    const disk = await this.backend.read(dir, stem);
    if (baseRaw == null && disk != null) draft = { ...draft, id: makeMemoID(draft.created) };   // 新的一篇撞名（幾乎不會）
    if (baseRaw == null || disk == null || disk === baseRaw) {
      // 新的一篇／打開後沒人動過／別台刪了但這邊在改（改的贏）
      return { memo: draft, raw: await this.writeMemo(dir, draft), kept: "draft" };
    }
    const now = this.clock();
    const theirs = decodeMemo(disk, stem, now);
    if (sameContent(theirs, decodeMemo(baseRaw, stem, now)) || sameContent(theirs, draft)) {
      // 別台只動了排進紀錄（或改得一模一樣）：合併
      const merged = { ...draft, usedCount: theirs.usedCount, usedIn: theirs.usedIn };
      return { memo: merged, raw: await this.writeMemo(dir, merged), kept: "draft" };
    }
    if (draft.updated >= theirs.updated) {
      const copy = conflictCopy(theirs, this.conflictMarker, makeMemoID(now));
      await this.writeMemo(dir, copy);
      return { memo: draft, raw: await this.writeMemo(dir, draft), copy, kept: "draft" };
    }
    const copy = conflictCopy(draft, this.conflictMarker, makeMemoID(now));
    await this.writeMemo(dir, copy);
    this.entries.set(stem, { memo: theirs, raw: disk, modifiedMs: -1, size: -1 });
    this.resort();
    this.emit();
    return { memo: theirs, raw: disk, copy, kept: "disk" };
  }

  /** 刪一篇並留墓碑（手機、平板看到墓碑才刪自己那份）。 */
  delete(id: string): Promise<void> { return this.run(() => this.doDelete(id)); }

  private async doDelete(id: string): Promise<void> {
    const dir = this.requireDir();
    const stem = fileStem(id);
    await this.backend.remove(dir, stem);
    if (this.entries.delete(stem)) this.resort();
    this.emit();
  }

  /** 排進畫面：讀最新的一份再記一次，別蓋掉別台剛改的字。 */
  markUsed(id: string, projectName: string): Promise<TextMemo | null> {
    return this.run(async () => {
      const dir = this.requireDir();
      const stem = fileStem(id);
      const disk = await this.backend.read(dir, stem);
      if (disk == null) return null;
      const next = markMemoUsed(decodeMemo(disk, stem, this.entries.get(stem)?.memo.updated ?? this.clock()), projectName);
      await this.writeMemo(dir, next);
      return next;
    });
  }

  /** 收進文字庫：一框一篇，庫裡已有同樣內容就不重複收。 */
  collect(sources: { text: string; cellsPerRow?: number }[], projectName: string): Promise<{ added: TextMemo[]; existing: number }> {
    return this.run(async () => {
      await this.doRefresh();
      const dir = this.requireDir();
      const plan = planCollect(sources, this.memos.map((m) => m.body), projectName, this.clock());
      for (const m of plan.added) await this.writeMemo(dir, m);
      return plan;
    });
  }
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

/** App 內：Rust textlib.rs。 */
export function tauriTextLibBackend(invoke: Invoke): TextLibBackend {
  return {
    locate: () => invoke("textlib_locate"),
    list: (dir) => invoke("textlib_list", { dir }),
    read: (dir, stem) => invoke("textlib_read", { dir, stem }),
    write: (dir, stem, contents) => invoke("textlib_write", { dir, stem, contents }),
    remove: (dir, stem) => invoke("textlib_delete", { dir, stem }),
    ensureDir: (dir) => invoke("textlib_ensure_dir", { dir }),
    download: (dir, stem) => invoke("textlib_download", { dir, stem }),
  };
}

/** 瀏覽器預覽與自測：檔案只在記憶體（重載就沒了）。 */
export function memoryTextLibBackend(loc: { aligned?: string | null; icloudRoot?: string | null } = {}):
  TextLibBackend & { files: Map<string, { raw: string; modifiedMs: number }>; tombstones: Set<string> } {
  const files = new Map<string, { raw: string; modifiedMs: number }>();
  const tombstones = new Set<string>();
  const dirs = new Set<string>();
  let tick = 0;
  const key = (dir: string, stem: string) => joinPath(dir, `${stem}.md`);
  return {
    files, tombstones,
    async locate() { return { icloudRoot: loc.icloudRoot ?? null, aligned: loc.aligned ?? null }; },
    async list(dir) {
      const prefix = joinPath(dir, "");
      const out = [...files]
        .filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes("/"))
        .map(([k, v]) => ({ name: k.slice(prefix.length), modifiedMs: v.modifiedMs, size: v.raw.length }));
      return { exists: dirs.has(dir) || out.length > 0, files: out, placeholders: [] };
    },
    async read(dir, stem) { return files.get(key(dir, stem))?.raw ?? null; },
    async write(dir, stem, raw) {
      dirs.add(dir);
      files.set(key(dir, stem), { raw, modifiedMs: Date.now() + ++tick });
      tombstones.delete(joinPath(dir, stem));
    },
    async remove(dir, stem) { files.delete(key(dir, stem)); tombstones.add(joinPath(dir, stem)); },
    async ensureDir(dir) { dirs.add(dir); },
    async download() { /* 記憶體版沒有雲端 */ },
  };
}
