import { Boom } from '@hapi/boom';
import { proto } from '../../WAProto/index.js';
import { areJidsSameUser, isHostedLidUser, isHostedPnUser, isJidBroadcast, isJidGroup, isJidMetaAI, isJidNewsletter, isJidStatusBroadcast, isLidUser, isPnUser, jidDecode
//	transferDevice
 } from '../WABinary/index.js';
import { toError, unpadRandomMax16 } from './generics.js';
import { decryptBotReplyNode, getBotReplyInfo } from './msmsg.js';
export const getDecryptionJid = async (sender, repository) => {
    if (isLidUser(sender) || isHostedLidUser(sender)) {
        return sender;
    }
    const mapped = await repository.lidMapping.getLIDForPN(sender);
    return mapped || sender;
};
const storeMappingFromEnvelope = async (stanza, sender, repository, decryptionJid, logger) => {
    const { senderAlt } = extractAddressingContext(stanza);
    if (senderAlt &&
        (isLidUser(senderAlt) || isHostedLidUser(senderAlt)) &&
        (isPnUser(sender) || isHostedPnUser(sender)) &&
        decryptionJid === sender) {
        try {
            await repository.lidMapping.storeLIDPNMappings([{ lid: senderAlt, pn: sender }]);
            await repository.migrateSession(sender, senderAlt);
            if (logger)
                logger.debug({ sender, senderAlt }, 'Stored LID mapping from envelope');
        }
        catch (error) {
            if (logger)
                logger.warn({ sender, senderAlt, error }, 'Failed to store LID mapping');
        }
    }
};
export const NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node';
export const MISSING_KEYS_ERROR_TEXT = 'Key used already or never filled';
export const ACCOUNT_RESTRICTED_TEXT = 'Your account has been restricted';
export const MISSING_BOT_MESSAGE_SECRET_TEXT = 'Message secret for the bot reply not found';
// Retry configuration for failed decryption
export const DECRYPTION_RETRY_CONFIG = {
    maxRetries: 3,
    baseDelayMs: 100,
    sessionRecordErrors: ['No session record', 'SessionError: No session record']
};
const ownJidUsersCache = new WeakMap();
/** NACK reason codes we send to the server (client → server) */
export const NACK_REASONS = {
    SenderReachoutTimelocked: 463,
    ParsingError: 487,
    UnrecognizedStanza: 488,
    UnrecognizedStanzaClass: 489,
    UnrecognizedStanzaType: 490,
    InvalidProtobuf: 491,
    InvalidHostedCompanionStanza: 493,
    MissingMessageSecret: 495,
    SignalErrorOldCounter: 496,
    MessageDeletedOnPeer: 499,
    UnhandledError: 500,
    UnsupportedAdminRevoke: 550,
    UnsupportedLIDGroup: 551,
    DBOperationFailed: 552
};
/**
 * Server-side error codes returned in ack stanzas (server → client) that we
 * currently have dedicated handlers for. Extend as more handlers are added.
 * Distinct from the client-side NackReason enum (WAWebCreateNackFromStanza).
 */
export const SERVER_ERROR_CODES = {
    /**
     * 1:1 message missing privacy token (tctoken). Usually means the account is
     * restricted: WhatsApp blocks starting new chats but preserves existing ones,
     * since established chats already carry a tctoken.
     */
    MessageAccountRestriction: '463',
    /** Stanza validation failure (SMAX_INVALID) — likely stale device session */
    SmaxInvalid: '479'
};
export const extractAddressingContext = (stanza) => {
    let senderAlt;
    let recipientAlt;
    const sender = stanza.attrs.participant || stanza.attrs.from;
    const addressingMode = stanza.attrs.addressing_mode || (sender?.endsWith('lid') ? 'lid' : 'pn');
    if (addressingMode === 'lid') {
        // Message is LID-addressed: sender is LID, extract corresponding PN
        // without device data
        senderAlt =
            stanza.attrs.participant_pn ||
                stanza.attrs.sender_pn ||
                stanza.attrs.peer_recipient_pn ||
                stanza.attrs.peer_recipient_username;
        recipientAlt = stanza.attrs.recipient_pn;
        // with device data
        //if (sender && senderAlt) senderAlt = transferDevice(sender, senderAlt)
    }
    else {
        // Message is PN-addressed: sender is PN, extract corresponding LID
        // without device data
        senderAlt = stanza.attrs.participant_lid || stanza.attrs.sender_lid || stanza.attrs.peer_recipient_lid;
        recipientAlt = stanza.attrs.recipient_lid || stanza.attrs.peer_recipient_pn || stanza.attrs.peer_recipient_username;
        //with device data
        //if (sender && senderAlt) senderAlt = transferDevice(sender, senderAlt)
    }
    return {
        addressingMode,
        senderAlt,
        recipientAlt
    };
};
/**
 * Decode the received node as a message.
 * @note this will only parse the message, not decrypt it
 */
