#!/usr/bin/env node

import { copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, parse, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const SERVER = { name: "aligned-local", version: "0.1.0" };
const MCP_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(MCP_DIR);
let mobileEndpoint = null;

const hexPattern = /^[0-9A-F]{6}$/;
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const upperHex = (value, fallback = "1A1A1A") => {
  const hex = String(value ?? fallback).replace(/^#/, "").toUpperCase();
  if (!hexPattern.test(hex)) throw new Error(`顏色必須是 6 位 hex：${value}`);
  return hex;
};

function tool(name, description, properties, required = []) {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
  };
}

export const TOOLS = [
  tool("aligned_inspect_project", "讀取 ALIGNED 專案摘要與驗證結果，不修改檔案。支援 project.json；macOS 也支援 .alignproj。", {
    path: { type: "string", description: "project.json 或 .alignproj 的絕對路徑" },
    page: { type: "integer", minimum: 1, description: "選填，只回傳指定頁的 block；1 起算" },
  }, ["path"]),
  tool("aligned_validate_project", "檢查 ALIGNED 專案結構、畫布範圍、跨頁文字、素材與重複 ID。", {
    path: { type: "string", description: "project.json 或 .alignproj 的絕對路徑" },
  }, ["path"]),
  tool("aligned_render_preview", "用 ALIGNED 本人的渲染核心產生單頁 PNG，並把圖片直接回傳給 AI；不修改專案。", {
    path: { type: "string", description: "project.json 或 .alignproj 的絕對路徑" },
    page: { type: "integer", minimum: 1, description: "要預覽的頁碼，1 起算" },
    max_width: { type: "integer", minimum: 256, maximum: 2048, default: 1080, description: "預覽最大寬度，不會放大原畫布" },
    output_path: { type: "string", description: "選填；保留 PNG 的絕對路徑。省略時輸出到系統暫存目錄" },
  }, ["path", "page"]),
  tool("aligned_create_project", "建立空白 ALIGNED 專案。預設另存新檔，不需要開啟 ALIGNED。", {
    output_path: { type: "string", description: "輸出的 project.json；macOS 可用 .alignproj" },
    name: { type: "string" },
    page_count: { type: "integer", minimum: 1, maximum: 20, default: 6 },
    canvas_width: { type: "number", exclusiveMinimum: 0, default: 1080 },
    page_height: { type: "number", exclusiveMinimum: 0, default: 1350 },
    background_hex: { type: "string", description: "選填，6 位 hex、不含 #" },
  }, ["output_path", "name"]),
  tool("aligned_add_text", "在既有專案加入可編輯文字。x/y 是頁內座標；修改預設另存「AI」副本。", {
    path: { type: "string" },
    output_path: { type: "string", description: "選填；省略時自動另存 AI 副本" },
    overwrite: { type: "boolean", default: false, description: "只有明確為 true 才能覆寫來源；覆寫前建立 .bak" },
    text: { type: "string" },
    page: { type: "integer", minimum: 1, description: "1 起算" },
    x: { type: "number" }, y: { type: "number" },
    width: { type: "number", exclusiveMinimum: 0 }, height: { type: "number", exclusiveMinimum: 0 },
    font_size: { type: "number", exclusiveMinimum: 0, default: 64 },
    font_weight: { type: "number", minimum: 0, maximum: 4, default: 3 },
    color_hex: { type: "string", default: "1A1A1A" },
    alignment: { type: "string", enum: ["leading", "center", "trailing"], default: "leading" },
    font_name: { type: "string" },
    kerning_em: { type: "number" },
    line_height_multiple: { type: "number", exclusiveMinimum: 0 },
    body_frame: { type: "boolean", default: false },
    vertical: { type: "boolean", default: false },
    rotation: { type: "number", default: 0 },
    opacity: { type: "number", minimum: 0, maximum: 1, default: 1 },
  }, ["path", "text", "page", "x", "y", "width", "height"]),
  tool("aligned_add_shape", "在既有專案加入可編輯矩形、橢圓或線。x/y 是頁內座標；修改預設另存「AI」副本。", {
    path: { type: "string" },
    output_path: { type: "string" },
    overwrite: { type: "boolean", default: false },
    page: { type: "integer", minimum: 1 },
    x: { type: "number" }, y: { type: "number" },
    width: { type: "number", exclusiveMinimum: 0 }, height: { type: "number", exclusiveMinimum: 0 },
    kind: { type: "string", enum: ["rectangle", "ellipse", "line"], default: "rectangle" },
    color_hex: { type: "string", default: "1A1A1A" },
    corner_radius: { type: "number", minimum: 0 },
    line_width: { type: "number", exclusiveMinimum: 0 },
    rotation: { type: "number", default: 0 },
    opacity: { type: "number", minimum: 0, maximum: 1, default: 1 },
  }, ["path", "page", "x", "y", "width", "height"]),
  tool("aligned_update_blocks", "依 block ID 更新位置、尺寸、旋轉、透明度或文字內容。修改預設另存「AI」副本。", {
    path: { type: "string" },
    output_path: { type: "string" },
    overwrite: { type: "boolean", default: false },
    updates: {
      type: "array", minItems: 1,
      items: {
        type: "object", additionalProperties: false,
        properties: {
          id: { type: "string" }, page: { type: "integer", minimum: 1 },
          x: { type: "number" }, y: { type: "number" }, width: { type: "number", exclusiveMinimum: 0 }, height: { type: "number", exclusiveMinimum: 0 },
          rotation: { type: "number" }, opacity: { type: "number", minimum: 0, maximum: 1 },
          text: { type: "string" }, color_hex: { type: "string" }, locked: { type: "boolean" },
        },
        required: ["id"],
      },
    },
  }, ["path", "updates"]),
  tool("aligned_mobile_connection", "連接、查看或中止同一個 Wi-Fi 上的 iPhone／iPad ALIGNED。連線位置與配對碼顯示在行動版設定頁。", {
    action: { type: "string", enum: ["connect", "status", "disconnect"] },
    host: { type: "string", description: "connect 時必填，例如 192.168.1.20" },
    port: { type: "integer", minimum: 1, maximum: 65535, description: "connect 時必填，預設畫面通常顯示 49777" },
    pairing_code: { type: "string", pattern: "^\\d{8}$", description: "connect 時必填，行動版畫面顯示的 8 位配對碼" },
  }, ["action"]),
  tool("aligned_get_app_state", "讀取正在執行的 ALIGNED App：目前專案、未儲存修訂版、全部 block 與使用者選取。不讀磁碟舊檔。", {}, []),
  tool("aligned_update_live_blocks", "直接修改 ALIGNED App 已開啟的畫布並進入同一套 Undo。必須帶剛讀到的 project ID 與 revision；版本不同時拒絕，避免蓋掉使用者同時操作。", {
    expected_project_id: { type: "string" },
    expected_revision: { type: "string" },
    updates: {
      type: "array", minItems: 1,
      items: {
        type: "object", additionalProperties: false,
        properties: {
          id: { type: "string" }, page: { type: "integer", minimum: 1 },
          x: { type: "number" }, y: { type: "number" }, width: { type: "number", exclusiveMinimum: 0 }, height: { type: "number", exclusiveMinimum: 0 },
          rotation: { type: "number" }, opacity: { type: "number", minimum: 0, maximum: 1 },
          text: { type: "string" }, color_hex: { type: "string" },
        },
        required: ["id"],
      },
    },
  }, ["expected_project_id", "expected_revision", "updates"]),
  tool("aligned_add_live_text", "直接在 ALIGNED App 已開啟的畫布加入可編輯文字並進入 Undo。適用於桌面版或已連線的 iPhone／iPad。", {
    expected_project_id: { type: "string" },
    expected_revision: { type: "string" },
    text: { type: "string" },
    page: { type: "integer", minimum: 1 },
    x: { type: "number" }, y: { type: "number" },
    width: { type: "number", exclusiveMinimum: 0 }, height: { type: "number", exclusiveMinimum: 0 },
    font_size: { type: "number", exclusiveMinimum: 0, default: 64 },
    font_weight: { type: "number", minimum: 0, maximum: 4, default: 3 },
    color_hex: { type: "string", default: "1A1A1A" },
    alignment: { type: "string", enum: ["leading", "center", "trailing", "justified"], default: "leading" },
    font_name: { type: "string" }, kerning_em: { type: "number" },
    line_height_multiple: { type: "number", exclusiveMinimum: 0 },
    body_frame: { type: "boolean", default: false },
    rotation: { type: "number", default: 0 }, opacity: { type: "number", minimum: 0, maximum: 1, default: 1 },
  }, ["expected_project_id", "expected_revision", "text", "page", "x", "y", "width", "height"]),
  tool("aligned_app_history", "在正在執行的 ALIGNED App 執行 Undo 或 Redo；同樣要求目前 project ID 與 revision，避免作用到錯的畫布。", {
    expected_project_id: { type: "string" },
    expected_revision: { type: "string" },
    action: { type: "string", enum: ["undo", "redo"] },
  }, ["expected_project_id", "expected_revision", "action"]),
];

const pathSchema = z.string().min(1).describe("project.json 或 .alignproj 的絕對路徑");
const outputSchema = z.string().min(1).optional().describe("選填；省略時自動另存 AI 副本");
const pageSchema = z.number().int().min(1).describe("1 起算");
const positionSchema = {
  page: pageSchema,
  x: z.number(), y: z.number(),
  width: z.number().positive(), height: z.number().positive(),
};
const writeSchema = {
  path: pathSchema,
  output_path: outputSchema,
  overwrite: z.boolean().optional().default(false).describe("只有明確為 true 才覆寫來源；覆寫前建立 .bak"),
};

const TOOL_SCHEMAS = {
  aligned_inspect_project: z.object({ path: pathSchema, page: z.number().int().min(1).optional().describe("選填，只回傳指定頁的 block；1 起算") }),
  aligned_validate_project: z.object({ path: pathSchema }),
  aligned_render_preview: z.object({
    path: pathSchema,
    page: pageSchema,
    max_width: z.number().int().min(256).max(2048).optional().default(1080),
    output_path: z.string().min(1).optional(),
  }),
  aligned_create_project: z.object({
    output_path: z.string().min(1), name: z.string().min(1),
    page_count: z.number().int().min(1).max(20).optional().default(6),
    canvas_width: z.number().positive().optional().default(1080),
    page_height: z.number().positive().optional().default(1350),
    background_hex: z.string().regex(/^#?[0-9A-Fa-f]{6}$/).optional(),
  }),
  aligned_add_text: z.object({
    ...writeSchema, ...positionSchema, text: z.string(),
    font_size: z.number().positive().optional().default(64),
    font_weight: z.number().min(0).max(4).optional().default(3),
    color_hex: z.string().regex(/^#?[0-9A-Fa-f]{6}$/).optional().default("1A1A1A"),
    alignment: z.enum(["leading", "center", "trailing"]).optional().default("leading"),
    font_name: z.string().optional(), kerning_em: z.number().optional(),
    line_height_multiple: z.number().positive().optional(),
    body_frame: z.boolean().optional().default(false), vertical: z.boolean().optional().default(false),
    rotation: z.number().optional().default(0), opacity: z.number().min(0).max(1).optional().default(1),
  }),
  aligned_add_shape: z.object({
    ...writeSchema, ...positionSchema,
    kind: z.enum(["rectangle", "ellipse", "line"]).optional().default("rectangle"),
    color_hex: z.string().regex(/^#?[0-9A-Fa-f]{6}$/).optional().default("1A1A1A"),
    corner_radius: z.number().min(0).optional(), line_width: z.number().positive().optional(),
    rotation: z.number().optional().default(0), opacity: z.number().min(0).max(1).optional().default(1),
  }),
  aligned_update_blocks: z.object({
    ...writeSchema,
    updates: z.array(z.object({
      id: z.string().min(1), page: z.number().int().min(1).optional(),
      x: z.number().optional(), y: z.number().optional(), width: z.number().positive().optional(), height: z.number().positive().optional(),
      rotation: z.number().optional(), opacity: z.number().min(0).max(1).optional(),
      text: z.string().optional(), color_hex: z.string().regex(/^#?[0-9A-Fa-f]{6}$/).optional(), locked: z.boolean().optional(),
    }).strict()).min(1),
  }),
  aligned_mobile_connection: z.object({
    action: z.enum(["connect", "status", "disconnect"]),
    host: z.string().min(1).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    pairing_code: z.string().regex(/^\d{8}$/).optional(),
  }),
  aligned_get_app_state: z.object({}),
  aligned_update_live_blocks: z.object({
    expected_project_id: z.string().min(1), expected_revision: z.string().min(1),
    updates: z.array(z.object({
      id: z.string().min(1), page: z.number().int().min(1).optional(),
      x: z.number().optional(), y: z.number().optional(), width: z.number().positive().optional(), height: z.number().positive().optional(),
      rotation: z.number().optional(), opacity: z.number().min(0).max(1).optional(),
      text: z.string().optional(), color_hex: z.string().regex(/^#?[0-9A-Fa-f]{6}$/).optional(),
    }).strict()).min(1),
  }),
  aligned_add_live_text: z.object({
    expected_project_id: z.string().min(1), expected_revision: z.string().min(1),
    text: z.string(), page: z.number().int().min(1),
    x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(),
    font_size: z.number().positive().optional().default(64),
    font_weight: z.number().min(0).max(4).optional().default(3),
    color_hex: z.string().regex(/^#?[0-9A-Fa-f]{6}$/).optional().default("1A1A1A"),
    alignment: z.enum(["leading", "center", "trailing", "justified"]).optional().default("leading"),
    font_name: z.string().optional(), kerning_em: z.number().optional(),
    line_height_multiple: z.number().positive().optional(), body_frame: z.boolean().optional().default(false),
    rotation: z.number().optional().default(0), opacity: z.number().min(0).max(1).optional().default(1),
  }),
  aligned_app_history: z.object({
    expected_project_id: z.string().min(1), expected_revision: z.string().min(1),
    action: z.enum(["undo", "redo"]),
  }),
};

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolveRun(stdout) : reject(new Error(stderr.trim() || `${command} 結束碼 ${code}`)));
  });
}

const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

export async function bridgeCall(method, params = {}) {
  const lanHost = process.env.ALIGNED_LAN_HOST?.trim();
  const lanPort = Number(process.env.ALIGNED_LAN_PORT);
  const lanToken = process.env.ALIGNED_LAN_TOKEN?.trim();
  if (lanHost || process.env.ALIGNED_LAN_PORT || lanToken) {
    if (!lanHost || !Number.isInteger(lanPort) || lanPort < 1 || lanPort > 65535 || !/^\d{8}$/.test(lanToken || "")) {
      throw new Error("行動版 MCP 設定不完整：需要 ALIGNED_LAN_HOST、ALIGNED_LAN_PORT、8 位 ALIGNED_LAN_TOKEN");
    }
    return lanBridgeCall({ host: lanHost, port: lanPort, token: lanToken }, method, params);
  }
  if (mobileEndpoint) return lanBridgeCall(mobileEndpoint, method, params);
  const discoveryPath = process.env.ALIGNED_AGENT_DISCOVERY || join(tmpdir(), "aligned-agent-bridge.json");
  let discovery;
  try {
    discovery = JSON.parse(await readFile(discoveryPath, "utf8"));
  } catch {
    throw new Error("找不到正在執行的 ALIGNED App。請先打開桌面版 ALIGNED");
  }
  if (discovery.version !== 1 || !discovery.directory || !discovery.token || !Number.isInteger(discovery.pid)) {
    throw new Error("ALIGNED App IPC discovery 格式無效；請重新啟動 ALIGNED");
  }
  try {
    process.kill(discovery.pid, 0);
  } catch (error) {
    if (error?.code !== "EPERM") throw new Error("ALIGNED App 已關閉；請重新打開桌面版 ALIGNED");
  }
  const requestDir = join(discovery.directory, "requests");
  const responseDir = join(discovery.directory, "responses");
  await stat(requestDir);
  await stat(responseDir);
  const id = randomUUID();
  const requestPath = join(requestDir, `${id}.json`);
  const tempPath = join(requestDir, `${id}.tmp-${process.pid}`);
  const responsePath = join(responseDir, `${id}.json`);
  await writeFile(tempPath, JSON.stringify({ id, token: discovery.token, method, params }), "utf8");
  await rename(tempPath, requestPath);
  const deadline = Date.now() + 8000;
  try {
    while (Date.now() < deadline) {
      if (existsSync(responsePath)) {
        const response = JSON.parse(await readFile(responsePath, "utf8"));
        if (response.error) throw new Error(response.error);
        return response.result;
      }
      await delay(50);
    }
    throw new Error("ALIGNED App 沒有回應；它可能仍在啟動或已被系統暫停");
  } finally {
    await rm(requestPath, { force: true });
    await rm(tempPath, { force: true });
    await rm(responsePath, { force: true });
  }
}

export async function lanBridgeCall(endpoint, method, params = {}) {
  const id = randomUUID();
  const request = `${JSON.stringify({ version: 1, id, token: endpoint.token, method, params })}\n`;
  return new Promise((resolveCall, rejectCall) => {
    const socket = createConnection({ host: endpoint.host, port: endpoint.port });
    let response = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) rejectCall(error); else resolveCall(value);
    };
    socket.setTimeout(8000);
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      if (Buffer.byteLength(response, "utf8") > 4 * 1024 * 1024) {
        finish(new Error("ALIGNED 行動版回應超過 4 MB"));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        const decoded = JSON.parse(response.slice(0, newline));
        if (decoded.id !== id) throw new Error("ALIGNED 行動版回應識別碼不符");
        if (decoded.error) throw new Error(decoded.error);
        finish(null, decoded.result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("timeout", () => finish(new Error("ALIGNED 行動版沒有回應；請確認 App 在前景且區網共編已開啟")));
    socket.on("error", (error) => finish(new Error(`無法連到 ALIGNED 行動版：${error.message}`)));
    socket.on("end", () => {
      if (!settled) finish(new Error("ALIGNED 行動版在回應前關閉連線"));
    });
  });
}

async function loadProject(inputPath) {
  const sourcePath = resolve(inputPath);
  await stat(sourcePath);
  if (extname(sourcePath).toLowerCase() !== ".alignproj") {
    return { sourcePath, rootDir: dirname(sourcePath), project: JSON.parse(await readFile(sourcePath, "utf8")), cleanup: null };
  }
  if (process.platform !== "darwin") throw new Error("目前只有 macOS 能解開 .alignproj；Windows 請使用 project.json 專案資料夾");
  const rootDir = await mkdtemp(join(tmpdir(), "aligned-mcp-read-"));
  try {
    await run("aa", ["extract", "-i", sourcePath, "-d", rootDir]);
    return {
      sourcePath,
      rootDir,
      project: JSON.parse(await readFile(join(rootDir, "project.json"), "utf8")),
      cleanup: () => rm(rootDir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }
}

function defaultOutputPath(sourcePath) {
  const p = parse(sourcePath);
  return join(p.dir, `${p.name} AI${p.ext || ".json"}`);
}

async function atomicReplace(tempPath, destination) {
  try {
    await rename(tempPath, destination);
  } catch (error) {
    if (!existsSync(destination)) throw error;
    await rm(destination, { force: true });
    await rename(tempPath, destination);
  }
}

async function saveProject(loaded, requestedOutput, overwrite = false) {
  const source = loaded.sourcePath;
  const destination = resolve(requestedOutput || (overwrite ? source : defaultOutputPath(source)));
  const same = destination === source;
  if (same && !overwrite) throw new Error("拒絕覆寫來源。請提供 output_path，或明確設定 overwrite: true");
  await mkdir(dirname(destination), { recursive: true });
  if (same && existsSync(destination)) {
    const backup = `${destination}.bak`;
    if (!existsSync(backup)) await copyFile(destination, backup);
  }

  loaded.project.updatedAt = new Date().toISOString();
  const json = `${JSON.stringify(loaded.project, null, 2)}\n`;
  if (extname(destination).toLowerCase() !== ".alignproj") {
    const temp = `${destination}.tmp-${process.pid}`;
    await writeFile(temp, json, "utf8");
    await atomicReplace(temp, destination);
    return destination;
  }
  if (process.platform !== "darwin") throw new Error("目前只有 macOS 能建立 .alignproj；Windows 請輸出 project.json");
  const staging = await mkdtemp(join(tmpdir(), "aligned-mcp-write-"));
  try {
    const assets = join(loaded.rootDir, "assets");
    if (existsSync(assets)) await cp(assets, join(staging, "assets"), { recursive: true });
    await writeFile(join(staging, "project.json"), json, "utf8");
    const temp = `${destination}.tmp-${process.pid}`;
    await run("aa", ["archive", "-d", staging, "-o", temp, "-a", "lzfse"]);
    await atomicReplace(temp, destination);
    return destination;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function rectOf(block) {
  const value = block?.frame;
  if (!Array.isArray(value) || !Array.isArray(value[0]) || !Array.isArray(value[1])) return null;
  const [x, y] = value[0];
  const [w, h] = value[1];
  return [x, y, w, h].every(finite) ? { x, y, w, h } : null;
}

function contentType(block) {
  const content = block?.content;
  if (!content || typeof content !== "object") return "unknown";
  const keys = Object.keys(content);
  return keys.length === 1 ? keys[0] : "unknown";
}

function textPayload(block) {
  const kind = contentType(block);
  return kind === "text" || kind === "textFlow" ? block.content[kind]?._0 : null;
}

function validate(project, rootDir) {
  const errors = [];
  const warnings = [];
  if (!project || typeof project !== "object") return { valid: false, errors: ["專案根節點不是物件"], warnings };
  if (!finite(project.canvasWidth) || project.canvasWidth <= 0) errors.push("canvasWidth 必須大於 0");
  if (!finite(project.pageHeight) || project.pageHeight <= 0) errors.push("pageHeight 必須大於 0");
  if (!Number.isInteger(project.pageCount) || project.pageCount < 1 || project.pageCount > 20) errors.push("pageCount 必須是 1–20 的整數");
  if (!Array.isArray(project.blocks)) errors.push("blocks 必須是陣列");
  const ids = new Set();
  const totalWidth = (finite(project.canvasWidth) ? project.canvasWidth : 0) * (Number.isInteger(project.pageCount) ? project.pageCount : 0);
  for (const [index, block] of (Array.isArray(project.blocks) ? project.blocks : []).entries()) {
    const label = `blocks[${index}]`;
    if (typeof block.id !== "string" || !block.id) errors.push(`${label} 缺少 id`);
    else if (ids.has(block.id)) errors.push(`${label} 的 id 重複：${block.id}`);
    else ids.add(block.id);
    const rect = rectOf(block);
    if (!rect || rect.w <= 0 || rect.h <= 0) errors.push(`${label} 的 frame 無效`);
    else {
      if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > totalWidth || rect.y + rect.h > project.pageHeight) warnings.push(`${label} 超出畫布範圍`);
      const kind = contentType(block);
      if ((kind === "text" || kind === "textFlow") && project.canvasWidth > 0) {
        const start = Math.floor(rect.x / project.canvasWidth);
        const end = Math.floor((rect.x + rect.w - 0.001) / project.canvasWidth);
        if (start !== end) warnings.push(`${label} 的文字跨過分頁線`);
      }
    }
    const kind = contentType(block);
    if (!new Set(["text", "textFlow", "image", "video", "shape", "model", "doodle"]).has(kind)) errors.push(`${label} 的 content 型別無效`);
    const text = textPayload(block);
    if (text) {
      if (text.colorHex && !hexPattern.test(String(text.colorHex).toUpperCase())) errors.push(`${label} 的 colorHex 無效`);
      const hasRunColor = Array.isArray(text.text) && text.text.some((part) => part && typeof part === "object" && part["SwiftUI.ForegroundColor"]);
      if (!hasRunColor) warnings.push(`${label} 的文字沒有烤入 AttributedString 顏色，iOS 可能顯示錯色`);
    }
    if (["image", "video", "model"].includes(kind)) {
      const payload = block.content[kind]?._0;
      const name = payload?.assetFileName;
      if (name && !existsSync(join(rootDir, "assets", basename(name)))) warnings.push(`${label} 找不到素材：${name}`);
    }
  }
  return { valid: errors.length === 0, errors, warnings };
}

function blockSummary(block, project) {
  const rect = rectOf(block);
  const kind = contentType(block);
  const text = textPayload(block);
  const media = ["image", "video", "model"].includes(kind) ? block.content[kind]?._0 : null;
  return {
    id: block.id,
    type: kind,
    page: rect ? Math.floor(rect.x / project.canvasWidth) + 1 : null,
    frame: rect,
    rotation: block.rotation,
    z_index: block.zIndex,
    locked: block.locked,
    opacity: block.opacity,
    ...(text ? { text: Array.isArray(text.text) ? text.text.filter((part) => typeof part === "string").join("") : String(text.text ?? "") } : {}),
    ...(media?.assetFileName ? { asset: media.assetFileName } : {}),
  };
}

function summary(project, rootDir, pageFilter) {
  const counts = {};
  for (const block of project.blocks ?? []) counts[contentType(block)] = (counts[contentType(block)] ?? 0) + 1;
  if (pageFilter !== undefined) requirePage(project, pageFilter);
  const blocks = (project.blocks ?? []).map((block) => blockSummary(block, project))
    .filter((block) => pageFilter === undefined || block.page === pageFilter);
  return {
    id: project.id,
    name: project.name,
    canvas: { width: project.canvasWidth, height: project.pageHeight, pages: project.pageCount },
    block_count: project.blocks?.length ?? 0,
    block_types: counts,
    blocks,
    validation: validate(project, rootDir),
  };
}

function linearChannel(byte) {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function attributedText(text, hex) {
  const channels = hex.match(/../g).map((part) => Number.parseInt(part, 16));
  return [text, {
    "SwiftUI.ForegroundColor": {
      tag: { constant: {} },
      value: { red: linearChannel(channels[0]), green: linearChannel(channels[1]), blue: linearChannel(channels[2]), opacity: 1 },
    },
  }];
}

function requirePage(project, page) {
  if (!Number.isInteger(page) || page < 1 || page > project.pageCount) throw new Error(`page 必須在 1–${project.pageCount} 之間`);
}

function nextZ(project) {
  return Math.max(0, ...(project.blocks ?? []).map((block) => finite(block.zIndex) ? block.zIndex : 0)) + 1;
}

async function mutate(args, mutation) {
  const loaded = await loadProject(args.path);
  try {
    loaded.project.blocks ??= [];
    await mutation(loaded.project);
    const check = validate(loaded.project, loaded.rootDir);
    if (!check.valid) throw new Error(`修改後專案驗證失敗：${check.errors.join("；")}`);
    const outputPath = await saveProject(loaded, args.output_path, args.overwrite === true);
    return { output_path: outputPath, ...summary(loaded.project, loaded.rootDir) };
  } finally {
    await loaded.cleanup?.();
  }
}

export async function callTool(name, args = {}) {
  if (name === "aligned_mobile_connection") {
    if (args.action === "status") {
      return mobileEndpoint
        ? { connected: true, host: mobileEndpoint.host, port: mobileEndpoint.port }
        : { connected: false };
    }
    if (args.action === "disconnect") {
      mobileEndpoint = null;
      return { connected: false };
    }
    if (!args.host || !Number.isInteger(args.port) || !/^\d{8}$/.test(args.pairing_code || "")) {
      throw new Error("connect 需要 host、port 與 8 位 pairing_code");
    }
    const candidate = { host: args.host, port: args.port, token: args.pairing_code };
    const state = await lanBridgeCall(candidate, "get_state");
    mobileEndpoint = candidate;
    return { connected: true, host: candidate.host, port: candidate.port, app: state };
  }
  if (name === "aligned_get_app_state") return bridgeCall("get_state");
  if (name === "aligned_update_live_blocks") return bridgeCall("update_blocks", args);
  if (name === "aligned_add_live_text") return bridgeCall("add_text", args);
  if (name === "aligned_app_history") return bridgeCall("history", args);
  if (name === "aligned_inspect_project" || name === "aligned_validate_project") {
    const loaded = await loadProject(args.path);
    try {
      return name === "aligned_validate_project" ? validate(loaded.project, loaded.rootDir) : summary(loaded.project, loaded.rootDir, args.page);
    } finally {
      await loaded.cleanup?.();
    }
  }
  if (name === "aligned_render_preview") {
    const loaded = await loadProject(args.path);
    const work = await mkdtemp(join(tmpdir(), "aligned-mcp-render-"));
    try {
      requirePage(loaded.project, args.page);
      const outputPath = args.output_path
        ? resolve(args.output_path)
        : join(tmpdir(), "aligned-mcp-previews", `${parse(loaded.sourcePath).name}-p${String(args.page).padStart(2, "0")}-${randomUUID()}.png`);
      if (args.output_path && existsSync(outputPath)) throw new Error("output_path 已存在；預覽不會覆寫現有檔案");
      const projectPath = join(work, "project.json");
      const jobPath = join(work, "job.json");
      await writeFile(projectPath, JSON.stringify(loaded.project), "utf8");
      await writeFile(jobPath, JSON.stringify({
        projectPath, rootDir: loaded.rootDir, outputPath, page: args.page,
        maxWidth: args.max_width ?? 1080, repoRoot: REPO_ROOT,
      }), "utf8");
      const stdout = await run(process.execPath, ["--import", "tsx", join(MCP_DIR, "render-preview.ts"), jobPath]);
      return JSON.parse(stdout);
    } finally {
      await rm(work, { recursive: true, force: true });
      await loaded.cleanup?.();
    }
  }
  if (name === "aligned_create_project") {
    if (existsSync(resolve(args.output_path))) throw new Error("output_path 已存在；建立新專案不會覆寫現有檔案");
    const pageCount = args.page_count ?? 6;
    const width = args.canvas_width ?? 1080;
    const height = args.page_height ?? 1350;
    if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 20) throw new Error("page_count 必須是 1–20 的整數");
    if (!finite(width) || width <= 0 || !finite(height) || height <= 0) throw new Error("畫布尺寸必須大於 0");
    const now = new Date().toISOString();
    const project = { id: randomUUID().toUpperCase(), name: String(args.name), createdAt: now, updatedAt: now, canvasWidth: width, pageHeight: height, pageCount, blocks: [] };
    if (args.background_hex) {
      const background = upperHex(args.background_hex);
      project.pageBackgroundHex = Object.fromEntries(Array.from({ length: pageCount }, (_, i) => [String(i), background]));
    }
    const rootDir = await mkdtemp(join(tmpdir(), "aligned-mcp-create-"));
    const loaded = { sourcePath: resolve(args.output_path), rootDir, project, cleanup: () => rm(rootDir, { recursive: true, force: true }) };
    try {
      const outputPath = await saveProject(loaded, args.output_path, true);
      return { output_path: outputPath, ...summary(project, loaded.rootDir) };
    } finally {
      await loaded.cleanup();
    }
  }
  if (name === "aligned_add_text") {
    return mutate(args, async (project) => {
      requirePage(project, args.page);
      const color = upperHex(args.color_hex);
      const payload = {
        text: attributedText(String(args.text), color), alignment: args.alignment ?? "leading",
        fontSize: args.font_size ?? 64, fontWeightValue: args.font_weight ?? 3,
        colorHex: color, inkX: true,
      };
      if (args.font_name) payload.fontName = args.font_name;
      if (finite(args.kerning_em)) payload.kerningEm = args.kerning_em;
      if (finite(args.line_height_multiple)) payload.lineHeightMultiple = args.line_height_multiple;
      if (args.body_frame === true) { payload.isBodyFrame = true; payload.manualWidth = args.width; payload.manualHeight = args.height; }
      if (args.vertical === true) payload.vertical = true;
      project.blocks.push({
        id: randomUUID().toUpperCase(),
        frame: [[(args.page - 1) * project.canvasWidth + args.x, args.y], [args.width, args.height]],
        rotation: args.rotation ?? 0, zIndex: nextZ(project), locked: false, opacity: args.opacity ?? 1,
        content: { text: { _0: payload } },
      });
    });
  }
  if (name === "aligned_add_shape") {
    return mutate(args, async (project) => {
      requirePage(project, args.page);
      const shape = { kind: args.kind ?? "rectangle", colorHex: upperHex(args.color_hex) };
      if (finite(args.corner_radius)) shape.cornerRadius = args.corner_radius;
      if (finite(args.line_width)) shape.lineWidth = args.line_width;
      project.blocks.push({
        id: randomUUID().toUpperCase(),
        frame: [[(args.page - 1) * project.canvasWidth + args.x, args.y], [args.width, args.height]],
        rotation: args.rotation ?? 0, zIndex: nextZ(project), locked: false, opacity: args.opacity ?? 1,
        content: { shape: { _0: shape } },
      });
    });
  }
  if (name === "aligned_update_blocks") {
    return mutate(args, async (project) => {
      const byId = new Map(project.blocks.map((block) => [block.id, block]));
      for (const update of args.updates ?? []) {
        const block = byId.get(update.id);
        if (!block) throw new Error(`找不到 block：${update.id}`);
        const rect = rectOf(block);
        if (!rect) throw new Error(`block frame 無效：${update.id}`);
        const page = update.page ?? Math.floor(rect.x / project.canvasWidth) + 1;
        requirePage(project, page);
        const localX = update.x ?? (rect.x % project.canvasWidth);
        block.frame = [[(page - 1) * project.canvasWidth + localX, update.y ?? rect.y], [update.width ?? rect.w, update.height ?? rect.h]];
        if (finite(update.rotation)) block.rotation = update.rotation;
        if (finite(update.opacity)) block.opacity = update.opacity;
        if (typeof update.locked === "boolean") block.locked = update.locked;
        const text = textPayload(block);
        if (update.text !== undefined) {
          if (!text) throw new Error(`block 不是文字：${update.id}`);
          const color = upperHex(update.color_hex ?? text.colorHex);
          text.text = attributedText(String(update.text), color);
          text.colorHex = color;
        } else if (update.color_hex !== undefined) {
          if (!text) throw new Error(`color_hex 目前只支援文字 block：${update.id}`);
          const color = upperHex(update.color_hex);
          const plain = Array.isArray(text.text) ? text.text.filter((part) => typeof part === "string").join("") : String(text.text ?? "");
          text.text = attributedText(plain, color);
          text.colorHex = color;
        }
      }
    });
  }
  throw new Error(`未知工具：${name}`);
}

function textResult(value, isError = false) {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], ...(isError ? { isError: true } : {}) };
}

export function createServer() {
  const server = new McpServer(SERVER, {
    instructions: "ALIGNED 本機排版工具。修改預設另存 AI 副本；覆寫必須明確傳 overwrite=true。",
  });
  for (const spec of TOOLS) {
    const readOnly = spec.name === "aligned_inspect_project" || spec.name === "aligned_validate_project"
      || spec.name === "aligned_render_preview" || spec.name === "aligned_get_app_state";
    server.registerTool(spec.name, {
      description: spec.description,
      inputSchema: TOOL_SCHEMAS[spec.name],
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: spec.name === "aligned_update_live_blocks" || spec.name === "aligned_add_live_text" || spec.name === "aligned_app_history",
        idempotentHint: readOnly,
        openWorldHint: false,
      },
    }, async (args) => {
      try {
        const result = await callTool(spec.name, args);
        if (spec.name === "aligned_render_preview") {
          const png = await readFile(result.output_path);
          const response = args.output_path
            ? result
            : { ...result, output_path: null, temporary_file_removed: true };
          if (!args.output_path) await rm(result.output_path, { force: true });
          return {
            content: [
              { type: "text", text: JSON.stringify(response, null, 2) },
              { type: "image", data: png.toString("base64"), mimeType: "image/png" },
            ],
          };
        }
        return textResult(result);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error), true);
      }
    });
  }
  return server;
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  serveStdio(() => createServer(), {
    onerror: (error) => console.error(`[aligned-mcp] ${error.message}`),
  });
}
