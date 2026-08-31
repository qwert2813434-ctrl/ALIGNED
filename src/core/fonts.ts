import { __ } from "../i18n";
// ALIGN Core — 字型解析。iOS 端 AppFontCatalog 的移植。
//
// 儲存模型：TextBlock.fontName 存的是**家族鍵**（該家族 Regular 的 PostScript 名），
// fontWeightValue（0…4）再從家族裡挑出具體字面。所以 "GenYoMin2TC-R" + 4 → "GenYoMin2TC-H"。
// 單一字重的字型（粉圓、Inter）沒有 weights 表，fontName 直接就是字面。
//
// ⚠️ 跨平台字型決定論：內嵌字型（思源宋、源樣明、粉圓…）在哪個平台都一樣；
// 但 fontName 未設時的系統預設在 iOS 是 PingFang TC——Mac 也有，所以 Mac 版能與 iOS 對齊，
// **Android 沒有**，屆時要落到內嵌的 Noto Sans TC 並在開檔時明示替換。

const WEIGHT_STEPS = 5;
const DEFAULT_WEIGHT = 3; // .bold —— iOS 端 TextWeightStep.resolved 的預設

/** 多字重家族：家族鍵 → 五個字階的具體字面。 */
const FAMILIES: Record<string, string[]> = {
  "NotoSerifTC-Regular": ["NotoSerifTC-ExtraLight", "NotoSerifTC-Light", "NotoSerifTC-Regular", "NotoSerifTC-Bold", "NotoSerifTC-Black"],
  "GenYoMin2TC-R": ["GenYoMin2TC-EL", "GenYoMin2TC-L", "GenYoMin2TC-R", "GenYoMin2TC-B", "GenYoMin2TC-H"],
  "PlayfairDisplayRoman-Regular": ["PlayfairDisplay-Regular", "PlayfairDisplay-Medium", "PlayfairDisplay-SemiBold", "PlayfairDisplay-Bold", "PlayfairDisplay-Black"],
  "FiraCode-Regular": ["FiraCode-Light", "FiraCode-Regular", "FiraCode-Medium", "FiraCode-SemiBold", "FiraCode-Bold"],
};

/** 內嵌字面 → public/fonts 下的檔名。 */
const FILES: Record<string, string> = {
  "NotoSerifTC-ExtraLight": "NotoSerifTC-ExtraLight.otf", "NotoSerifTC-Light": "NotoSerifTC-Light.otf",
  "NotoSerifTC-Regular": "NotoSerifTC-Regular.otf", "NotoSerifTC-Bold": "NotoSerifTC-Bold.otf",
  "NotoSerifTC-Black": "NotoSerifTC-Black.otf",
  "GenYoMin2TC-EL": "GenYoMin2TC-EL.otf", "GenYoMin2TC-L": "GenYoMin2TC-L.otf",
  "GenYoMin2TC-R": "GenYoMin2TC-R.otf", "GenYoMin2TC-B": "GenYoMin2TC-B.otf", "GenYoMin2TC-H": "GenYoMin2TC-H.otf",
  "PlayfairDisplay-Regular": "PlayfairDisplay-Regular.ttf", "PlayfairDisplay-Medium": "PlayfairDisplay-Medium.ttf",
  "PlayfairDisplay-SemiBold": "PlayfairDisplay-SemiBold.ttf", "PlayfairDisplay-Bold": "PlayfairDisplay-Bold.ttf",
  "PlayfairDisplay-Black": "PlayfairDisplay-Black.ttf",
  "FiraCode-Light": "FiraCode-Light.ttf", "FiraCode-Regular": "FiraCode-Regular.ttf",
  "FiraCode-Medium": "FiraCode-Medium.ttf", "FiraCode-SemiBold": "FiraCode-SemiBold.ttf", "FiraCode-Bold": "FiraCode-Bold.ttf",
  "jf-openhuninn-2.1": "jf-openhuninn-2.1.ttf",
  "Inter-Regular": "Inter-Regular.otf",
  "ArchivoBlack-Regular": "ArchivoBlack-Regular.ttf",
};

