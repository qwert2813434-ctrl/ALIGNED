import { defineConfig } from "vite";

// 版本戳：build 當下的時間烤進程式。搞不清楚「現在跑的是哪一份」的教訓（2026-08-05）——
// 使用者連續回報三輪「還是卡」，最後發現開到的是 /Applications 裡三天前的舊包。
export default defineConfig({
  define: {
    __BUILD_STAMP__: JSON.stringify(
      new Date().toLocaleString("zh-TW", { hour12: false, month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit" }),
    ),
  },
});
