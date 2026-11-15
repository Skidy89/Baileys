import { Boom } from '@hapi/boom';
import type { SocketConfig } from '../Types';
import type { BinaryNode } from '../WABinary';
import { USyncQuery } from '../WAUSync';
export declare const makeUSyncSocket: (config: SocketConfig) => {
    executeUSyncQuery: (usyncQuery: USyncQuery) => Promise<import("..").USyncQueryResult | undefined>;
    type: "md";
    ws: import("./Client").WebSocketClient;
    ev: import("..").BaileysEventEmitter & {
        process(handler: (events: Partial<import("..").BaileysEventMap>) => void | Promise<void>): () => void;
        buffer(): void;
        createBufferedFunction<A extends unknown[], T>(work: (...args: A) => Promise<T>): (...args: A) => Promise<T>;
        flush(): boolean;
        isBuffering(): boolean;
        destroy(): void;
    };
    authState: {
        creds: import("..").AuthenticationCreds;
        keys: import("..").SignalKeyStoreWithRecordTransaction;
    };
    signalRepository: import("..").SignalRepositoryWithLIDStore;
    user: import("..").Contact | undefined;
    generateMessageTag: () => string;
    query: (node: BinaryNode, timeoutMs?: number) => Promise<BinaryNode>;
    waitForMessage: <T>(msgId: string, timeoutMs?: number | undefined) => Promise<T>;
    waitForSocketOpen: () => Promise<void>;
    sendRawMessage: (data: Uint8Array | Buffer) => Promise<void>;
    sendNode: (frame: BinaryNode) => Promise<void>;
    logout: (msg?: string) => Promise<void>;
    end: (error: Error | undefined) => Promise<void>;
    registerSocketEndHandler: (handler: (error: Error | undefined) => void | Promise<void>) => void;
    onUnexpectedError: (err: Error | Boom, msg: string) => void;
    uploadPreKeys: (count?: number) => Promise<void>;
    uploadPreKeysToServerIfRequired: () => Promise<void>;
    digestKeyBundle: () => Promise<void>;
    rotateSignedPreKey: () => Promise<void>;
    requestPairingCode: (phoneNumber: string, customPairingCode?: string) => Promise<string>;
    updateServerTimeOffset: ({ attrs }: BinaryNode) => void;
    sendUnifiedSession: () => Promise<void>;
    wamBuffer: import("..").BinaryInfo;
    getUSyncDevicesForMigration: (jid: string) => Promise<string[]>;
    waitForConnectionUpdate: (check: (u: Partial<import("..").ConnectionState>) => Promise<boolean | undefined>, timeoutMs?: number) => Promise<void>;
    sendWAMBuffer: (wamBuffer: Buffer) => Promise<BinaryNode>;
    onWhatsApp: (...phoneNumber: string[]) => Promise<{
        jid: string;
        exists: boolean;
    }[] | undefined>;
    fetchNewChatMessageCap: () => Promise<import("..").NewChatMessageCapInfo>;
};
//# sourceMappingURL=usync.d.ts.map