/**
 * 系統多語家族的字重表——與 iOS `AppFontCatalog` 的 PHASE1 多語言區塊**逐項同表**。
 *
 * 🔴 少了這張表就是「粗細滑桿對這四套字完全沒作用」的根：
 * `resolvedFace` 在 FAMILIES 找不到 key 就把家族鍵原樣回傳，於是五個字階解出同一張臉。
 * 打包版更慘——那條路會落到 `DYNAMIC_CSS`（殼層開機登記系統字型），而那個分支組出來的
 * font 串整串沒有 font-weight，所以永遠是 Regular。dev（localhost:5173）沒有殼層、
 * 不走那條路，所以這個 bug 只在正式版發作，開發時測不到。
 * （2026-09-01 42-agent 審計抓到；iOS 早就有表，是 Mac 這邊沒移植。）
 *
 * 臉名兩邊都驗過：iOS 是 FontDiagnostics 在 26.5 實機印出來的，Mac 這邊用 WKWebView
 * 逐張量墨量確認**每個 PostScript 名都吃得到**（量寬度沒用——中日韓等寬，粗細不改進距）。
 */
const SYSTEM_FAMILIES: Record<string, string[]> = {
  "PingFangSC-Regular": ["PingFangSC-Ultralight", "PingFangSC-Light", "PingFangSC-Regular", "PingFangSC-Medium", "PingFangSC-Semibold"],
  "HiraginoSans-W4": ["HiraginoSans-W3", "HiraginoSans-W3", "HiraginoSans-W4", "HiraginoSans-W6", "HiraginoSans-W8"],
  "AppleSDGothicNeo-Regular": ["AppleSDGothicNeo-UltraLight", "AppleSDGothicNeo-Light", "AppleSDGothicNeo-Regular", "AppleSDGothicNeo-Bold", "AppleSDGothicNeo-Bold"],
  "HiraMinProN-W3": ["HiraMinProN-W3", "HiraMinProN-W3", "HiraMinProN-W3", "HiraMinProN-W6", "HiraMinProN-W6"],
};

/** 家族鍵 → macOS 上的家族顯示名（PostScript 名萬一取不到時的保險）。 */
const SYSTEM_LABEL: Record<string, string> = {
  "PingFangSC-Regular": "PingFang SC",
  "HiraginoSans-W4": "Hiragino Sans",
  "AppleSDGothicNeo-Regular": "Apple SD Gothic Neo",
  "HiraMinProN-W3": "Hiragino Mincho ProN",
};

/** 系統字面 → CSS family 串（**已含引號**）。表由上面兩張自動展開，不手抄。 */
const SYSTEM_CSS: Record<string, string> = {};
for (const [key, faces] of Object.entries(SYSTEM_FAMILIES)) {
  Object.assign(FAMILIES, { [key]: faces });
  for (const f of faces) SYSTEM_CSS[f] = `"${f}", "${SYSTEM_LABEL[key]}"`;
}

/**
 * fontName 未設時的系統預設。
 *
 * ⚠️ **必須是 system-ui，不能寫死 PingFang TC。** iOS 那邊是
 * `UIFont.systemFont(ofSize:weight:)`＝SF Pro，中日韓字才由系統回落到 PingFang；
 * Mac 寫死 PingFang 的話**拉丁字母用的是 PingFang 的西文字面**，比 SF Pro 寬約 4.7%，
 * 累積成「每行少一個字、整段多一行、超出框底」——同一份專案兩邊排版對不上。
 * （2026-09-01 小高用 iPad 截圖對照抓到：他那塊內文框寬 591.6，
 *   PingFang 量到 614.5 放不下、system-ui 量到 586.9 放得下，跟 iPad 畫面一致。）
 * 後面接 PingFang TC＝中日韓的實際字面，跟 iOS 的回落結果同一套。
 */
const SYSTEM_DEFAULT = 'system-ui, "PingFang TC"';

/** CSS font-weight，只有系統字型用得到（內嵌字面本身已帶字重）。 */
const CSS_WEIGHTS = [200, 300, 400, 700, 900];

