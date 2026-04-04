import { Elysia, t } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { cors } from "@elysiajs/cors";
import { spawn, execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const AUTH_TOKEN = process.env.DASHBOARD_AUTH_TOKEN || "yukimochi0721";
const PROJECT_ROOT = path.resolve(import.meta.dir, "../../");
const MEMORY_FILES_ROOT = path.join(PROJECT_ROOT, ".runtime/memory_files");
const ENV_PATH = path.join(PROJECT_ROOT, ".env");
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

  // --- Logs API ---
  .get("/api/logs", ({ set }) => {
    set.headers['Content-Type'] = 'text/event-stream';
    set.headers['Cache-Control'] = 'no-cache';
    set.headers['Connection'] = 'keep-alive';

    // 直接通过 docker logs 获取
    const child = spawn("docker", ["logs", "-f", "--tail", "200", "memoh-lite-app-1"], {
      env: { ...process.env, DOCKER_HOST: "unix:///var/run/docker.sock" }
    });

    return new ReadableStream({
      start(controller) {
        child.stdout.on("data", (d) => controller.enqueue(`data: ${d.toString()}\n\n`));
        child.stderr.on("data", (d) => controller.enqueue(`data: ${d.toString()}\n\n`));
        child.on("close", () => controller.close());
      },
      cancel() { child.kill(); }
    });
  })

  // --- Status API (含 Adapter 状态) ---
  .get("/api/status", async () => {
    const sockets = [
      { name: "VFS", path: "/run/kairos-runtime/sockets/kairos-runtime-vfs.sock" },
      { name: "Enclave", path: "/run/kairos-runtime/sockets/kairos-runtime-enclave.sock" }
    ];
    
    const services = await Promise.all(sockets.map(async (s) => {
      try { await fs.access(s.path); return { name: s.name, online: true }; }
      catch { return { name: s.name, online: false }; }
    }));

    let adapterStatus = "Disconnected";
    let botInfo = null;
    try {
      // 从 app 容器日志中抓取最近的登录信息
      const lastLogs = execSync("docker logs --tail 100 memoh-lite-app-1").toString();
      const match = lastLogs.match(/UserBot: 已作为 (.+?) \((.+?)\) 登录 \(ID: (\d+)\)/);
      if (match) {
        adapterStatus = "Connected";
        botInfo = { name: match[1], username: match[2], id: match[3] };
      }
    } catch (e) {}

    return { services, adapter: { status: adapterStatus, bot: botInfo }, timestamp: Date.now() };
  })

  // --- Env Configuration API ---
  .get("/api/config/env", async () => {
    try { return { content: await fs.readFile(ENV_PATH, "utf-8") }; }
    catch { return { content: "" }; }
  })
  .post("/api/config/env", async ({ body }) => {
    await fs.writeFile(ENV_PATH, body.content, "utf-8");
    return { success: true };
  }, { body: t.Object({ content: t.String() }) })

  // --- Memory Files API ---
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

  // --- System Actions ---
  .post("/api/actions/core/restart", () => {
    spawn("docker", ["compose", "restart", "app"], { cwd: PROJECT_ROOT, detached: true, stdio: "ignore" }).unref();
    return { success: true };
  })
  .post("/api/actions/core/shutdown", () => {
    spawn("docker", ["compose", "stop", "app"], { cwd: PROJECT_ROOT, detached: true, stdio: "ignore" }).unref();
    return { success: true };
  })

  .listen(PORT);

console.log(`🦊 Kairos Manager running at ${PORT}`);
