// 互通測試用的檔案層：規則逐條照 src-tauri/src/textlib.rs（列檔略過點開頭與非 .md、原子寫、刪除留墓碑、寫回拿掉墓碑）。
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { TextLibBackend } from "../src/textlib";

export function nodeTextLibBackend(loc: { aligned: string | null; icloudRoot: string | null }): TextLibBackend {
  return {
    async locate() { return loc; },
    async list(dir) {
      if (!existsSync(dir)) return { exists: false, files: [], placeholders: [] };
      const files: { name: string; modifiedMs: number; size: number }[] = [];
      const placeholders: string[] = [];
      for (const name of readdirSync(dir)) {
        if (name.startsWith(".") && name.endsWith(".md.icloud")) { placeholders.push(name.slice(1, -".md.icloud".length)); continue; }
        if (name.startsWith(".") || extname(name).toLowerCase() !== ".md") continue;
        const st = statSync(join(dir, name));
        if (st.isFile()) files.push({ name, modifiedMs: st.mtimeMs, size: st.size });
      }
      return { exists: true, files, placeholders };
    },
    async read(dir, stem) {
      try { return readFileSync(join(dir, `${stem}.md`), "utf8"); }
      catch (e) { if ((e as { code?: string }).code === "ENOENT") return null; throw e; }
    },
    async write(dir, stem, contents) {
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `.${stem}.md.${process.pid}.tmp`);
      writeFileSync(tmp, contents);
      renameSync(tmp, join(dir, `${stem}.md`));
      rmSync(join(dir, ".deleted", stem), { force: true });
      rmSync(join(dir, ".deleted", `.${stem}.icloud`), { force: true });
    },
    async remove(dir, stem) {
      rmSync(join(dir, `${stem}.md`), { force: true });
      mkdirSync(join(dir, ".deleted"), { recursive: true });
      writeFileSync(join(dir, ".deleted", stem), "");
    },
    async ensureDir(dir) { mkdirSync(dir, { recursive: true }); },
    async download() { /* 本機暫存資料夾沒有雲端 */ },
  };
}
