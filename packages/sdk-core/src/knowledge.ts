// Grounding answers in the app's own knowledge without benatif storing it. Three sources, same API:
//   docs     — a few documents passed inline; ranked locally by keyword overlap (no embeddings)
//   retrieve — the app's existing search / vector DB; we only pass the question and use the result
//   (index)  — on-device embeddings index: planned, see PLAN §17
// The retrieved passages go into the *last user turn*, not the system prompt, so the system prompt
// and earlier turns stay byte-identical and the engine's prefix cache keeps working.

export interface KnowledgeChunk {
  id: string;
  text: string;
  title?: string;
  url?: string;
  score?: number;
}

export type KnowledgeDoc = string | { id?: string; title?: string; url?: string; text: string };

export interface KnowledgeOptions {
  docs?: KnowledgeDoc[];
  /** Your own retrieval (Pinecone, pgvector, Algolia, an internal API…). Return the best passages. */
  retrieve?: (query: string, opts: { topK: number; signal?: AbortSignal }) => Promise<Array<KnowledgeChunk | string>>;
  /** Passages per question (default 4). */
  topK?: number;
  /** Budget for passages in the prompt, in characters (default 6000 ≈ 1500 tokens). */
  maxContextChars?: number;
}

/**
 * off    — knowledge is not used
 * prefer — use the sources when relevant, cite them, otherwise answer normally
 * strict — answer only from the sources; say so when they don't contain the answer
 */
export type Grounding = "off" | "prefer" | "strict";

export interface Source {
  /** 1-based number the model cites as [n]. */
  n: number;
  id: string;
  title?: string;
  url?: string;
  snippet: string;
  /** True when the answer cites this source. */
  cited: boolean;
}

const CHUNK_CHARS = 900;
const STOP = new Set(
  "a al algo como con de del el en es esta este la las lo los mas me mi no o para pero por que se si sin su sus te tu un una y yo the a an and are as at be by for from has have how i in is it of on or that the this to was what when where which who why will with you your".split(" "),
);

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
export const tokenize = (s: string) => norm(s).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w));

/** Split documents into ~900-char chunks on paragraph boundaries. */
export function chunkDocs(docs: KnowledgeDoc[]): KnowledgeChunk[] {
  const out: KnowledgeChunk[] = [];
  docs.forEach((d, di) => {
    const doc = typeof d === "string" ? { text: d } : d;
    const base = doc.id ?? `doc${di + 1}`;
    let buf = "";
    let part = 0;
    const flush = () => {
      if (buf.trim()) out.push({ id: `${base}#${++part}`, text: buf.trim(), title: doc.title, url: doc.url });
      buf = "";
    };
    for (const para of doc.text.split(/\n\s*\n/)) {
      if (buf && buf.length + para.length > CHUNK_CHARS) flush();
      if (para.length > CHUNK_CHARS) {
        for (let i = 0; i < para.length; i += CHUNK_CHARS) { buf = para.slice(i, i + CHUNK_CHARS); flush(); }
      } else buf += (buf ? "\n\n" : "") + para;
    }
    flush();
  });
  return out;
}

/** BM25 over the chunks. Good enough for FAQs and catalogs; bigger corpora should use `retrieve`. */
export function rankChunks(chunks: KnowledgeChunk[], query: string, topK: number): KnowledgeChunk[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !chunks.length) return [];
  const docs = chunks.map((c) => tokenize(`${c.title ?? ""} ${c.text}`));
  const avg = docs.reduce((a, d) => a + d.length, 0) / docs.length;
  const df = new Map(q.map((t) => [t, docs.filter((d) => d.includes(t)).length]));
  const k1 = 1.2, b = 0.75;
  return chunks
    .map((c, i) => {
      const d = docs[i]!;
      let score = 0;
      for (const t of q) {
        const f = d.filter((w) => w === t).length;
        if (!f) continue;
        const idf = Math.log(1 + (chunks.length - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.length) / avg)));
      }
      return { ...c, score };
    })
    .filter((c) => c.score > 0)
    .sort((a, b2) => b2.score! - a.score!)
    .slice(0, topK);
}

export class Knowledge {
  private chunks: KnowledgeChunk[];
  private allChars: number;
  constructor(private opts: KnowledgeOptions) {
    this.chunks = chunkDocs(opts.docs ?? []);
    this.allChars = this.chunks.reduce((a, c) => a + c.text.length, 0);
  }

  async find(query: string, signal?: AbortSignal): Promise<KnowledgeChunk[]> {
    const topK = this.opts.topK ?? 4;
    const max = this.opts.maxContextChars ?? 6000;
    // Few docs: send them all (ranking would only risk dropping the right one).
    const local = this.allChars <= max ? this.chunks : rankChunks(this.chunks, query, topK);
    const remote = this.opts.retrieve
      ? (await this.opts.retrieve(query, { topK, signal })).map((r, i) => (typeof r === "string" ? { id: `r${i + 1}`, text: r } : r))
      : [];
    const seen = new Set<string>();
    const picked: KnowledgeChunk[] = [];
    let used = 0;
    for (const c of [...remote, ...local]) {
      if (seen.has(c.id) || !c.text?.trim()) continue;
      if (used + c.text.length > max && picked.length) break;
      seen.add(c.id);
      picked.push(c);
      used += c.text.length;
    }
    return picked;
  }
}

const RULES: Record<Exclude<Grounding, "off">, string> = {
  strict:
    "Answer using ONLY the sources above. If they do not contain the answer, say that you don't have that information. Do not use outside knowledge. Cite the sources you use like [1]. Answer in the language of the question.",
  prefer:
    "Use the sources above when they are relevant and cite them like [1]. If they don't cover the question, answer normally. Answer in the language of the question.",
};

export function groundedMessage(question: string, chunks: KnowledgeChunk[], grounding: Exclude<Grounding, "off">): string {
  const sources = chunks.length
    ? chunks.map((c, i) => `[${i + 1}]${c.title ? ` ${c.title}:` : ""} ${c.text}`).join("\n\n")
    : "(no sources found for this question)";
  return `Sources:\n${sources}\n\n${RULES[grounding]}\n\nQuestion: ${question}`;
}

export function toSources(chunks: KnowledgeChunk[], answer: string): Source[] {
  const cited = new Set([...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  return chunks.map((c, i) => ({
    n: i + 1,
    id: c.id,
    title: c.title,
    url: c.url,
    snippet: c.text.length > 200 ? `${c.text.slice(0, 200)}…` : c.text,
    cited: cited.has(i + 1),
  }));
}
