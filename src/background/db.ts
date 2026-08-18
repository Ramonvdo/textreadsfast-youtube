/**
 * The session library's database.
 *
 * WHY INDEXEDDB AND NOT `chrome.storage.local`: a 60-minute transcript is
 * 0.5–0.7MB of text, and `storage.local` has no partial write — every note
 * keystroke would re-serialise the whole session and push it across an IPC
 * boundary. Its 10MB default would also hold only 15–20 sessions, and while
 * `unlimitedStorage` lifts the ceiling it does nothing about the rewrite cost.
 * IndexedDB gives per-record writes and real indexes, which is what a library
 * that is read one row at a time actually needs.
 *
 * WHY THE LOGIC TAKES A `LibraryStore`: every rule worth testing here — merge
 * semantics, count recomputation, sort order, cascade delete, idempotent append
 * — is independent of IndexedDB, and IndexedDB does not exist in the test
 * environment. The store functions therefore talk to a narrow adapter, and only
 * `handleLibraryRequest` knows that the real one is backed by `indexedDB`.
 */

import type { ChatMessage, Note } from "../readmode/model";
import {
  SCHEMA_VERSION,
  thumbnailUrl,
  type FullSession,
  type LibraryRequest,
  type LibraryResponse,
  type SessionRecord,
  type SessionSummary,
  type TranscriptRecord,
} from "../shared/libraryProtocol";

const DB_NAME = "trf-library";

export type StoreName = "sessions" | "transcripts" | "notes" | "messages";

export type IndexName =
  "by-updatedAt" | "by-video" | "by-video-time" | "by-video-created";

/**
 * The primary key of each store, for adapters that have to derive it themselves.
 *
 * Must agree with the migration that created the store — IndexedDB will not
 * warn if it does not, it will simply refuse the write.
 */
export const KEY_PATHS: Record<StoreName, string> = {
  sessions: "videoId",
  transcripts: "videoId",
  notes: "id",
  messages: "id",
};

/**
 * Index key paths, used to turn a `videoId` into a query.
 *
 * A compound index is queried by its first component: everything belonging to
 * one video, in the order the remaining components impose. Index names are
 * unique across stores, so one flat map is enough.
 */
export const INDEX_KEY_PATHS: Record<IndexName, readonly string[]> = {
  "by-updatedAt": ["updatedAt"],
  "by-video": ["videoId"],
  "by-video-time": ["videoId", "atMs"],
  "by-video-created": ["videoId", "createdAt"],
};

export interface ScanOptions {
  /** Walk the index backwards — newest first, for `by-updatedAt`. */
  descending?: boolean;
  limit?: number;
}

/**
 * The only thing the library logic knows about storage.
 *
 * Deliberately smaller than IndexedDB: no transactions, no cursors, no key
 * ranges. Read-modify-write safety comes from serialising requests (see
 * `serialize`) rather than from transaction scope, which is affordable because
 * one user's library sees a handful of writes a minute at most.
 */
export interface LibraryStore {
  get<T>(store: StoreName, key: string): Promise<T | undefined>;
  put<T extends object>(store: StoreName, value: T): Promise<void>;
  delete(store: StoreName, key: string): Promise<void>;
  /** Records whose index key is — or, for a compound index, begins with — `key`. */
  byIndex<T>(store: StoreName, index: IndexName, key: string): Promise<T[]>;
  countByIndex(
    store: StoreName,
    index: IndexName,
    key: string,
  ): Promise<number>;
  /** The whole store in index order. */
  scanIndex<T>(
    store: StoreName,
    index: IndexName,
    options?: ScanOptions,
  ): Promise<T[]>;
}

/* ── stored shapes ───────────────────────────────────────────────────────── */

/**
 * A note as stored: the model's `Note` plus what the database needs.
 *
 * `videoId` is not on `Note` because inside Read Mode there is only ever one
 * video; the library holds every video at once and has to index by it.
 */
export interface NoteRecord extends Note {
  videoId: string;
  schemaVersion: number;
}

export interface MessageRecord extends ChatMessage {
  videoId: string;
  schemaVersion: number;
}

export interface StoredTranscript extends TranscriptRecord {
  schemaVersion: number;
}

/**
 * What `library.upsertSession` may leave out.
 *
 * Wider than the protocol's own `Omit<SessionRecord, "schemaVersion">` on
 * purpose — the message type is assignable to this, and a caller that has no
 * summary or no idea when the session was first saved can say so by omission
 * instead of guessing a value that would overwrite the truth.
 */
