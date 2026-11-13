// Type-only import so we don't pull better-sqlite3 into the bundle
// unconditionally. The runtime `import('better-sqlite3')` below remains lazy.
import type BetterSqlite3Module from 'better-sqlite3'
import { Worker } from 'node:worker_threads'
import { resolve } from 'node:path'
import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds, AuthenticationState, SignalDataSet, SignalDataTypeMap } from '../Types'
import { initAuthCreds } from './auth-utils'
import { packr } from './auth-state-serialization'
import type { StoredRow, WorkerCommand, WorkerResponse } from './sqlite-auth-worker'
/** A live `better-sqlite3` database handle (the instance type, not the constructor). */
type Database = BetterSqlite3Module.Database
/** The constructor exposed by `better-sqlite3`'s `export =` default. */
type DatabaseConstructor = typeof BetterSqlite3Module

/**
 * Lazy load `better-sqlite3` so the dependency is only required when this
 * adapter is actually used. The package is declared as an optional peer
 * dependency; users who stick with `useMultiFileAuthState` (or supply their
 * own store) don't need to install it.
 */
async function loadBetterSqlite3(): Promise<DatabaseConstructor> {
	try {
		const mod = await import('better-sqlite3')
		return mod.default ?? mod
	} catch (err) {
		const helpful = new Error(
			'`better-sqlite3` is required for `useSqliteAuthState`. Install it as a peer dependency: `npm install better-sqlite3`.'
		)
		Object.defineProperty(helpful, 'cause', { value: err })
		throw helpful
	}
}

