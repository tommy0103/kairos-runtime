export type SendMessageMode = "strict" | "compat";

export interface SystemPromptFile {
  filename: string;
  content: string;
}

export interface RenderSystemPromptInput {
  sendMessageMode: SendMessageMode;
  systemFiles: SystemPromptFile[];
}

export interface RenderLateBindingPromptInput {
  timeNow: string;
  timeZoneLabel?: string;
  isProbeEnabled?: boolean;
  isProbing?: boolean;
  isMentioned?: boolean;
  isReplied?: boolean;
  extraGuideline?: string;
  triggerReason?: string;
}
