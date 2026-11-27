import { proto } from '../../WAProto/index.js';
import type { Chat, Contact, LIDMapping, WAMessage } from '../Types/index.js';
import type { ILogger } from './logger.js';
export declare const downloadHistory: (msg: proto.Message.IHistorySyncNotification, options: RequestInit) => Promise<proto.HistorySync & proto.HistorySync.$Shape>;
export declare const processHistoryMessage: (item: proto.IHistorySync, logger?: ILogger) => {
    chats: Chat[];
    contacts: Contact[];
    messages: WAMessage[];
    lidPnMappings: LIDMapping[];
    pastParticipants: proto.PastParticipants.$Properties[] | null | undefined;
    callLogRecords: proto.CallLogRecord.$Properties[] | null | undefined;
    syncType: proto.HistorySync.HistorySyncType;
    progress: number | null | undefined;
};
export declare const downloadAndProcessHistorySyncNotification: (msg: proto.Message.IHistorySyncNotification, options: RequestInit, logger?: ILogger) => Promise<{
    chats: Chat[];
    contacts: Contact[];
    messages: WAMessage[];
    lidPnMappings: LIDMapping[];
    pastParticipants: proto.PastParticipants.$Properties[] | null | undefined;
    callLogRecords: proto.CallLogRecord.$Properties[] | null | undefined;
    syncType: proto.HistorySync.HistorySyncType;
    progress: number | null | undefined;
}>;
export declare const getHistoryMsg: (message: proto.IMessage) => proto.Message.HistorySyncNotification.$Properties;
export declare const decodeGroupHistoryMessages: (input: Buffer) => WAMessage[];
export declare const isGroupHistoryRecipient: (historyReceivers: string[] | undefined, recipientJids: string[]) => boolean;
export declare const isValidGroupHistoryBundle: (bundle: proto.Message.IMessageHistoryBundle) => boolean;
export declare const matchesGroupHistoryPlaintextHash: (actual: Buffer, expected: Uint8Array) => boolean;
export declare const isGroupHistoryBundleWithinWindow: (timestamp: number, now?: number) => boolean;
export declare const isGroupHistoryMessageWithinWindow: (message: WAMessage, now?: number) => boolean;
export declare const addProcessedGroupHistoryBundle: (processed: string[], key: string, limit?: number) => string[];
export declare const isSupportedGroupHistoryMessage: (message: WAMessage) => boolean;
export declare const downloadAndProcessGroupHistoryBundle: (message: WAMessage, recipientJids: string[], options: RequestInit, logger?: ILogger) => Promise<{
    messages: WAMessage[];
    processed: boolean;
}>;
//# sourceMappingURL=history.d.ts.map