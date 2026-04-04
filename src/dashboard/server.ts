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
  .use(staticPlugin({ assets: "public", prefix: "" }))
  .derive(({ headers }) => {
    const auth = headers['authorization'];
    return { isAuthorized: auth === `Bearer ${AUTH_TOKEN}` };
  })
  .onBeforeHandle(({ isAuthorized, path }) => {
    if (path === "/api/auth/login" || !path.startsWith("/api")) return;
    if (!isAuthorized) return new Response("Unauthorized", { status: 401 });
  })
  
  .get("/", () => Bun.file("public/index.html"))

  .post("/api/auth/login", ({ body }) => {
    if (body.token === AUTH_TOKEN) return { success: true };
    return new Response("Invalid Token", { status: 401 });
  }, { body: t.Object({ token: t.String() }) })

  .get("/api/logs", ({ set }) => {
    set.headers['Content-Type'] = 'text/event-stream';
    set.headers['Cache-Control'] = 'no-cache';
    set.headers['Connection'] = 'keep-alive';

    const child = spawn("docker", ["logs", "-f", "--tail", "200", "memoh-lite-app-1"], {
      env: { ...process.env, DOCKER_HOST: "unix:///var/run/docker.sock" }
    });

    return new ReadableStream({
      start(controller) {
        const handleData = (data: Buffer) => {
          const lines = data.toString().split('\n');
          lines.forEach(line => {
            if (line.trim()) controller.enqueue(`data: ${line}\n\n`);
          });
        };
        child.stdout.on("data", handleData);
        child.stderr.on("data", handleData);
        child.on("close", () => controller.close());
      },
      cancel() { child.kill(); }
    });
  })

  .get("/api/status", async () => {
    const sockets = [
      { name: "VFS", path: "/run/kairos-runtime/sockets/kairos-runtime-vfs.sock" },
      { name: "Enclave", path: "/run/kairos-runtime/sockets/kairos-runtime-enclave.sock" }
    ];
    const status = await Promise.all(sockets.map(async (s) => {
      try { await fs.access(s.path); return { name: s.name, online: true }; }
      catch { return { name: s.name, online: false }; }
    }));
    return { services: status, timestamp: Date.now() };
  })

  .get("/api/memory/files", async () => {
    try { return (await fs.readdir(MEMORY_FILES_ROOT)).filter(f => f.endsWith(".md")); }
    catch { return []; }
  })
  .get("/api/memory/content", async ({ query }) => {
    const content = await fs.readFile(path.join(MEMORY_FILES_ROOT, String(query.file)), "utf-8");
    return { content };
  }, { query: t.Object({ file: t.String() }) })
  .post("/api/memory/content", async ({ body }) => {
    await fs.writeFile(path.join(MEMORY_FILES_ROOT, body.file), body.content, "utf-8");
    return { success: true };
  }, { body: t.Object({ file: t.String(), content: t.String() }) })

  .post("/api/actions/restart", async () => {
    spawn("docker", ["compose", "restart", "app"], {
      cwd: path.resolve(import.meta.dir, "../../"),
      detached: true,
      stdio: "ignore"
    }).unref();
    return { success: true };
  })

  .post("/api/actions/shutdown", async () => {
    setTimeout(() => process.exit(0), 1000);
    return { success: true };
  })

  .listen(PORT);

console.log(`🦊 Kairos Dashboard is running at http://localhost:${PORT}`);
