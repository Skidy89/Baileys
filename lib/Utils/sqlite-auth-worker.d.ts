import type { SignalDataSet, SignalDataType } from '../Types/index.js';
export type WorkerCommand = {
    op: 'initialize';
    initialCreds: Uint8Array;
} | {
    op: 'get';
    type: SignalDataType;
    ids: string[];
} | {
    op: 'set';
    data: SignalDataSet;
} | {
    op: 'save-creds';
    value: Uint8Array;
} | {
    op: 'clear';
} | {
    op: 'list';
    type: SignalDataType;
    after: string | null;
    includeValues: boolean;
} | {
    op: 'close';
};
export type StoredRow = {
    id: string;
    value: Uint8Array;
};
export type WorkerResponse = {
    id: number;
    result?: unknown;
    error?: string;
};
//# sourceMappingURL=sqlite-auth-worker.d.ts.map