const CREDS_ROW_KEY = '__creds__'

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
`

type SqliteAuthStateOptions = {
	/**
	 * Filesystem path to the SQLite database file. The file will be created if
	 * it does not exist. Use `':memory:'` for an in-process ephemeral store
	 * (useful in tests).
	 */
	dbPath: string
	/**
	 * If supplied, overrides the default `better-sqlite3` import — primarily
	 * for tests / advanced consumers that want to inject a pre-opened
	 * `Database` handle.
	 */
	database?: Database
}

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
export async function useSqliteAuthState(opts: SqliteAuthStateOptions): Promise<{
	state: AuthenticationState
	saveCreds: () => Promise<void>
	close: () => void
}> {
	// Track whether this function created the handle. If we did and any
	// subsequent init step (pragma / exec / prepare / loadCreds) throws, we
	// need to close the native handle ourselves — otherwise the caller never
	// sees a `close()` to call and the file descriptor / WAL lock leaks on
	// the startup failure path.
	let db: Database | undefined
	const ownsDb = !opts.database
	try {
		if (opts.database) {
			db = opts.database
		} else {
			const Database = await loadBetterSqlite3()
			db = new Database(opts.dbPath)
		}

		// WAL mode allows concurrent reads alongside a single writer; matches
		// what SQLite recommends for read-heavy workloads with sporadic writes.
		db.pragma('journal_mode = WAL')
		db.pragma('synchronous = NORMAL')
		db.pragma('busy_timeout = 5000')
		db.exec(CREATE_SCHEMA_SQL)

		const stmts = {
			credsSelect: db.prepare('SELECT value FROM creds WHERE key = ?'),
			credsUpsert: db.prepare(
				'INSERT INTO creds (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
			),
			keySelect: db.prepare('SELECT value FROM signal_keys WHERE type = ? AND id = ?'),
			keyUpsert: db.prepare(
				'INSERT INTO signal_keys (type, id, value) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET value = excluded.value'
			),
			keyDelete: db.prepare('DELETE FROM signal_keys WHERE type = ? AND id = ?'),
			keyListIds: db.prepare('SELECT id FROM signal_keys WHERE type = ?'),
			keyList: db.prepare('SELECT id, value FROM signal_keys WHERE type = ?'),
			clearKeys: db.prepare('DELETE FROM signal_keys')
		}

		const loadCreds = (): AuthenticationCreds => {
			const row = stmts.credsSelect.get(CREDS_ROW_KEY) as { value: Uint8Array } | undefined
			if (!row) return initAuthCreds()
			return packr.decode(row.value) as AuthenticationCreds
		}

		const persistCreds = (creds: AuthenticationCreds): void => {
			stmts.credsUpsert.run(CREDS_ROW_KEY, packr.pack(creds))
		}

		const creds = loadCreds()

		// One BEGIN IMMEDIATE transaction per `set` call covers every type +
		// every id at once. better-sqlite3's `transaction()` defaults to
		// DEFERRED — the write lock is only acquired on the first writing
		// statement, which under concurrency can produce `SQLITE_BUSY` if
		// two callers race to upgrade their readers to writers. We invoke
		// via the `.immediate(...)` flavour below so the write lock is
		// taken up front and the whole call either gets the lock or fails
		// fast, without leaving the caller mid-write.
		const applySetTx = db.transaction((data: SignalDataSet) => {
			for (const category in data) {
				const type = category as keyof SignalDataTypeMap
				const bucket = data[type]
				if (!bucket) continue
				for (const id in bucket) {
					const value = bucket[id]
					if (value === null) {
						stmts.keyDelete.run(type, id)
					} else {
						stmts.keyUpsert.run(type, id, packr.pack(value))
					}
				}
			}
		})

		// `db` is captured by `close` below; the non-null narrowing inside this
		// successful-init branch is local.
		const handle = db
		return {
			state: {
				creds,
				keys: {
					get: async (type, ids) => {
						const out: Record<string, SignalDataTypeMap[typeof type]> = {}
						for (const id of ids) {
							const row = stmts.keySelect.get(type, id) as { value: Uint8Array } | undefined
							if (!row) continue
							let value: unknown
							try {
								value = packr.unpack(row.value)
							} catch (e) {
								console.error(`Failed to unpack value for type ${type} and id ${id}:`, e)
								continue
							}
							if (type === 'app-state-sync-key' && typeof value === 'object' && value !== null) {
								value = proto.Message.AppStateSyncKeyData.fromObject(value)
							}

							out[id] = value as SignalDataTypeMap[typeof type]
						}

						return out
					},
					set: async data => {
						applySetTx.immediate(data)
					},
					clear: async () => {
						stmts.clearKeys.run()
					},
					list: async function* <T extends keyof SignalDataTypeMap>(
						type: T
					): AsyncIterable<readonly [string, SignalDataTypeMap[T]]> {
						for (const row of stmts.keyList.iterate(type) as Iterable<{ id: string; value: Uint8Array }>) {
							let value: unknown
							try {
								value = packr.unpack(row.value)
							} catch (e) {
								console.error(`Failed to unpack value for type ${type} and id ${row.id}:`, e)
								continue
							}
							if (type === 'app-state-sync-key' && typeof value === 'object' && value !== null) {
								value = proto.Message.AppStateSyncKeyData.fromObject(value)
							}

							yield [row.id, value as SignalDataTypeMap[T]] as const
						}
					},
					listIds: async function* <T extends keyof SignalDataTypeMap>(type: T): AsyncIterable<string> {
						for (const row of stmts.keyListIds.iterate(type) as Iterable<{ id: string }>) {
							yield row.id
						}
					}
				}
			},
			saveCreds: async () => {
				persistCreds(creds)
			},
			close: () => {
				handle.close()
			}
		}
	} catch (err) {
		// Init failed AFTER we opened the handle (or while opening it). If we
		// own the handle, close it so the file descriptor / WAL lock doesn't
		// leak — the caller never received a `close()` to call. If the caller
		// passed an existing `opts.database`, leave it alone; lifecycle is
		// theirs.
		if (ownsDb && db) {
			try {
				db.close()
			} catch {
				// best-effort — original error wins.
			}
		}

		throw err
	}
}

type PendingWorkerRequest = {
	resolve: (result: unknown) => void
	reject: (error: Error) => void
}

class SqliteAuthWorkerClient {
	private readonly worker: Worker
	private readonly pending = new Map<number, PendingWorkerRequest>()
	private nextRequestId = 0
	private isClosing = false

	constructor(dbPath: string) {
		this.worker = new Worker(new URL('./sqlite-auth-worker.js', import.meta.url), { workerData: { dbPath } })
		this.worker.on('message', (response: WorkerResponse) => {
			const pending = this.pending.get(response.id)
			if (!pending) return
			this.pending.delete(response.id)
			if (response.error) pending.reject(new Error(response.error))
			else pending.resolve(response.result)
		})
		this.worker.on('error', error => this.rejectPending(error))
		this.worker.on('exit', code => {
			if (!this.isClosing && code !== 0) {
				this.rejectPending(new Error(`SQLite auth worker exited with code ${code}`))
			}
		})
	}

	request<T>(command: WorkerCommand): Promise<T> {
		return new Promise((resolveRequest, rejectRequest) => {
			const id = ++this.nextRequestId
			this.pending.set(id, {
				resolve: result => resolveRequest(result as T),
				reject: rejectRequest
			})
			try {
				this.worker.postMessage({ ...command, id })
			} catch (error) {
				this.pending.delete(id)
				rejectRequest(error instanceof Error ? error : new Error(String(error)))
			}
		})
	}

	async close(): Promise<void> {
		this.isClosing = true
		try {
			await this.request<void>({ op: 'close' })
		} finally {
			await this.worker.terminate()
		}
	}

	private rejectPending(error: Error) {
		for (const pending of this.pending.values()) pending.reject(error)
		this.pending.clear()
	}
}

type SharedSqliteAuthWorker = {
	client: SqliteAuthWorkerClient
	state: AuthenticationState
	references: number
}

const sharedSqliteWorkers = new Map<string, Promise<SharedSqliteAuthWorker>>()

async function createSqliteAuthWorker(dbPath: string): Promise<SharedSqliteAuthWorker> {
	const client = new SqliteAuthWorkerClient(dbPath)
	try {
		const serializedCreds = await client.request<Uint8Array>({ op: 'initialize', initialCreds: packr.pack(initAuthCreds()) })
		const creds = packr.unpack(serializedCreds) as AuthenticationCreds
		const keys = createWorkerSignalKeyStore(client)
		return { client, state: { creds, keys }, references: 0 }
	} catch (error) {
		await client.close().catch(() => undefined)
		throw error
	}
}

async function acquireSqliteAuthWorker(dbPath: string): Promise<{ shared: SharedSqliteAuthWorker; release: () => void }> {
	const key = dbPath === ':memory:' ? dbPath : resolve(dbPath)
	let pending = sharedSqliteWorkers.get(key)
	if (!pending) {
		pending = createSqliteAuthWorker(dbPath)
		sharedSqliteWorkers.set(key, pending)
	}

	let shared: SharedSqliteAuthWorker
	try {
		shared = await pending
	} catch (error) {
		if (sharedSqliteWorkers.get(key) === pending) sharedSqliteWorkers.delete(key)
		throw error
	}

	shared.references++
	let released = false
	return {
		shared,
		release: () => {
			if (released) return
			released = true
			shared.references--
			if (shared.references === 0 && sharedSqliteWorkers.get(key) === pending) {
				sharedSqliteWorkers.delete(key)
				void shared.client.close()
			}
		}
	}
}

function createWorkerSignalKeyStore(client: SqliteAuthWorkerClient): AuthenticationState['keys'] {
	return {
		get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
			const rows = await client.request<StoredRow[]>({ op: 'get', type, ids })
			const values: Record<string, SignalDataTypeMap[T]> = {}
			for (const row of rows) {
				let value: unknown = packr.unpack(row.value)
				if (type === 'app-state-sync-key' && typeof value === 'object' && value !== null) {
					value = proto.Message.AppStateSyncKeyData.fromObject(value)
				}
				values[row.id] = value as SignalDataTypeMap[T]
			}
			return values
		},
		set: async (data: SignalDataSet) => {
			await client.request<void>({ op: 'set', data })
		},
		clear: async () => {
			await client.request<void>({ op: 'clear' })
		},
		list: async function* <T extends keyof SignalDataTypeMap>(
			type: T
		): AsyncIterable<readonly [string, SignalDataTypeMap[T]]> {
			let after: string | null = null
			while (true) {
				const rows: StoredRow[] = await client.request<StoredRow[]>({ op: 'list', type, after, includeValues: true })
				if (rows.length === 0) return
				for (const row of rows) {
					let value: unknown = packr.unpack(row.value)
					if (type === 'app-state-sync-key' && typeof value === 'object' && value !== null) {
						value = proto.Message.AppStateSyncKeyData.fromObject(value)
					}
					yield [row.id, value as SignalDataTypeMap[T]] as const
				}
				after = rows.at(-1)!.id
			}
		},
		listIds: async function* (type) {
			let after: string | null = null
			while (true) {
				const ids: string[] = await client.request<string[]>({ op: 'list', type, after, includeValues: false })
				if (ids.length === 0) return
				for (const id of ids) yield id
				after = ids.at(-1)!
			}
		}
	}
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
export async function useSqliteAuthStateInWorker(opts: Pick<SqliteAuthStateOptions, 'dbPath'>): Promise<{
	state: AuthenticationState
	saveCreds: () => Promise<void>
	close: () => void
}> {
	const { shared, release } = await acquireSqliteAuthWorker(opts.dbPath)
	return {
		state: shared.state,
		saveCreds: async () => {
			await shared.client.request<void>({ op: 'save-creds', value: packr.pack(shared.state.creds) })
		},
		close: release
	}
}
