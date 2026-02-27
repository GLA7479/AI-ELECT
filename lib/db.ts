import Dexie, { Table } from "dexie";

export type SourceChunk = {
  id: string;
  title: string;
  section: string;
  text: string;
  updatedAt: string;
  tags: string[];
};

export type OfflinePack = {
  id: string;
  name: string;
  version: string;
  installedAt: string;
};

export type ChatHistory = {
  id: string;
  q: string;
  a: string;
  createdAt: string;
  mode: "offline" | "online";
};

class AppDB extends Dexie {
  chunks!: Table<SourceChunk, string>;
  packs!: Table<OfflinePack, string>;
  history!: Table<ChatHistory, string>;

  constructor() {
    super("electrician_ai_db");
    this.version(1).stores({
      chunks: "id, title, section, updatedAt, *tags",
      packs: "id, name, version, installedAt",
      history: "id, createdAt, mode",
    });
  }
}

export const db = new AppDB();

