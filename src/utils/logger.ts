import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

class Logger {
    private db: Database;
    private stmtInsert: any;

    constructor(dbPath = "data/memoh.db") {
        const dir = dirname(dbPath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        this.db = new Database(dbPath, { create: true });

        this.db.run(`
      CREATE TABLE IF NOT EXISTS logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp   INTEGER NOT NULL,
        level       TEXT NOT NULL,
        module      TEXT NOT NULL,
        message     TEXT NOT NULL,
        metadata    TEXT
      )
    `);

        this.stmtInsert = this.db.prepare(`
      INSERT INTO logs (timestamp, level, module, message, metadata)
      VALUES (?, ?, ?, ?, ?)
    `);
    }

    log(level: LogLevel, module: string, message: string, metadata?: any) {
        const now = Date.now();
        const ts = new Date(now).toISOString().replace("T", " ").split(".")[0];

        // Console output with simple formatting
        const color = level === "ERROR" ? "\x1b[31m" : level === "WARN" ? "\x1b[33m" : "\x1b[32m";
        const reset = "\x1b[0m";
        console.log(`${ts} ${color}${level.padEnd(5)}${reset} [${module}] ${message}`);
        if (metadata) console.dir(metadata, { depth: null });

        // DB output
        try {
            this.stmtInsert.run(
                now,
                level,
                module,
                message,
                metadata ? JSON.stringify(metadata) : null
            );
        } catch (e) {
            console.error("Failed to write log to DB:", e);
        }
    }

    debug(module: string, message: string, metadata?: any) { this.log("DEBUG", module, message, metadata); }
    info(module: string, message: string, metadata?: any) { this.log("INFO", module, message, metadata); }
    warn(module: string, message: string, metadata?: any) { this.log("WARN", module, message, metadata); }
    error(module: string, message: string, metadata?: any) { this.log("ERROR", module, message, metadata); }

    flush(hours: number) {
        const cutoff = Date.now() - hours * 3600000;
        const result = this.db.run("DELETE FROM logs WHERE timestamp < ?", [cutoff]);
        return result.changes;
    }

    getRecentLogs(limit: number = 20) {
        const rows = this.db.query<any, [number]>(
            "SELECT timestamp, level, module, message FROM logs ORDER BY id DESC LIMIT ?"
        ).all(limit);
        return rows.reverse();
    }
}

// Singleton instance
export const logger = new Logger();
