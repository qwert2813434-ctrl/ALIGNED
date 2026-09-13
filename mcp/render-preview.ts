import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  createCanvas, DOMMatrix, GlobalFonts, Image, ImageData, loadImage, Path2D,
} from "@napi-rs/canvas";

interface Job {
  projectPath: string;
  rootDir: string;
  outputPath: string;
  page: number;
  maxWidth: number;
  repoRoot: string;
}

const jobPath = process.argv[2];
if (!jobPath) throw new Error("缺少 render job");
const job = JSON.parse(await readFile(jobPath, "utf8")) as Job;

// 核心模組會經過 platform/i18n。載入時維持沒有 document，讓它走 worker 的純函式路徑；
// navigator 只用來判斷鍵盤平台，先補最小值避免 Node 沒有該全域。
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { platform: process.platform === "darwin" ? "MacIntel" : "Win32", userAgent: "ALIGNED MCP" },
});

const [{ decodeProject }, renderModule, filterModule] = await Promise.all([
  import("../src/core/schema.ts"),
  import("../src/core/render.ts"),
  import("../src/core/filters.ts"),
]);

function canvasElement(width = 1, height = 1) {
  const canvas = createCanvas(width, height) as ReturnType<typeof createCanvas> & {
    remove?: () => void; isConnected?: boolean; style?: Record<string, string>; dataset?: Record<string, string>;
  };
  canvas.remove = () => undefined;
  canvas.isConnected = true;
  canvas.style = {};
  canvas.dataset = {};
  return canvas;
}

const fakeNode = () => ({
  isConnected: true,
  style: {} as Record<string, string>,
  dataset: {} as Record<string, string>,
  append: () => undefined,
  remove: () => undefined,
});

Object.assign(globalThis, { Image, ImageData, Path2D, DOMMatrix });
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    body: { append: () => undefined },
    createElement: (tag: string) => tag === "canvas" ? canvasElement() : fakeNode(),
  },
});

const fontDir = join(job.repoRoot, "public", "fonts");
for (const file of await readdir(fontDir)) {
  if (!new Set([".otf", ".ttf", ".ttc"]).has(extname(file).toLowerCase())) continue;
  GlobalFonts.registerFromPath(join(fontDir, file), basename(file, extname(file)));
}

async function filterAssets() {
  const base = join(job.repoRoot, "public", "luts");
  const bytes = async (name: string) => new Uint8Array(await readFile(join(base, name)));
  const cubeNames = ["a1", "a2", "a3", "b2", "mono"];
  const curveNames = ["faded", "redFilter", "infrared", "finePaper"];
  const grainNames = ["b1", "c1", "c3", "c4"];
  const plane = async (file: string) => {
    const image = await loadImage(join(base, file));
    const canvas = canvasElement(256, 256);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, 256, 256);
    const pixels = context.getImageData(0, 0, 256, 256).data;
    const out = new Float32Array(256 * 256);
    for (let i = 0, p = 0; i < pixels.length; i += 4, p++) out[p] = pixels[i];
    return out;
  };
  const tile = async (name: string) => ({
    rgb: await plane(`grain_${name}.png`),
    alpha: await plane(`grainA_${name}.png`),
  });
  const [cubes, curves, grains, dots] = await Promise.all([
    Promise.all(cubeNames.map((name) => bytes(`lut_${name}.bin`))),
    Promise.all(curveNames.map((name) => bytes(`curve_${name}.lut`))),
    Promise.all(grainNames.map(tile)),
    bytes("dotscreen.bin"),
  ]);
  return {
    cube: new Map(cubeNames.map((name, index) => [name, cubes[index]])),
    curve: new Map(curveNames.map((name, index) => [name, curves[index]])),
    grain: new Map(grainNames.map((name, index) => [name, grains[index]])),
    dots,
  };
}

function filteredCanvas(image: Awaited<ReturnType<typeof loadImage>>, signature: string, filters: Awaited<ReturnType<typeof filterAssets>>) {
  const cap = filterModule.isParamSig(signature) ? 2560 : Infinity;
  const scale = Math.min(1, cap / Math.max(image.width, image.height));
  const canvas = canvasElement(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale)));
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  filterModule.applyFilter(signature, data as unknown as globalThis.ImageData, filters);
  context.putImageData(data, 0, 0);
  return canvas;
}

function matteCanvas(image: Awaited<ReturnType<typeof loadImage>>, inverted = false) {
  const canvas = canvasElement(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < data.data.length; i += 4) {
    const lum = (data.data[i] * 0.2126 + data.data[i + 1] * 0.7152 + data.data[i + 2] * 0.0722) | 0;
    data.data[i] = data.data[i + 1] = data.data[i + 2] = 255;
    data.data[i + 3] = inverted ? 255 - lum : lum;
  }
  context.putImageData(data, 0, 0);
  return canvas;
}

const raw = JSON.parse(await readFile(job.projectPath, "utf8"));
const project = decodeProject(raw);
if (job.page < 1 || job.page > project.pageCount) throw new Error(`page 必須在 1–${project.pageCount} 之間`);

const filters = await filterAssets();
const images = new Map<string, CanvasImageSource>();
const mattes = new Map<string, CanvasImageSource>();
const warnings: string[] = [];
const imageCache = new Map<string, Awaited<ReturnType<typeof loadImage>>>();
const getImage = async (name: string) => {
  if (imageCache.has(name)) return imageCache.get(name)!;
  try {
    const image = await loadImage(join(job.rootDir, "assets", basename(name)));
    imageCache.set(name, image);
    return image;
  } catch {
    warnings.push(`找不到或無法解碼素材：${name}`);
    return null;
  }
};

for (const block of project.blocks) {
  if (block.content.type === "model") warnings.push(`3D 物件目前以線框佔位：${block.id}`);
  if (block.content.type !== "image" && block.content.type !== "video") continue;
  const media = block.content.media;
  if (!media.assetFileName) continue;
  const main = block.content.type === "video" ? `${media.assetFileName}.poster.jpg` : media.assetFileName;
  const signature = filterModule.filterSig(media);
  for (const name of [main, ...(media.carouselAssets ?? [])]) {
    const image = await getImage(name);
    if (!image) continue;
    images.set(name + (signature ? `|${signature}` : ""), signature ? filteredCanvas(image, signature, filters) : image);
  }
  if (media.matteFileName) {
    const image = await getImage(media.matteFileName);
    if (image) mattes.set(`matte:${media.matteFileName}${media.matteInverted ? "!" : ""}`, matteCanvas(image, media.matteInverted));
  }
}

const scale = Math.min(1, job.maxWidth / project.canvasWidth);
const canvas = renderModule.renderPageCanvas(project, job.page - 1, {
  images, mattes, filters, scale, placeholderForMissingMedia: true,
}) as unknown as ReturnType<typeof createCanvas>;
await mkdir(dirname(resolve(job.outputPath)), { recursive: true });
await writeFile(job.outputPath, await canvas.encode("png"));
process.stdout.write(JSON.stringify({
  output_path: resolve(job.outputPath),
  page: job.page,
  width: canvas.width,
  height: canvas.height,
  warnings: [...new Set(warnings)],
}));
