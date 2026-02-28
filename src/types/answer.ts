import type { ChatState } from "./chat";

export type SourceRef = { title: string; section: string; url?: string };

export type Answer = {
  kind: "calc" | "flow" | "rag";
  title: string;
  bottomLine: string;
  steps: string[];
  values?: Record<string, number | string>;
  assumptions?: string[];
  requiredInfo?: string[];
  followUpQuestion?: string;
  cautions?: string[];
  sources?: SourceRef[];
  confidence: "high" | "medium" | "low";
  chatState?: ChatState;
};