export type SessionUpsert = Omit<
  SessionRecord,
  | "schemaVersion"
  | "createdAt"
  | "summaryMarkdown"
  | "noteCount"
  | "messageCount"
> &
  Partial<
    Pick<
      SessionRecord,
      "createdAt" | "summaryMarkdown" | "noteCount" | "messageCount"
    >
  >;

/* ── schema ──────────────────────────────────────────────────────────────── */

type Migration = (db: IDBDatabase, transaction: IDBTransaction) => void;

/**
 * The upgrade ladder: one entry per version, applied in order from whatever is
 * on disk up to `SCHEMA_VERSION`.
 *
 * Each entry is frozen once shipped. Version 2 is a new function appended here
 * — `(db, transaction) => { const notes = transaction.objectStore("notes"); … }`
 * — and a bump of `SCHEMA_VERSION` in the protocol. Editing an existing entry
 * would change the shape only for users who install after the edit, and leave
 * everyone else on a database no code in the tree describes.
 */
export const MIGRATIONS: readonly Migration[] = [
  /** → v1 */
  (db) => {
    const sessions = db.createObjectStore("sessions", { keyPath: "videoId" });
    // The library is read newest-first and nothing else; one index covers it.
    sessions.createIndex("by-updatedAt", "updatedAt");

    // Transcripts are the bulk of a session and are read only when the model is
    // asked something. Splitting them out is what lets `list` stay cheap.
    db.createObjectStore("transcripts", { keyPath: "videoId" });

    const notes = db.createObjectStore("notes", { keyPath: "id" });
    notes.createIndex("by-video", "videoId");
    notes.createIndex("by-video-time", ["videoId", "atMs"]);

    const messages = db.createObjectStore("messages", { keyPath: "id" });
    messages.createIndex("by-video-created", ["videoId", "createdAt"]);
  },
];

/* ── promise helpers over IndexedDB's event API ──────────────────────────── */

function failure(source: { error: DOMException | null }, what: string): Error {
  const error = source.error;
  return new Error(
    error ? `${what}: ${error.name} ${error.message}` : `${what} failed`,
  );
}

function requestAsPromise<T>(request: IDBRequest<T>, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(failure(request, what));
  });
}

/** Resolves when the write is durable, not merely when the request succeeded. */
function transactionAsPromise(
  transaction: IDBTransaction,
  what: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(failure(transaction, what));
    transaction.onabort = () => reject(failure(transaction, `${what} aborted`));
  });
}

/**
 * A query for everything belonging to one video.
 *
 * On a compound index the upper bound is `[videoId, []]`: IndexedDB orders
 * arrays after every other key type, so that sorts above `[videoId, <number>]`
 * without having to invent a maximum timestamp.
 */
function videoQuery(index: IndexName, key: string): IDBKeyRange | string {
  return INDEX_KEY_PATHS[index].length > 1
    ? IDBKeyRange.bound([key], [key, []])
    : key;
}

function idbStore(db: IDBDatabase): LibraryStore {
  const read = (name: StoreName) =>
    db.transaction(name, "readonly").objectStore(name);

  return {
    async get<T>(name: StoreName, key: string) {
      return await requestAsPromise<T | undefined>(
        read(name).get(key) as IDBRequest<T | undefined>,
        `read ${name}`,
      );
    },

    async put(name, value) {
      const transaction = db.transaction(name, "readwrite");
      transaction.objectStore(name).put(value);
      await transactionAsPromise(transaction, `write ${name}`);
    },

    async delete(name, key) {
      const transaction = db.transaction(name, "readwrite");
      transaction.objectStore(name).delete(key);
      await transactionAsPromise(transaction, `delete from ${name}`);
    },

    async byIndex<T>(name: StoreName, index: IndexName, key: string) {
      return await requestAsPromise<T[]>(
        read(name).index(index).getAll(videoQuery(index, key)) as IDBRequest<
          T[]
        >,
        `read ${name} by ${index}`,
      );
    },

    async countByIndex(name, index, key) {
      return await requestAsPromise(
        read(name).index(index).count(videoQuery(index, key)),
        `count ${name} by ${index}`,
      );
    },

    scanIndex<T>(name: StoreName, index: IndexName, options: ScanOptions = {}) {
      const source = read(name).index(index);
      const cursor = source.openCursor(
        null,
        options.descending ? "prev" : "next",
      );
      return new Promise<T[]>((resolve, reject) => {
        const rows: T[] = [];
        cursor.onerror = () => reject(failure(cursor, `scan ${name}`));
        cursor.onsuccess = () => {
          const position = cursor.result;
          if (!position) {
            resolve(rows);
            return;
          }
          rows.push(position.value as T);
          if (options.limit !== undefined && rows.length >= options.limit) {
            resolve(rows);
            return;
          }
          position.continue();
        };
      });
    },
  };
}

