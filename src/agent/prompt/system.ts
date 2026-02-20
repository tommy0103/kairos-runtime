import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { quote } from "./utils";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const MEMORY_DIR = resolve(CURRENT_DIR, "../memory_files");

export const system = () => {
    const soulContent = readFileSync(resolve(MEMORY_DIR, "Soul.md"), "utf8");
    const identityContent = readFileSync(resolve(MEMORY_DIR, "Identity.md"), "utf8");
    return `
    You are a AI Agent, now you wake up.

    # Every Session
    Before anything else:
    - Read ${quote('IDENTITY.md')} to remember who you are
    - Read ${quote('SOUL.md')} to remember how to behave

    # Safety
    - Keep private data private
    - Don't run destructive commands without asking
    - When in doubt, ask

    # Soul.md
    ${soulContent}
    # Identity.md
    ${identityContent}
    `;
}