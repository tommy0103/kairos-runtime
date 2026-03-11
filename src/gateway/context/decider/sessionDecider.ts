import type { TelegramMessage } from "../../../types/message";
import type { LLMMessage } from "../../../types/message";
import type { LocalModel, CloudModel } from "../../../model/llm";

export interface SessionSummary {
  sessionId: string;
  topicSummary: string;
}

export type SessionDeciderResult =
  | { action: "assign"; sessionId: string }
  | { action: "create" };

const DECIDER_SYSTEM = `You are a session classifier. Given the current user message and a list of existing conversation sessions (each with sessionId and topicSummary), decide either:
1. Assign the message to an existing session: reply with JSON only: {"action":"assign","sessionId":"<sessionId>"}
2. Start a new session: reply with JSON only: {"action":"create"}

Reply with exactly one JSON object, no other text.`;

function buildDeciderPrompt(message: TelegramMessage, sessions: SessionSummary[]): string {
  const user = message.metadata.username ?? "user";
  const sessionList = sessions
    .map((s) => `- sessionId: "${s.sessionId}", topic: "${s.topicSummary}"`)
    .join("\n");
  return `${DECIDER_SYSTEM}

Existing sessions:
${sessionList}

Current message (speaker: ${user}): ${message.context}

Your JSON reply:`;
}

function buildDeciderMessages(message: TelegramMessage, sessions: SessionSummary[]): LLMMessage[] {
  return [{ role: "user", content: buildDeciderPrompt(message, sessions) }];
}

function parseDeciderOutput(
  text: string,
  validSessionIds: Set<string>
): SessionDeciderResult {
  const trimmed = text.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}") + 1;
  if (jsonStart < 0 || jsonEnd <= jsonStart) {
    return { action: "create" };
  }
  let data: unknown;
  try {
    data = JSON.parse(trimmed.slice(jsonStart, jsonEnd));
  } catch {
    return { action: "create" };
  }
  if (data && typeof data === "object" && "action" in data) {
    const d = data as { action: string; sessionId?: string };
    if (d.action === "assign" && typeof d.sessionId === "string" && validSessionIds.has(d.sessionId)) {
      return { action: "assign", sessionId: d.sessionId };
    }
  }
  return { action: "create" };
}

const DEFAULT_RERANKER_API_URL = "http://127.0.0.1:8008/rerank";
const DEFAULT_RERANKER_TIMEOUT_MS = 2500;
const DEFAULT_RERANKER_ASSIGN_THRESHOLD = 0.30;

interface RerankerResponse {
  scores?: number[];
}

function parseEnvNumber(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function buildRerankerPairs(message: TelegramMessage, sessions: SessionSummary[]): string[][] {
  const query = message.context.trim();
  return sessions.map((session) => [query, session.topicSummary.trim()]);
}

function pickBestScore(scores: number[]): { index: number; score: number } | null {
  let winnerIndex = -1;
  let winnerScore = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < scores.length; index += 1) {
    const score = scores[index];
    if (!Number.isFinite(score)) {
      continue;
    }
    if (score > winnerScore) {
      winnerScore = score;
      winnerIndex = index;
    }
  }
  if (winnerIndex < 0) {
    return null;
  }
  return { index: winnerIndex, score: winnerScore };
}

export async function decideSessionByReranker(input: {
  message: TelegramMessage;
  sessions: SessionSummary[];
}): Promise<SessionDeciderResult> {
  const { message, sessions } = input;
  if (sessions.length === 0) {
    return { action: "create" };
  }

  const endpoint = process.env.RERANKER_API_URL ?? DEFAULT_RERANKER_API_URL;
  const timeoutMs = parseEnvNumber(
    process.env.RERANKER_TIMEOUT_MS,
    DEFAULT_RERANKER_TIMEOUT_MS
  );
  const threshold = parseEnvNumber(
    process.env.RERANKER_ASSIGN_THRESHOLD,
    DEFAULT_RERANKER_ASSIGN_THRESHOLD
  );

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        pairs: buildRerankerPairs(message, sessions),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      return { action: "create" };
    }

    const body = (await response.json()) as RerankerResponse;
    const scores = body.scores;
    if (!Array.isArray(scores) || scores.length !== sessions.length) {
      return { action: "create" };
    }

    console.log("scores", scores);
    const winner = pickBestScore(scores);
    if (!winner || winner.score < threshold) {
      return { action: "create" };
    }

    return { action: "assign", sessionId: sessions[winner.index].sessionId };
  } catch {
    return { action: "create" };
  }
}

export async function decideSessionByLlm(input: {
  message: TelegramMessage;
  sessions: SessionSummary[];
  cloudModel?: CloudModel;
  localModel?: LocalModel;
}): Promise<SessionDeciderResult> {
  const { message, sessions, localModel, cloudModel } = input;
  if (sessions.length === 0) {
    return { action: "create" };
  }
  const model = cloudModel ?? localModel;
  if (!model) {
    return { action: "create" };
  }
  const validSessionIds = new Set(sessions.map((s) => s.sessionId));
  const { text } = cloudModel
    ? await cloudModel.complete({ messages: buildDeciderMessages(message, sessions) })
    : await localModel!.complete({ prompt: buildDeciderPrompt(message, sessions) });
  return parseDeciderOutput(text, validSessionIds);
}
