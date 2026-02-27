import { Index } from "flexsearch";
import { db, type SourceChunk } from "./db";

type SearchHit = { id: string; score: number };

let index: Index | null = null;
let indexed = false;

async function buildIndex() {
  const idx = new Index({ tokenize: "forward", cache: 100 });
  const all = await db.chunks.toArray();
  for (const c of all) {
    idx.add(c.id, `${c.title}\n${c.section}\n${c.text}\n${c.tags.join(" ")}`);
  }
  index = idx;
  indexed = true;
}

export async function ensureIndex() {
  if (!indexed) await buildIndex();
}

export async function offlineSearch(
  query: string,
  limit = 5
): Promise<SourceChunk[]> {
  await ensureIndex();
  if (!index) return [];
  const ids = (index.search(query, limit) as SearchHit[] | string[]).map((h) =>
    typeof h === "string" ? h : h.id
  );
  const chunks = await db.chunks.bulkGet(ids);
  return chunks.filter(Boolean) as SourceChunk[];
}

