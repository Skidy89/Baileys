import WebSocket from 'ws';
import { AbstractSocketClient } from './types.js';
export declare class WebSocketClient extends AbstractSocketClient {
    private readonly fallbackUrls;
    protected socket: WebSocket | null;
    private readonly sockets;
    private connected;
    constructor(url: URL, config: ConstructorParameters<typeof AbstractSocketClient>[1], fallbackUrls?: URL[]);
    get isOpen(): boolean;
    get isClosed(): boolean;
    get isClosing(): boolean;
    get isConnecting(): boolean;
    connect(): void;
    pause(): void;
    resume(): void;
    close(): Promise<void>;
    send(str: string | Uint8Array, cb?: (err?: Error) => void): boolean;
}
//# sourceMappingURL=websocket.d.ts.map