/**
 * The library's rules, tested against an in-memory store.
 *
 * IndexedDB does not exist in the node test environment, and faking it whole
 * would be testing a fake browser rather than this code. `db.ts` therefore
 * takes a `LibraryStore`, and everything that can actually be wrong — merging
 * rather than clobbering, deriving counts, ordering, cascade delete, idempotent
 * append — is exercised through the seam.
 *
 * The fake reads its key paths from `db.ts`'s own maps, so a store whose shape
 * changed without its queries changing fails here rather than in Chrome.
 */

import { describe, expect, it } from "vitest";
import {
  INDEX_KEY_PATHS,
  KEY_PATHS,
  MIGRATIONS,
  appendMessage,
  deleteNote,
  deleteSession,
  dispatch,
  getSession,
  handleLibraryRequest,
  listSessions,
  putNote,
  putTranscript,
  setSummary,
  upsertSession,
  type IndexName,
  type LibraryStore,
  type ScanOptions,
  type SessionUpsert,
  type StoreName,
} from "./db";
import { SCHEMA_VERSION, type SessionRecord } from "../shared/libraryProtocol";

type Row = Record<string, unknown>;

interface MemoryStore extends LibraryStore {
  /** Every store touched by a read, so a test can prove what was *not* read. */
  reads: StoreName[];
  rows(store: StoreName): Row[];
  seed(store: StoreName, ...records: Row[]): void;
}

