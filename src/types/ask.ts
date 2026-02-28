export type AskSource = {
  title: string;
  section: string;
  url?: string;
};

export type AskResponse = {
  bottomLine: string;
  steps: string[];
  cautions: string[];
  requiredInfo?: string[];
  followUpQuestion?: string;
  sources: AskSource[];
  confidence: "high" | "medium" | "low";
};