/* ── connection ──────────────────────────────────────────────────────────── */

let connection: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, SCHEMA_VERSION);

    request.onupgradeneeded = (event) => {
      const transaction = request.transaction;
      if (!transaction) throw new Error("upgrade began without a transaction");
      const target = event.newVersion ?? SCHEMA_VERSION;
      for (let version = event.oldVersion; version < target; version += 1) {
        const step = MIGRATIONS[version];
        if (!step) throw new Error(`no migration to version ${version + 1}`);
        step(request.result, transaction);
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // Another context wants a version this connection would block. Closing
      // here is what keeps *that* open from hanging on `blocked` forever.
      db.onversionchange = () => {
        db.close();
        connection = null;
      };
      // Eviction or a forced close leaves a handle that fails every request.
      db.onclose = () => {
        connection = null;
      };
      resolve(db);
    };

    request.onerror = () => reject(failure(request, "open the library"));

    // An open blocked by an older connection never settles on its own. Failing
    // loudly turns a silent hang into an error the caller can show.
    request.onblocked = () =>
      reject(
        new Error(
          "the library is open in another context running an older version",
        ),
      );
  });
}

function database(): Promise<IDBDatabase> {
  if (!connection) {
    connection = openDatabase().catch((error: unknown) => {
      // A rejected promise must not be cached, or one transient failure would
      // make every later request fail with the same stale error.
      connection = null;
      throw error;
    });
  }
  return connection;
}

/**
 * Run library work one request at a time.
 *
 * The store functions read, decide and write, and `await` between those steps.
 * Two overlapping upserts for the same video would otherwise both read the same
 * "before" and the second would undo the first. A queue is enough here: this is
 * one user's own library, not a contended server.
 */
let queue: Promise<unknown> = Promise.resolve();

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

/* ── the store functions ─────────────────────────────────────────────────── */

