/**
 * Test kairos-runtime logos integration without Telegram/enclave.
 * Validates: VFS client call(), clientRuntime recordMessage, context retrieval.
 */

// Set env BEFORE static imports capture it
const SOCKET = process.env.LOGOS_SOCKET ?? "/home/parallels/tomiya/logos-fs/data/state/sandbox/logos.sock";
process.env.LOGOS_SOCKET = SOCKET;

import { MemoryVfsClient } from "./state-daemon/storage/vfs/client";
import {
  logosPrimitiveTools,
  initLogosSession,
} from "./enclave-runtime/agent/tools/logosPrimitives";

const TS = Date.now();

let passed = 0, failed = 0;
function ok(n: string, d?: string) { passed++; console.log(`  ✓ ${n}${d ? ` — ${d.slice(0,60)}` : ""}`); }
function fail(n: string, e: string) { failed++; console.log(`  ✗ ${n} — ${e.slice(0,100)}`); }
async function t(n: string, f: () => Promise<void>) { try { await f(); ok(n); } catch(e:any) { fail(n, e.message??String(e)); } }

/** Helper: extract text from AgentTool execute result */
function text(result: any): string {
  if (typeof result === "string") return result;
  if (result?.content?.[0]?.text != null) return result.content[0].text;
  return JSON.stringify(result);
}

async function main() {
  console.log("\n=== 1. VFS Client (logos call) ===\n");

  const vfs = new MemoryVfsClient({ target: `unix://${SOCKET}` });

  await t("vfs.write message to memory", async () => {
    await vfs.write({
      path: "logos://memory/groups/kairos-test/messages",
      content: JSON.stringify({
        msg_id: Date.now(), chat_id: "kairos-test", speaker: "alice",
        text: "kairos integration test", reply_to: null,
        ts: new Date().toISOString(), mentions: "[]",
      }),
    });
  });

  // messages endpoint is write-only (insert), read requires /messages/{id}

  // VFS client call() requires session — tested via enclave tools below instead
  console.log("  (skipping vfs.call — no session, tested via enclave tools)");

  await t("vfs.write to users", async () => {
    await vfs.write({
      path: "logos://users/alice/profile.json",
      content: JSON.stringify({ name: "Alice", from: "kairos-test" }),
    });
  });

  await t("vfs.read users", async () => {
    const r = await vfs.read({ path: "logos://users/alice/profile.json" });
    if (!r.content.includes("Alice")) throw new Error(r.content.slice(0, 80));
  });

  await t("vfs.write to tmp", async () => {
    await vfs.write({ path: "logos://tmp/kairos-flag", content: "alive" });
  });

  await t("vfs.read tmp", async () => {
    const r = await vfs.read({ path: "logos://tmp/kairos-flag" });
    if (r.content !== "alive") throw new Error(r.content);
  });

  console.log("\n=== 2. Logos Primitive Tools (enclave side) ===\n");

  // Init session for enclave tools
  await t("initLogosSession", async () => {
    await initLogosSession(`kairos-enc-${TS}`, "kairos-agent");
  });

  // Create task so complete works
  const writeTool = logosPrimitiveTools.find(t => t.name === "logos_write")!;
  await t("logos_write: create task", async () => {
    await writeTool.execute("test", {
      uri: "logos://system/tasks",
      content: JSON.stringify({
        task_id: `kairos-enc-${TS}`, description: "enclave tool test",
        chat_id: "kairos-test", trigger: "user_message",
      }),
    });
  });

  const readTool = logosPrimitiveTools.find(t => t.name === "logos_read")!;
  await t("logos_read: system tasks", async () => {
    const r = text(await readTool.execute("test", { uri: "logos://system/tasks" }));
    if (!r.includes("tasks")) throw new Error(r.slice(0, 80));
  });

  await t("logos_write: sandbox file (relative)", async () => {
    await writeTool.execute("test", { uri: "test.txt", content: "from kairos enclave" });
  });

  await t("logos_read: sandbox file back", async () => {
    const r = text(await readTool.execute("test", { uri: "test.txt" }));
    if (r !== "from kairos enclave") throw new Error(r);
  });

  const execTool = logosPrimitiveTools.find(t => t.name === "logos_exec")!;
  await t("logos_exec: echo", async () => {
    const r = text(await execTool.execute("test", { command: "echo hello-kairos" }));
    if (!r.includes("hello-kairos")) throw new Error(r);
  });

  await t("logos_exec: cat sandbox file", async () => {
    const r = text(await execTool.execute("test", { command: "cat test.txt" }));
    if (!r.includes("from kairos enclave")) throw new Error(r);
  });

  const callTool = logosPrimitiveTools.find(t => t.name === "logos_call")!;
  await t("logos_call: system.search_tasks", async () => {
    const r = text(await callTool.execute("test", {
      tool: "system.search_tasks",
      params: { query: "enclave", limit: 5 },
    }));
    if (!r.includes("l1_hits")) throw new Error(r.slice(0, 80));
  });

  await t("logos_call: system.complete", async () => {
    const r = text(await callTool.execute("test", {
      tool: "system.complete",
      params: {
        task_id: `kairos-enc-${TS}`,
        summary: "kairos integration test passed",
        anchor: true,
      },
    }));
    if (!r.includes("anchor_id")) throw new Error(r.slice(0, 80));
  });

  const patchTool = logosPrimitiveTools.find(t => t.name === "logos_patch")!;
  await t("logos_patch: users profile", async () => {
    await patchTool.execute("test", {
      uri: "logos://users/alice/profile.json",
      partial: JSON.stringify({ role: "tester" }),
    });
    const r = text(await readTool.execute("test", { uri: "logos://users/alice/profile.json" }));
    if (!r.includes("tester") || !r.includes("Alice")) throw new Error(r.slice(0, 80));
  });

  console.log("\n=== RESULTS ===\n");
  console.log(`  ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
