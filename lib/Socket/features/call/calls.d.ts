import type { GroupSession } from '@skidy89/signal-protocol';
import { type BinaryNode } from '../../../WABinary/index.js';
import type { VoipConfig } from '@skidy89/signal-protocol';
import type { CallMediaStream } from './call-media.js';
export type CallState = {
    callId: string;
    peer: string;
    group?: string;
    creator: string;
    direction: 'incoming' | 'outgoing';
    video: boolean;
    lightweight?: boolean;
    devices: string[];
    status: 'calling' | 'ringing' | 'connected' | 'ended';
    startedAt: number;
    offer?: BinaryNode;
    offerFrom?: string;
    relay?: BinaryNode;
    callKey?: Buffer;
    media?: CallMediaStream;
    groupSession?: GroupSession;
    peerDevice?: string;
    videoRequest?: boolean;
};
export declare const newCallId: () => string;
export declare const buildOffer: (o: {
    callId: string;
    to: string;
    creator: string;
    id: string;
    video: boolean;
    keys: Array<{
        jid: string;
        type: "msg" | "pkmsg";
        ciphertext: Uint8Array;
    }>;
    deviceIdentity?: Uint8Array;
}) => BinaryNode;
export declare const buildPreaccept: (callId: string, to: string, creator: string, id: string, video: boolean) => BinaryNode;
export declare const buildAccept: (callId: string, to: string, creator: string, id: string, video: boolean) => BinaryNode;
export declare const buildTerminate: (callId: string, to: string, creator: string, id: string) => BinaryNode;
export declare const buildVideoState: (callId: string, to: string, creator: string, id: string, state: number) => BinaryNode;
export declare const getCallKey: (decryptMessage: (opts: {
    jid: string;
    type: "msg" | "pkmsg";
    ciphertext: Uint8Array;
}) => Promise<Uint8Array>, from: string, enc: BinaryNode) => Promise<Buffer<ArrayBuffer>>;
export declare const mediaConfigFromRelay: (relay: BinaryNode, callId: string, direction: "incoming" | "outgoing", selfLid: string, peerLid: string, callKey: Uint8Array, video: boolean) => VoipConfig;
//# sourceMappingURL=calls.d.ts.map