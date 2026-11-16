import { proto } from '../../../WAProto/index.js';
import type { MessageUserReceipt, WAMessage, WAMessageContent, WAMessageKey } from '../../Types/index.js';
/** Get the key to access the true type of content */
export declare const getContentType: (content: proto.IMessage | undefined) => keyof proto.IMessage | undefined;
/**
 * Normalizes ephemeral, view once messages to regular message content
 * Eg. image messages in ephemeral messages, in view once messages etc.
 * @param content
 * @returns
 */
export declare const normalizeMessageContent: (content: WAMessageContent | null | undefined) => WAMessageContent | undefined;
/**
 * Extract the true message content from a message
 * Eg. extracts the inner message from a disappearing message/view once message
 */
export declare const extractMessageContent: (content: WAMessageContent | undefined | null) => WAMessageContent | undefined;
/**
 * Returns the device predicted by message ID
 */
export declare const getDevice: (id: string) => "web" | "unknown" | "android" | "ios" | "desktop";
/** Upserts a receipt in the message */
export declare const updateMessageWithReceipt: (msg: Pick<WAMessage, "userReceipt">, receipt: MessageUserReceipt) => void;
/** Update the message with a new reaction */
export declare const updateMessageWithReaction: (msg: Pick<WAMessage, "reactions">, reaction: proto.IReaction) => void;
/** Update the message with a new poll update */
export declare const updateMessageWithPollUpdate: (msg: Pick<WAMessage, "pollUpdates">, update: proto.IPollUpdate) => void;
/** Update the message with a new event response */
export declare const updateMessageWithEventResponse: (msg: Pick<WAMessage, "eventResponses">, update: proto.IEventResponse) => void;
type VoteAggregation = {
    name: string;
    voters: string[];
};
/**
 * Aggregates all poll updates in a poll.
 * @param msg the poll creation message
 * @param meId your jid
 * @returns A list of options & their voters
 */
export declare function getAggregateVotesInPollMessage({ message, pollUpdates }: Pick<WAMessage, 'pollUpdates' | 'message'>, meId?: string): VoteAggregation[];
type ResponseAggregation = {
    response: string;
    responders: string[];
};
/**
 * Aggregates all event responses in an event message.
 * @param msg the event creation message
 * @param meId your jid
 * @returns A list of response types & their responders
 */
export declare function getAggregateResponsesInEventMessage({ eventResponses }: Pick<WAMessage, 'eventResponses'>, meId?: string): ResponseAggregation[];
/** Given a list of message keys, aggregates them by chat & sender. Useful for sending read receipts in bulk */
export declare const aggregateMessageKeysNotFromMe: (keys: WAMessageKey[]) => {
    jid: string;
    participant: string | undefined;
    messageIds: string[];
}[];
export {};
//# sourceMappingURL=content.d.ts.map