// 畫布上的 3D 物件（2026-08-16）。
//
// 架構仿 videopool：**WebGL 離屏渲染 → 每個 block 一張 2D 畫布 → 餵給 renderPage**。
// 渲染核心（render.ts）看到的只是 CanvasImageSource，完全不知道有 3D——
// 所以出場動畫、陸續出現、逐格匯出全部自動繼承，畫面永遠只有一條路。
//
// 展示角度由 core/anim.ts 的 modelYawAt 求值（純函式）：同一個 time 永遠同一個角度，
// 編輯預覽與逐格匯出因此逐像素一致。
//
// 燈光＝RoomEnvironment 攝影棚環境光（PBR 不給環境光會死黑）；背景透明，頁面底色透出來。

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { Block } from "./core/schema";
import { modelYawAt } from "./core/anim";

/** 離屏渲染的像素上限（長邊）——與 videopool 的 PLAIN_CAP 同理，預覽不超過匯出細節。 */
const CAP = 1080;

interface Loaded {
  root: THREE.Group;
  size: THREE.Vector3;
}

export class ModelPool {
  /** 共用一顆 WebGL renderer（context 是稀缺資源），逐 block 輪流畫。 */
  private renderer: THREE.WebGLRenderer | null | undefined;
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
  private holder = new THREE.Group();
  /** assetFileName → 已載入的模型（置中過）；"loading"/"failed" 是狀態哨兵。 */
  private models = new Map<string, Loaded | "loading" | "failed">();
  /** block.id → 該 block 的輸出畫布（renderer 共用，成品必須各自留一份）。 */
  private out = new Map<string, HTMLCanvasElement>();
  private url: ((file: string) => string) | null = null;
  /** 載入排隊：**一次只載一顆**。90MB 級的模型並行抓會把 WKWebView 記憶體
   *  推過線，GLTFLoader 靜靜失敗（2026-08-18 真專案重現：八張 33MP 照片在
   *  記憶體裡時，兩顆 90MB .glb 並行載必失敗、逐顆載全過）。 */
  private queue: string[] = [];
  private busy = false;
  /** file → 已失敗次數。記憶體壓力是暫態，先重試；三次才蓋章 failed。 */
  private tries = new Map<string, number>();

  constructor(private onFrame: () => void, private onFail?: (file: string) => void) {
    this.scene.add(this.holder);
  }

  /** 素材檔名怎麼變 URL。null＝這個來源沒素材可載（畫佔位）。換專案時呼叫。 */
  attach(resolve: ((file: string) => string) | null): void {
    this.url = resolve;
    this.models.clear();
    this.out.clear();
    this.queue = [];
    this.tries.clear();
  }

  private ensureRenderer(): THREE.WebGLRenderer | null {
    if (this.renderer !== undefined) return this.renderer;
    try {
      const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
      r.toneMapping = THREE.ACESFilmicToneMapping;
      this.scene.environment = new THREE.PMREMGenerator(r).fromScene(new RoomEnvironment(), 0.04).texture;
      this.renderer = r;
    } catch {
      this.renderer = null;   // WebGL 建不起來＝這台只畫佔位框
    }
    return this.renderer;
  }

  private load(file: string): void {
    if (this.models.has(file) || !this.url) return;
    this.models.set(file, "loading");
    this.queue.push(file);
    this.pump();
  }

  private pump(): void {
    if (this.busy || !this.url) return;
    const file = this.queue.shift();
    if (file === undefined) return;
    this.busy = true;
    const next = (): void => { this.busy = false; this.pump(); };
    new GLTFLoader().load(this.url(file), (g) => {
      const root = g.scene;
      const box = new THREE.Box3().setFromObject(root);
      root.position.sub(box.getCenter(new THREE.Vector3()));   // 置中＝繞自己轉
      this.models.set(file, { root, size: box.getSize(new THREE.Vector3()) });
      this.onFrame();   // 載好了請畫布重畫一次
      next();
    }, undefined, () => {
      const n = (this.tries.get(file) ?? 0) + 1;
      this.tries.set(file, n);
      if (n < 3) {
        // 暫態失敗先放手：下一次重畫（或一秒後）會經 load() 重新排隊
        this.models.delete(file);
        setTimeout(() => { if (!this.models.has(file)) { this.load(file); this.onFrame(); } }, 1000);
      } else {
        this.models.set(file, "failed");
        this.onFail?.(file);
      }
      next();
    });
  }

  /** 有沒有任何 3D 物件設了展示方式（播放中要不要每格重畫）。 */
  static hasMotion(b: Block): boolean {
    return b.content.type === "model" && !!b.content.model.mode;
  }

  /**
   * 渲染一個 3D block 在時間 time 的樣子。undefined＝還沒載好／失敗（呼叫端畫佔位）。
   * time 未給＝靜止在 yaw（編輯靜態與 PNG 匯出）。
   */
  render(b: Block, time?: number): CanvasImageSource | undefined {
    if (b.content.type !== "model" || !b.content.model.assetFileName) return undefined;
    const m = b.content.model;
    const got = this.models.get(m.assetFileName);
    if (!got) { this.load(m.assetFileName); return undefined; }
    if (got === "loading" || got === "failed") return undefined;
    const r = this.ensureRenderer();
    if (!r) return undefined;

    const k = Math.min(1, CAP / Math.max(b.frame.w, b.frame.h));
    const w = Math.max(2, Math.round(b.frame.w * k));
    const h = Math.max(2, Math.round(b.frame.h * k));
    if (r.domElement.width !== w || r.domElement.height !== h) r.setSize(w, h, false);

    // 取景：以模型高為準、1.35 邊距（與 PoC 定裝同款）；框的形狀由相機 aspect 吃掉
    const s = got.size;
    this.cam.aspect = b.frame.w / b.frame.h;
    const dist = (s.y / 2) / Math.tan((this.cam.fov * Math.PI) / 360) * 1.35;
    this.cam.position.set(0, s.y * 0.06, Math.max(dist, Math.max(s.x, s.z) * 1.6));
    this.cam.lookAt(0, 0, 0);
    this.cam.updateProjectionMatrix();

    this.holder.clear();
    this.holder.add(got.root);
    this.holder.rotation.y = (modelYawAt(m, time) * Math.PI) / 180;
    r.render(this.scene, this.cam);

    // renderer 是共用的——成品拷進 block 專屬畫布，下一個 block 才不會把它蓋掉
    let o = this.out.get(b.id);
    if (!o) { o = document.createElement("canvas"); this.out.set(b.id, o); }
    if (o.width !== w || o.height !== h) { o.width = w; o.height = h; }
    const cx = o.getContext("2d")!;
    cx.clearRect(0, 0, w, h);
    cx.drawImage(r.domElement, 0, 0);
    return o;
  }
}