export function decodeMessageNode(stanza, meId, meLid, ownJidUsers = { meIdUser: jidDecode(meId)?.user, meLidUser: jidDecode(meLid)?.user }) {
    let msgType;
    let chatId;
    let author;
    let fromMe = false;
    const msgId = stanza.attrs.id;
    const from = stanza.attrs.from;
    const participant = stanza.attrs.participant;
    const recipient = stanza.attrs.recipient;
    if (!msgId) {
        throw new Boom('Invalid message stanza: missing id attribute', { data: stanza });
    }
    if (!from) {
        throw new Boom('Invalid message stanza: missing from attribute', { data: stanza });
    }
    const addressingContext = extractAddressingContext(stanza);
    const isMe = (jid) => areJidsSameUser(jid, meId);
    const isMeLid = (jid) => areJidsSameUser(jid, meLid);
    if (isPnUser(from) || isLidUser(from) || isHostedLidUser(from) || isHostedPnUser(from)) {
        const fromUser = jidDecode(from)?.user;
        const senderIsMe = fromUser === ownJidUsers.meIdUser || fromUser === ownJidUsers.meLidUser;
        if (recipient && (!isJidMetaAI(recipient) || isMe(from) || isMeLid(from))) {
            if (!senderIsMe) {
                throw new Boom('receipient present, but msg not from me', { data: stanza });
            }
            fromMe = senderIsMe;
            chatId = recipient;
        }
        else {
            // Peer-routed self stanzas (history sync, app-state sync, etc.) arrive
            // with `from` set to our own device but no `recipient` attribute —
            // still mark as fromMe so self-only protocolMessage handlers run.
            fromMe = senderIsMe;
            chatId = from;
        }
        msgType = 'chat';
        author = from;
    }
    else if (isJidMetaAI(from)) {
        msgType = 'chat';
        chatId = from;
        author = from;
    }
    else if (isJidGroup(from)) {
        if (!participant) {
            throw new Boom('No participant in group message');
        }
        const participantUser = jidDecode(participant)?.user;
        fromMe = participantUser === ownJidUsers.meIdUser || participantUser === ownJidUsers.meLidUser;
        msgType = 'group';
        author = participant;
        chatId = from;
    }
    else if (isJidBroadcast(from)) {
        if (!participant) {
            throw new Boom('No participant in group message');
        }
        const isParticipantMe = jidDecode(participant)?.user === ownJidUsers.meIdUser;
        if (isJidStatusBroadcast(from)) {
            msgType = isParticipantMe ? 'direct_peer_status' : 'other_status';
        }
        else {
            msgType = isParticipantMe ? 'peer_broadcast' : 'other_broadcast';
        }
        fromMe = isParticipantMe;
        chatId = from;
        author = participant;
    }
    else if (isJidNewsletter(from)) {
        msgType = 'newsletter';
        chatId = from;
        author = from;
        const fromUser = jidDecode(from)?.user;
        fromMe = fromUser === ownJidUsers.meIdUser || fromUser === ownJidUsers.meLidUser;
    }
    else {
        throw new Boom('Unknown message type', { data: stanza });
    }
    const pushname = stanza?.attrs?.notify;
    const key = {
        remoteJid: chatId,
        remoteJidAlt: !isJidGroup(chatId) && !isJidMetaAI(chatId) ? addressingContext.senderAlt : undefined,
        remoteJidUsername: !isJidGroup(chatId)
            ? stanza.attrs.peer_recipient_username || stanza.attrs.recipient_username
            : undefined,
        fromMe,
        id: msgId,
        participant,
        participantAlt: isJidGroup(chatId) ? addressingContext.senderAlt : undefined,
        participantUsername: stanza.attrs.participant ? stanza.attrs.participant_username : undefined,
        addressingMode: addressingContext.addressingMode,
        ...(msgType === 'newsletter' && stanza.attrs.server_id ? { server_id: stanza.attrs.server_id } : {})
    };
    const fullMessage = {
        key,
        category: stanza.attrs.category,
        messageTimestamp: +stanza.attrs.t,
        pushName: pushname,
        broadcast: isJidBroadcast(from)
    };
    if (key.fromMe) {
        fullMessage.status = proto.WebMessageInfo.Status.SERVER_ACK;
    }
    const lidPnMappings = [];
    if (fromMe) {
        const chatIsLid = isLidUser(chatId) || isHostedLidUser(chatId);
        const chatIsPn = isPnUser(chatId) || isHostedPnUser(chatId);
        const peerLid = chatIsPn ? stanza.attrs.recipient_lid || stanza.attrs.peer_recipient_lid : undefined;
        const peerPn = chatIsLid ? stanza.attrs.recipient_pn || stanza.attrs.peer_recipient_pn : undefined;
        const lid = chatIsLid ? chatId : peerLid;
        const pn = chatIsPn ? chatId : peerPn;
        if (lid && pn && (isLidUser(lid) || isHostedLidUser(lid)) && (isPnUser(pn) || isHostedPnUser(pn))) {
            lidPnMappings.push({ lid, pn });
            const latestLid = stanza.attrs.recipient_latest_lid;
            const hasPeerRecipient = (chatIsPn && !stanza.attrs.recipient_lid && stanza.attrs.peer_recipient_lid) ||
                (chatIsLid && !stanza.attrs.recipient_pn && stanza.attrs.peer_recipient_pn);
            if (hasPeerRecipient && latestLid && (isLidUser(latestLid) || isHostedLidUser(latestLid)) && latestLid !== lid) {
                lidPnMappings.push({ lid: latestLid, pn });
            }
        }
    }
    return {
        fullMessage,
        author,
        sender: msgType === 'chat' ? author : chatId,
        lidPnMappings
    };
}
export const decryptMessageNode = (stanza, meId, meLid, repository, logger, getBotMessageSecret) => {
    let ownJidUsers = ownJidUsersCache.get(repository);
    if (!ownJidUsers || ownJidUsers.meId !== meId || ownJidUsers.meLid !== meLid) {
        ownJidUsers = { meId, meLid, meIdUser: jidDecode(meId)?.user, meLidUser: jidDecode(meLid)?.user };
        ownJidUsersCache.set(repository, ownJidUsers);
    }
    const { fullMessage, author, sender, lidPnMappings } = decodeMessageNode(stanza, meId, meLid, ownJidUsers);
    if (lidPnMappings.length)
        logger?.trace({ lidPnMappings }, 'extracted recipient LID-PN mappings');
    const decryptBotReplyStanza = async (content) => {
        if (!isJidMetaAI(author)) {
            throw new Error('msmsg from a sender that is not a bot');
        }
        const info = getBotReplyInfo(stanza);
        const targetSenderJid = info.targetSenderJid || meLid;
        const isOwnTarget = !!targetSenderJid &&
            (isLidUser(targetSenderJid) ? areJidsSameUser(targetSenderJid, meLid) : areJidsSameUser(targetSenderJid, meId));
        if (!info.targetId || !isOwnTarget) {
            throw new Error('bot reply does not answer one of our messages');
        }
        const messageSecret = await getBotMessageSecret?.({
            remoteJid: fullMessage.key.remoteJid,
            id: info.targetId,
            fromMe: true
        });
        if (!messageSecret?.length) {
            throw new Error(MISSING_BOT_MESSAGE_SECRET_TEXT);
        }
        return await decryptBotReplyNode({
            content,
            stanzaId: fullMessage.key.id,
            info,
            messageSecret,
            targetSenderJid,
            botJid: author
        });
    };
    return {
        fullMessage,
        category: stanza.attrs.category,
        author,
        lidPnMappings,
        async decrypt() {
            let decryptables = 0;
            if (Array.isArray(stanza.content)) {
                for (const { tag, attrs, content } of stanza.content) {
                    if (tag === 'verified_name' && content instanceof Uint8Array) {
                        const cert = proto.VerifiedNameCertificate.decode(content);
                        const details = proto.VerifiedNameCertificate.Details.decode(cert.details);
                        fullMessage.verifiedBizName = details.verifiedName;
                    }
                    if (tag === 'unavailable' && attrs.type === 'view_once') {
                        fullMessage.key.isViewOnce = true;
                        fullMessage.messageStubType = proto.WebMessageInfo.StubType.VIEWED_ONCE;
                    }
                    if (attrs.count && tag === 'enc') {
                        fullMessage.retryCount = Number(attrs.count);
                    }
                    if (tag !== 'enc' && tag !== 'plaintext') {
                        continue;
                    }
                    if (!(content instanceof Uint8Array)) {
                        continue;
                    }
                    decryptables += 1;
                    let msgBuffer;
                    const decryptionJid = await getDecryptionJid(author, repository);
                    if (tag !== 'plaintext') {
                        await storeMappingFromEnvelope(stanza, author, repository, decryptionJid, logger);
                    }
                    try {
                        const e2eType = tag === 'plaintext' ? 'plaintext' : attrs.type;
                        switch (e2eType) {
                            case 'skmsg':
                            case 'frskmsg':
                                msgBuffer = await repository.decryptGroupMessage({
                                    group: sender,
                                    authorJid: author,
                                    msg: content
                                });
                                break;
                            case 'pkmsg':
                            case 'msg':
                                msgBuffer = await repository.decryptMessage({
                                    jid: decryptionJid,
                                    type: e2eType,
                                    ciphertext: content
                                });
                                break;
                            case 'msmsg':
                                msgBuffer = await decryptBotReplyStanza(content);
                                break;
                            case 'plaintext':
                                msgBuffer = content;
                                break;
                            default:
                                throw new Error(`Unknown e2e type: ${e2eType}`);
                        }
                        let msg = proto.Message.decode(e2eType === 'plaintext' || e2eType === 'msmsg' ? msgBuffer : unpadRandomMax16(msgBuffer));
                        msg = msg.deviceSentMessage?.message || msg;
                        if (msg.senderKeyDistributionMessage) {
                            //eslint-disable-next-line max-depth
                            try {
                                await repository.processSenderKeyDistributionMessage({
                                    authorJid: author,
                                    item: msg.senderKeyDistributionMessage
                                });
                            }
                            catch (err) {
                                if (logger)
                                    logger.error({ key: fullMessage.key, err }, 'failed to process sender key distribution message');
                            }
                        }
                        if (fullMessage.message) {
                            Object.assign(fullMessage.message, msg);
                        }
                        else {
                            fullMessage.message = msg;
                        }
                    }
                    catch (err) {
                        const errorContext = {
                            key: fullMessage.key,
                            err,
                            messageType: tag === 'plaintext' ? 'plaintext' : attrs.type,
                            sender,
                            author,
                            isSessionRecordError: isSessionRecordError(err)
                        };
                        if (logger)
                            logger.error(errorContext, 'failed to decrypt message');
                        fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT;
                        fullMessage.messageStubParameters = [toError(err).message];
                    }
                }
            }
            // if nothing was found to decrypt
            if (!decryptables && !fullMessage.key?.isViewOnce) {
                fullMessage.messageStubType = proto.WebMessageInfo.StubType.CIPHERTEXT;
                fullMessage.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT];
            }
        }
    };
};
/**
 * Utility function to check if an error is related to missing session record
 */
function isSessionRecordError(error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return DECRYPTION_RETRY_CONFIG.sessionRecordErrors.some(errorPattern => errorMessage.includes(errorPattern));
}
//# sourceMappingURL=decode-wa-message.js.map