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

/** 系統字型的 PostScript 名 → CSS family（macOS 上存在，Android 上不存在）。 */
const SYSTEM_CSS: Record<string, string> = {
  "PingFangSC-Regular": "PingFang SC",
  "HiraginoSans-W4": "Hiragino Sans",
  "AppleSDGothicNeo-Regular": "Apple SD Gothic Neo",
  "HiraMinProN-W3": "Hiragino Mincho ProN",
};

/** fontName 未設時的系統預設（iOS＝PingFang TC）。 */
const SYSTEM_DEFAULT = "PingFang TC";

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
export function cssFont(t: { fontName?: string; fontWeightValue?: number }, sizePx: number): string {
  const face = resolvedFace(t.fontName, t.fontWeightValue);
  if (face && FILES[face]) return `${sizePx}px "${face}"`;
  const dyn = face && DYNAMIC_CSS.get(face);
  if (dyn) return `${sizePx}px ${dyn}`;
  const cssFamily = (face && SYSTEM_CSS[face]) ?? SYSTEM_DEFAULT;
  return `${CSS_WEIGHTS[step(t.fontWeightValue)]} ${sizePx}px "${cssFamily}"`;
}

// ── 動態字型（剪映語彙：介面字體之外，還有這台電腦的系統字體＋匯入檔） ──
// 專案照舊只存 PostScript 名——同一套字型 iPad 也裝了，專案就兩邊長一樣；
// 沒裝的機器回落系統黑體（與 iOS 匯入字型同一套設計，字型檔不進專案檔）。

/** 殼層餵進來的一筆字型：label＝顯示名（有中文名用中文名）、ps＝PostScript 名。 */
export interface DynamicFont { label: string; ps: string; path: string | null }

/** 檢視器選單用的動態目錄，開機時由殼層填。 */
export const fontCatalog = {
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
  { label: "黑體（系統）", value: "" },
  { label: "粉圓體", value: "jf-openhuninn-2.1" },
  { label: "思源宋體", value: "NotoSerifTC-Regular" },
  { label: "源樣明體", value: "GenYoMin2TC-R" },
  { label: "Playfair Display", value: "PlayfairDisplayRoman-Regular" },
  { label: "Fira Code", value: "FiraCode-Regular" },
  { label: "Inter", value: "Inter-Regular" },
  { label: "Archivo Black", value: "ArchivoBlack-Regular" },
];

/** 字重五檔的顯示名（0…4，iOS TextWeightStep 同序）。 */
export const WEIGHT_LABELS = ["極細", "細", "標準", "粗", "特粗"];
