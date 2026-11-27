import { createHash, timingSafeEqual } from 'crypto';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { promisify } from 'util';
import { createInflate, inflate } from 'zlib';
import $protobuf from 'protobufjs/minimal.js';
import { proto } from '../../WAProto/index.js';
import { WAMessageStubType } from '../Types/index.js';
import { areJidsSameUser, isHostedLidUser, isHostedPnUser, isJidGroup, isLidUser, isPnUser } from '../WABinary/index.js';
import { toNumber, unixTimestampSeconds } from './generics.js';
import { normalizeMessageContent } from './messages.js';
import { downloadContentFromMessage } from './messages/media/index.js';
const inflatePromise = promisify(inflate);
const MAX_HISTORY_SYNC_OUTPUT_SIZE = 100 * 1024 * 1024;
const MAX_HISTORY_SYNC_INPUT_SIZE = 110 * 1024 * 1024;
const MAX_GROUP_HISTORY_INPUT_SIZE = 110 * 1024 * 1024;
const MAX_GROUP_HISTORY_OUTPUT_SIZE = 100 * 1024 * 1024;
const GROUP_HISTORY_BUNDLE_WINDOW_SECONDS = 14 * 24 * 60 * 60;
const GROUP_HISTORY_MESSAGE_AGE_SECONDS = 2 * 45 * 24 * 60 * 60;
const INLINE_PAYLOAD_SYNC_TYPES = new Set([
    proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
    proto.HistorySync.HistorySyncType.INITIAL_STATUS_V3,
    proto.HistorySync.HistorySyncType.PUSH_NAME,
    proto.HistorySync.HistorySyncType.ON_DEMAND,
    proto.HistorySync.HistorySyncType.RECENT
]);
export const downloadHistory = async (msg, options) => {
    const stream = await downloadContentFromMessage(msg, 'md-msg-hist', { options });
    const inflater = createInflate({ chunkSize: 1024 * 1024 });
    const chunks = [];
    let inputSize = 0;
    let outputSize = 0;
    const inputLimit = new Transform({
        transform(chunk, _encoding, callback) {
            inputSize += chunk.length;
            if (inputSize > MAX_HISTORY_SYNC_INPUT_SIZE) {
                callback(new Error('History sync payload exceeds 110 MiB compressed limit'));
            }
            else {
                callback(null, chunk);
            }
        }
    });
    const outputLimit = new Transform({
        transform(chunk, _encoding, callback) {
            outputSize += chunk.length;
            if (outputSize > MAX_HISTORY_SYNC_OUTPUT_SIZE) {
                callback(new Error('History sync payload exceeds 100 MiB inflated limit'));
            }
            else {
                callback(null, chunk);
            }
        }
    });
    outputLimit.on('data', (chunk) => chunks.push(chunk));
    await pipeline(stream, inputLimit, inflater, outputLimit);
    const buffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, outputSize);
    chunks.length = 0;
    const syncData = proto.HistorySync.decode(buffer);
    return syncData;
};
export const processHistoryMessage = (item, logger) => {
    const messages = [];
    const contacts = [];
    const chats = [];
    const lidPnMappings = [];
    logger?.trace({ progress: item.progress }, 'processing history of type ' + item.syncType?.toString());
    // Extract LID-PN mappings for all sync types
    for (const m of item.phoneNumberToLidMappings || []) {
        if (m.lidJid && m.pnJid) {
            lidPnMappings.push({ lid: m.lidJid, pn: m.pnJid });
        }
    }
    switch (item.syncType) {
        case proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP:
        case proto.HistorySync.HistorySyncType.RECENT:
        case proto.HistorySync.HistorySyncType.FULL:
        case proto.HistorySync.HistorySyncType.ON_DEMAND:
            for (const chat of item.conversations) {
                contacts.push({
                    id: chat.id,
                    name: chat.displayName || chat.name || chat.username || undefined,
                    username: chat.username || undefined,
                    lid: chat.lidJid || chat.accountLid || undefined,
                    phoneNumber: chat.pnJid || undefined
                });
                const chatId = chat.id;
                const isLid = isLidUser(chatId) || isHostedLidUser(chatId);
                const isPn = isPnUser(chatId) || isHostedPnUser(chatId);
                const shouldExtractPnFromReceipt = isLid && !chat.pnJid;
                if (isLid && chat.pnJid) {
                    lidPnMappings.push({ lid: chatId, pn: chat.pnJid });
                }
                else if (isPn && chat.lidJid) {
                    lidPnMappings.push({ lid: chat.lidJid, pn: chatId });
                }
                const msgs = chat.messages || [];
                delete chat.messages;
                let pnFromReceipt;
                for (const item of msgs) {
                    const message = item.message;
                    messages.push(message);
                    if (shouldExtractPnFromReceipt && !pnFromReceipt && message.key.fromMe && message.userReceipt?.length) {
                        const userJid = message.userReceipt[0]?.userJid;
                        if (userJid && (isPnUser(userJid) || isHostedPnUser(userJid)))
                            pnFromReceipt = userJid;
                    }
                    if (!chat.messages?.length) {
                        // keep only the most recent message in the chat array
                        chat.messages = [{ message }];
                    }
                    if (!message.key.fromMe && !chat.lastMessageRecvTimestamp) {
                        chat.lastMessageRecvTimestamp = toNumber(message.messageTimestamp);
                    }
                    if ((message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_BSP ||
                        message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_FB) &&
                        message.messageStubParameters?.[0]) {
                        contacts.push({
                            id: message.key.participant || message.key.remoteJid,
                            verifiedName: message.messageStubParameters?.[0]
                        });
                    }
                }
                if (pnFromReceipt)
                    lidPnMappings.push({ lid: chatId, pn: pnFromReceipt });
                chats.push(chat);
            }
            break;
        case proto.HistorySync.HistorySyncType.PUSH_NAME:
            for (const c of item.pushnames) {
                contacts.push({ id: c.id, notify: c.pushname });
            }
            break;
    }
    return {
        chats,
        contacts,
        messages,
        lidPnMappings,
        pastParticipants: item.pastParticipants,
        callLogRecords: item.callLogRecords,
        syncType: item.syncType,
        progress: item.progress
    };
};
export const downloadAndProcessHistorySyncNotification = async (msg, options, logger) => {
    let historyMsg;
    const inlinePayload = msg.initialHistBootstrapInlinePayload;
    if (inlinePayload?.byteLength && INLINE_PAYLOAD_SYNC_TYPES.has(msg.syncType)) {
        try {
            historyMsg = proto.HistorySync.decode(await inflatePromise(inlinePayload, { maxOutputLength: MAX_HISTORY_SYNC_OUTPUT_SIZE }));
        }
        catch (err) {
            logger?.error({ err, syncType: msg.syncType, payloadByteLength: inlinePayload.byteLength }, 'failed to inflate inline history sync payload');
            throw err;
        }
    }
    else {
        try {
            historyMsg = await downloadHistory(msg, options);
        }
        catch (err) {
            logger?.error({ err, syncType: msg.syncType, fileLength: msg.fileLength, hasDirectPath: !!msg.directPath }, 'failed to download or inflate history sync payload');
            throw err;
        }
    }
    return processHistoryMessage(historyMsg, logger);
};
export const getHistoryMsg = (message) => {
    const normalizedContent = !!message ? normalizeMessageContent(message) : undefined;
    const anyHistoryMsg = normalizedContent?.protocolMessage?.historySyncNotification;
    return anyHistoryMsg;
};
export const decodeGroupHistoryMessages = (input) => {
    const reader = $protobuf.Reader.create(input);
    const messages = [];
    const readMessage = (reader, length) => {
        const message = proto.WebMessageInfo.decode(reader, length);
        if (message.key?.remoteJid && message.message)
            messages.push(message);
    };
    const readAssociatedList = (reader, length) => {
        const end = reader.pos + length;
        const associatedMessages = [];
        let associationType = 0;
        while (reader.pos < end) {
            const tag = reader.uint32();
            const field = tag >>> 3;
            if (field === 1 && (tag & 7) === 2) {
                const itemLength = reader.uint32();
                associatedMessages.push(proto.WebMessageInfo.decode(reader, itemLength));
            }
            else if (field === 3 && (tag & 7) === 0) {
                associationType = reader.uint32();
            }
            else {
                reader.skipType(tag & 7);
            }
        }
        if (associationType === proto.MessageAssociation.AssociationType.POLL_ADD_OPTION) {
            for (const message of associatedMessages) {
                if (message.key?.remoteJid && message.message)
                    messages.push(message);
            }
        }
    };
    const end = reader.len;
    while (reader.pos < end) {
        const tag = reader.uint32();
        const field = tag >>> 3;
        if ((tag & 7) !== 2) {
            reader.skipType(tag & 7);
            continue;
        }
        const length = reader.uint32();
        if (field === 1 || field === 3 || field === 4)
            readMessage(reader, length);
        else if (field === 2)
            readAssociatedList(reader, length);
        else if (field === 5)
            readMessage(reader, length);
        else
            reader.skip(length);
    }
    return messages;
};
export const isGroupHistoryRecipient = (historyReceivers = [], recipientJids) => historyReceivers.some(receiver => recipientJids.some(jid => areJidsSameUser(receiver, jid)));
export const isValidGroupHistoryBundle = (bundle) => {
    const metadata = bundle.messageHistoryMetadata;
    return (bundle.mimetype === 'application/protobuf' &&
        bundle.fileSha256?.byteLength === 32 &&
        bundle.mediaKey?.byteLength === 32 &&
        bundle.fileEncSha256?.byteLength === 32 &&
        !!metadata?.historyReceivers?.length &&
        metadata.oldestMessageTimestampInWindow != null &&
        toNumber(metadata.messageCount) > 0);
};
export const matchesGroupHistoryPlaintextHash = (actual, expected) => expected.byteLength === 32 && timingSafeEqual(actual, Buffer.from(expected));
export const isGroupHistoryBundleWithinWindow = (timestamp, now = unixTimestampSeconds()) => timestamp > 0 && now <= timestamp + GROUP_HISTORY_BUNDLE_WINDOW_SECONDS;
export const isGroupHistoryMessageWithinWindow = (message, now = unixTimestampSeconds()) => {
    const timestamp = toNumber(message.messageTimestamp);
    if (!timestamp)
        return true;
    if (now > timestamp + GROUP_HISTORY_MESSAGE_AGE_SECONDS)
        return false;
    return !(message.ephemeralDuration &&
        message.keepInChat?.keepType !== proto.KeepType.KEEP_FOR_ALL &&
        timestamp + message.ephemeralDuration <= now);
};
export const addProcessedGroupHistoryBundle = (processed, key, limit = 500) => {
    const next = processed.filter(item => item !== key);
    next.push(key);
    return next.slice(-limit);
};
export const isSupportedGroupHistoryMessage = (message) => {
    const content = message.message ? normalizeMessageContent(message.message) : undefined;
    if (!content)
        return false;
    return !!(content.conversation ||
        content.extendedTextMessage ||
        content.imageMessage ||
        content.audioMessage ||
        content.videoMessage ||
        content.ptvMessage ||
        content.documentMessage ||
        content.stickerMessage ||
        content.contactMessage ||
        content.contactsArrayMessage ||
        content.locationMessage ||
        content.liveLocationMessage ||
        content.groupInviteMessage ||
        content.albumMessage ||
        content.pollCreationMessage ||
        content.pollCreationMessageV2 ||
        content.pollCreationMessageV3 ||
        content.pollUpdateMessage ||
        content.eventMessage ||
        content.protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE);
};
export const downloadAndProcessGroupHistoryBundle = async (message, recipientJids, options, logger) => {
    const bundle = message.message?.messageHistoryBundle;
    const remoteJid = message.key.remoteJid;
    if (!bundle || !remoteJid || !isJidGroup(remoteJid) || message.key.fromMe) {
        return { messages: [], processed: false };
    }
    if (!isValidGroupHistoryBundle(bundle))
        return { messages: [], processed: false };
    const historyReceivers = bundle.messageHistoryMetadata?.historyReceivers || [];
    if (!isGroupHistoryRecipient(historyReceivers, recipientJids))
        return { messages: [], processed: false };
    if (!isGroupHistoryBundleWithinWindow(toNumber(message.messageTimestamp)))
        return { messages: [], processed: false };
    const chunks = [];
    let inputSize = 0;
    let outputSize = 0;
    const plaintextHash = createHash('sha256');
    const inputLimit = new Transform({
        transform(chunk, _encoding, callback) {
            inputSize += chunk.length;
            if (inputSize > MAX_GROUP_HISTORY_INPUT_SIZE) {
                callback(new Error('Group history bundle exceeds 110 MiB compressed limit'));
            }
            else {
                plaintextHash.update(chunk);
                callback(null, chunk);
            }
        }
    });
    const outputLimit = new Transform({
        transform(chunk, _encoding, callback) {
            outputSize += chunk.length;
            if (outputSize > MAX_GROUP_HISTORY_OUTPUT_SIZE)
                callback(new Error('Group history bundle exceeds 100 MiB inflated limit'));
            else {
                chunks.push(chunk);
                callback(null, chunk);
            }
        }
    });
    outputLimit.resume();
    try {
        const stream = await downloadContentFromMessage(bundle, 'group-history', {
            options,
            expectedFileEncSha256: bundle.fileEncSha256
        });
        await pipeline(stream, inputLimit, createInflate({ chunkSize: 1024 * 1024 }), outputLimit);
        if (!matchesGroupHistoryPlaintextHash(plaintextHash.digest(), bundle.fileSha256)) {
            throw new Error('Group history bundle plaintext hash mismatch');
        }
        const inflated = Buffer.concat(chunks, outputSize);
        chunks.length = 0;
        const messages = decodeGroupHistoryMessages(inflated);
        const groupJid = message.key.remoteJid;
        const now = unixTimestampSeconds();
        return {
            messages: messages.filter(item => item.key.remoteJid === groupJid &&
                isSupportedGroupHistoryMessage(item) &&
                isGroupHistoryMessageWithinWindow(item, now)),
            processed: true
        };
    }
    catch (err) {
        logger?.warn({ err, msgId: message.key.id }, 'failed to download or decode group history bundle');
        return { messages: [], processed: false };
    }
};
//# sourceMappingURL=history.js.map