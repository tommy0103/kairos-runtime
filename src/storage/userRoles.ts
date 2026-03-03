import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type UserRole = "owner" | "member" | "blocked";

export interface UserRoleEntry {
    userId: string;
    role: UserRole;
    alias: string | null;
    addedAt: number;
}

export interface UserRolesStore {
    getRole: (userId: string) => UserRole;
    setRole: (userId: string, role: UserRole, alias?: string) => void;
    removeRole: (userId: string) => boolean;
    isBlocked: (userId: string) => boolean;
    listAll: () => UserRoleEntry[];
}

const VALID_ROLES = new Set<string>(["owner", "member", "blocked"]);

export function createUserRolesStore(dbPath = "data/memoh.db"): UserRolesStore {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    const db = new Database(dbPath, { create: true });

    db.run(`
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id   TEXT PRIMARY KEY,
      role      TEXT NOT NULL DEFAULT 'member',
      alias     TEXT,
      added_at  INTEGER NOT NULL
    )
  `);

    const stmtGet = db.query<{ role: string }, [string]>(
        "SELECT role FROM user_roles WHERE user_id = ?"
    );
    const stmtUpsert = db.query<void, [string, string, string | null, number]>(
        "INSERT OR REPLACE INTO user_roles (user_id, role, alias, added_at) VALUES (?, ?, ?, ?)"
    );
    const stmtDelete = db.query<void, [string]>(
        "DELETE FROM user_roles WHERE user_id = ?"
    );
    const stmtAll = db.query<UserRoleEntry, []>(
        "SELECT user_id AS userId, role, alias, added_at AS addedAt FROM user_roles"
    );

    return {
        getRole: (userId) => {
            const row = stmtGet.get(userId);
            if (!row || !VALID_ROLES.has(row.role)) return "member";
            return row.role as UserRole;
        },

        setRole: (userId, role, alias) => {
            stmtUpsert.run(userId, role, alias ?? null, Date.now());
        },

        removeRole: (userId) => {
            stmtDelete.run(userId);
            return db.query<{ c: number }, []>("SELECT changes() AS c").get()?.c !== 0;
        },

        isBlocked: (userId) => {
            const row = stmtGet.get(userId);
            return row?.role === "blocked";
        },

        listAll: () => stmtAll.all(),
    };
}
