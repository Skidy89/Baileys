import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import { createInflate, inflate } from 'zlib';
import { proto } from '../../WAProto/index.js';
import { WAMessageStubType } from '../Types/index.js';
import { isHostedLidUser, isHostedPnUser, isLidUser, isPnUser } from '../WABinary/index.js';
import { toNumber } from './generics.js';
import { normalizeMessageContent } from './messages.js';
import { downloadContentFromMessage } from './messages/media/index.js';
const inflatePromise = promisify(inflate);
export const downloadHistory = async (msg, options) => {
    const stream = await downloadContentFromMessage(msg, 'md-msg-hist', { options });
    const inflater = createInflate();
    const chunks = [];
    inflater.on('data', (chunk) => chunks.push(chunk));
    await pipeline(stream, inflater);
    const buffer = Buffer.concat(chunks);
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
        syncType: item.syncType,
        progress: item.progress
    };
};
export const downloadAndProcessHistorySyncNotification = async (msg, options, logger) => {
    let historyMsg;
    if (msg.initialHistBootstrapInlinePayload) {
        historyMsg = proto.HistorySync.decode(await inflatePromise(msg.initialHistBootstrapInlinePayload));
    }
    else {
        historyMsg = await downloadHistory(msg, options);
    }
    return processHistoryMessage(historyMsg, logger);
};
export const getHistoryMsg = (message) => {
    const normalizedContent = !!message ? normalizeMessageContent(message) : undefined;
    const anyHistoryMsg = normalizedContent?.protocolMessage?.historySyncNotification;
    return anyHistoryMsg;
};
//# sourceMappingURL=history.js.map