function step(weightValue: number | undefined): number {
  const v = weightValue == null ? DEFAULT_WEIGHT : Math.round(weightValue);
  return Math.min(Math.max(v, 0), WEIGHT_STEPS - 1);
}

/** 對應 iOS 的 AppFontCatalog.resolvedFace。回 null 代表用系統字型。 */
export function resolvedFace(fontName?: string, weightValue?: number): string | null {
  if (!fontName) return null;
  const family = FAMILIES[fontName];
  return family ? family[step(weightValue)] : fontName;
}

/** 組出 canvas 的 ctx.font 字串。 */
/** 缺字備援鏈：WKWebView 在特定情況（normal 字重＋離屏畫布）不走系統缺字備援，
 *  字型沒有的字（・①…）會直接畫豆腐——明列備援家族才救得回來（2026-08-31 實測：
 *  掛 sans-serif 沒用，要指名 Hiragino）。只影響主字型**沒有**的字，版面逐位不變。 */
const FALLBACK_CHAIN = '"PingFang TC", "Hiragino Sans", sans-serif';

export function cssFont(t: { fontName?: string; fontWeightValue?: number }, sizePx: number): string {
  const face = resolvedFace(t.fontName, t.fontWeightValue);
  if (face && FILES[face]) return `${sizePx}px "${face}", ${FALLBACK_CHAIN}`;
  // 系統多語家族排在動態登記之前：那張表已經解出**確切的臉**，就不要再掛 font-weight
  // 疊合成粗體（也讓 dev 與打包版走同一條路——差別只在殼層有沒有登記系統字型）。
  const sys = face && SYSTEM_CSS[face];
  if (sys) return `${sizePx}px ${sys}, ${FALLBACK_CHAIN}`;
  const dyn = face && DYNAMIC_CSS.get(face);
  if (dyn) return `${sizePx}px ${dyn}, ${FALLBACK_CHAIN}`;
  return `${CSS_WEIGHTS[step(t.fontWeightValue)]} ${sizePx}px ${SYSTEM_DEFAULT}, ${FALLBACK_CHAIN}`;
}

// ── 動態字型（剪映語彙：介面字體之外，還有這台電腦的系統字體＋匯入檔） ──
// 專案照舊只存 PostScript 名——同一套字型 iPad 也裝了，專案就兩邊長一樣；
// 沒裝的機器回落系統黑體（與 iOS 匯入字型同一套設計，字型檔不進專案檔）。

/** 殼層餵進來的一筆字型：label＝顯示名（有中文名用中文名）、ps＝PostScript 名。 */
export interface DynamicFont { label: string; ps: string; path: string | null }

/** 檢視器選單用的動態目錄，開機時由殼層填。 */
export const fontCatalog = {
  /** 字體商店下載的字型（IndexedDB，重開還在）——見 fontstore.ts */
  store: [] as { label: string; value: string }[],
  /** 匯入的字型檔（App 資料夾 UserFonts/） */
  custom: [] as { label: string; value: string }[],
  /** 這台電腦裝的字型（一家族一代表面） */
  system: [] as { label: string; value: string }[],
};

/** PostScript 名 → ctx.font 能用的 family 串（含備援家族名）。 */
const DYNAMIC_CSS = new Map<string, string>();

/**
 * 系統字型整批登記。**不需要 await**：字型已裝在系統裡，渲染器直接可用，
 * 沒有網路載入的時間差（「字型要先載完」那條雷只打 url() 來源的字型）。
 * ctx.font 先試 PostScript 名，再備援家族顯示名——WebKit 兩種都認得。
 */
export function registerSystemFonts(fonts: DynamicFont[]): void {
  for (const f of fonts) {
    if (FILES[f.ps]) continue;   // 內嵌的同名字面以內嵌為準（跨平台決定論）
    DYNAMIC_CSS.set(f.ps, `"${f.ps}", "${f.label}"`);
    fontCatalog.system.push({ label: f.label, value: f.ps });
  }
}