/** IndexedDB's own ordering, for the two key types this schema uses. */
function compare(paths: readonly string[], a: Row, b: Row): number {
  for (const path of paths) {
    const left = a[path];
    const right = b[path];
    if (typeof left === "number" && typeof right === "number") {
      if (left !== right) return left - right;
      continue;
    }
    const l = String(left);
    const r = String(right);
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

/**
 * @param reverseIndexResults hand index queries back in the wrong order, so a
 * test can tell the difference between the library sorting and the store
 * happening to be sorted already.
 */
function memoryStore(reverseIndexResults = false): MemoryStore {
  // Derived from KEY_PATHS rather than listed, so adding a store to the schema
  // cannot leave the fake silently missing it. It did exactly that once: writes
  // to `activity` threw, `dispatch` swallowed the error into `{ ok: false }`,
  // and the tests that only asserted on sessions carried on passing.
  const data = new Map<StoreName, Map<string, Row>>(
    (Object.keys(KEY_PATHS) as StoreName[]).map((name) => [name, new Map()]),
  );
  const reads: StoreName[] = [];

  const table = (name: StoreName): Map<string, Row> => {
    const found = data.get(name);
    if (!found) throw new Error(`no store ${name}`);
    return found;
  };

  const keyOf = (name: StoreName, row: Row): string => {
    const key = row[KEY_PATHS[name]];
    if (typeof key !== "string") {
      throw new Error(`record for ${name} has no ${KEY_PATHS[name]}`);
    }
    return key;
  };

  const sorted = (name: StoreName, index: IndexName): Row[] => {
    const paths = INDEX_KEY_PATHS[index];
    return [...table(name).values()].sort((a, b) => compare(paths, a, b));
  };

  const matching = (name: StoreName, index: IndexName, key: string): Row[] => {
    const [first] = INDEX_KEY_PATHS[index];
    return sorted(name, index).filter((row) => row[first] === key);
  };

  return {
    reads,
    rows: (name) => [...table(name).values()],
    seed(name, ...records) {
      for (const record of records)
        table(name).set(keyOf(name, record), record);
    },

    async get<T>(name: StoreName, key: string) {
      reads.push(name);
      const row = table(name).get(key);
      return row === undefined ? undefined : (structuredClone(row) as T);
    },

    async put(name, value) {
      const row = structuredClone(value) as Row;
      table(name).set(keyOf(name, row), row);
    },

    async delete(name, key) {
      table(name).delete(key);
    },

    async byIndex<T>(name: StoreName, index: IndexName, key: string) {
      reads.push(name);
      const found = matching(name, index, key);
      return structuredClone(
        reverseIndexResults ? found.reverse() : found,
      ) as T[];
    },

    async countByIndex(name, index, key) {
      reads.push(name);
      return matching(name, index, key).length;
    },

    async scanIndex<T>(
      name: StoreName,
      index: IndexName,
      options: ScanOptions = {},
    ) {
      reads.push(name);
      const all = sorted(name, index);
      if (options.descending) all.reverse();
      const limited =
        options.limit === undefined ? all : all.slice(0, options.limit);
      return structuredClone(limited) as T[];
    },
  };
}

function session(overrides: Partial<SessionUpsert> = {}): SessionUpsert {
  return {
    videoId: "vid1",
    title: "Claude Code New Features, Explained",
    channel: "Greg Isenberg",
    durationMs: 1_425_000,
    thumbnailUrl: "",
    updatedAt: 1_000,
    chapters: [],
    chapterSource: "none",
    ...overrides,
  };
}

const stored = async (store: MemoryStore, videoId = "vid1") =>
  (await store.get<SessionRecord>("sessions", videoId)) as SessionRecord;

describe("schema", () => {
  it("has one migration per version", () => {
    // A bumped SCHEMA_VERSION with no matching step opens a database that
    // silently lacks the store the new code expects.
    expect(MIGRATIONS).toHaveLength(SCHEMA_VERSION);
  });

  it("stamps every record with the schema version", async () => {
    const store = memoryStore();
    await upsertSession(store, session());
    await putTranscript(store, {
      videoId: "vid1",
      language: "en",
      plainText: "hello",
      updatedAt: 5,
    });
    await putNote(store, "vid1", {
      id: "n1",
      atMs: 1,
      text: "note",
      createdAt: 1,
    });
    await appendMessage(store, "vid1", {
      id: "m1",
      role: "user",
      text: "hi",
      createdAt: 1,
    });

    for (const name of [
      "sessions",
      "transcripts",
      "notes",
      "messages",
    ] as StoreName[]) {
      for (const row of store.rows(name)) {
        expect(row.schemaVersion).toBe(SCHEMA_VERSION);
      }
    }
  });
});

describe("upsertSession", () => {
  it("derives the thumbnail when the caller gives none", async () => {
    const store = memoryStore();
    await upsertSession(store, session());
    expect((await stored(store)).thumbnailUrl).toContain("vid1");
  });

  it("keeps the original createdAt when the video is reopened", async () => {
    const store = memoryStore();
    await upsertSession(store, session({ createdAt: 100, updatedAt: 100 }));
    // Read Mode stamps `Date.now()` every time it opens a video; honouring it
    // would make a revisit look like a brand new session.
    await upsertSession(store, session({ createdAt: 900, updatedAt: 900 }));

    const row = await stored(store);
    expect(row.createdAt).toBe(100);
    expect(row.updatedAt).toBe(900);
  });

  it("preserves a summary the upsert does not carry", async () => {
    const store = memoryStore();
    await upsertSession(store, session());
    await setSummary(store, "vid1", "# Summary\n\nSomething learned.");

    await upsertSession(store, session({ updatedAt: 2_000 }));

    expect((await stored(store)).summaryMarkdown).toBe(
      "# Summary\n\nSomething learned.",
    );
  });

  it("takes a summary the upsert does carry", async () => {
    const store = memoryStore();
    await upsertSession(store, session());
    await setSummary(store, "vid1", "old");
    await upsertSession(store, session({ summaryMarkdown: "new" }));
    expect((await stored(store)).summaryMarkdown).toBe("new");
  });

  it("preserves title, channel and chapters against a bare upsert", async () => {
    const store = memoryStore();
    await upsertSession(
      store,
      session({
        chapters: [{ title: "Intro", startMs: 0 }],
        chapterSource: "description",
      }),
    );

    // A second entry before YouTube has painted the header, and before the
    // chapter tiers have run.
    await upsertSession(
      store,
      session({ title: "", channel: "", durationMs: 0, chapters: [] }),
    );

    const row = await stored(store);
    expect(row.title).toBe("Claude Code New Features, Explained");
    expect(row.channel).toBe("Greg Isenberg");
    expect(row.durationMs).toBe(1_425_000);
    expect(row.chapters).toHaveLength(1);
    expect(row.chapterSource).toBe("description");
  });

  it("recomputes the counts instead of trusting the caller", async () => {
    const store = memoryStore();
    await upsertSession(store, session());
    await putNote(store, "vid1", {
      id: "n1",
      atMs: 10,
      text: "a",
      createdAt: 1,
    });
    await appendMessage(store, "vid1", {
      id: "m1",
      role: "user",
      text: "q",
      createdAt: 1,
    });
    await appendMessage(store, "vid1", {
      id: "m2",
      role: "assistant",
      text: "a",
      createdAt: 2,
    });

    await upsertSession(store, session({ noteCount: 99, messageCount: 0 }));

    const row = await stored(store);
    expect(row.noteCount).toBe(1);
    expect(row.messageCount).toBe(2);
  });

  it("counts only its own video's rows", async () => {
    const store = memoryStore();
    await upsertSession(store, session());
    await upsertSession(store, session({ videoId: "vid2" }));
    await putNote(store, "vid2", {
      id: "n2",
      atMs: 1,
      text: "b",
      createdAt: 1,
    });

    expect((await stored(store, "vid1")).noteCount).toBe(0);
    expect((await stored(store, "vid2")).noteCount).toBe(1);
  });
});

describe("listSessions", () => {
  it("returns rows newest first and honours the limit", async () => {
    const store = memoryStore();
    await upsertSession(store, session({ videoId: "old", updatedAt: 100 }));
    await upsertSession(store, session({ videoId: "new", updatedAt: 300 }));
    await upsertSession(store, session({ videoId: "mid", updatedAt: 200 }));

    expect((await listSessions(store)).map((s) => s.videoId)).toEqual([
      "new",
      "mid",
      "old",
    ]);
    expect((await listSessions(store, 2)).map((s) => s.videoId)).toEqual([
      "new",
      "mid",
    ]);
  });

  it("never reads the transcripts store", async () => {
    const store = memoryStore();
    await upsertSession(store, session());
    await putTranscript(store, {
      videoId: "vid1",
      language: "en",
      plainText: "x".repeat(10_000),
      updatedAt: 1,
    });

    store.reads.length = 0;
    await listSessions(store);

    // Dragging half a megabyte of transcript across the message channel to draw
    // a grid of cards is exactly what the separate store exists to prevent.
    expect(store.reads).not.toContain("transcripts");
  });

  it("drops the chapters and summary from a list row", async () => {
    const store = memoryStore();
    await upsertSession(
      store,
      session({ chapters: [{ title: "Intro", startMs: 0 }] }),
    );
    await setSummary(store, "vid1", "# Summary");

    const [row] = await listSessions(store);
    expect(row).not.toHaveProperty("chapters");
    expect(row).not.toHaveProperty("summaryMarkdown");
  });
});

describe("getSession", () => {
  it("sorts notes by time and messages by creation", async () => {
    // The store hands index results back reversed, so passing this means the
    // library sorted rather than inherited an order.
    const store = memoryStore(true);
    await upsertSession(store, session());
    for (const atMs of [30_000, 10_000, 20_000]) {
      await putNote(store, "vid1", {
        id: `n${atMs}`,
        atMs,
        text: `at ${atMs}`,
        createdAt: atMs,
      });
    }
    for (const createdAt of [3, 1, 2]) {
      await appendMessage(store, "vid1", {
        id: `m${createdAt}`,
        role: createdAt % 2 === 0 ? "assistant" : "user",
        text: `#${createdAt}`,
        createdAt,
      });
    }

    const full = await getSession(store, "vid1");
    expect(full.notes.map((n) => n.atMs)).toEqual([10_000, 20_000, 30_000]);
    expect(full.messages.map((m) => m.createdAt)).toEqual([1, 2, 3]);
  });

  it("orders messages deterministically when timestamps collide", async () => {
    const store = memoryStore(true);
    await appendMessage(store, "vid1", {
      id: "b",
      role: "assistant",
      text: "second",
      createdAt: 7,
    });
    await appendMessage(store, "vid1", {
      id: "a",
      role: "user",
      text: "first",
      createdAt: 7,
    });

    const full = await getSession(store, "vid1");
    expect(full.messages.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("returns the transcript and strips the storage fields", async () => {
    const store = memoryStore();
    await putTranscript(store, {
      videoId: "vid1",
      language: "en",
      plainText: "hello",
      updatedAt: 42,
    });

    const full = await getSession(store, "vid1");
    expect(full.transcript).toEqual({
      videoId: "vid1",
      language: "en",
      plainText: "hello",
      updatedAt: 42,
    });
  });

  it("answers for a video that was never saved", async () => {
    const full = await getSession(memoryStore(), "unknown");
    expect(full).toEqual({
      session: null,
      notes: [],
      messages: [],
      transcript: null,
    });
  });
});

describe("deleteSession", () => {
  it("removes the transcript, notes and messages too", async () => {
    const store = memoryStore();
    await upsertSession(store, session());
    await putTranscript(store, {
      videoId: "vid1",
      language: "en",
      plainText: "hello",
      updatedAt: 1,
    });
    await putNote(store, "vid1", {
      id: "n1",
      atMs: 1,
      text: "a",
      createdAt: 1,
    });
    await appendMessage(store, "vid1", {
      id: "m1",
      role: "user",
      text: "q",
      createdAt: 1,
    });

    await deleteSession(store, "vid1");

    // Rows keyed by their own id are not removed by anything implicitly; an
    // orphan still answers every index query it used to.
    expect(store.rows("sessions")).toHaveLength(0);
    expect(store.rows("transcripts")).toHaveLength(0);
    expect(store.rows("notes")).toHaveLength(0);
    expect(store.rows("messages")).toHaveLength(0);
  });

  it("leaves another video alone", async () => {
    const store = memoryStore();
    await upsertSession(store, session());
    await upsertSession(store, session({ videoId: "vid2" }));
    await putNote(store, "vid1", {
      id: "n1",
      atMs: 1,
      text: "a",
      createdAt: 1,
    });
    await putNote(store, "vid2", {
      id: "n2",
      atMs: 1,
      text: "b",
      createdAt: 1,
    });
    await appendMessage(store, "vid2", {
      id: "m2",
      role: "user",
      text: "q",
      createdAt: 1,
    });

    await deleteSession(store, "vid1");

    expect(store.rows("sessions").map((r) => r.videoId)).toEqual(["vid2"]);
    expect(store.rows("notes").map((r) => r.id)).toEqual(["n2"]);
    expect(store.rows("messages").map((r) => r.id)).toEqual(["m2"]);
  });
});

describe("appendMessage", () => {
  it("writes one row when the same message arrives twice", async () => {
    const store = memoryStore();
    await upsertSession(store, session());

    await appendMessage(store, "vid1", {
      id: "m1",
      role: "assistant",
      text: "the answer",
      createdAt: 500,
    });
    // The worker was torn down before the reply landed, so the content script
    // retried with a fresh timestamp.
    await appendMessage(store, "vid1", {
      id: "m1",
      role: "assistant",
      text: "the answer",
      createdAt: 900,
    });

    expect(store.rows("messages")).toHaveLength(1);
    expect((await stored(store)).messageCount).toBe(1);
    // Taking the retry's timestamp would jump the reply to the end of the
    // conversation it is part of.
    expect(store.rows("messages")[0].createdAt).toBe(500);
  });

  it("does not persist the streaming flag", async () => {
    const store = memoryStore();
    await appendMessage(store, "vid1", {
      id: "m1",
      role: "assistant",
      text: "half",
      createdAt: 1,
      streaming: true,
    });
    // Persisted, it would render as a reply that never finishes arriving.
    expect(store.rows("messages")[0]).not.toHaveProperty("streaming");
  });

  it("refuses an id that belongs to another video", async () => {
    const store = memoryStore();
    await appendMessage(store, "vid1", {
      id: "m1",
      role: "user",
      text: "q",
      createdAt: 1,
    });

    const response = await dispatch(store, {
      type: "library.appendMessage",
      videoId: "vid2",
      message: { id: "m1", role: "user", text: "q", createdAt: 1 },
    });

    expect(response.ok).toBe(false);
    expect(store.rows("messages")).toHaveLength(1);
    expect(store.rows("messages")[0].videoId).toBe("vid1");
  });
});

describe("notes", () => {
  it("keeps a note taken before the session row landed", async () => {
    const store = memoryStore();
    await putNote(store, "vid1", {
      id: "n1",
      atMs: 1,
      text: "typed early",
      createdAt: 1,
    });

    expect(store.rows("notes")).toHaveLength(1);
    // …and the next upsert picks it up in its recount.
    await upsertSession(store, session());
    expect((await stored(store)).noteCount).toBe(1);
  });

  it("refreshes the count when a note is deleted", async () => {
    const store = memoryStore();
    await upsertSession(store, session());
    await putNote(store, "vid1", {
      id: "n1",
      atMs: 1,
      text: "a",
      createdAt: 1,
    });
    await putNote(store, "vid1", {
      id: "n2",
      atMs: 2,
      text: "b",
      createdAt: 2,
    });
    expect((await stored(store)).noteCount).toBe(2);

    await deleteNote(store, "vid1", "n1");
    expect((await stored(store)).noteCount).toBe(1);
  });

  it("refuses to delete another video's note", async () => {
    const store = memoryStore();
    await putNote(store, "vid1", {
      id: "n1",
      atMs: 1,
      text: "a",
      createdAt: 1,
    });

    const response = await dispatch(store, {
      type: "library.deleteNote",
      videoId: "vid2",
      noteId: "n1",
    });

    expect(response.ok).toBe(false);
    expect(store.rows("notes")).toHaveLength(1);
  });
});

describe("dispatch", () => {
  it("reports a failure instead of throwing", async () => {
    const response = await dispatch(memoryStore(), {
      type: "library.setSummary",
      videoId: "never-saved",
      summaryMarkdown: "# hi",
    });

    expect(response).toEqual({
      ok: false,
      error: "no saved session for never-saved",
    });
  });

  it("round-trips a session through the message shapes", async () => {
    const store = memoryStore();
    const saved = await dispatch(store, {
      type: "library.upsertSession",
      session: {
        videoId: "vid1",
        title: "Title",
        channel: "Channel",
        durationMs: 1,
        thumbnailUrl: "",
        createdAt: 1,
        updatedAt: 1,
        noteCount: 0,
        messageCount: 0,
        chapters: [],
        chapterSource: "none",
        summaryMarkdown: null,
      },
    });
    expect(saved).toEqual({ ok: true, type: "void" });

    const list = await dispatch(store, { type: "library.list" });
    expect(list.ok && list.type === "list" && list.sessions).toHaveLength(1);

    const one = await dispatch(store, {
      type: "library.getSession",
      videoId: "vid1",
    });
    expect(one.ok && one.type === "session" && one.session.session?.title).toBe(
      "Title",
    );

    await dispatch(store, { type: "library.delete", videoId: "vid1" });
    const empty = await dispatch(store, { type: "library.list" });
    expect(empty.ok && empty.type === "list" && empty.sessions).toHaveLength(0);
  });

  it("survives having no IndexedDB at all", async () => {
    // The real entry point, in an environment with no `indexedDB` global —
    // the caller is a message channel, so a rejection would reach the content
    // script as `undefined` with the reason left in the worker's console.
    const response = await handleLibraryRequest({ type: "library.list" });
    expect(response.ok).toBe(false);
  });
});

describe("study stats (schema 2)", () => {
  const baseSession = {
    videoId: "vid",
    title: "T",
    channel: "C",
    durationMs: 60_000,
    thumbnailUrl: "",
    createdAt: 1,
    updatedAt: 1,
    noteCount: 0,
    messageCount: 0,
    chapters: [],
    chapterSource: "none" as const,
    summaryMarkdown: null,
  };

  async function seeded() {
    const store = memoryStore();
    await dispatch(store, {
      type: "library.upsertSession",
      session: baseSession,
    });
    return store;
  }

  it("accumulates deltas rather than replacing totals", async () => {
    const store = await seeded();

    for (let i = 0; i < 3; i += 1) {
      await dispatch(store, {
        type: "library.recordActivity",
        videoId: "vid",
        watchedMs: 1_000,
        openMs: 2_000,
        seen: [i],
        totalBuckets: 12,
        opened: i === 0,
      });
    }

    const reply = await dispatch(store, {
      type: "library.getSession",
      videoId: "vid",
    });
    expect(reply.ok && reply.type === "session").toBe(true);
    if (!reply.ok || reply.type !== "session") return;

    const session = reply.session.session!;
    expect(session.watchedMs).toBe(3_000);
    expect(session.openMs).toBe(6_000);
    // Only the first flush counted as a visit.
    expect(session.openCount).toBe(1);
    expect(session.coveragePct).toBeCloseTo(3 / 12);
  });

  // Rewatching the same stretch is effort, not progress. This is the whole
  // reason coverage is a bucket map instead of a running total.
  it("does not let a rewatched bucket inflate coverage", async () => {
    const store = await seeded();

    for (let i = 0; i < 5; i += 1) {
      await dispatch(store, {
        type: "library.recordActivity",
        videoId: "vid",
        watchedMs: 1_000,
        openMs: 1_000,
        seen: [0],
        totalBuckets: 10,
        opened: false,
      });
    }

    const reply = await dispatch(store, {
      type: "library.getSession",
      videoId: "vid",
    });
    if (!reply.ok || reply.type !== "session") throw new Error("no session");
    expect(reply.session.session!.coveragePct).toBeCloseTo(0.1);
    expect(reply.session.session!.watchedMs).toBe(5_000);
  });

  /*
   * A v1 session has none of these fields. It must open, and it must start
   * counting from zero rather than claiming a history it never had.
   */
  it("adopts a session saved before stats existed", async () => {
    const store = memoryStore();
    await store.put("sessions", {
      ...baseSession,
      schemaVersion: 1,
      // No coverage, watchedMs, openMs, openCount, lastOpenedAt, coveragePct.
    });

    await dispatch(store, {
      type: "library.recordActivity",
      videoId: "vid",
      watchedMs: 4_000,
      openMs: 4_000,
      seen: [1],
      totalBuckets: 10,
      opened: true,
    });

    const reply = await dispatch(store, {
      type: "library.getSession",
      videoId: "vid",
    });
    if (!reply.ok || reply.type !== "session") throw new Error("no session");
    const session = reply.session.session!;

    expect(session.watchedMs).toBe(4_000);
    expect(session.openCount).toBe(1);
    expect(session.title).toBe("T"); // nothing lost in the adoption
  });

  it("never shrinks coverage when a later duration is shorter", async () => {
    const store = await seeded();

    await dispatch(store, {
      type: "library.recordActivity",
      videoId: "vid",
      watchedMs: 1_000,
      openMs: 1_000,
      seen: [19],
      totalBuckets: 20,
      opened: true,
    });
    // A second visit reports a shorter timeline; the history must survive.
    await dispatch(store, {
      type: "library.recordActivity",
      videoId: "vid",
      watchedMs: 1_000,
      openMs: 1_000,
      seen: [0],
      totalBuckets: 5,
      opened: false,
    });

    const reply = await dispatch(store, {
      type: "library.getSession",
      videoId: "vid",
    });
    if (!reply.ok || reply.type !== "session") throw new Error("no session");
    expect(reply.session.session!.coverage.length).toBe(20);
    expect(reply.session.session!.coverage[19]).toBe(1);
  });

  it("ignores activity for a video that was never saved", async () => {
    const store = memoryStore();
    const reply = await dispatch(store, {
      type: "library.recordActivity",
      videoId: "ghost",
      watchedMs: 1_000,
      openMs: 1_000,
      seen: [0],
      totalBuckets: 4,
      opened: true,
    });
    expect(reply.ok).toBe(true);
  });

  it("buckets activity by day and totals it", async () => {
    const store = await seeded();
    await dispatch(store, {
      type: "library.recordActivity",
      videoId: "vid",
      watchedMs: 90_000,
      openMs: 120_000,
      seen: [0, 1],
      totalBuckets: 12,
      opened: true,
    });

    const reply = await dispatch(store, {
      type: "library.stats",
      granularity: "day",
    });
    if (!reply.ok || reply.type !== "stats") throw new Error("no stats");

    expect(reply.stats.totalWatchedMs).toBe(90_000);
    expect(reply.stats.videoCount).toBe(1);
    expect(reply.stats.buckets).toHaveLength(1);
    expect(reply.stats.buckets[0].watchedMs).toBe(90_000);
  });
});
