import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
import { callTool, createServer, lanBridgeCall, TOOLS } from "./server.mjs";

test("builds an official MCP server with the expected tools", () => {
  const server = createServer();
  assert.ok(server);
  assert.equal(TOOLS.length, 12);
  assert.ok(TOOLS.some((item) => item.name === "aligned_add_text"));
  assert.ok(TOOLS.some((item) => item.name === "aligned_add_live_text"));
  assert.ok(TOOLS.some((item) => item.name === "aligned_mobile_connection"));
});

test("connects the mobile MCP tool and routes live canvas calls over LAN", async () => {
  const token = "12345678";
  const server = createNetServer((socket) => {
    let input = "";
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline));
      assert.equal(request.version, 1);
      assert.equal(request.token, token);
      assert.equal(request.method, "get_state");
      socket.end(`${JSON.stringify({ id: request.id, result: { connected: true, surface: "canvas" }, error: null })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const connected = await callTool("aligned_mobile_connection", {
      action: "connect", host: "127.0.0.1", port: address.port, pairing_code: token,
    });
    assert.equal(connected.connected, true);
    assert.deepEqual(await callTool("aligned_get_app_state"), { connected: true, surface: "canvas" });
    assert.deepEqual(await callTool("aligned_mobile_connection", { action: "status" }), {
      connected: true, host: "127.0.0.1", port: address.port,
    });
    assert.deepEqual(await callTool("aligned_mobile_connection", { action: "disconnect" }), { connected: false });
  } finally {
    await callTool("aligned_mobile_connection", { action: "disconnect" });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("rejects a LAN response with a mismatched request id", async () => {
  const server = createNetServer((socket) => {
    socket.once("data", () => socket.end(`${JSON.stringify({ id: "wrong", result: {}, error: null })}\n`));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await assert.rejects(
      lanBridgeCall({ host: "127.0.0.1", port: address.port, token: "12345678" }, "get_state"),
      /識別碼不符/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("exchanges a live request with the App IPC bridge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aligned-mcp-bridge-test-"));
  const requests = join(dir, "requests");
  const responses = join(dir, "responses");
  const discovery = join(dir, "discovery.json");
  await mkdir(requests); await mkdir(responses);
  await writeFile(discovery, JSON.stringify({
    version: 1, pid: process.pid, directory: dir, token: "test-token",
  }));
  process.env.ALIGNED_AGENT_DISCOVERY = discovery;
  const fakeApp = async () => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const files = (await readdir(requests)).filter((name) => name.endsWith(".json"));
      if (files.length) {
        const request = JSON.parse(await readFile(join(requests, files[0]), "utf8"));
        assert.equal(request.token, "test-token");
        assert.equal(request.method, "get_state");
        await writeFile(join(responses, `${request.id}.json`), JSON.stringify({
          result: { connected: true, editing: true, project: { id: "LIVE" } }, error: null,
        }));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("fake App 沒收到 request");
  };
  try {
    const [state] = await Promise.all([callTool("aligned_get_app_state"), fakeApp()]);
    assert.equal(state.connected, true);
    assert.equal(state.project.id, "LIVE");
  } finally {
    delete process.env.ALIGNED_AGENT_DISCOVERY;
    await rm(dir, { recursive: true, force: true });
  }
});

test("renders a page through the shared ALIGNED renderer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aligned-mcp-test-"));
  try {
    const source = join(dir, "render.json");
    const preview = join(dir, "preview.png");
    await callTool("aligned_create_project", {
      output_path: source, name: "Render Test", page_count: 1,
      canvas_width: 1080, page_height: 1350, background_hex: "EFEEE8",
    });
    await callTool("aligned_add_shape", {
      path: source, overwrite: true, page: 1, x: 100, y: 100,
      width: 400, height: 300, kind: "ellipse", color_hex: "C0703F",
    });
    await callTool("aligned_add_text", {
      path: source, overwrite: true, page: 1, x: 100, y: 500,
      width: 800, height: 180, text: "ALIGNED MCP", color_hex: "1A1A1A",
    });
    const rendered = await callTool("aligned_render_preview", {
      path: source, page: 1, max_width: 540, output_path: preview,
    });
    assert.equal(rendered.width, 540);
    assert.equal(rendered.height, 675);
    assert.deepEqual(rendered.warnings, []);
    assert.ok((await stat(preview)).size > 1_000);
    assert.deepEqual([...await readFile(preview)].slice(0, 8), [137, 80, 78, 71, 13, 10, 26, 10]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renders a real project with bundled image assets", async () => {
  const source = fileURLToPath(new URL("../public/samples/real/project.json", import.meta.url));
  const rendered = await callTool("aligned_render_preview", { path: source, page: 1, max_width: 540 });
  try {
    assert.equal(rendered.width, 540);
    assert.equal(rendered.height, 675);
    assert.deepEqual(rendered.warnings, []);
    assert.ok((await stat(rendered.output_path)).size > 20_000);
  } finally {
    await rm(rendered.output_path, { force: true });
  }
});

test("create, edit, inspect and validate a project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aligned-mcp-test-"));
  try {
    const source = join(dir, "source.json");
    const edited = join(dir, "edited.json");
    await callTool("aligned_create_project", { output_path: source, name: "MCP Test", page_count: 2, background_hex: "EFEEE8" });
    const added = await callTool("aligned_add_text", {
      path: source, output_path: edited, text: "Hello ALIGNED", page: 2,
      x: 64, y: 120, width: 720, height: 160, color_hex: "26251F",
    });
    assert.equal(added.block_count, 1);
    assert.equal(added.validation.valid, true);
    const project = JSON.parse(await readFile(edited, "utf8"));
    assert.equal(project.blocks[0].frame[0][0], 1144);
    assert.ok(project.blocks[0].content.text._0.text[1]["SwiftUI.ForegroundColor"]);
    const inspected = await callTool("aligned_inspect_project", { path: edited });
    assert.equal(inspected.block_types.text, 1);
    assert.equal(inspected.blocks[0].page, 2);
    assert.equal(inspected.blocks[0].text, "Hello ALIGNED");
    assert.deepEqual(inspected.validation.errors, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mutations default to a copy and overwrite creates a backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aligned-mcp-test-"));
  try {
    const source = join(dir, "source.json");
    await callTool("aligned_create_project", { output_path: source, name: "Safe writes", page_count: 1 });
    const copy = await callTool("aligned_add_shape", {
      path: source, page: 1, x: 20, y: 20, width: 200, height: 100, color_hex: "C0703F",
    });
    assert.equal(copy.output_path, join(dir, "source AI.json"));
    assert.equal(JSON.parse(await readFile(source, "utf8")).blocks.length, 0);
    await callTool("aligned_add_shape", {
      path: source, overwrite: true, page: 1, x: 20, y: 20, width: 200, height: 100,
    });
    assert.equal(JSON.parse(await readFile(source, "utf8")).blocks.length, 1);
    assert.equal(JSON.parse(await readFile(`${source}.bak`, "utf8")).blocks.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("creates and reopens a native .alignproj package on macOS", { skip: process.platform !== "darwin" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "aligned-mcp-test-"));
  try {
    const output = join(dir, "native.alignproj");
    await callTool("aligned_create_project", { output_path: output, name: "Native package", page_count: 3 });
    const inspected = await callTool("aligned_inspect_project", { path: output });
    assert.equal(inspected.name, "Native package");
    assert.equal(inspected.canvas.pages, 3);
    assert.equal(inspected.validation.valid, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("create_project refuses to replace an existing project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aligned-mcp-test-"));
  try {
    const output = join(dir, "existing.json");
    await callTool("aligned_create_project", { output_path: output, name: "Original" });
    await assert.rejects(
      callTool("aligned_create_project", { output_path: output, name: "Replacement" }),
      /已存在/,
    );
    assert.equal(JSON.parse(await readFile(output, "utf8")).name, "Original");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
