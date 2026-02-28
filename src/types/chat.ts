export type ChatTopic =
  | "loop_fault"
  | "earthing"
  | "rcd"
  | "cable"
  | "vdrop"
  | "general";

export type ChatStage = "collecting" | "answering" | "done";

export type PendingSlot =
  | "measurement_type"
  | "system"
  | "rcd"
  | "protection"
  | "voltage"
  | "value_ohm";

export type ChatState = {
  topic?: ChatTopic;
  stage?: ChatStage;
  pendingSlot?: PendingSlot;
  slots: {
    measurement_type?: "RA" | "ZS" | "PE";
    value_ohm?: number;
    system?: "TT" | "TN" | "UNKNOWN";
    rcd_ma?: 30 | 100 | 300 | null;
    protection?: string; // e.g. "C16"
    voltage?: 230 | 400;
  };
  pendingQuestion?: string;
  lastSummary?: string;
};

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
};