/**
 * 匯入檔登記：走 url() 就**必須 await 載完**再用（量測那條鐵則）。
 * 回傳是否成功——壞檔回 false，呼叫端自己決定要不要跟使用者說。
 */
export async function registerUserFont(f: DynamicFont, url: string): Promise<boolean> {
  if (DYNAMIC_CSS.has(f.ps) || FILES[f.ps]) return true;   // 同一套匯兩次＝已經能用
  try {
    const face = new FontFace(f.ps, `url("${url}")`);
    await face.load();
    document.fonts.add(face);
  } catch {
    return false;
  }
  DYNAMIC_CSS.set(f.ps, `"${f.ps}"`);
  fontCatalog.custom.push({ label: f.label, value: f.ps });
  return true;
}

/**
 * 字體商店家族登記（fontstore.ts 在還原與下載完成時呼叫）。
 * key＝家族鍵（400 那面的 PostScript 名，跟 iOS 同一套儲存模型）；
 * faces＝五字階→具體字面（單字重傳 null，粗細滑桿自然沒作用）。
 * FontFace 本身由呼叫端先 add 完（量測鐵則：load 完才能進渲染）。
 */
export function registerStoreFamily(key: string, label: string, faces: string[] | null): void {
  if (faces) {
    FAMILIES[key] = faces;
    for (const f of faces) DYNAMIC_CSS.set(f, `"${f}"`);
  }
  DYNAMIC_CSS.set(key, `"${key}"`);
  if (!fontCatalog.store.some((x) => x.value === key)) {
    fontCatalog.store.push({ label, value: key });
  }
}

export function unregisterStoreFamily(key: string): void {
  for (const f of FAMILIES[key] ?? []) DYNAMIC_CSS.delete(f);
  delete FAMILIES[key];
  DYNAMIC_CSS.delete(key);
  fontCatalog.store = fontCatalog.store.filter((x) => x.value !== key);
}

/** 這個 PostScript 名目前有沒有東西能渲染（內嵌／系統／匯入／商店）。 */
export function canRender(ps: string): boolean {
  return Boolean(FILES[ps] || DYNAMIC_CSS.has(ps) || SYSTEM_CSS[ps]);
}

/**
 * 注入 @font-face 並等全部載入。
 * 必須 await——canvas 的 ctx.font 對還沒載入的字型會靜默回落系統字型，
 * 不報錯、只是量測與渲染全錯，是最難查的那種 bug。
 */
export async function loadFonts(base = "/fonts/"): Promise<void> {
  await Promise.all(
    Object.entries(FILES).map(async ([face, file]) => {
      const f = new FontFace(face, `url("${base}${file}")`);
      await f.load();
      document.fonts.add(f);
    }),
  );
}

/** 字型選單（檢視器用）。value ＝存進 TextBlock.fontName 的家族鍵，"" ＝系統黑體。 */
export const FONT_CHOICES: { label: string; value: string }[] = [
  { label: __("黑體（系統）"), value: "" },
  { label: __("粉圓體"), value: "jf-openhuninn-2.1" },
  { label: __("思源宋體"), value: "NotoSerifTC-Regular" },
  { label: __("源樣明體"), value: "GenYoMin2TC-R" },
  { label: "Playfair Display", value: "PlayfairDisplayRoman-Regular" },
  { label: "Fira Code", value: "FiraCode-Regular" },
  { label: "Inter", value: "Inter-Regular" },
  { label: "Archivo Black", value: "ArchivoBlack-Regular" },
  // 系統多語家族（macOS 自帶，零體積）——與 iOS 選單同名同序、粗細滑桿五檔同表
  { label: "黑体", value: "PingFangSC-Regular" },
  { label: "ゴシック", value: "HiraginoSans-W4" },
  { label: "고딕", value: "AppleSDGothicNeo-Regular" },
  { label: "明朝", value: "HiraMinProN-W3" },
];

/** 字重五檔的顯示名（0…4，iOS TextWeightStep 同序）。 */
export const WEIGHT_LABELS = [__("極細"), __("細"), __("標準"), __("粗"), __("特粗")];
