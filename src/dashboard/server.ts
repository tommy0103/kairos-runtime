import { Elysia, t } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { cors } from "@elysiajs/cors";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const AUTH_TOKEN = process.env.DASHBOARD_AUTH_TOKEN || "yukimochi0721";
const PROJECT_ROOT = path.resolve(import.meta.dir, "../../");
const MEMORY_FILES_ROOT = path.join(PROJECT_ROOT, ".runtime/memory_files");
const EVOLUTIONS_ROOT = path.join(PROJECT_ROOT, ".runtime/evolutions");
const ENV_PATH = path.join(PROJECT_ROOT, ".env");
const PORT = Number(process.env.DASHBOARD_PORT || 8080);

const app = new Elysia()
  .use(cors())
  .use(staticPlugin({ assets: "public", prefix: "" }))
  .derive(({ headers }) => ({ isAuthorized: headers['authorization'] === `Bearer ${AUTH_TOKEN}` }))
  .onBeforeHandle(({ isAuthorized, path }) => {
    if (path === "/api/auth/login" || !path.startsWith("/api")) return;
    if (!isAuthorized) return new Response("Unauthorized", { status: 401 });
  })
  
  .get("/", () => Bun.file("public/index.html"))

  .post("/api/auth/login", ({ body }) => {
    if (body.token === AUTH_TOKEN) return { success: true };
    return new Response("Invalid Token", { status: 401 });
  }, { body: t.Object({ token: t.String() }) })

  // --- Logs API (Optimized SSE) ---
  .get("/api/logs", ({ set }) => {
    set.headers['Content-Type'] = 'text/event-stream';
    set.headers['Cache-Control'] = 'no-cache';
    set.headers['Connection'] = 'keep-alive';

    const child = spawn("docker", ["logs", "-f", "--tail", "300", "memoh-lite-app-1"], {
      env: { ...process.env, DOCKER_HOST: "unix:///var/run/docker.sock" }
    });

    return new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (data: string) => {
          controller.enqueue(encoder.encode(`data: ${data.replace(/\n/g, "\\n")}\n\n`));
        };
        child.stdout.on("data", (d) => send(d.toString()));
        child.stderr.on("data", (d) => send(d.toString()));
        child.on("close", () => controller.close());
      },
      cancel() { child.kill(); }
    });
  })

  // --- Status API (Enhanced Detection) ---
  .get("/api/status", async () => {
    const sockets = [
      { name: "VFS", path: "/run/kairos-runtime/sockets/kairos-runtime-vfs.sock" },
      { name: "Enclave", path: "/run/kairos-runtime/sockets/kairos-runtime-enclave.sock" }
    ];
    const services = await Promise.all(sockets.map(async (s) => {
      try { await fs.access(s.path); return { name: s.name, online: true }; }
      catch { return { name: s.name, online: false }; }
    }));

    let adapterStatus = "Offline";
    let botInfo = null;
    try {
      const logs = execSync("docker logs --tail 200 memoh-lite-app-1").toString();
      // 兼容多种登录日志格式
      const loginMatch = logs.match(/UserBot: (?:已作为|Logged in as) (.+?) \((.+?)\) 登录 \(ID: (\d+)\)/i) || 
                         logs.match(/UserBot: (.+?) \(@(.+?)\) 登录 \(ID: (\d+)\)/);
      if (loginMatch) {
        adapterStatus = "Online";
        botInfo = { name: loginMatch[1], username: loginMatch[2], id: loginMatch[3] };
      } else if (logs.includes("UserBot:")) {
        adapterStatus = "Connecting";
      }
    } catch (e) {}

    return { services, adapter: { status: adapterStatus, bot: botInfo }, timestamp: Date.now() };
  })

  // --- File Management Helpers ---
  .group("/api/fs", (app) => app
    .get("/list", async ({ query }) => {
      const root = query.type === 'evolutions' ? EVOLUTIONS_ROOT : MEMORY_FILES_ROOT;
      try { return (await fs.readdir(root)).filter(f => !f.startsWith('.')); } catch { return []; }
    }, { query: t.Object({ type: t.String() }) })
    .get("/read", async ({ query }) => {
      const root = query.type === 'evolutions' ? EVOLUTIONS_ROOT : MEMORY_FILES_ROOT;
      const content = await fs.readFile(path.join(root, String(query.file)), "utf-8");
      return { content };
    }, { query: t.Object({ file: t.String(), type: t.String() }) })
    .post("/write", async ({ body }) => {
      const root = body.type === 'evolutions' ? EVOLUTIONS_ROOT : MEMORY_FILES_ROOT;
      await fs.writeFile(path.join(root, body.file), body.content, "utf-8");
      return { success: true };
    }, { body: t.Object({ file: t.String(), content: t.String(), type: t.String() }) })
  )

  // --- Env & Actions ---
  .get("/api/config/env", async () => ({ content: await fs.readFile(ENV_PATH, "utf-8") }))
  .post("/api/config/env", async ({ body }) => {
    await fs.writeFile(ENV_PATH, body.content, "utf-8");
    return { success: true };
  }, { body: t.Object({ content: t.String() }) })

  .post("/api/actions/core/:action", async ({ params }) => {
    const cmd = params.action === 'restart' ? "restart" : "stop";
    spawn("docker", ["compose", cmd, "app"], { cwd: PROJECT_ROOT, detached: true, stdio: "ignore" }).unref();
    return { success: true };
  })

  .listen(PORT);

console.log(`🦊 Kairos Manager v2 Running at ${PORT}`);
