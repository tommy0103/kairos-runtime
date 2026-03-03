import { Database } from "bun:sqlite";
import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export type UserRole = "owner" | "admin" | "member" | "blocked";

export interface UserRoleEntry {
    userId: string;
    username: string | null;
    role: UserRole;
    addedAt: number;
}

export interface UserRolesStore {
    getRole: (userId: string) => UserRole;
    setRole: (userId: string, role: UserRole, username?: string) => void;
    removeRole: (userId: string) => boolean;
    isBlocked: (userId: string) => boolean;
    listAll: () => UserRoleEntry[];
    /** Track a username→userId mapping from incoming messages */
    trackUser: (userId: string, username: string) => void;
    /** Resolve a username to userId, returns null if unknown */
    resolveUserId: (username: string) => string | null;
}

const VALID_ROLES = new Set<string>(["owner", "admin", "member", "blocked"]);

export function createUserRolesStore(dbPath = "data/memoh.db"): UserRolesStore {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }

    const db = new Database(dbPath, { create: true });

    // Migration: rename 'alias' to 'username' if 'alias' exists
    const tableInfo = db.query<any, [string]>("PRAGMA table_info(user_roles)").all("user_roles");
    const hasAlias = tableInfo.some(c => c.name === "alias");
    const hasUsername = tableInfo.some(c => c.name === "username");

    if (hasAlias && !hasUsername) {
        db.run("ALTER TABLE user_roles RENAME COLUMN alias TO username");
    }

    db.run(`
    CREATE TABLE IF NOT EXISTS user_roles (
      user_id   TEXT PRIMARY KEY,
      role      TEXT NOT NULL DEFAULT 'member',
      username  TEXT,
      added_at  INTEGER NOT NULL
    )
  `);

    db.run(`
    CREATE TABLE IF NOT EXISTS known_users (
      user_id   TEXT PRIMARY KEY,
      username  TEXT NOT NULL
    )
  `);
    db.run(`
    CREATE INDEX IF NOT EXISTS idx_known_users_username
    ON known_users (username COLLATE NOCASE)
  `);

    const stmtGet = db.query<{ role: string }, [string]>(
        "SELECT role FROM user_roles WHERE user_id = ?"
    );
    const stmtUpsert = db.query<void, [string, string, string | null, number]>(
        "INSERT OR REPLACE INTO user_roles (user_id, role, username, added_at) VALUES (?, ?, ?, ?)"
    );
    const stmtDelete = db.query<void, [string]>(
        "DELETE FROM user_roles WHERE user_id = ?"
    );
    const stmtAll = db.query<UserRoleEntry, []>(
        "SELECT user_id AS userId, role, username, added_at AS addedAt FROM user_roles"
    );
    const stmtTrack = db.query<void, [string, string]>(
        "INSERT OR REPLACE INTO known_users (user_id, username) VALUES (?, ?)"
    );
    const stmtResolve = db.query<{ user_id: string }, [string]>(
        "SELECT user_id FROM known_users WHERE username = ? COLLATE NOCASE"
    );

    return {
        getRole: (userId) => {
            const row = stmtGet.get(userId);
            if (!row || !VALID_ROLES.has(row.role)) return "member";
            return row.role as UserRole;
        },

        setRole: (userId, role, username) => {
            stmtUpsert.run(userId, role, username ?? null, Date.now());
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

        trackUser: (userId, username) => {
            stmtTrack.run(userId, username);
        },

        resolveUserId: (username) => {
            const row = stmtResolve.get(username);
            return row?.user_id ?? null;
        },
    };
}
