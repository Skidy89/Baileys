import { type CallEngine, type GroupSession } from '@skidy89/signal-protocol';
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
    heartbeat?: NodeJS.Timeout;
    status: 'offer_sent' | 'server_ack' | 'ringing' | 'connected' | 'ended';
    startedAt: number;
    offer?: BinaryNode;
    offerFrom?: string;
    relay?: BinaryNode;
    callKey?: Buffer;
    media?: CallMediaStream;
    groupSession?: GroupSession;
    groupEngine?: CallEngine;
    groupState?: GroupCallSnapshot;
    groupRelay?: BinaryNode;
    groupEpoch?: {
        transactionId: number;
        key: Buffer;
    };
    groupEpochTransaction?: number;
    peerDevice?: string;
    videoRequest?: boolean;
};
export declare const isCallActive: (calls: Map<string, CallState>, call: CallState) => boolean;
export type GroupCallSnapshot = {
    applied: string;
    transactionId: number;
    media: string;
    rekeyRequested: boolean;
    hasRelay: boolean;
    epochRecipients: string[];
    members: string[];
};
export declare const newCallId: () => string;
export declare const packGroupCallNode: (node: BinaryNode) => Buffer<ArrayBufferLike>;
export declare function acknowledgeOffer(call: CallState, ack: BinaryNode, stanzaId: string | undefined): void;
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
export declare const buildGroupOffer: (callId: string, id: string, creator: string, group: string, roster: Map<string, string[]>, video: boolean) => BinaryNode;
export declare const buildPreaccept: (callId: string, to: string, creator: string, id: string, video: boolean) => BinaryNode;
export declare const buildAccept: (callId: string, to: string, creator: string, id: string, video: boolean) => BinaryNode;
export declare const buildTerminate: (callId: string, to: string, creator: string, id: string) => BinaryNode;
export declare const buildVideoState: (callId: string, to: string, creator: string, id: string, state: number, o?: {
    dec?: string;
    orientation?: number;
}) => BinaryNode;
export declare const getCallKey: (decryptMessage: (opts: {
    jid: string;
    type: "msg" | "pkmsg";
    ciphertext: Uint8Array;
}) => Promise<Uint8Array>, from: string, enc: BinaryNode) => Promise<Buffer<ArrayBuffer>>;
export declare const getCallOfferEnc: (action: BinaryNode, ownJids: string[]) => BinaryNode | undefined;
export declare const mediaConfigFromRelay: (relay: BinaryNode, callId: string, direction: "incoming" | "outgoing", selfLid: string, peerLid: string, callKey: Uint8Array, video: boolean) => VoipConfig;
export declare const groupRelayEndpointFromNode: (relay: BinaryNode) => {
    relayIp: string;
    relayPort: number;
};
export declare const buildGroupEncRekey: (o: {
    callId: string;
    creator: string;
    to: string;
    id: string;
    transactionId: number;
    encrypted: {
        type: "msg" | "pkmsg";
        ciphertext: Uint8Array;
    };
    deviceIdentity?: Uint8Array;
}) => BinaryNode;
//# sourceMappingURL=calls.d.ts.map