import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";

/**
 * 用户长期记忆存储接口
 * 用于管理关于用户的事实（Facts）列表
 */
export interface UserMemoryStore {
  /** 获取指定用户的所有记忆事实 */
  getFacts: (userId: string) => Promise<string[]>;
  /** 保存/覆盖指定用户的全部记忆事实 */
  saveFacts: (userId: string, facts: string[]) => Promise<void>;
  /** 为指定用户新增一条记忆事实（如果已存在则跳过） */
  addFact: (userId: string, fact: string) => Promise<void>;
}

/**
 * 创建基于文件系统的用户记忆存储实例
 * @param baseDir 记忆文件存放的基础目录，默认为 "data/memory"
 */
export function createUserMemoryStore(baseDir = "data/memory"): UserMemoryStore {
  // 获取特定用户的 JSON 文件路径
  const getFilePath = (userId: string) => join(baseDir, `${userId}.json`);

  // 确保存储目录存在
  const ensureDir = async () => {
    if (!existsSync(baseDir)) {
      await mkdir(baseDir, { recursive: true });
    }
  };

  const store: UserMemoryStore = {
    getFacts: async (userId) => {
      const path = getFilePath(userId);
      try {
        if (!existsSync(path)) return [];
        const content = await readFile(path, "utf8");
        return JSON.parse(content) as string[];
      } catch (error) {
        console.error(`[MemoryStore] 读取用户 ${userId} 的记忆失败:`, error);
        return [];
      }
    },

    saveFacts: async (userId, facts) => {
      await ensureDir();
      const path = getFilePath(userId);
      try {
        // 使用 2 空格缩进保存 JSON，方便人工查看和调试
        await writeFile(path, JSON.stringify(facts, null, 2), "utf8");
      } catch (error) {
        console.error(`[MemoryStore] 保存用户 ${userId} 的记忆失败:`, error);
      }
    },

    addFact: async (userId, fact) => {
      const facts = await store.getFacts(userId);
      // 简单的去重逻辑
      if (!facts.includes(fact)) {
        facts.push(fact);
        await store.saveFacts(userId, facts);
      }
    },
  };

  return store;
}
