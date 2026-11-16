export type WACallUpdateType = 'offer' | 'ringing' | 'preaccept' | 'transport' | 'relaylatency' | 'timeout' | 'reject' | 'accept' | 'video' | 'group_update' | 'enc_rekey' | 'terminate';
export type WACallEvent = {
    chatId: string;
    from: string;
    creator?: string;
    callerPn?: string;
    isGroup?: boolean;
    groupJid?: string;
    groupState?: Record<string, unknown>;
    lightweight?: boolean;
    id: string;
    date: Date;
    isVideo?: boolean;
    status: WACallUpdateType;
    offline: boolean;
    latencyMs?: number;
    videoState?: number;
};
//# sourceMappingURL=Call.d.ts.map