import Database from 'better-sqlite3';
import { parentPort, workerData } from 'node:worker_threads';
import { packr } from './auth-state-serialization';
const port = parentPort;
if (!port)
    throw new Error('SQLite auth worker must run in a worker thread');
const { dbPath } = workerData;
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.exec(`
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
`);
const statements = {
    credsSelect: db.prepare('SELECT value FROM creds WHERE key = ?'),
    credsUpsert: db.prepare('INSERT INTO creds (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    keySelect: db.prepare('SELECT value FROM signal_keys WHERE type = ? AND id = ?'),
    keyUpsert: db.prepare('INSERT INTO signal_keys (type, id, value) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET value = excluded.value'),
    keyDelete: db.prepare('DELETE FROM signal_keys WHERE type = ? AND id = ?'),
    keyList: db.prepare('SELECT id, value FROM signal_keys WHERE type = ? AND (? IS NULL OR id > ?) ORDER BY id LIMIT ?'),
    keyListIds: db.prepare('SELECT id FROM signal_keys WHERE type = ? AND (? IS NULL OR id > ?) ORDER BY id LIMIT ?'),
    clearKeys: db.prepare('DELETE FROM signal_keys')
};
const applySet = db.transaction((data) => {
    for (const category in data) {
        const type = category;
        const bucket = data[type];
        if (!bucket)
            continue;
        for (const id in bucket) {
            const value = bucket[id];
            if (value === null)
                statements.keyDelete.run(type, id);
            else if (value !== undefined)
                statements.keyUpsert.run(type, id, packr.pack(value));
        }
    }
});
function listRows(type, after, includeValues) {
    if (includeValues) {
        return Array.from(statements.keyList.iterate(type, after, after, 100));
    }
    return Array.from(statements.keyListIds.iterate(type, after, after, 100), row => row.id);
}
function respond(request) {
    switch (request.op) {
        case 'initialize': {
            const row = statements.credsSelect.get('__creds__');
            if (row)
                return { id: request.id, result: row.value };
            statements.credsUpsert.run('__creds__', request.initialCreds);
            return { id: request.id, result: request.initialCreds };
        }
        case 'get': {
            const result = [];
            for (const id of request.ids) {
                const row = statements.keySelect.get(request.type, id);
                if (row)
                    result.push({ id, value: row.value });
            }
            return { id: request.id, result };
        }
        case 'set':
            applySet.immediate(request.data);
            return { id: request.id };
        case 'save-creds':
            statements.credsUpsert.run('__creds__', request.value);
            return { id: request.id };
        case 'clear':
            statements.clearKeys.run();
            return { id: request.id };
        case 'list':
            return { id: request.id, result: listRows(request.type, request.after, request.includeValues) };
        case 'close':
            db.close();
            return { id: request.id };
    }
}
port.on('message', (request) => {
    try {
        port.postMessage(respond(request));
    }
    catch (error) {
        port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
    }
});
//# sourceMappingURL=sqlite-auth-worker.js.map