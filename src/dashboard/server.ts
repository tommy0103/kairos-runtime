import { Elysia, t } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { cors } from "@elysiajs/cors";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const AUTH_TOKEN = process.env.DASHBOARD_AUTH_TOKEN || "yukimochi0721";
const MEMORY_FILES_ROOT = process.env.MEMORY_FILES_ROOT || "../../.runtime/memory_files";
const PORT = Number(process.env.DASHBOARD_PORT || 8080);

const app = new Elysia()
  .use(cors())
  .use(staticPlugin({
    assets: "public",
    prefix: ""
  }))
  .derive(({ headers }) => {
    const auth = headers['authorization'];
    return {
      isAuthorized: auth === `Bearer ${AUTH_TOKEN}`
    };
  })
  .onBeforeHandle(({ isAuthorized, path }) => {
    // 允许通过身份验证界面，不拦截静态文件，只拦截 API
    if (path === "/api/auth/login" || !path.startsWith("/api")) return;
    if (!isAuthorized) {
      return new Response("Unauthorized", { status: 401 });
    }
  })
  
  // 显式映射根路径
  .get("/", () => Bun.file("public/index.html"))

  // --- Auth API ---
  .post("/api/auth/login", ({ body }) => {
    if (body.token === AUTH_TOKEN) return { success: true };
    return new Response("Invalid Token", { status: 401 });
  }, { body: t.Object({ token: t.String() }) })

  // --- Logs API (SSE) ---
  .get("/api/logs", ({ set }) => {
    set.headers['Content-Type'] = 'text/event-stream';
    set.headers['Cache-Control'] = 'no-cache';
    set.headers['Connection'] = 'keep-alive';

    const child = spawn("docker", ["compose", "logs", "-f", "--tail", "100"], {
      cwd: path.resolve(import.meta.dir, "../../")
    });

    return new ReadableStream({
      start(controller) {
        child.stdout.on("data", (data) => {
          controller.enqueue(`data: ${data.toString()}\n\n`);
        });
        child.stderr.on("data", (data) => {
          controller.enqueue(`data: ${data.toString()}\n\n`);
        });
        child.on("close", () => controller.close());
      },
      cancel() {
        child.kill();
      }
    });
  })

  // --- Status API ---
  .get("/api/status", async () => {
    const sockets = [
      { name: "VFS", path: "/run/kairos-runtime/sockets/kairos-runtime-vfs.sock" },
      { name: "Enclave", path: "/run/kairos-runtime/sockets/kairos-runtime-enclave.sock" }
    ];

    const status = await Promise.all(sockets.map(async (s) => {
      try {
        await fs.access(s.path);
        return { name: s.name, online: true };
      } catch {
        return { name: s.name, online: false };
      }
    }));

    return { services: status, timestamp: Date.now() };
  })

  // --- Memory Files API ---
  .get("/api/memory/files", async () => {
    try {
      const files = await fs.readdir(MEMORY_FILES_ROOT);
      return files.filter(f => f.endsWith(".md"));
    } catch {
      return [];
    }
  })
  .get("/api/memory/content", async ({ query }) => {
    const filePath = path.join(MEMORY_FILES_ROOT, String(query.file));
    const content = await fs.readFile(filePath, "utf-8");
    return { content };
  }, { query: t.Object({ file: t.String() }) })
  .post("/api/memory/content", async ({ body }) => {
    const filePath = path.join(MEMORY_FILES_ROOT, body.file);
    await fs.writeFile(filePath, body.content, "utf-8");
    return { success: true };
  }, { body: t.Object({ file: t.String(), content: t.String() }) })

  // --- Actions ---
  .post("/api/actions/restart", async () => {
    spawn("docker", ["compose", "restart", "app"], {
      cwd: path.resolve(import.meta.dir, "../../"),
      detached: true,
      stdio: "ignore"
    }).unref();
    return { success: true, message: "Restarting app container..." };
  })

  .listen(PORT);

console.log(`🦊 Kairos Dashboard is running at http://localhost:${PORT}`);
