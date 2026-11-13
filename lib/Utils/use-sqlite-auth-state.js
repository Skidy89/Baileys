import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { proto } from '../../WAProto/index.js';
import { initAuthCreds } from './auth-utils.js';
import { packr } from './auth-state-serialization.js';
/**
 * Lazy load `better-sqlite3` so the dependency is only required when this
 * adapter is actually used. The package is declared as an optional peer
 * dependency; users who stick with `useMultiFileAuthState` (or supply their
 * own store) don't need to install it.
 */
async function loadBetterSqlite3() {
    try {
        const mod = await import('better-sqlite3');
        return mod.default ?? mod;
    }
    catch (err) {
        const helpful = new Error('`better-sqlite3` is required for `useSqliteAuthState`. Install it as a peer dependency: `npm install better-sqlite3`.');
        Object.defineProperty(helpful, 'cause', { value: err });
        throw helpful;
    }
}
const CREDS_ROW_KEY = '__creds__';
const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS creds (
  key TEXT PRIMARY KEY,
  value BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS signal_keys (
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  value BLOB NOT NULL,
  PRIMARY KEY (type, id)
);
CREATE INDEX IF NOT EXISTS signal_keys_type_idx ON signal_keys(type);
`;
/**
 * SQLite-backed authentication state for Baileys.
 *
 * Why this and not `useMultiFileAuthState`?
 *   - cross-process safe (SQLite handles file locking);
 *   - true per-call atomicity via `BEGIN IMMEDIATE; …; COMMIT` — a multi-type
 *     `set({ session, 'identity-key' })` either commits both types or rolls
 *     back the whole call (closes the cross-file H3/H5 gap that the multi-file
 *     adapter can only approximate);
 *   - constant-time point reads under arbitrarily large state;
 *   - efficient `list`/`listIds` enumeration for bulk operations and migration.
 *
 * Lifecycle:
 *   - the returned `close()` closes the underlying SQLite handle.
 *   - The same `dbPath` can be reopened after `close()` to resume.
 *
 * For migrating an existing on-disk `useMultiFileAuthState` folder to this
 * store, see {@link migrateAuthState}.
 */
export async function useSqliteAuthState(opts) {
    // Track whether this function created the handle. If we did and any
    // subsequent init step (pragma / exec / prepare / loadCreds) throws, we
    // need to close the native handle ourselves — otherwise the caller never
    // sees a `close()` to call and the file descriptor / WAL lock leaks on
    // the startup failure path.
    let db;
    const ownsDb = !opts.database;
    try {
        if (opts.database) {
            db = opts.database;
        }
        else {
            const Database = await loadBetterSqlite3();
            db = new Database(opts.dbPath);
        }
        // WAL mode allows concurrent reads alongside a single writer; matches
        // what SQLite recommends for read-heavy workloads with sporadic writes.
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = NORMAL');
        db.pragma('busy_timeout = 5000');
        db.exec(CREATE_SCHEMA_SQL);
        const stmts = {
            credsSelect: db.prepare('SELECT value FROM creds WHERE key = ?'),
            credsUpsert: db.prepare('INSERT INTO creds (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
            keySelect: db.prepare('SELECT value FROM signal_keys WHERE type = ? AND id = ?'),
            keyUpsert: db.prepare('INSERT INTO signal_keys (type, id, value) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET value = excluded.value'),
            keyDelete: db.prepare('DELETE FROM signal_keys WHERE type = ? AND id = ?'),
            keyListIds: db.prepare('SELECT id FROM signal_keys WHERE type = ?'),
            keyList: db.prepare('SELECT id, value FROM signal_keys WHERE type = ?'),
            clearKeys: db.prepare('DELETE FROM signal_keys')
        };
        const loadCreds = () => {
            const row = stmts.credsSelect.get(CREDS_ROW_KEY);
            if (!row)
                return initAuthCreds();
            return packr.decode(row.value);
        };
        const persistCreds = (creds) => {
            stmts.credsUpsert.run(CREDS_ROW_KEY, packr.pack(creds));
        };
        const creds = loadCreds();
        // One BEGIN IMMEDIATE transaction per `set` call covers every type +
        // every id at once. better-sqlite3's `transaction()` defaults to
        // DEFERRED — the write lock is only acquired on the first writing
        // statement, which under concurrency can produce `SQLITE_BUSY` if
        // two callers race to upgrade their readers to writers. We invoke
        // via the `.immediate(...)` flavour below so the write lock is
        // taken up front and the whole call either gets the lock or fails
        // fast, without leaving the caller mid-write.
        const applySetTx = db.transaction((data) => {
            for (const category in data) {
                const type = category;
                const bucket = data[type];
                if (!bucket)
                    continue;
                for (const id in bucket) {
                    const value = bucket[id];
                    if (value === null) {
                        stmts.keyDelete.run(type, id);
                    }
                    else {
                        stmts.keyUpsert.run(type, id, packr.pack(value));
                    }
                }
            }
        });
        // `db` is captured by `close` below; the non-null narrowing inside this
        // successful-init branch is local.
        const handle = db;
        return {
            state: {
                creds,
                keys: {
                    get: async (type, ids) => {
                        const out = {};
                        for (const id of ids) {
                            const row = stmts.keySelect.get(type, id);
                            if (!row)
                                continue;
                            let value;
                            try {
                                value = packr.unpack(row.value);
                            }
                            catch (e) {
                                console.error(`Failed to unpack value for type ${type} and id ${id}:`, e);
                                continue;
                            }
                            if (type === 'app-state-sync-key' && typeof value === 'object' && value !== null) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            out[id] = value;
                        }
                        return out;
                    },
                    set: async (data) => {
                        applySetTx.immediate(data);
                    },
                    clear: async () => {
                        stmts.clearKeys.run();
                    },
                    list: async function* (type) {
                        for (const row of stmts.keyList.iterate(type)) {
                            let value;
                            try {
                                value = packr.unpack(row.value);
                            }
                            catch (e) {
                                console.error(`Failed to unpack value for type ${type} and id ${row.id}:`, e);
                                continue;
                            }
                            if (type === 'app-state-sync-key' && typeof value === 'object' && value !== null) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            yield [row.id, value];
                        }
                    },
                    listIds: async function* (type) {
                        for (const row of stmts.keyListIds.iterate(type)) {
                            yield row.id;
                        }
                    }
                }
            },
            saveCreds: async () => {
                persistCreds(creds);
            },
            close: () => {
                handle.close();
            }
        };
    }
    catch (err) {
        // Init failed AFTER we opened the handle (or while opening it). If we
        // own the handle, close it so the file descriptor / WAL lock doesn't
        // leak — the caller never received a `close()` to call. If the caller
        // passed an existing `opts.database`, leave it alone; lifecycle is
        // theirs.
        if (ownsDb && db) {
            try {
                db.close();
            }
            catch {
                // best-effort — original error wins.
            }
        }
        throw err;
    }
}
class SqliteAuthWorkerClient {
    constructor(dbPath) {
        this.pending = new Map();
        this.nextRequestId = 0;
        this.isClosing = false;
        this.worker = new Worker(new URL('./sqlite-auth-worker.js', import.meta.url), { workerData: { dbPath } });
        this.worker.on('message', (response) => {
            const pending = this.pending.get(response.id);
            if (!pending)
                return;
            this.pending.delete(response.id);
            if (response.error)
                pending.reject(new Error(response.error));
            else
                pending.resolve(response.result);
        });
        this.worker.on('error', error => this.rejectPending(error));
        this.worker.on('exit', code => {
            if (!this.isClosing && code !== 0) {
                this.rejectPending(new Error(`SQLite auth worker exited with code ${code}`));
            }
        });
    }
    request(command) {
        return new Promise((resolveRequest, rejectRequest) => {
            const id = ++this.nextRequestId;
            this.pending.set(id, {
                resolve: result => resolveRequest(result),
                reject: rejectRequest
            });
            try {
                this.worker.postMessage({ ...command, id });
            }
            catch (error) {
                this.pending.delete(id);
                rejectRequest(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    async close() {
        this.isClosing = true;
        try {
            await this.request({ op: 'close' });
        }
        finally {
            await this.worker.terminate();
        }
    }
    rejectPending(error) {
        for (const pending of this.pending.values())
            pending.reject(error);
        this.pending.clear();
    }
}
const sharedSqliteWorkers = new Map();
async function createSqliteAuthWorker(dbPath) {
    const client = new SqliteAuthWorkerClient(dbPath);
    try {
        const serializedCreds = await client.request({ op: 'initialize', initialCreds: packr.pack(initAuthCreds()) });
        const creds = packr.unpack(serializedCreds);
        const keys = createWorkerSignalKeyStore(client);
        return { client, state: { creds, keys }, references: 0 };
    }
    catch (error) {
        await client.close().catch(() => undefined);
        throw error;
    }
}
async function acquireSqliteAuthWorker(dbPath) {
    const key = dbPath === ':memory:' ? dbPath : resolve(dbPath);
    let pending = sharedSqliteWorkers.get(key);
    if (!pending) {
        pending = createSqliteAuthWorker(dbPath);
        sharedSqliteWorkers.set(key, pending);
    }
    let shared;
    try {
        shared = await pending;
    }
    catch (error) {
        if (sharedSqliteWorkers.get(key) === pending)
            sharedSqliteWorkers.delete(key);
        throw error;
    }
    shared.references++;
    let released = false;
    return {
        shared,
        release: () => {
            if (released)
                return;
            released = true;
            shared.references--;
            if (shared.references === 0 && sharedSqliteWorkers.get(key) === pending) {
                sharedSqliteWorkers.delete(key);
                void shared.client.close();
            }
        }
    };
}
function createWorkerSignalKeyStore(client) {
    return {
        get: async (type, ids) => {
            const rows = await client.request({ op: 'get', type, ids });
            const values = {};
            for (const row of rows) {
                let value = packr.unpack(row.value);
                if (type === 'app-state-sync-key' && typeof value === 'object' && value !== null) {
                    value = proto.Message.AppStateSyncKeyData.fromObject(value);
                }
                values[row.id] = value;
            }
            return values;
        },
        set: async (data) => {
            await client.request({ op: 'set', data });
        },
        clear: async () => {
            await client.request({ op: 'clear' });
        },
        list: async function* (type) {
            let after = null;
            while (true) {
                const rows = await client.request({ op: 'list', type, after, includeValues: true });
                if (rows.length === 0)
                    return;
                for (const row of rows) {
                    let value = packr.unpack(row.value);
                    if (type === 'app-state-sync-key' && typeof value === 'object' && value !== null) {
                        value = proto.Message.AppStateSyncKeyData.fromObject(value);
                    }
                    yield [row.id, value];
                }
                after = rows.at(-1).id;
            }
        },
        listIds: async function* (type) {
            let after = null;
            while (true) {
                const ids = await client.request({ op: 'list', type, after, includeValues: false });
                if (ids.length === 0)
                    return;
                for (const id of ids)
                    yield id;
                after = ids.at(-1);
            }
        }
    };
}
/**
 * SQLite auth storage whose database work runs on a shared worker thread.
 * Multiple callers using the same resolved path share one worker, one key
 * store, and one credentials object. The worker serializes SQLite operations
 * while keeping synchronous disk access off the application event loop.
 *
 * Use this for several sockets in one process. Each socket should receive the
 * same returned `state` so its in-memory credentials and transaction locks are
 * shared as well.
 */
export async function useSqliteAuthStateInWorker(opts) {
    const { shared, release } = await acquireSqliteAuthWorker(opts.dbPath);
    return {
        state: shared.state,
        saveCreds: async () => {
            await shared.client.request({ op: 'save-creds', value: packr.pack(shared.state.creds) });
        },
        close: release
    };
}
//# sourceMappingURL=use-sqlite-auth-state.js.map