/** A timestamp, or nothing — so `??` can fall through a caller's 0. */
function timestamp(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

async function counts(
  store: LibraryStore,
  videoId: string,
): Promise<{ noteCount: number; messageCount: number }> {
  const [noteCount, messageCount] = await Promise.all([
    store.countByIndex("notes", "by-video", videoId),
    store.countByIndex("messages", "by-video-created", videoId),
  ]);
  return { noteCount, messageCount };
}

/**
 * Save or update a session, merging over what is already stored.
 *
 * Read Mode upserts on every entry into a video, with whatever the page has
 * given it so far. A straight `put` would therefore reset the session each time
 * it was reopened: the original save date, the summary that cost a model call,
 * and — if YouTube had not painted the header yet — the title.
 */
export async function upsertSession(
  store: LibraryStore,
  incoming: SessionUpsert,
): Promise<SessionRecord> {
  const existing = await store.get<SessionRecord>("sessions", incoming.videoId);
  const now = Date.now();
  const hasChapters = incoming.chapters.length > 0;

  const record: SessionRecord = {
    schemaVersion: SCHEMA_VERSION,
    videoId: incoming.videoId,
    title: incoming.title || existing?.title || "",
    channel: incoming.channel || existing?.channel || "",
    durationMs: incoming.durationMs || existing?.durationMs || 0,
    thumbnailUrl: incoming.thumbnailUrl || thumbnailUrl(incoming.videoId),
    // AI chapters cost a model call, and the "derived" tier costs a pass over
    // the transcript. Reopening a video before either has run must not spend
    // them again, so an empty list means "nothing new", not "no chapters".
    chapters: hasChapters ? incoming.chapters : (existing?.chapters ?? []),
    chapterSource: hasChapters
      ? incoming.chapterSource
      : (existing?.chapterSource ?? incoming.chapterSource),
    // The summary is written by `setSummary`; a session upsert carries none, and
    // taking its `null` would delete one the user has already read.
    summaryMarkdown:
      incoming.summaryMarkdown ?? existing?.summaryMarkdown ?? null,
    // Existing wins outright. The caller stamps `Date.now()` when it opens the
    // video, so honouring it would make every revisit look like a new session
    // and shuffle the library's own history.
    createdAt: existing?.createdAt ?? timestamp(incoming.createdAt) ?? now,
    updatedAt: timestamp(incoming.updatedAt) ?? now,
    // Derived, never accepted: the caller's counts are a snapshot from before
    // its own notes and messages landed, and drift is invisible in the UI.
    ...(await counts(store, incoming.videoId)),
  };

  await store.put("sessions", record);
  return record;
}

/** Refresh a stored session after its notes or messages changed. */
async function touchSession(
  store: LibraryStore,
  videoId: string,
  at = Date.now(),
): Promise<void> {
  const existing = await store.get<SessionRecord>("sessions", videoId);
  // A note taken before the session row landed is still the user's note. It
  // stays in the notes store and is picked up by the next upsert's recount.
  if (!existing) return;
  await store.put("sessions", {
    ...existing,
    updatedAt: at,
    ...(await counts(store, videoId)),
  });
}

export async function putTranscript(
  store: LibraryStore,
  transcript: TranscriptRecord,
): Promise<void> {
  const record: StoredTranscript = {
    schemaVersion: SCHEMA_VERSION,
    videoId: transcript.videoId,
    language: transcript.language,
    plainText: transcript.plainText,
    updatedAt: timestamp(transcript.updatedAt) ?? Date.now(),
  };
  await store.put("transcripts", record);
}

/** The list row. Chapters and the summary are dropped: neither is drawn on a card. */
function toSummary(record: SessionRecord): SessionSummary {
  return {
    videoId: record.videoId,
    title: record.title,
    channel: record.channel,
    durationMs: record.durationMs,
    thumbnailUrl: record.thumbnailUrl || thumbnailUrl(record.videoId),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    noteCount: record.noteCount,
    messageCount: record.messageCount,
  };
}

/**
 * The library, newest first.
 *
 * Reads the sessions store and nothing else — pulling a transcript per row
 * would move megabytes across the message channel to draw a grid of cards,
 * which is the entire reason transcripts are stored separately.
 */
export async function listSessions(
  store: LibraryStore,
  limit?: number,
): Promise<SessionSummary[]> {
  const rows = await store.scanIndex<SessionRecord>(
    "sessions",
    "by-updatedAt",
    { descending: true, limit },
  );
  return rows.map(toSummary);
}

function toNote(record: NoteRecord): Note {
  return {
    id: record.id,
    atMs: record.atMs,
    text: record.text,
    createdAt: record.createdAt,
  };
}

function toMessage(record: MessageRecord): ChatMessage {
  return {
    id: record.id,
    role: record.role,
    text: record.text,
    createdAt: record.createdAt,
  };
}

export async function getSession(
  store: LibraryStore,
  videoId: string,
): Promise<FullSession> {
  const [session, transcript, noteRows, messageRows] = await Promise.all([
    store.get<SessionRecord>("sessions", videoId),
    store.get<StoredTranscript>("transcripts", videoId),
    store.byIndex<NoteRecord>("notes", "by-video-time", videoId),
    store.byIndex<MessageRecord>("messages", "by-video-created", videoId),
  ]);

  return {
    session: session ?? null,
    // Sorted here as well as by the index, so the order is a property of the
    // library rather than of whichever store happens to be underneath it.
    notes: noteRows.map(toNote).sort((a, b) => a.atMs - b.atMs),
    messages: messageRows
      .map(toMessage)
      // Two messages can share a millisecond; falling back to the id keeps the
      // conversation from reordering itself between reads.
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    transcript: transcript
      ? {
          videoId: transcript.videoId,
          language: transcript.language,
          plainText: transcript.plainText,
          updatedAt: transcript.updatedAt,
        }
      : null,
  };
}

/**
 * Remove a session and everything hanging off it.
 *
 * Notes and messages are keyed by their own id, so nothing deletes them
 * implicitly — a session dropped on its own leaves rows that no longer appear
 * anywhere in the UI but still answer every index query.
 */
export async function deleteSession(
  store: LibraryStore,
  videoId: string,
): Promise<void> {
  const [notes, messages] = await Promise.all([
    store.byIndex<NoteRecord>("notes", "by-video", videoId),
    store.byIndex<MessageRecord>("messages", "by-video-created", videoId),
  ]);

  await Promise.all([
    store.delete("sessions", videoId),
    store.delete("transcripts", videoId),
    ...notes.map((note) => store.delete("notes", note.id)),
    ...messages.map((message) => store.delete("messages", message.id)),
  ]);
}

export async function putNote(
  store: LibraryStore,
  videoId: string,
  note: Note,
): Promise<void> {
  const existing = await store.get<NoteRecord>("notes", note.id);
  if (existing && existing.videoId !== videoId) {
    throw new Error(`note ${note.id} belongs to another video`);
  }

  const record: NoteRecord = {
    schemaVersion: SCHEMA_VERSION,
    videoId,
    id: note.id,
    atMs: note.atMs,
    text: note.text,
    createdAt: timestamp(note.createdAt) ?? existing?.createdAt ?? Date.now(),
  };

  await store.put("notes", record);
  await touchSession(store, videoId);
}

export async function deleteNote(
  store: LibraryStore,
  videoId: string,
  noteId: string,
): Promise<void> {
  const existing = await store.get<NoteRecord>("notes", noteId);
  if (existing && existing.videoId !== videoId) {
    throw new Error(`note ${noteId} belongs to another video`);
  }
  await store.delete("notes", noteId);
  await touchSession(store, videoId);
}

/**
 * Append a chat message, or leave it exactly as it is.
 *
 * Assistant rows are written once, on completion, but a worker that is torn
 * down mid-write leaves the content script no way to know whether the write
 * landed, so it retries. Keyed on the message's own id, the retry rewrites one
 * row instead of adding a second — and keeps the original `createdAt`, or the
 * message would jump to the end of the conversation it is part of.
 */
export async function appendMessage(
  store: LibraryStore,
  videoId: string,
  message: ChatMessage,
): Promise<void> {
  const existing = await store.get<MessageRecord>("messages", message.id);
  if (existing && existing.videoId !== videoId) {
    throw new Error(`message ${message.id} belongs to another video`);
  }

  const record: MessageRecord = {
    schemaVersion: SCHEMA_VERSION,
    videoId,
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt:
      existing?.createdAt ?? timestamp(message.createdAt) ?? Date.now(),
    // `streaming` is deliberately not stored. It describes a live request, and
    // persisted it would render as a reply that never finishes arriving.
  };

  await store.put("messages", record);
  await touchSession(store, videoId);
}

export async function setSummary(
  store: LibraryStore,
  videoId: string,
  summaryMarkdown: string,
): Promise<void> {
  const existing = await store.get<SessionRecord>("sessions", videoId);
  if (!existing) throw new Error(`no saved session for ${videoId}`);
  await store.put("sessions", {
    ...existing,
    summaryMarkdown,
    updatedAt: Date.now(),
  });
}

/* ── routing ─────────────────────────────────────────────────────────────── */

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function route(
  store: LibraryStore,
  message: LibraryRequest,
): Promise<LibraryResponse> {
  switch (message.type) {
    case "library.upsertSession":
      await upsertSession(store, message.session);
      return { ok: true, type: "void" };

    case "library.putTranscript":
      await putTranscript(store, message.transcript);
      return { ok: true, type: "void" };

    case "library.getSession":
      return {
        ok: true,
        type: "session",
        session: await getSession(store, message.videoId),
      };

    case "library.list":
      return {
        ok: true,
        type: "list",
        sessions: await listSessions(store, message.limit),
      };

    case "library.delete":
      await deleteSession(store, message.videoId);
      return { ok: true, type: "void" };

    case "library.putNote":
      await putNote(store, message.videoId, message.note);
      return { ok: true, type: "void" };

    case "library.deleteNote":
      await deleteNote(store, message.videoId, message.noteId);
      return { ok: true, type: "void" };

    case "library.appendMessage":
      await appendMessage(store, message.videoId, message.message);
      return { ok: true, type: "void" };

    case "library.setSummary":
      await setSummary(store, message.videoId, message.summaryMarkdown);
      return { ok: true, type: "void" };

    default: {
      // Adding a request to the protocol without handling it here is a compile
      // error rather than a message that quietly does nothing.
      const unhandled: never = message;
      return {
        ok: false,
        error: `unknown request ${JSON.stringify(unhandled)}`,
      };
    }
  }
}

/**
 * The dispatcher, over any store.
 *
 * Nothing escapes as an exception: the caller is a message channel, and a
 * rejected promise there reaches the content script as `undefined` with the
 * reason only in the worker's own console.
 */
export async function dispatch(
  store: LibraryStore,
  message: LibraryRequest,
): Promise<LibraryResponse> {
  try {
    return await route(store, message);
  } catch (error) {
    return { ok: false, error: describe(error) };
  }
}

export async function handleLibraryRequest(
  message: LibraryRequest,
): Promise<LibraryResponse> {
  try {
    return await serialize(async () =>
      dispatch(idbStore(await database()), message),
    );
  } catch (error) {
    // Opening the database can fail on its own — a blocked upgrade, a private
    // window with storage disabled — before any request has been routed.
    return { ok: false, error: describe(error) };
  }
}
