import NodeCache from '@cacheable/node-cache';
import { Boom } from '@hapi/boom';
import { randomBytes } from 'crypto';
import Long from 'long';
import { proto } from '../../../WAProto/index.js';
import { DEFAULT_CACHE_TTLS, KEY_BUNDLE_TYPE, PLACEHOLDER_MAX_AGE_SECONDS, STATUS_EXPIRY_SECONDS } from '../../Defaults/index.js';
import { ReachoutTimelockEnforcementType, WAMessageStatus, WAMessageStubType } from '../../Types/index.js';
import { ACCOUNT_RESTRICTED_TEXT, aesDecryptCTR, aesEncryptGCM, cleanMessage, Curve, decodeMediaRetryNode, decodeMessageNode, decryptMessageNode, delay, derivePairingCodeKey, encodeBigEndian, encodeSignedDeviceIdentity, encodeWAMessage, extractAddressingContext, extractE2ESessionFromRetryReceipt, getHistoryMsg, getNextPreKeys, generateMessageID, getStatusFromReceiptType, handleIdentityChange, hkdf, MISSING_KEYS_ERROR_TEXT, NACK_REASONS, NO_MESSAGE_FOUND_ERROR_TEXT, packr, SERVER_ERROR_CODES, toNumber, unixTimestampSeconds, xmppPreKey, xmppSignedPreKey } from '../../Utils/index.js';
import { makeMutex } from '../../Utils/make-mutex.js';
import { makeOfflineNodeProcessor } from '../../Utils/offline-node-processor.js';
import { buildAckStanza } from '../../Utils/stanza-ack.js';
import { buildMergedTcTokenIndexWrite, isTcTokenExpired, readTcTokenIndex, resolveIssuanceJid, resolveTcTokenJid, storeTcTokensFromIqResult, TC_TOKEN_INDEX_KEY } from '../../Utils/tc-token-utils.js';
import { areJidsSameUser, binaryNodeToString, getAllBinaryNodeChildren, getBinaryNodeChild, getBinaryNodeChildBuffer, getBinaryNodeChildren, getBinaryNodeChildString, getBinaryNodeChildUInt, isJidGroup, isJidMetaAI, isJidNewsletter, isJidStatusBroadcast, isLidUser, isPnUser, jidDecode, jidNormalizedUser, S_WHATSAPP_NET } from '../../WABinary/index.js';
import { extractGroupMetadata } from '../groups.js';
import { makeMessagesSocket } from './send.js';
import { makeLockManager } from '../../Utils/lock-manager.js';
import { binaryPack, GroupSession } from '@skidy89/signal-protocol';
import { encodeBinaryNode } from '../../WABinary/index.js';
import { callAck, parseCall, rejectCallNode } from '../features/call/call-events.js';
import { createCallMediaStream } from '../features/call/call-media.js';
import { enableEncodedAudio } from '../features/call/encode-audio.js';
import { queueAudioFile, resolveCallFiles } from '../features/call/media-file.js';
import { buildAccept, buildOffer, buildGroupOffer, acknowledgeOffer, buildPreaccept, buildTerminate, buildVideoState, getCallKey, mediaConfigFromRelay, newCallId } from '../features/call/calls.js';
import { handleServerEncryptNotification } from '../../Utils/server-enc-notifiaction.js';
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const ENFORCEMENT_TYPE_VALUES = new Set(Object.values(ReachoutTimelockEnforcementType));
function isValidEnforcementType(value) {
    return typeof value === 'string' && ENFORCEMENT_TYPE_VALUES.has(value);
}
export const makeMessagesRecvSocket = (config) => {
    const { logger, retryRequestDelayMs, maxMsgRetryCount, getMessage, shouldIgnoreJid, enableAutoSessionRecreation } = config;
    const sock = makeMessagesSocket(config);
    const { userDevicesCache, devicesMutex, ev, authState, ws, messageMutex, notificationMutex, receiptMutex, signalRepository, getUSyncDevices, query, upsertMessage, resyncAppState, onUnexpectedError, assertSessions, sendNode, relayMessage, sendReceipt, uploadPreKeys, sendPeerDataOperationMessage, messageRetryManager, registerSocketEndHandler, issuePrivacyTokens, placeholderResendCache } = sock;
    const getLIDForPN = signalRepository.lidMapping.getLIDForPN.bind(signalRepository.lidMapping);
    const getPNForLID = signalRepository.lidMapping.getPNForLID.bind(signalRepository.lidMapping);
    const callUserMatches = async (jid, expected) => {
        if (areJidsSameUser(jid, expected))
            return true;
        const normalizedJid = jid.replace(/:\d+@/, '@');
        const normalizedExpected = expected.replace(/:\d+@/, '@');
        if (isLidUser(normalizedExpected)) {
            const pn = await getPNForLID(normalizedExpected);
            if (pn && areJidsSameUser(jid, pn))
                return true;
        }
        if (isLidUser(normalizedJid)) {
            const pn = await getPNForLID(normalizedJid);
            if (pn && areJidsSameUser(pn, expected))
                return true;
        }
        return false;
    };
    /** this mutex ensures that each retryRequest will wait for the previous one to finish */
    const retryMutex = makeMutex();
    const msgRetryCache = config.msgRetryCounterCache ||
        new NodeCache({
            stdTTL: DEFAULT_CACHE_TTLS.MSG_RETRY, // 1 hour
            useClones: false
        });
    const callOfferCache = config.callOfferCache ||
        new NodeCache({
            stdTTL: DEFAULT_CACHE_TTLS.CALL_OFFER, // 5 mins
            useClones: false
        });
    const calls = new Map();
    const pendingCallFiles = new WeakMap();
    const lidMigrationLocks = makeLockManager();
    // Debounce identity-change session refreshes per JID to avoid bursts
    const identityAssertDebounce = new NodeCache({ stdTTL: 5, useClones: false });
    let sendActiveReceipts = false;
    const fetchMessageHistory = async (count, oldestMsgKey, oldestMsgTimestamp) => {
        if (!authState.creds.me?.id) {
            throw new Boom('Not authenticated');
        }
        const pdoMessage = {
            historySyncOnDemandRequest: {
                chatJid: oldestMsgKey.remoteJid,
                oldestMsgFromMe: oldestMsgKey.fromMe,
                oldestMsgId: oldestMsgKey.id,
                oldestMsgTimestampMs: oldestMsgTimestamp,
                onDemandMsgCount: count
            },
            peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND
        };
        return sendPeerDataOperationMessage(pdoMessage);
    };
    const requestPlaceholderResend = async (messageKey, msgData) => {
        if (!authState.creds.me?.id) {
            throw new Boom('Not authenticated');
        }
        if (await placeholderResendCache.get(messageKey?.id)) {
            if (logger)
                if (logger)
                    logger.debug({ messageKey }, 'already requested resend');
            return;
        }
        else {
            // Store original message data so PDO response handler can preserve
            // metadata (LID details, timestamps, etc.) that the phone may omit
            await placeholderResendCache.set(messageKey?.id, msgData || true);
        }
        await delay(2000);
        if (!(await placeholderResendCache.get(messageKey?.id))) {
            if (logger)
                if (logger)
                    logger.debug({ messageKey }, 'message received while resend requested');
            return 'RESOLVED';
        }
        const pdoMessage = {
            placeholderMessageResendRequest: [
                {
                    messageKey
                }
            ],
            peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND
        };
        setTimeout(async () => {
            if (await placeholderResendCache.get(messageKey?.id)) {
                if (logger)
                    logger.debug({ messageKey }, 'PDO message without response after 8 seconds. Phone possibly offline');
                await placeholderResendCache.del(messageKey?.id);
            }
        }, 8000);
        return sendPeerDataOperationMessage(pdoMessage);
    };
    const handleMexNotification = async (node) => {
        const updateNode = getBinaryNodeChild(node, 'update');
        if (updateNode) {
            const opName = updateNode.attrs?.op_name;
            if (!opName) {
                if (logger)
                    logger.warn({ node: binaryNodeToString(node) }, 'mex notification missing op_name, fallback to legacy');
                await handleLegacyMexNewsletterNotification(node);
                return;
            }
            let mexResponse;
            try {
                const parsed = JSON.parse(updateNode.content.toString());
                if (!isRecord(parsed))
                    throw new Error('expected an object');
                mexResponse = {
                    ...(isRecord(parsed.data) ? { data: parsed.data } : {}),
                    ...(Array.isArray(parsed.errors) ? { errors: parsed.errors } : {})
                };
            }
            catch (error) {
                if (logger)
                    logger.error({ err: error, opName }, 'failed to parse mex notification JSON');
                return;
            }
            if (mexResponse.errors?.length) {
                if (logger)
                    logger.warn({ errors: mexResponse.errors, opName }, 'mex notification has GQL errors');
                return;
            }
            const data = mexResponse.data;
            if (!data) {
                if (logger)
                    logger.warn({ opName }, 'mex notification has null data');
                return;
            }
            if (logger)
                logger.debug({ opName }, 'processing mex notification');
            switch (opName) {
                case 'NotificationUserReachoutTimelockUpdate':
                    handleReachoutTimelockNotification(data);
                    break;
                case 'NotificationGroupLimitSharingPropertyUpdate':
                    handleGroupLimitSharingPropertyUpdate(updateNode);
                    break;
                case 'MessageCappingInfoNotification':
                    handleMessageCappingNotification(data);
                    break;
                // newsletter ops still use the legacy <mex> child structure
                case 'NotificationNewsletterUpdate':
                case 'NotificationLinkedProfilesUpdates':
                case 'NotificationNewsletterAdminPromote':
                case 'NotificationNewsletterAdminDemote':
                case 'NotificationNewsletterUserSettingChange':
                case 'NotificationNewsletterJoin':
                case 'NotificationNewsletterLeave':
                case 'NotificationNewsletterStateChange':
                case 'NotificationNewsletterAdminMetadataUpdate':
                case 'NotificationNewsletterOwnerUpdate':
                case 'NotificationNewsletterAdminInviteRevoke':
                case 'NotificationNewsletterWamoSubStatusChange':
                case 'NotificationNewsletterBlockUser':
                case 'NotificationNewsletterPaidPartnership':
                case 'NotificationNewsletterMilestone':
                case 'NewsletterResponseStateUpdate':
                    await handleLegacyMexNewsletterNotification(node);
                    break;
                default:
                    if (logger)
                        logger.debug({ opName }, 'unhandled mex notification');
                    break;
            }
            return;
        }
        await handleLegacyMexNewsletterNotification(node);
    };
    const handleGroupLimitSharingPropertyUpdate = (BinaryNode) => {
        // just ack for now
        void sendMessageAck(BinaryNode).catch(err => {
            if (logger)
                logger.error({ err, node: binaryNodeToString(BinaryNode) }, 'failed to send ack for group limit sharing property update');
        });
    };
    const handleReachoutTimelockNotification = (data) => {
        const payload = data.xwa2_notify_account_reachout_timelock;
        if (!payload) {
            if (logger)
                logger.warn('reachout timelock notification missing payload');
            return;
        }
        if (!payload.is_active) {
            if (logger)
                logger.info('reachout timelock restriction lifted');
            ev.emit('connection.update', {
                reachoutTimeLock: {
                    isActive: false,
                    enforcementType: ReachoutTimelockEnforcementType.DEFAULT
                }
            });
            return;
        }
        // WA Web defaults to now+60s when the server omits the expiry
        const timeEnforcementEnds = payload.time_enforcement_ends
            ? new Date(parseInt(payload.time_enforcement_ends, 10) * 1000)
            : new Date(Date.now() + 60000);
        const enforcementType = isValidEnforcementType(payload.enforcement_type)
            ? payload.enforcement_type
            : ReachoutTimelockEnforcementType.DEFAULT;
        if (logger)
            logger.info({ enforcementType, timeEnforcementEnds }, 'reachout timelock restriction set');
        ev.emit('connection.update', {
            reachoutTimeLock: {
                isActive: true,
                timeEnforcementEnds,
                enforcementType
            }
        });
    };
    const handleMessageCappingNotification = (data) => {
        const payload = data.xwa2_notify_new_chat_messages_capping_info_update;
        if (!payload) {
            if (logger)
                logger.warn('message capping notification missing payload');
            return;
        }
        if (logger)
            logger.info({ payload }, 'received message capping update');
        ev.emit('message-capping.update', payload);
    };
    const handleLegacyMexNewsletterNotification = async (node) => {
        const mexNode = getBinaryNodeChild(node, 'mex');
        const updateNode = mexNode?.content ? null : getBinaryNodeChild(node, 'update') || getAllBinaryNodeChildren(node)[0];
        const payloadNode = mexNode?.content ? mexNode : updateNode;
        if (!payloadNode?.content) {
            if (logger)
                logger.warn({ node: binaryNodeToString(node) }, 'invalid mex newsletter notification');
            return;
        }
        let data;
        try {
            const payloadContent = payloadNode.content;
            if (Array.isArray(payloadContent)) {
                if (logger)
                    logger.warn({ payloadNode }, 'invalid mex newsletter notification payload format');
                return;
            }
            const contentBuf = typeof payloadContent === 'string'
                ? Buffer.from(payloadContent, 'binary')
                : Buffer.from(payloadContent.buffer, payloadContent.byteOffset, payloadContent.byteLength);
            const parsed = JSON.parse(contentBuf.toString());
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                if (logger)
                    logger.warn({ payloadNode }, 'invalid mex newsletter notification content');
                return;
            }
            data = parsed;
        }
        catch (error) {
            if (logger)
                logger.error({ err: error, node: binaryNodeToString(node) }, 'failed to parse mex newsletter notification');
            return;
        }
        const operationValue = data.operation ?? payloadNode.attrs.op_name;
        const operation = typeof operationValue === 'string' ? operationValue : undefined;
        let updates = data.updates;
        if (!updates) {
            const nestedData = data.data;
            const linkedProfiles = typeof nestedData === 'object' && nestedData !== null && !Array.isArray(nestedData)
                ? nestedData.xwa2_notify_linked_profiles
                : undefined;
            if (linkedProfiles) {
                updates = [linkedProfiles];
            }
        }
        if (!Array.isArray(updates) || !operation) {
            if (logger)
                logger.warn({ data }, 'invalid mex newsletter notification content');
            return;
        }
        const validUpdates = updates.filter((update) => typeof update === 'object' && update !== null && !Array.isArray(update));
        if (logger)
            logger.info({ operation, updates }, 'got mex newsletter notification');
        switch (operation) {
            case 'NotificationNewsletterUpdate':
                for (const update of validUpdates) {
                    const jid = update.jid;
                    const settings = update.settings;
                    if (typeof jid === 'string' &&
                        typeof settings === 'object' &&
                        settings !== null &&
                        !Array.isArray(settings)) {
                        const settingsRecord = settings;
                        const updateSettings = {
                            ...(typeof settingsRecord.name === 'string' ? { name: settingsRecord.name } : {}),
                            ...(typeof settingsRecord.description === 'string' ? { description: settingsRecord.description } : {})
                        };
                        if (Object.keys(updateSettings).length === 0)
                            continue;
                        ev.emit('newsletter-settings.update', {
                            id: jid,
                            update: updateSettings
                        });
                    }
                }
                break;
            case 'NotificationNewsletterAdminPromote':
                for (const update of validUpdates) {
                    if (typeof update.jid === 'string' && typeof update.user === 'string') {
                        ev.emit('newsletter-participants.update', {
                            id: update.jid,
                            author: node.attrs.from,
                            user: update.user,
                            new_role: 'ADMIN',
                            action: 'promote'
                        });
                    }
                }
                break;
            case 'NotificationLinkedProfilesUpdates':
                for (const update of validUpdates) {
                    const lid = typeof update.jid === 'string' ? update.jid : undefined;
                    const addedProfiles = Array.isArray(update.added_profiles) ? update.added_profiles : [];
                    const mappings = [];
                    for (const profile of addedProfiles) {
                        const profileRecord = typeof profile === 'object' && profile !== null ? profile : undefined;
                        const pn = typeof profile === 'string'
                            ? profile
                            : typeof profileRecord?.pn === 'string'
                                ? profileRecord.pn
                                : typeof profileRecord?.jid === 'string'
                                    ? profileRecord.jid
                                    : undefined;
                        if (lid && pn) {
                            const mapping = { lid, pn };
                            ev.emit('lid-mapping.update', mapping);
                            mappings.push(mapping);
                        }
                    }
                    await signalRepository.lidMapping.storeLIDPNMappings(mappings);
                }
                break;
            default:
                if (logger)
                    logger.info({ operation, data }, 'unhandled mex newsletter notification');
                break;
        }
    };
    // Handles newsletter notifications
    const handleNewsletterNotification = async (node) => {
        const from = node.attrs.from;
        const children = getAllBinaryNodeChildren(node);
        const author = node.attrs.participant;
        for (const child of children) {
            if (logger)
                logger.debug({ from, child }, 'got newsletter notification');
            switch (child.tag) {
                case 'reaction': {
                    const reactionUpdate = {
                        id: from,
                        server_id: child.attrs.message_id,
                        reaction: {
                            code: getBinaryNodeChildString(child, 'reaction'),
                            count: 1
                        }
                    };
                    ev.emit('newsletter.reaction', reactionUpdate);
                    break;
                }
                case 'view': {
                    const viewUpdate = {
                        id: from,
                        server_id: child.attrs.message_id,
                        count: parseInt(child.content?.toString() || '0', 10)
                    };
                    ev.emit('newsletter.view', viewUpdate);
                    break;
                }
                case 'participant': {
                    const participantUpdate = {
                        id: from,
                        author,
                        user: child.attrs.jid,
                        action: child.attrs.action,
                        new_role: child.attrs.role
                    };
                    ev.emit('newsletter-participants.update', participantUpdate);
                    break;
                }
                case 'update': {
                    const settingsNode = getBinaryNodeChild(child, 'settings');
                    if (settingsNode) {
                        const update = {};
                        const nameNode = getBinaryNodeChild(settingsNode, 'name');
                        if (nameNode?.content)
                            update.name = nameNode.content.toString();
                        const descriptionNode = getBinaryNodeChild(settingsNode, 'description');
                        if (descriptionNode?.content)
                            update.description = descriptionNode.content.toString();
                        ev.emit('newsletter-settings.update', {
                            id: from,
                            update
                        });
                    }
                    break;
                }
                case 'message': {
                    const plaintextNode = getBinaryNodeChild(child, 'plaintext');
                    if (plaintextNode?.content) {
                        try {
                            const contentBuf = typeof plaintextNode.content === 'string'
                                ? Buffer.from(plaintextNode.content, 'binary')
                                : Buffer.from(plaintextNode.content.buffer, plaintextNode.content.byteOffset, plaintextNode.content.byteLength);
                            const messageProto = proto.Message.decode(contentBuf).toJSON();
                            const fullMessage = proto.WebMessageInfo.fromObject({
                                key: {
                                    remoteJid: from,
                                    id: child.attrs.message_id || child.attrs.server_id,
                                    fromMe: false // TODO: is this really true though
                                },
                                message: messageProto,
                                messageTimestamp: +child.attrs.t
                            }).toJSON();
                            await upsertMessage(fullMessage, 'append');
                            if (logger)
                                logger.debug('Processed plaintext newsletter message');
                        }
                        catch (error) {
                            if (logger)
                                logger.error({ error }, 'Failed to decode plaintext newsletter message');
                        }
                    }
                    break;
                }
                default:
                    if (logger)
                        logger.warn({ node, child }, 'Unknown newsletter notification child');
                    break;
            }
        }
    };
    const sendMessageAck = async (node, errorCode) => {
        const stanza = buildAckStanza(node, errorCode, authState.creds.me.id);
        if (logger)
            logger.debug({ recv: { tag: node.tag, attrs: node.attrs }, sent: stanza.attrs }, 'sent ack');
        await sendNode(stanza);
    };
    const logCall = (callId, state, enc) => logger?.info({ callId, state, timestamp: Date.now(), enc }, 'call signaling');
    const finishCall = (call) => {
        call.status = 'ended';
        clearInterval(call.heartbeat);
        calls.delete(call.callId);
        pendingCallFiles.delete(call);
        call.media?.destroy();
        call.callKey?.fill(0);
    };
    const applyCallFiles = async (call, files) => {
        if (!call.media)
            return;
        if (files.opusFile)
            call.media.playOpusFile(files.opusFile);
        else if (files.audioIn)
            call.media.speak(files.audioIn, true);
        if (files.videoFrames) {
            if (!call.media.startVideoFrames(files.videoFrames, files.videoFps))
                throw new Boom('Could not start video file playback');
            const to = call.peerDevice || call.offerFrom || call.peer;
            await sendNode(buildVideoState(call.callId, to, call.creator, generateMessageID(), 11, { dec: 'H264', orientation: 0 }));
        }
    };
    async function startCall(to, options = {}) {
        const ownLid = authState.creds.me?.lid;
        if (!ownLid)
            throw new Boom('Cannot place a call before the account LID is available');
        let peer = to.replace(/:\d+@/, '@');
        if (!isLidUser(peer)) {
            await getUSyncDevices([peer], false, false);
            const lid = await getLIDForPN(peer);
            if (!lid)
                throw new Boom(`No LID is known for ${to}`);
            peer = lid;
        }
        const devices = await getUSyncDevices([peer], false, false);
        if (!devices.length)
            throw new Boom(`No call devices found for ${peer}`);
        const files = await resolveCallFiles(options);
        const deviceJids = devices.map(device => device.jid);
        await assertSessions(deviceJids);
        const callKey = randomBytes(32);
        const clearKey = encodeWAMessage({ call: { callKey } });
        let encrypted;
        try {
            encrypted = await Promise.all(devices.map(async (device) => ({
                jid: device.jid,
                ...(await signalRepository.encryptMessage({ jid: device.jid, data: clearKey }))
            })));
        }
        catch (error) {
            clearKey.fill(0);
            callKey.fill(0);
            throw error;
        }
        clearKey.fill(0);
        const callId = newCallId();
        const offer = buildOffer({
            callId,
            to: peer,
            creator: ownLid,
            id: generateMessageID(),
            video: !!(options.video || options.videoFile),
            keys: encrypted,
            ...(encrypted.some(key => key.type === 'pkmsg') &&
                authState.creds.account && {
                deviceIdentity: encodeSignedDeviceIdentity(authState.creds.account, true)
            })
        });
        const call = {
            callId,
            peer,
            creator: ownLid,
            direction: 'outgoing',
            video: !!(options.video || options.videoFile),
            devices: deviceJids,
            status: 'offer_sent',
            startedAt: Date.now(),
            callKey
        };
        calls.set(callId, call);
        try {
            logCall(callId, 'offer_sent', encrypted.map(key => key.type));
            const ack = await query(offer, 20000);
            if (!calls.has(callId))
                throw new Boom('Call ended before offer acknowledgement');
            acknowledgeOffer(call, ack, offer.attrs.id);
            logCall(callId, 'server_ack');
            const relay = getBinaryNodeChild(ack, 'relay');
            if (!relay)
                return options.encodedAudio ? enableEncodedAudio(call, pendingCallFiles) : call;
            call.relay = relay;
            const media = createCallMediaStream(mediaConfigFromRelay(relay, callId, 'outgoing', ownLid, peer, callKey, call.video), { logger });
            call.media = media;
            if (call.peerDevice)
                media.rekeyRecv(call.peerDevice);
            media.on('media-event', event => {
                if (!event.startsWith('RtcpReceived'))
                    logger?.debug({ callId, event }, 'call media event');
            });
            media.on('error', error => logger?.error({ err: error, callId }, 'call media transport failed'));
            if (call.status === 'connected')
                await applyCallFiles(call, files);
            else if (options.audioFile || options.videoFile)
                pendingCallFiles.set(call, files);
            return options.encodedAudio ? enableEncodedAudio(call, pendingCallFiles) : call;
        }
        catch (error) {
            finishCall(call);
            calls.delete(callId);
            throw error;
        }
    }
    const offerCall = async (jid, { video = false } = {}) => {
        if (!isJidGroup(jid)) {
            const { callId } = await startCall(jid, { video });
            return { callId };
        }
        const creator = authState.creds.me?.lid;
        if (!creator)
            throw new Boom('Missing own LID');
        const own = jidNormalizedUser(creator);
        const roster = new Map([[own, [creator]]]);
        const metadata = await sock.groupMetadata(jid);
        for (const participant of metadata.participants) {
            const user = jidNormalizedUser(participant.id);
            const lid = participant.lid || (isLidUser(user) ? user : await getLIDForPN(user));
            if (!lid)
                throw new Boom('Missing group participant LID');
            if (!roster.has(lid))
                roster.set(lid, []);
        }
        const peers = [...roster.keys()].filter(user => user !== own);
        if (!peers.length || roster.size > 32)
            throw new Boom('Invalid group call roster size');
        for (const device of await getUSyncDevices(peers, false, false)) {
            if (device.device !== 99)
                roster.get(jidNormalizedUser(device.jid))?.push(device.jid);
        }
        if ([...roster.values()].some(devices => !devices.length))
            throw new Boom('Incomplete group device roster');
        const callId = newCallId();
        const session = new GroupSession(callId, creator, creator);
        const call = {
            callId,
            creator,
            group: jid,
            peer: jid,
            groupSession: session,
            devices: peers.flatMap(user => roster.get(user)),
            direction: 'outgoing',
            status: 'offer_sent',
            video,
            startedAt: Date.now()
        };
        const to = callId + '@call';
        calls.set(callId, call);
        try {
            logCall(callId, 'offer_sent');
            const offer = buildGroupOffer(callId, generateMessageID(), creator, jid, roster, video);
            const ack = await query(offer, 20000);
            if (!calls.has(callId))
                throw new Boom('Group call ended before acknowledgement');
            acknowledgeOffer(call, ack, offer.attrs.id);
            logCall(callId, 'server_ack');
            session.applyAck(binaryPack(encodeBinaryNode(ack)));
            const beat = () => void sendNode({
                tag: 'call',
                attrs: { to, id: generateMessageID() },
                content: [{ tag: 'heartbeat', attrs: { 'call-id': callId, 'call-creator': creator } }]
            }).catch(() => logger?.debug({ callId }, 'group heartbeat failed'));
            beat();
            call.heartbeat = setInterval(beat, 10000).unref();
            return { callId };
        }
        catch (err) {
            if (call.status !== 'offer_sent' && calls.has(callId))
                await sendNode(buildTerminate(callId, to, creator, generateMessageID())).catch(() => { });
            finishCall(call);
            throw err;
        }
    };
    const acceptCall = async (callId, options = {}) => {
        const call = calls.get(callId);
        if (!call || call.direction !== 'incoming' || !call.offer)
            throw new Boom(`No incoming call offer ${callId}`);
        if (call.lightweight)
            throw new Boom('Silent group calls cannot be answered from a companion device');
        if (options.videoFile && !call.video)
            throw new Boom('Cannot send a video file in an audio-only call');
        const own = authState.creds.me;
        if (!own?.lid)
            throw new Boom('Cannot answer a call before the account LID is available');
        const action = Array.isArray(call.offer.content) ? call.offer.content[0] : undefined;
        if (!action)
            throw new Boom('The call offer has no action node');
        const content = Array.isArray(action.content) ? action.content : [];
        let enc = content.find(child => child.tag === 'enc');
        if (!enc) {
            const destination = content.find(child => child.tag === 'destination');
            const device = getBinaryNodeChildren(destination, 'to').find(child => [own.id, own.lid].includes(child.attrs.jid || ''));
            enc = getBinaryNodeChildren(device, 'enc')[0];
        }
        const relay = getBinaryNodeChild(action, 'relay');
        if (!enc || !relay)
            throw new Boom('The incoming call offer is missing this device key or its relay');
        const from = call.offerFrom || call.creator;
        const preaccept = buildPreaccept(callId, from, call.creator, generateMessageID(), call.video);
        await sendNode(preaccept);
        const files = await resolveCallFiles(options);
        const callKey = await getCallKey(signalRepository.decryptMessage.bind(signalRepository), call.creator, enc);
        try {
            const media = createCallMediaStream(mediaConfigFromRelay(relay, callId, 'incoming', own.lid, call.peer, callKey, call.video));
            media.on('media-event', event => {
                if (!event.startsWith('RtcpReceived'))
                    logger?.debug({ callId, event }, 'call media event');
            });
            media.on('error', error => logger?.error({ err: error, callId }, 'call media transport failed'));
            call.callKey = callKey;
            call.relay = relay;
            call.media = media;
            await sendNode(buildAccept(callId, from, call.creator, generateMessageID(), call.video));
            call.status = 'connected';
            await applyCallFiles(call, files);
            return call;
        }
        catch (error) {
            finishCall(call);
            throw error;
        }
    };
    const rejectCall = async (callId, callFrom = '') => {
        const call = calls.get(callId);
        const to = call?.offerFrom || callFrom;
        if (!to)
            throw new Boom(`Unknown incoming call ${callId}`);
        await query(rejectCallNode(callId, to, call?.creator || callFrom, generateMessageID()));
        if (call) {
            logCall(callId, 'reject');
            finishCall(call);
        }
    };
    const terminateCall = async (callId, callTo, creator) => {
        if (!creator) {
            const active = calls.get(callId);
            if (!active || (active.peer !== callTo && !(await callUserMatches(active.peer, callTo))))
                throw new Boom('Unknown call destination');
            return endCall(callId);
        }
        await query(buildTerminate(callId, callTo, creator, generateMessageID()));
        const call = calls.get(callId);
        if (call)
            finishCall(call);
    };
    const endCall = async (callId) => {
        const call = calls.get(callId);
        if (!call)
            throw new Boom(`Unknown call ${callId}`);
        try {
            if (call.groupSession) {
                const duration = String(Math.max(0, Date.now() - call.startedAt));
                const attrs = { 'call-id': callId, 'call-creator': call.creator, audio_duration: duration };
                await sendNode({
                    tag: 'call',
                    attrs: { to: callId + '@call', id: generateMessageID() },
                    content: [{ tag: 'terminate', attrs: { ...attrs, duration } }]
                });
                await sendNode({
                    tag: 'call',
                    attrs: { to: 'call', id: generateMessageID() },
                    content: [{ tag: 'group_call_duration', attrs: { ...attrs, type: 'group' } }]
                });
            }
            else {
                for (const device of call.devices)
                    await sendNode(buildTerminate(callId, device, call.creator, generateMessageID()));
            }
            logCall(callId, 'terminate');
        }
        finally {
            finishCall(call);
        }
    };
    const enableCamera = async (callId, frames, fps = 15) => {
        const call = calls.get(callId);
        if (!call?.media || !frames.length)
            throw new Boom(`Call ${callId} has no media stream or video frames`);
        if (!call.media.startVideoFrames(frames, fps, true))
            throw new Boom('This call did not negotiate video');
        const to = call.peerDevice || call.offerFrom || call.peer;
        await sendNode(buildVideoState(callId, to, call.creator, generateMessageID(), 11, { dec: 'H264', orientation: 0 }));
    };
    const disableCamera = async (callId) => {
        const call = calls.get(callId);
        if (!call?.media)
            throw new Boom(`Call ${callId} has no media stream`);
        call.media.stopVideo();
        const to = call.peerDevice || call.offerFrom || call.peer;
        await sendNode(buildVideoState(callId, to, call.creator, generateMessageID(), 6));
    };
    const acceptVideoUpgrade = async (callId, frames, fps = 15) => {
        const call = calls.get(callId);
        if (!call?.media || !call.videoRequest)
            throw new Boom(`Call ${callId} has no pending video request`);
        if (frames?.length)
            call.media.startVideoFrames(frames, fps);
        else if (!call.media.enableVideo())
            throw new Boom('This call cannot enable video');
        const to = call.peerDevice || call.offerFrom || call.peer;
        await sendNode(buildVideoState(callId, to, call.creator, generateMessageID(), 4, { dec: 'H264,AV1', orientation: 0 }));
        call.videoRequest = false;
    };
    const rejectVideoUpgrade = async (callId) => {
        const call = calls.get(callId);
        if (!call?.videoRequest)
            throw new Boom(`Call ${callId} has no pending video request`);
        const to = call.peerDevice || call.offerFrom || call.peer;
        await sendNode(buildVideoState(callId, to, call.creator, generateMessageID(), 5));
        call.videoRequest = false;
    };
    const playInCall = (callId, pcm, replace = false) => {
        const media = calls.get(callId)?.media;
        if (!media)
            throw new Boom(`Call ${callId} has no media stream`);
        media.speak(pcm, replace);
    };
    const queueAudioFileInCall = (callId, path, options) => {
        const media = calls.get(callId)?.media;
        if (!media)
            throw new Boom(`Call ${callId} has no media stream`);
        return queueAudioFile(media, path, options);
    };
    const setCallVolume = (callId, gain) => {
        const media = calls.get(callId)?.media;
        if (!media)
            throw new Boom(`Call ${callId} has no media stream`);
        media.setVolume(gain);
    };
    const pauseCallMedia = (callId) => {
        const media = calls.get(callId)?.media;
        if (!media)
            throw new Boom(`Call ${callId} has no media stream`);
        media.pauseMedia();
    };
    const resumeCallMedia = (callId) => {
        const media = calls.get(callId)?.media;
        if (!media)
            throw new Boom(`Call ${callId} has no media stream`);
        media.resumeMedia();
    };
    const sendRetryRequest = async (node, forceIncludeKeys = false) => {
        const { fullMessage } = decodeMessageNode(node, authState.creds.me.id, authState.creds.me.lid || '');
        const { key: msgKey } = fullMessage;
        const msgId = msgKey.id;
        if (messageRetryManager) {
            // Check if we've exceeded max retries using the new system
            if (messageRetryManager.hasExceededMaxRetries(msgId)) {
                if (logger)
                    logger.debug({ msgId }, 'reached retry limit with new retry manager, clearing');
                messageRetryManager.markRetryFailed(msgId);
                return;
            }
            // Increment retry count using new system
            const retryCount = messageRetryManager.incrementRetryCount(msgId);
            // Use the new retry count for the rest of the logic
            const key = `${msgId}:${msgKey?.participant}`;
            await msgRetryCache.set(key, retryCount);
        }
        else {
            // Fallback to old system
            const key = `${msgId}:${msgKey?.participant}`;
            let retryCount = (await msgRetryCache.get(key)) || 0;
            if (retryCount >= maxMsgRetryCount) {
                if (logger)
                    logger.debug({ retryCount, msgId }, 'reached retry limit, clearing');
                await msgRetryCache.del(key);
                return;
            }
            retryCount += 1;
            await msgRetryCache.set(key, retryCount);
        }
        const key = `${msgId}:${msgKey?.participant}`;
        const retryCount = (await msgRetryCache.get(key)) || 1;
        const { account, signedPreKey, signedIdentityKey: identityKey } = authState.creds;
        const fromJid = node.attrs.from;
        // Check if we should recreate the session
        let shouldRecreateSession = false;
        let recreateReason = '';
        if (enableAutoSessionRecreation && messageRetryManager && retryCount > 1) {
            try {
                // Check if we have a session with this JID
                const sessionId = signalRepository.jidToSignalProtocolAddress(fromJid);
                const hasSession = await signalRepository.validateSession(fromJid);
                const result = messageRetryManager.shouldRecreateSession(fromJid, hasSession.exists);
                shouldRecreateSession = result.recreate;
                recreateReason = result.reason;
                if (shouldRecreateSession) {
                    if (logger)
                        logger.debug({ fromJid, retryCount, reason: recreateReason }, 'recreating session for retry');
                    // Delete existing session to force recreation
                    await authState.keys.set({ session: { [sessionId]: null } });
                    forceIncludeKeys = true;
                }
            }
            catch (error) {
                if (logger)
                    logger.warn({ error, fromJid }, 'failed to check session recreation');
            }
        }
        if (retryCount <= 2) {
            // Use new retry manager for phone requests if available
            if (messageRetryManager) {
                // Schedule phone request with delay (like whatsmeow)
                messageRetryManager.schedulePhoneRequest(msgId, async () => {
                    try {
                        const requestId = await requestPlaceholderResend(msgKey);
                        if (logger)
                            logger.debug(`sendRetryRequest: requested placeholder resend (${requestId}) for message ${msgId} (scheduled)`);
                    }
                    catch (error) {
                        if (logger)
                            logger.warn({ error, msgId }, 'failed to send scheduled phone request');
                    }
                });
            }
            else {
                // Fallback to immediate request
                const msgId = await requestPlaceholderResend(msgKey);
                if (logger)
                    logger.debug(`sendRetryRequest: requested placeholder resend for message ${msgId}`);
            }
        }
        const deviceIdentity = encodeSignedDeviceIdentity(account, true);
        await authState.keys.transaction(async () => {
            const receipt = {
                tag: 'receipt',
                attrs: {
                    id: msgId,
                    type: 'retry',
                    to: node.attrs.from
                },
                content: [
                    {
                        tag: 'retry',
                        attrs: {
                            count: retryCount.toString(),
                            id: node.attrs.id,
                            t: node.attrs.t,
                            v: '1',
                            // ADD ERROR FIELD
                            error: '0'
                        }
                    },
                    {
                        tag: 'registration',
                        attrs: {},
                        content: encodeBigEndian(authState.creds.registrationId)
                    }
                ]
            };
            if (node.attrs.recipient) {
                receipt.attrs.recipient = node.attrs.recipient;
            }
            if (node.attrs.participant) {
                receipt.attrs.participant = node.attrs.participant;
            }
            if (retryCount > 1 || forceIncludeKeys || shouldRecreateSession) {
                const { update, preKeys } = await getNextPreKeys(authState, 1);
                const [keyId] = Object.keys(preKeys);
                const key = preKeys[+keyId];
                const content = receipt.content;
                content.push({
                    tag: 'keys',
                    attrs: {},
                    content: [
                        { tag: 'type', attrs: {}, content: Buffer.from(KEY_BUNDLE_TYPE) },
                        { tag: 'identity', attrs: {}, content: identityKey.public },
                        xmppPreKey(key, +keyId),
                        xmppSignedPreKey(signedPreKey),
                        { tag: 'device-identity', attrs: {}, content: deviceIdentity }
                    ]
                });
                ev.emit('creds.update', update);
            }
            await sendNode(receipt);
            if (logger)
                logger.info({ msgAttrs: node.attrs, retryCount }, 'sent retry receipt');
        }, authState?.creds?.me?.id || 'sendRetryRequest');
    };
    // Mirrors WAWeb/Handle/PreKeyLow.js: skip a re-issued notification with the same stanza id.
    const inFlightPreKeyLow = new Set();
    /**
     * Fire-and-forget tctoken re-issuance after a peer's device identity changed.
     * Mirrors WAWebSendTcTokenWhenDeviceIdentityChange — runs in parallel with
     * the session refresh (not after it).
     */
    const reissueTcTokenAfterIdentityChange = (from) => {
        void (async () => {
            const normalizedJid = jidNormalizedUser(from);
            const tcJid = await resolveTcTokenJid(normalizedJid, getLIDForPN);
            const tcTokenData = await authState.keys.get('tctoken', [tcJid]);
            const senderTs = tcTokenData?.[tcJid]?.senderTimestamp;
            if (senderTs === null || senderTs === undefined || isTcTokenExpired(senderTs)) {
                return;
            }
            if (logger)
                logger.debug({ jid: normalizedJid, senderTimestamp: senderTs }, 'identity changed, re-issuing tctoken');
            const getPNForLID = signalRepository.lidMapping.getPNForLID.bind(signalRepository.lidMapping);
            const issueJid = await resolveIssuanceJid(normalizedJid, sock.serverProps.lidTrustedTokenIssueToLid, getLIDForPN, getPNForLID);
            const result = await issuePrivacyTokens([issueJid], senderTs);
            await storeTcTokensFromIqResult({
                result,
                fallbackJid: tcJid,
                keys: authState.keys,
                getLIDForPN,
                onNewJidStored: trackTcTokenJid
            });
        })().catch(err => {
            if (logger)
                logger.debug({ jid: from, err: err?.message }, 'failed to re-issue tctoken after identity change');
        });
    };
    const handleEncryptNotification = async (node) => {
        const from = node.attrs.from;
        if (from === S_WHATSAPP_NET) {
            await handleServerEncryptNotification(node, { query, uploadPreKeys, inFlightPreKeyLow, logger });
        }
        else {
            const result = await handleIdentityChange(node, {
                meId: authState.creds.me?.id,
                meLid: authState.creds.me?.lid,
                validateSession: signalRepository.validateSession,
                assertSessions,
                debounceCache: identityAssertDebounce,
                logger,
                onBeforeSessionRefresh: reissueTcTokenAfterIdentityChange
            });
            if (result.action === 'no_identity_node') {
                if (logger)
                    logger.info({ node }, 'unknown encrypt notification');
            }
        }
    };
    const handleGroupNotification = async (fullNode, child, msg) => {
        // TODO: Support PN/LID (Here is only LID now)
        const actingParticipantLid = fullNode.attrs.participant;
        const actingParticipantPn = fullNode.attrs.participant_pn;
        const actingParticipantUsername = fullNode.attrs.participant_username;
        const affectedParticipantLid = getBinaryNodeChild(child, 'participant')?.attrs?.jid || actingParticipantLid;
        const affectedParticipantPn = getBinaryNodeChild(child, 'participant')?.attrs?.phone_number || actingParticipantPn;
        switch (child?.tag) {
            case 'create':
                const metadata = extractGroupMetadata(child);
                msg.messageStubType = WAMessageStubType.GROUP_CREATE;
                msg.messageStubParameters = [metadata.subject];
                msg.key = { participant: metadata.owner, participantAlt: metadata.ownerPn };
                ev.emit('chats.upsert', [
                    {
                        id: metadata.id,
                        name: metadata.subject,
                        conversationTimestamp: metadata.creation
                    }
                ]);
                ev.emit('groups.upsert', [
                    {
                        ...metadata,
                        author: actingParticipantLid,
                        authorPn: actingParticipantPn,
                        authorUsername: actingParticipantUsername
                    }
                ]);
                break;
            case 'ephemeral':
            case 'not_ephemeral':
                msg.message = {
                    protocolMessage: {
                        type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
                        ephemeralExpiration: +(child.attrs.expiration || 0)
                    }
                };
                break;
            case 'modify':
                const oldNumber = getBinaryNodeChildren(child, 'participant').map(p => p.attrs.jid);
                msg.messageStubParameters = oldNumber || [];
                msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_CHANGE_NUMBER;
                break;
            case 'promote':
            case 'demote':
            case 'remove':
            case 'add':
                const stubType = `GROUP_PARTICIPANT_${child.tag.toUpperCase()}`;
                msg.messageStubType = WAMessageStubType[stubType];
                const participants = getBinaryNodeChildren(child, 'participant').map(({ attrs }) => {
                    return {
                        id: attrs.jid,
                        phoneNumber: isLidUser(attrs.jid) && isPnUser(attrs.phone_number) ? attrs.phone_number : undefined,
                        lid: isPnUser(attrs.jid) && isLidUser(attrs.lid) ? attrs.lid : undefined,
                        username: attrs.participant_username || attrs.username || undefined,
                        admin: (attrs.type || null)
                    };
                });
                const lidMappings = [];
                for (const p of participants) {
                    if (p.phoneNumber)
                        lidMappings.push({ lid: p.id, pn: p.phoneNumber });
                    else if (p.lid)
                        lidMappings.push({ lid: p.lid, pn: p.id });
                }
                if (actingParticipantLid &&
                    actingParticipantPn &&
                    isLidUser(actingParticipantLid) &&
                    isPnUser(actingParticipantPn)) {
                    lidMappings.push({ lid: actingParticipantLid, pn: actingParticipantPn });
                }
                if (lidMappings.length) {
                    await sock.signalRepository.lidMapping
                        .storeLIDPNMappings(lidMappings)
                        .catch(err => logger?.warn({ err }, 'failed to store LID mappings from group notification'));
                }
                if (participants.length === 1 &&
                    // if recv. "remove" message and sender removed themselves
                    // mark as left
                    (areJidsSameUser(participants[0].id, actingParticipantLid) ||
                        areJidsSameUser(participants[0].id, actingParticipantPn)) &&
                    child.tag === 'remove') {
                    msg.messageStubType = WAMessageStubType.GROUP_PARTICIPANT_LEAVE;
                }
                msg.messageStubParameters = participants.map(a => JSON.stringify(a));
                break;
            case 'subject':
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_SUBJECT;
                msg.messageStubParameters = [child.attrs.subject];
                break;
            case 'description':
                const description = getBinaryNodeChild(child, 'body')?.content?.toString();
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_DESCRIPTION;
                msg.messageStubParameters = description ? [description] : undefined;
                break;
            case 'announcement':
            case 'not_announcement':
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_ANNOUNCE;
                msg.messageStubParameters = [child.tag === 'announcement' ? 'on' : 'off'];
                break;
            case 'locked':
            case 'unlocked':
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_RESTRICT;
                msg.messageStubParameters = [child.tag === 'locked' ? 'on' : 'off'];
                break;
            case 'invite':
                msg.messageStubType = WAMessageStubType.GROUP_CHANGE_INVITE_LINK;
                msg.messageStubParameters = [child.attrs.code];
                break;
            case 'member_add_mode':
                const addMode = child.content;
                if (addMode) {
                    msg.messageStubType = WAMessageStubType.GROUP_MEMBER_ADD_MODE;
                    msg.messageStubParameters = [addMode.toString()];
                }
                break;
            case 'membership_approval_mode':
                const approvalMode = getBinaryNodeChild(child, 'group_join');
                if (approvalMode) {
                    msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_MODE;
                    msg.messageStubParameters = [approvalMode.attrs.state];
                }
                break;
            case 'created_membership_requests':
                msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD;
                msg.messageStubParameters = [
                    JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }),
                    'created',
                    child.attrs.request_method
                ];
                break;
            case 'revoked_membership_requests':
                const isDenied = areJidsSameUser(affectedParticipantLid, actingParticipantLid);
                await sock.signalRepository.lidMapping.storeLIDPNMappings([
                    { lid: affectedParticipantLid, pn: affectedParticipantPn }
                ]);
                msg.messageStubType = WAMessageStubType.GROUP_MEMBERSHIP_JOIN_APPROVAL_REQUEST_NON_ADMIN_ADD;
                msg.messageStubParameters = [
                    JSON.stringify({ lid: affectedParticipantLid, pn: affectedParticipantPn }),
                    isDenied ? 'revoked' : 'rejected'
                ];
                break;
        }
    };
    const handleDevicesNotification = async (node) => {
        const [child] = getAllBinaryNodeChildren(node);
        const from = jidNormalizedUser(node.attrs.from);
        if (!child) {
            if (logger)
                logger.debug({ from }, 'devices notification missing child, skipping');
            return;
        }
        const tag = child.tag;
        const deviceHash = child.attrs.device_hash;
        const devices = getBinaryNodeChildren(child, 'device');
        if (areJidsSameUser(from, authState.creds.me.id) || areJidsSameUser(from, authState.creds.me.lid)) {
            const deviceJids = devices.map(d => d.attrs.jid);
            if (logger)
                logger.info({ deviceJids }, 'got my own devices');
        }
        if (!devices.length) {
            if (logger)
                logger.debug({ from, tag }, 'no devices in notification, skipping');
            return;
        }
        const decoded = [];
        for (const d of devices) {
            const jid = d.attrs.jid;
            if (!jid)
                continue;
            const parts = jidDecode(jid);
            if (!parts) {
                if (logger)
                    logger.debug({ jid }, 'failed to decode device jid, skipping');
                continue;
            }
            decoded.push({ jid, user: parts.user, server: parts.server, device: parts.device });
        }
        if (!decoded.length)
            return;
        await devicesMutex.mutex(async () => {
            const byUser = new Map();
            for (const d of decoded) {
                const list = byUser.get(d.user) || [];
                list.push(d);
                byUser.set(d.user, list);
            }
            for (const [user, entries] of byUser) {
                if (tag === 'update') {
                    if (logger)
                        logger.debug({ user }, `${user}'s device list updated, dropping cached devices`);
                    await userDevicesCache?.del(user);
                    continue;
                }
                if (tag === 'remove') {
                    await signalRepository.deleteSession(entries.map(e => e.jid));
                }
                const existingCache = (await userDevicesCache?.get(user)) || [];
                if (!existingCache.length) {
                    // No baseline yet; skip applying the delta so getUSyncDevices can
                    // later fetch the full device list. Caching just the notification
                    // entries would make a partial list look authoritative.
                    if (logger)
                        logger.debug({ user, tag }, 'device list not cached, deferring to USync refresh');
                    continue;
                }
                const affected = new Set(entries.map(e => e.device));
                let updatedDevices;
                switch (tag) {
                    case 'add':
                        if (logger)
                            logger.info({ deviceHash, count: entries.length }, 'devices added');
                        updatedDevices = [
                            ...existingCache.filter(d => !affected.has(d.device)),
                            ...entries.map(e => ({ user: e.user, server: e.server, device: e.device }))
                        ];
                        break;
                    case 'remove':
                        if (logger)
                            logger.info({ deviceHash, count: entries.length }, 'devices removed');
                        updatedDevices = existingCache.filter(d => !affected.has(d.device));
                        break;
                    default:
                        if (logger)
                            logger.debug({ tag }, 'Unknown device list change tag');
                        continue;
                }
                if (updatedDevices.length === 0) {
                    await userDevicesCache?.del(user);
                }
                else {
                    await userDevicesCache?.set(user, updatedDevices);
                }
            }
        });
    };
    const processNotification = async (node) => {
        const result = {};
        const [child] = getAllBinaryNodeChildren(node);
        const nodeType = node.attrs.type;
        const from = jidNormalizedUser(node.attrs.from);
        switch (nodeType) {
            case 'newsletter':
                await handleNewsletterNotification(node);
                break;
            case 'mex':
                await handleMexNotification(node);
                break;
            case 'w:gp2':
                // TODO: HANDLE PARTICIPANT_PN
                await handleGroupNotification(node, child, result);
                break;
            case 'mediaretry':
                const event = decodeMediaRetryNode(node);
                ev.emit('messages.media-update', [event]);
                break;
            case 'encrypt':
                await handleEncryptNotification(node);
                break;
            case 'devices':
                try {
                    await handleDevicesNotification(node);
                }
                catch (error) {
                    if (logger)
                        logger.error({ error, node }, 'failed to handle devices notification');
                }
                break;
            case 'server_sync':
                const update = getBinaryNodeChild(node, 'collection');
                if (update) {
                    const name = update.attrs.name;
                    await resyncAppState([name], false);
                }
                break;
            case 'picture':
                const setPicture = getBinaryNodeChild(node, 'set');
                const delPicture = getBinaryNodeChild(node, 'delete');
                // TODO: WAJIDHASH stuff proper support inhouse
                ev.emit('contacts.update', [
                    {
                        id: jidNormalizedUser(node?.attrs?.from) || (setPicture || delPicture)?.attrs?.hash || '',
                        imgUrl: setPicture ? 'changed' : 'removed'
                    }
                ]);
                if (isJidGroup(from)) {
                    const node = setPicture || delPicture;
                    result.messageStubType = WAMessageStubType.GROUP_CHANGE_ICON;
                    if (setPicture) {
                        result.messageStubParameters = [setPicture.attrs.id];
                    }
                    result.participant = node?.attrs.author;
                    result.key = {
                        ...(result.key || {}),
                        participant: setPicture?.attrs.author
                    };
                }
                break;
            case 'account_sync':
                if (child.tag === 'disappearing_mode') {
                    const newDuration = +child.attrs.duration;
                    const timestamp = +child.attrs.t;
                    if (logger)
                        logger.info({ newDuration }, 'updated account disappearing mode');
                    ev.emit('creds.update', {
                        accountSettings: {
                            ...authState.creds.accountSettings,
                            defaultDisappearingMode: {
                                ephemeralExpiration: newDuration,
                                ephemeralSettingTimestamp: timestamp
                            }
                        }
                    });
                }
                else if (child.tag === 'blocklist') {
                    const blocklists = getBinaryNodeChildren(child, 'item');
                    for (const { attrs } of blocklists) {
                        const blocklist = [attrs.jid];
                        const type = attrs.action === 'block' ? 'add' : 'remove';
                        ev.emit('blocklist.update', { blocklist, type });
                    }
                }
                break;
            case 'link_code_companion_reg':
                const linkCodeCompanionReg = getBinaryNodeChild(node, 'link_code_companion_reg');
                const ref = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_ref'));
                const primaryIdentityPublicKey = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'primary_identity_pub'));
                const primaryEphemeralPublicKeyWrapped = toRequiredBuffer(getBinaryNodeChildBuffer(linkCodeCompanionReg, 'link_code_pairing_wrapped_primary_ephemeral_pub'));
                const codePairingPublicKey = await decipherLinkPublicKey(primaryEphemeralPublicKeyWrapped);
                const companionSharedKey = Curve.sharedKey(authState.creds.pairingEphemeralKeyPair.private, codePairingPublicKey);
                const random = randomBytes(32);
                const linkCodeSalt = randomBytes(32);
                const linkCodePairingExpanded = hkdf(companionSharedKey, 32, {
                    salt: linkCodeSalt,
                    info: 'link_code_pairing_key_bundle_encryption_key'
                });
                const encryptPayload = Buffer.concat([
                    Buffer.from(authState.creds.signedIdentityKey.public),
                    primaryIdentityPublicKey,
                    random
                ]);
                const encryptIv = randomBytes(12);
                const encrypted = aesEncryptGCM(encryptPayload, linkCodePairingExpanded, encryptIv, Buffer.alloc(0));
                const encryptedPayload = Buffer.concat([linkCodeSalt, encryptIv, encrypted]);
                const identitySharedKey = Curve.sharedKey(authState.creds.signedIdentityKey.private, primaryIdentityPublicKey);
                const identityPayload = Buffer.concat([companionSharedKey, identitySharedKey, random]);
                authState.creds.advSecretKey = Buffer.from(hkdf(identityPayload, 32, { info: 'adv_secret' })).toString('base64');
                await query({
                    tag: 'iq',
                    attrs: {
                        to: S_WHATSAPP_NET,
                        type: 'set',
                        id: sock.generateMessageTag(),
                        xmlns: 'md'
                    },
                    content: [
                        {
                            tag: 'link_code_companion_reg',
                            attrs: {
                                jid: authState.creds.me.id,
                                stage: 'companion_finish'
                            },
                            content: [
                                {
                                    tag: 'link_code_pairing_wrapped_key_bundle',
                                    attrs: {},
                                    content: encryptedPayload
                                },
                                {
                                    tag: 'companion_identity_public',
                                    attrs: {},
                                    content: authState.creds.signedIdentityKey.public
                                },
                                {
                                    tag: 'link_code_pairing_ref',
                                    attrs: {},
                                    content: ref
                                }
                            ]
                        }
                    ]
                });
                authState.creds.registered = true;
                ev.emit('creds.update', authState.creds);
                break;
            case 'privacy_token':
                await handlePrivacyTokenNotification(node);
                break;
        }
        if (Object.keys(result).length) {
            return result;
        }
    };
    /**
     * In-memory cache of storage JIDs with stored tctokens, seeded from the persisted index.
     * Used to coalesce writes during a session; pruning always re-reads the persisted index
     * to cover writes made by other layers (e.g. history sync).
     */
    const tcTokenKnownJids = new Set();
    const tcTokenIndexLoaded = (async () => {
        try {
            const jids = await readTcTokenIndex(authState.keys);
            for (const jid of jids)
                tcTokenKnownJids.add(jid);
            if (logger)
                logger.debug({ count: tcTokenKnownJids.size }, 'loaded tctoken index');
        }
        catch (err) {
            if (logger)
                logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'failed to load tctoken index');
        }
    })();
    let tcTokenIndexTimer;
    async function flushTcTokenIndex() {
        if (tcTokenIndexTimer) {
            clearTimeout(tcTokenIndexTimer);
            tcTokenIndexTimer = undefined;
        }
        // Merge with whatever is already persisted so we don't clobber writes from other
        // paths (history sync, concurrent sessions on the same store).
        const write = await buildMergedTcTokenIndexWrite(authState.keys, tcTokenKnownJids);
        return authState.keys.set({ tctoken: write });
    }
    function scheduleTcTokenIndexSave() {
        if (tcTokenIndexTimer) {
            clearTimeout(tcTokenIndexTimer);
        }
        tcTokenIndexTimer = setTimeout(() => {
            tcTokenIndexTimer = undefined;
            flushTcTokenIndex().catch(err => {
                if (logger)
                    logger.warn({ err: err?.message }, 'failed to save tctoken index');
            });
        }, 5000);
    }
    function trackTcTokenJid(jid) {
        if (jid && jid !== TC_TOKEN_INDEX_KEY && !tcTokenKnownJids.has(jid)) {
            tcTokenKnownJids.add(jid);
            scheduleTcTokenIndexSave();
        }
    }
    const handlePrivacyTokenNotification = async (node) => {
        const tokensNode = getBinaryNodeChild(node, 'tokens');
        if (!tokensNode)
            return;
        const from = jidNormalizedUser(node.attrs.from);
        // WA Web uses: senderLid ?? toLid(from) for the storage key
        // The sender_lid attribute provides the LID directly when available
        const senderLid = node.attrs.sender_lid && isLidUser(jidNormalizedUser(node.attrs.sender_lid))
            ? jidNormalizedUser(node.attrs.sender_lid)
            : undefined;
        const fallbackJid = senderLid ?? (await resolveTcTokenJid(from, getLIDForPN));
        if (logger)
            logger.debug({ from, storageJid: fallbackJid }, 'processing privacy token notification');
        await storeTcTokensFromIqResult({
            result: node,
            fallbackJid,
            keys: authState.keys,
            getLIDForPN,
            onNewJidStored: trackTcTokenJid
        });
    };
    async function decipherLinkPublicKey(data) {
        const buffer = toRequiredBuffer(data);
        const salt = buffer.subarray(0, 32);
        const secretKey = await derivePairingCodeKey(authState.creds.pairingCode, salt);
        const iv = buffer.subarray(32, 48);
        const payload = buffer.subarray(48, 80);
        return aesDecryptCTR(payload, secretKey, iv);
    }
    function toRequiredBuffer(data) {
        if (data === undefined) {
            throw new Boom('Invalid buffer', { statusCode: 400 });
        }
        return data instanceof Buffer ? data : Buffer.from(data);
    }
    const willSendMessageAgain = async (id, participant) => {
        const key = `${id}:${participant}`;
        const retryCount = (await msgRetryCache.get(key)) || 0;
        return retryCount < maxMsgRetryCount;
    };
    const updateSendMessageAgainCount = async (id, participant) => {
        const key = `${id}:${participant}`;
        const newValue = ((await msgRetryCache.get(key)) || 0) + 1;
        await msgRetryCache.set(key, newValue);
    };
    const sendMessagesAgain = async (key, ids, retryNode, receiptNode) => {
        const remoteJid = key.remoteJid;
        const participant = key.participant || remoteJid;
        const retryCount = +retryNode.attrs.count || 1;
        const msgId = ids[0];
        // Try to get messages from cache first, then fallback to getMessage
        const msgs = [];
        for (const id of ids) {
            let msg;
            // Try to get from retry cache first if enabled
            if (messageRetryManager) {
                const cachedMsg = messageRetryManager.getRecentMessage(remoteJid, id);
                if (cachedMsg) {
                    msg = cachedMsg.message;
                    if (logger)
                        logger.debug({ jid: remoteJid, id }, 'found message in retry cache');
                    // Mark retry as successful since we found the message
                    messageRetryManager.markRetrySuccess(id);
                }
            }
            // Fallback to getMessage if not found in cache
            if (!msg) {
                msg = await getMessage({ ...key, id });
                if (msg) {
                    if (logger)
                        logger.debug({ jid: remoteJid, id }, 'found message via getMessage');
                    // Also mark as successful if found via getMessage
                    if (messageRetryManager) {
                        messageRetryManager.markRetrySuccess(id);
                    }
                }
            }
            msgs.push(msg);
        }
        // if it's the primary jid sending the request
        // just re-send the message to everyone
        // prevents the first message decryption failure
        const sendToAll = !jidDecode(participant)?.device;
        const sessionId = signalRepository.jidToSignalProtocolAddress(participant);
        let injectedFromBundle = false;
        const bundle = extractE2ESessionFromRetryReceipt(receiptNode);
        if (bundle) {
            try {
                await signalRepository.injectE2ESession({ jid: participant, session: bundle });
                injectedFromBundle = true;
                if (logger)
                    logger.debug({ participant, retryCount }, 'injected session from retry receipt key bundle');
            }
            catch (error) {
                if (logger)
                    logger.warn({ error, participant }, 'failed to inject session from retry receipt');
            }
        }
        if (!injectedFromBundle) {
            const receivedRegId = getBinaryNodeChildUInt(receiptNode, 'registration', 4);
            if (typeof receivedRegId === 'number' && Number.isInteger(receivedRegId)) {
                const info = await signalRepository.getSessionInfo(participant);
                if (info && info.registrationId !== 0 && info.registrationId !== receivedRegId) {
                    if (logger)
                        logger.info({ participant, stored: info.registrationId, received: receivedRegId }, 'reg id mismatch on retry without bundle, deleting session');
                    await authState.keys.set({ session: { [sessionId]: null } });
                }
            }
        }
        const BASE_KEY_CHECK_RETRY = 2;
        if (msgId && messageRetryManager) {
            const info = await signalRepository.getSessionInfo(participant);
            if (info) {
                if (retryCount === BASE_KEY_CHECK_RETRY) {
                    messageRetryManager.saveBaseKey(sessionId, msgId, info.baseKey);
                }
                else if (retryCount > BASE_KEY_CHECK_RETRY) {
                    if (messageRetryManager.hasSameBaseKey(sessionId, msgId, info.baseKey)) {
                        if (logger)
                            logger.warn({ participant, retryCount }, 'base key collision on retry, forcing fresh session');
                        await authState.keys.set({ session: { [sessionId]: null } });
                    }
                    messageRetryManager.deleteBaseKey(sessionId, msgId);
                }
            }
        }
        let shouldRecreateSession = false;
        let recreateReason = '';
        if (enableAutoSessionRecreation && messageRetryManager && retryCount > 1 && !injectedFromBundle) {
            try {
                const hasSession = await signalRepository.validateSession(participant);
                const result = messageRetryManager.shouldRecreateSession(participant, hasSession.exists);
                shouldRecreateSession = result.recreate;
                recreateReason = result.reason;
                if (shouldRecreateSession) {
                    if (logger)
                        logger.debug({ participant, retryCount, reason: recreateReason }, 'recreating session for outgoing retry');
                    await authState.keys.set({ session: { [sessionId]: null } });
                }
            }
            catch (error) {
                if (logger)
                    logger.warn({ error, participant }, 'failed to check session recreation for outgoing retry');
            }
        }
        if (!injectedFromBundle) {
            await assertSessions([participant], true);
        }
        if (isJidGroup(remoteJid)) {
            await authState.keys.set({ 'sender-key-memory': { [remoteJid]: null } });
        }
        if (logger)
            logger.debug({ participant, sendToAll, shouldRecreateSession, recreateReason, injectedFromBundle }, 'prepared session for retry resend');
        for (const [i, msg] of msgs.entries()) {
            if (!ids[i])
                continue;
            if (msg && (await willSendMessageAgain(ids[i], participant))) {
                await updateSendMessageAgainCount(ids[i], participant);
                const msgRelayOpts = { messageId: ids[i] };
                if (sendToAll) {
                    msgRelayOpts.useUserDevicesCache = false;
                }
                else {
                    msgRelayOpts.participant = {
                        jid: participant,
                        count: +retryNode.attrs.count
                    };
                }
                await relayMessage(key.remoteJid, msg, msgRelayOpts);
            }
            else {
                if (logger)
                    logger.debug({ jid: key.remoteJid, id: ids[i] }, 'recv retry request, but message not available');
            }
        }
    };
    const handleReceipt = async (node) => {
        const { attrs, content } = node;
        const isLid = attrs.from.includes('lid');
        const isNodeFromMe = areJidsSameUser(attrs.participant || attrs.from, isLid ? authState.creds.me?.lid : authState.creds.me?.id);
        const remoteJid = !isNodeFromMe || isJidGroup(attrs.from) ? attrs.from : attrs.recipient;
        const fromMe = !attrs.recipient || ((attrs.type === 'retry' || attrs.type === 'sender') && isNodeFromMe);
        const key = {
            remoteJid,
            id: '',
            fromMe,
            participant: attrs.participant
        };
        const ids = [attrs.id];
        if (Array.isArray(content)) {
            const items = getBinaryNodeChildren(content[0], 'item');
            ids.push(...items.map(i => i.attrs.id));
        }
        try {
            await Promise.all([
                receiptMutex.mutex(async () => {
                    const status = getStatusFromReceiptType(attrs.type);
                    if (typeof status !== 'undefined' &&
                        // basically, we only want to know when a message from us has been delivered to/read by the other person
                        // or another device of ours has read some messages
                        (status >= proto.WebMessageInfo.Status.SERVER_ACK || !isNodeFromMe)) {
                        if (isJidGroup(remoteJid) || isJidStatusBroadcast(remoteJid)) {
                            if (attrs.participant) {
                                const updateKey = status === proto.WebMessageInfo.Status.DELIVERY_ACK ? 'receiptTimestamp' : 'readTimestamp';
                                ev.emit('message-receipt.update', ids.map(id => ({
                                    key: { ...key, id },
                                    receipt: {
                                        userJid: jidNormalizedUser(attrs.participant),
                                        [updateKey]: +attrs.t
                                    }
                                })));
                            }
                        }
                        else {
                            ev.emit('messages.update', ids.map(id => ({
                                key: { ...key, id },
                                update: { status, messageTimestamp: toNumber(+(attrs.t ?? 0)) }
                            })));
                        }
                    }
                    if (attrs.type === 'retry') {
                        // correctly set who is asking for the retry
                        key.participant = key.participant || attrs.from;
                        const retryNode = getBinaryNodeChild(node, 'retry');
                        if (ids[0] && key.participant && (await willSendMessageAgain(ids[0], key.participant))) {
                            if (key.fromMe) {
                                try {
                                    await updateSendMessageAgainCount(ids[0], key.participant);
                                    if (logger)
                                        logger.debug({ attrs, key }, 'recv retry request');
                                    await sendMessagesAgain(key, ids, retryNode, node);
                                }
                                catch (error) {
                                    if (logger)
                                        logger.error({ key, ids, trace: error instanceof Error ? error.stack : 'Unknown error' }, 'error in sending message again');
                                }
                            }
                            else {
                                if (logger)
                                    logger.info({ attrs, key }, 'recv retry for not fromMe message');
                            }
                        }
                        else {
                            if (logger)
                                logger.info({ attrs, key }, 'will not send message again, as sent too many times');
                        }
                    }
                })
            ]);
        }
        finally {
            await sendMessageAck(node).catch(ackErr => {
                if (logger)
                    logger.error({ ackErr }, 'failed to ack receipt');
            });
        }
    };
    const handleNotification = async (node) => {
        const remoteJid = node.attrs.from;
        try {
            await Promise.all([
                notificationMutex.mutex(async () => {
                    const msg = await processNotification(node);
                    if (msg) {
                        const fromMe = areJidsSameUser(node.attrs.participant || remoteJid, authState.creds.me.id);
                        const { senderAlt: participantAlt, addressingMode } = extractAddressingContext(node);
                        msg.key = {
                            remoteJid,
                            fromMe,
                            participant: node.attrs.participant,
                            participantAlt,
                            participantUsername: node.attrs.participant_username,
                            addressingMode,
                            id: node.attrs.id,
                            ...(msg.key || {})
                        };
                        msg.participant ?? (msg.participant = node.attrs.participant);
                        msg.messageTimestamp = +node.attrs.t;
                        const fullMsg = proto.WebMessageInfo.fromObject(msg);
                        await upsertMessage(fullMsg, 'append');
                    }
                })
            ]);
        }
        finally {
            try {
                await sendMessageAck(node);
            }
            catch (ackErr) {
                if (logger)
                    logger.error({ ackErr }, 'failed to ack notification');
            }
        }
    };
    const getBotMessageSecret = async (key) => {
        let message = messageRetryManager?.getRecentMessage(key.remoteJid, key.id)?.message;
        if (!message) {
            try {
                message = await getMessage(key);
            }
            catch (err) {
                logger?.warn({ err, key }, 'failed to get message for bot reply secret');
            }
        }
        return message?.messageContextInfo?.messageSecret;
    };
    const handleMessage = async (node) => {
        const isBotReply = getBinaryNodeChildren(node, 'enc').some(enc => enc.attrs.type === 'msmsg');
        // TODO: temporary fix for crashes and issues resulting of failed msmsg decryption
        let acked = false;
        try {
            const { fullMessage: msg, category, author, decrypt } = decryptMessageNode(node, authState.creds.me.id, authState.creds.me.lid || '', signalRepository, logger, getBotMessageSecret);
            const alt = msg.key.participantAlt || msg.key.remoteJidAlt;
            // store new mappings we didn't have before
            if (!!alt) {
                // H8 fix: serialize the look-up → store → migrate sequence per
                // alt-jid. Concurrent inbound messages from the same participant
                // would otherwise each observe a null mapping and each fire the
                // migration.
                await lidMigrationLocks.withLock({ namespace: 'lid-migration', id: alt }, async () => {
                    const altServer = jidDecode(alt)?.server;
                    const primaryJid = msg.key.participant || msg.key.remoteJid;
                    // Skip the store + migrate ONLY when the existing mapping
                    // already matches the incoming `primaryJid`. A bare
                    // existence check would freeze a stale mapping forever:
                    // if a PN previously mapped to one LID and a new message
                    // arrives announcing a different LID, we must reconcile
                    // rather than silently ignore the update. Equality with
                    // the incoming side is the correct idempotency guard.
                    if (altServer === 'lid') {
                        const existingPn = await signalRepository.lidMapping.getPNForLID(alt);
                        if (existingPn !== primaryJid) {
                            await signalRepository.lidMapping.storeLIDPNMappings([{ lid: alt, pn: primaryJid }]);
                            await signalRepository.migrateSession(primaryJid, alt);
                        }
                    }
                    else {
                        const existingLid = await signalRepository.lidMapping.getLIDForPN(alt);
                        if (existingLid !== primaryJid) {
                            await signalRepository.lidMapping.storeLIDPNMappings([{ lid: primaryJid, pn: alt }]);
                            await signalRepository.migrateSession(alt, primaryJid);
                        }
                    }
                });
            }
            await messageMutex.mutex(async () => {
                await decrypt();
                if (msg.key?.remoteJid && msg.key?.id && msg.message && messageRetryManager) {
                    messageRetryManager.addRecentMessage(msg.key.remoteJid, msg.key.id, msg.message);
                }
                // message failed to decrypt
                if (msg.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT && msg.category !== 'peer') {
                    if (msg?.messageStubParameters?.[0] === MISSING_KEYS_ERROR_TEXT) {
                        acked = true;
                        return sendMessageAck(node, NACK_REASONS.ParsingError);
                    }
                    if (isBotReply) {
                        logger?.debug({ key: msg.key, reason: msg.messageStubParameters?.[0] }, 'failed to decrypt bot reply');
                        acked = true;
                        return sendMessageAck(node, NACK_REASONS.MissingMessageSecret);
                    }
                    if (msg.messageStubParameters?.[0] === NO_MESSAGE_FOUND_ERROR_TEXT) {
                        // Message arrived without encryption (e.g. CTWA ads messages).
                        // Check if this is eligible for placeholder resend (matching WA Web filters).
                        const unavailableNode = getBinaryNodeChild(node, 'unavailable');
                        const unavailableType = unavailableNode?.attrs?.type;
                        if (unavailableType === 'bot_unavailable_fanout' ||
                            unavailableType === 'hosted_unavailable_fanout' ||
                            unavailableType === 'view_once_unavailable_fanout' ||
                            unavailableType === 'sender_drop') {
                            logger &&
                                logger.debug({ msgId: msg.key.id, unavailableType }, 'skipping placeholder resend for excluded unavailable type');
                            acked = true;
                            return sendMessageAck(node);
                        }
                        const messageAge = unixTimestampSeconds() - toNumber(msg.messageTimestamp);
                        if (messageAge > PLACEHOLDER_MAX_AGE_SECONDS) {
                            logger && logger.debug({ msgId: msg.key.id, messageAge }, 'skipping placeholder resend for old message');
                            acked = true;
                            return sendMessageAck(node);
                        }
                        // Request the real content from the phone via placeholder resend PDO.
                        // Upsert the CIPHERTEXT stub as a placeholder (like WA Web's processPlaceholderMsg),
                        // and store the requestId in stubParameters[1] so users can correlate
                        // with the incoming PDO response event.
                        const cleanKey = {
                            remoteJid: msg.key.remoteJid,
                            fromMe: msg.key.fromMe,
                            id: msg.key.id,
                            participant: msg.key.participant
                        };
                        // Cache the original message metadata so the PDO response handler
                        // can preserve key fields (LID details etc.) that the phone may omit
                        const msgData = {
                            key: msg.key,
                            messageTimestamp: msg.messageTimestamp,
                            pushName: msg.pushName,
                            participant: msg.participant,
                            verifiedBizName: msg.verifiedBizName
                        };
                        requestPlaceholderResend(cleanKey, msgData)
                            .then(requestId => {
                            if (requestId && requestId !== 'RESOLVED') {
                                logger &&
                                    logger.debug({ msgId: msg.key.id, requestId }, 'requested placeholder resend for unavailable message');
                                ev.emit('messages.update', [
                                    {
                                        key: msg.key,
                                        update: { messageStubParameters: [NO_MESSAGE_FOUND_ERROR_TEXT, requestId] }
                                    }
                                ]);
                            }
                        })
                            .catch(err => {
                            logger &&
                                logger.warn({ err, msgId: msg.key.id }, 'failed to request placeholder resend for unavailable message');
                        });
                        acked = true;
                        await sendMessageAck(node);
                        // Don't return — fall through to upsertMessage so the stub is emitted
                    }
                    else {
                        // A retry receipt only makes sense for a message from SOMEONE ELSE.
                        // An undecryptable `fromMe` message is the echo of our own account
                        // synced from another of our devices (sender fanout / deviceSentMessage),
                        // encrypted under the ORIGINATING device's session — not under a session
                        // this client holds. Asking for a resend is asking ourselves; the server
                        // answers with `<stream:error><ack/>` and tears the stream down (surfaces
                        // as a 500 "bad session" close, which it is not). Measured 26/08/2026 on a
                        // 6.7.x production client: a burst of 28 `SessionError: No matching
                        // sessions`, all fromMe, and the `<ack>` id inside the stream:error was one
                        // of them. Ack and move on: a retry for our own message cannot bring the
                        // content back, and keeping the connection alive is what matters.
                        if (msg.key.fromMe) {
                            logger && logger.debug({ key: msg.key }, 'undecryptable fromMe message: acking without a retry receipt');
                            acked = true;
                            return sendMessageAck(node);
                        }
                        // Skip retry for expired status messages (>24h old)
                        if (isJidStatusBroadcast(msg.key.remoteJid)) {
                            const messageAge = unixTimestampSeconds() - toNumber(msg.messageTimestamp);
                            if (messageAge > STATUS_EXPIRY_SECONDS) {
                                logger &&
                                    logger.debug({ msgId: msg.key.id, messageAge, remoteJid: msg.key.remoteJid }, 'skipping retry for expired status message');
                                acked = true;
                                return sendMessageAck(node);
                            }
                        }
                        logger && logger.debug('[handleMessage] Attempting retry request for failed decryption');
                        // WAWeb only retry-receipts here; server emits PreKeyLow if prekeys run low.
                        await retryMutex.mutex(async () => {
                            try {
                                if (!ws.isOpen) {
                                    logger && logger.debug({ node }, 'Connection closed, skipping retry');
                                    return;
                                }
                                const encNode = getBinaryNodeChild(node, 'enc');
                                await sendRetryRequest(node, !encNode);
                                if (retryRequestDelayMs) {
                                    await delay(retryRequestDelayMs);
                                }
                            }
                            catch (err) {
                                logger && logger.error({ err }, 'Failed to send retry');
                            }
                            acked = true;
                            await sendMessageAck(node, NACK_REASONS.UnhandledError);
                        });
                    }
                }
                else {
                    if (messageRetryManager && msg.key.id) {
                        messageRetryManager.cancelPendingPhoneRequest(msg.key.id);
                    }
                    const isNewsletter = isJidNewsletter(msg.key.remoteJid);
                    if (!isNewsletter) {
                        // no type in the receipt => message delivered
                        let type = undefined;
                        let participant = msg.key.participant;
                        if (category === 'peer') {
                            // special peer message
                            type = 'peer_msg';
                        }
                        else if (msg.key.fromMe) {
                            // message was sent by us from a different device
                            type = 'sender';
                            // need to specially handle this case
                            if (isLidUser(msg.key.remoteJid) || isLidUser(msg.key.remoteJidAlt) || isJidMetaAI(msg.key.remoteJid)) {
                                participant = author; // TODO: investigate sending receipts to LIDs and not PNs
                            }
                        }
                        else if (!sendActiveReceipts) {
                            type = 'inactive';
                        }
                        acked = true;
                        await sendReceipt(msg.key.remoteJid, participant, [msg.key.id], type);
                        // send ack for history message
                        const isAnyHistoryMsg = getHistoryMsg(msg.message);
                        if (isAnyHistoryMsg) {
                            const jid = jidNormalizedUser(msg.key.remoteJid);
                            await sendReceipt(jid, undefined, [msg.key.id], 'hist_sync'); // TODO: investigate
                        }
                    }
                    else {
                        acked = true;
                        await sendMessageAck(node);
                        logger && logger.debug({ key: msg.key }, 'processed newsletter message without receipts');
                    }
                }
                cleanMessage(msg, authState.creds.me.id, authState.creds.me.lid);
                await upsertMessage(msg, node.attrs.offline ? 'append' : 'notify');
            });
        }
        catch (error) {
            logger && logger.error({ error, node: binaryNodeToString(node) }, 'error in handling message');
            if (!acked) {
                await sendMessageAck(node, NACK_REASONS.UnhandledError).catch(ackErr => logger && logger.error({ ackErr }, 'failed to ack message after error'));
            }
        }
    };
    const handleBadAck = async ({ attrs }) => {
        const key = { remoteJid: attrs.from, fromMe: true, id: attrs.id };
        // WARNING: REFRAIN FROM ENABLING THIS FOR NOW. IT WILL CAUSE A LOOP
        // // current hypothesis is that if pash is sent in the ack
        // // it means -- the message hasn't reached all devices yet
        // // we'll retry sending the message here
        // if(attrs.phash) {
        // 	logger.info({ attrs }, 'received phash in ack, resending message...')
        // 	const msg = await getMessage(key)
        // 	if(msg) {
        // 		await relayMessage(key.remoteJid!, msg, { messageId: key.id!, useUserDevicesCache: false })
        // 	} else {
        // 		logger.warn({ attrs }, 'could not send message again, as it was not found')
        // 	}
        // }
        // error in acknowledgement,
        // device could not display the message
        if (attrs.error) {
            const isReachoutTimelocked = attrs.error === String(NACK_REASONS.SenderReachoutTimelocked);
            if (attrs.error === SERVER_ERROR_CODES.MessageAccountRestriction) {
                // 463 = 1:1 message missing privacy token (tctoken). Usually means the
                // account is restricted: WhatsApp blocks starting new chats but preserves
                // existing ones, since established chats already carry a tctoken.
                // WA Web prevents this client-side (disables the compose bar).
                // No retry — retrying counts as another "reach out" and worsens the restriction.
                if (logger)
                    logger.warn({ msgId: attrs.id, from: attrs.from }, 'error 463: account restricted or missing tctoken for contact');
                const ackFrom = attrs.from;
                if (ackFrom && !inFlight463Recoveries.has(ackFrom)) {
                    inFlight463Recoveries.add(ackFrom);
                    void (async () => {
                        try {
                            const getPNForLID = signalRepository.lidMapping.getPNForLID.bind(signalRepository.lidMapping);
                            const tcStorageJid = await resolveTcTokenJid(ackFrom, getLIDForPN);
                            const issueJid = await resolveIssuanceJid(ackFrom, sock.serverProps.lidTrustedTokenIssueToLid, getLIDForPN, getPNForLID);
                            const result = await issuePrivacyTokens([issueJid], unixTimestampSeconds());
                            await storeTcTokensFromIqResult({
                                result,
                                fallbackJid: tcStorageJid,
                                keys: authState.keys,
                                getLIDForPN,
                                onNewJidStored: trackTcTokenJid
                            });
                            if (logger)
                                logger.debug({ from: ackFrom }, 'completed 463 token recovery issuance');
                        }
                        catch (err) {
                            if (logger)
                                logger.debug({ from: ackFrom, err: err instanceof Error ? err.message : String(err) }, 'failed 463 token recovery issuance');
                        }
                        finally {
                            inFlight463Recoveries.delete(ackFrom);
                        }
                    })();
                }
            }
            else if (attrs.error === SERVER_ERROR_CODES.SmaxInvalid) {
                if (logger)
                    logger.warn({ msgId: attrs.id, from: attrs.from }, 'smax-invalid (479): stanza rejected by server — likely stale device session or malformed addressing');
            }
            else if (isReachoutTimelocked) {
                if (logger)
                    logger.warn({ attrs }, 'received error in ack, sender reachout timelocked');
            }
            else {
                if (logger)
                    logger.warn({ attrs }, 'received error in ack');
            }
            ev.emit('messages.update', [
                {
                    key,
                    update: {
                        status: WAMessageStatus.ERROR,
                        messageStubParameters: isReachoutTimelocked ? [attrs.error, ACCOUNT_RESTRICTED_TEXT] : [attrs.error]
                    }
                }
            ]);
        }
    };
    /// processes a node with the given function
    /// and adds the task to the existing buffer if we're buffering events
    const processNodeWithBuffer = async (node, identifier, exec) => {
        ev.buffer();
        await execTask();
        ev.flush();
        function execTask() {
            return exec(node, false).catch(err => onUnexpectedError(err, identifier));
        }
    };
    const offlineNodeProcessor = makeOfflineNodeProcessor(new Map([
        ['message', handleMessage],
        ['receipt', handleReceipt],
        ['notification', handleNotification]
    ]), {
        isWsOpen: () => ws.isOpen,
        onUnexpectedError,
        yieldToEventLoop: () => new Promise(resolve => setImmediate(resolve))
    });
    const processNode = async (type, node, identifier, exec) => {
        // Fast path: ack and drop ignored JIDs before entering the buffer/queue
        const from = node.attrs.from;
        let ignoreJid = from;
        if (type === 'receipt' && from) {
            const attrs = node.attrs;
            const isLid = attrs.from.includes('lid');
            const isNodeFromMe = areJidsSameUser(attrs.participant || attrs.from, isLid ? authState.creds.me?.lid : authState.creds.me?.id);
            ignoreJid = !isNodeFromMe || isJidGroup(attrs.from) ? attrs.from : attrs.recipient;
        }
        if (ignoreJid && ignoreJid !== S_WHATSAPP_NET && shouldIgnoreJid(ignoreJid)) {
            await sendMessageAck(node, type === 'message' ? NACK_REASONS.UnhandledError : undefined);
            return;
        }
        const isOffline = !!node.attrs.offline;
        if (isOffline) {
            offlineNodeProcessor.enqueue(type, node);
        }
        else {
            await processNodeWithBuffer(node, identifier, exec);
        }
    };
    // recv a message
    ws.on('CB:message', async (node) => {
        await processNode('message', node, 'processing message', handleMessage);
    });
    ws.on('CB:receipt', async (node) => {
        await processNode('receipt', node, 'handling receipt', handleReceipt);
    });
    ws.on('CB:notification', async (node) => {
        await processNode('notification', node, 'handling notification', handleNotification);
    });
    ws.on('CB:call', async (node) => {
        try {
            await sendNode(callAck(node));
            const call = parseCall(node);
            if (call &&
                (call.status !== 'offer' || call.isGroup || (await callUserMatches(call.creator || call.from, call.from)))) {
                const action = Array.isArray(node.content) ? node.content[0] : undefined;
                const current = calls.get(call.id);
                if (current?.group &&
                    current.direction === 'outgoing' &&
                    call.from !== current.callId + '@call' &&
                    !current.devices.some(device => jidNormalizedUser(device) === jidNormalizedUser(call.from)))
                    return;
                if (call.status === 'terminate') {
                    logger?.debug({ callId: call.id, from: call.from, reason: action?.attrs.reason, mediaStats: current?.media?.stats }, 'call terminated');
                }
                if (call.status === 'offer') {
                    await callOfferCache.set(call.id, call);
                    if (call.isGroup && !current && authState.creds.me?.lid) {
                        const creator = call.creator || call.from;
                        const session = new GroupSession(call.id, creator, authState.creds.me.lid);
                        const groupSummary = JSON.parse(session.applyInvite(binaryPack(encodeBinaryNode(action))));
                        call.groupState = groupSummary;
                        calls.set(call.id, {
                            callId: call.id,
                            peer: call.groupJid || call.from,
                            creator,
                            direction: 'incoming',
                            video: !!call.isVideo,
                            devices: [call.from],
                            status: 'ringing',
                            startedAt: Date.now(),
                            offer: node,
                            offerFrom: call.from,
                            groupSession: session,
                            ...(call.groupJid && { group: call.groupJid }),
                            ...(call.lightweight && { lightweight: true })
                        });
                    }
                    else if (!call.isGroup && !current) {
                        calls.set(call.id, {
                            callId: call.id,
                            peer: call.creator || call.from,
                            creator: call.creator || call.from,
                            direction: 'incoming',
                            video: !!call.isVideo,
                            devices: [call.from],
                            status: 'ringing',
                            startedAt: Date.now(),
                            offer: node,
                            offerFrom: call.from,
                            ...(call.lightweight && { lightweight: true })
                        });
                        if (calls.size > 200) {
                            for (const [id, state] of calls) {
                                if (state.status === 'ended')
                                    calls.delete(id);
                                if (calls.size <= 200)
                                    break;
                            }
                            while (calls.size > 200)
                                finishCall(calls.values().next().value);
                        }
                    }
                }
                else if (current?.groupSession && (call.status === 'group_update' || call.status === 'enc_rekey')) {
                    if (call.status === 'group_update') {
                        if (action && call.from === current.callId + '@call')
                            call.groupState = JSON.parse(current.groupSession.applyUpdate(binaryPack(encodeBinaryNode(action))));
                    }
                }
                else if (current) {
                    const expectedPeer = current.direction === 'outgoing' ? current.peer : current.creator;
                    const matchesPeer = (!!current.group && current.direction === 'outgoing') ||
                        (await callUserMatches(call.from, expectedPeer)) ||
                        (!!call.callerPn && (await callUserMatches(call.callerPn, expectedPeer)));
                    if (matchesPeer) {
                        logCall(call.id, call.status);
                        if (call.status === 'preaccept' || call.status === 'ringing') {
                            if (current.status !== 'connected')
                                current.status = 'ringing';
                        }
                        else if (call.status === 'accept') {
                            current.status = 'connected';
                            current.peerDevice = call.from;
                            if (current.direction === 'outgoing')
                                current.media?.rekeyRecv(call.from);
                            const files = pendingCallFiles.get(current);
                            if (files) {
                                pendingCallFiles.delete(current);
                                await applyCallFiles(current, files);
                            }
                        }
                        else if (call.status === 'reject' || call.status === 'terminate' || call.status === 'timeout') {
                            if (!current.groupSession || call.from === current.callId + '@call')
                                finishCall(current);
                        }
                        else if (call.status === 'video' && call.videoState !== undefined) {
                            if (call.videoState === 11 || call.videoState === 3)
                                current.videoRequest = true;
                            else if (call.videoState === 4) {
                                current.videoRequest = false;
                                current.media?.releaseVideo();
                            }
                            else if (call.videoState === 5 || call.videoState === 6) {
                                current.videoRequest = false;
                                current.media?.stopVideo();
                            }
                        }
                    }
                }
                ev.emit('call', [call]);
            }
        }
        catch (error) {
            onUnexpectedError(error instanceof Error ? error : new Error(String(error)), 'processing call stanza');
        }
    });
    ws.on('CB:status', (node) => {
        sendMessageAck(node).catch(error => onUnexpectedError(error, 'acking status'));
    });
    ws.on('CB:ack,class:message', (node) => {
        handleBadAck(node).catch(error => onUnexpectedError(error, 'handling bad ack'));
    });
    /** timestamp of last tctoken prune run — throttles to once per 24h */
    let lastTcTokenPruneTs = 0;
    /** dedupe in-flight 463 recovery token issuance by target JID */
    const inFlight463Recoveries = new Set();
    ev.on('connection.update', ({ isOnline, connection }) => {
        if (typeof isOnline !== 'undefined') {
            sendActiveReceipts = isOnline;
            if (logger)
                logger.trace(`sendActiveReceipts set to "${sendActiveReceipts}"`);
        }
        // Flush pending tctoken index save on disconnect to avoid writing after close
        if (connection === 'close' && tcTokenIndexTimer) {
            clearTimeout(tcTokenIndexTimer);
            tcTokenIndexTimer = undefined;
            // Best-effort flush — may fail if store is already closed
            try {
                void Promise.resolve(flushTcTokenIndex()).catch(() => { });
            }
            catch {
                /* ignore sync errors */
            }
        }
        // Prune expired tctokens when coming online, at most once per 24 hours
        // Matches WA Web's CLEAN_TC_TOKENS task
        // Note: don't gate on tcTokenKnownJids.size — the index may still be loading
        if (isOnline) {
            const now = Date.now();
            const DAY_MS = 24 * 60 * 60 * 1000;
            if (now - lastTcTokenPruneTs >= DAY_MS) {
                lastTcTokenPruneTs = now;
                void pruneExpiredTcTokens();
            }
        }
    });
    registerSocketEndHandler(() => {
        if (!config.msgRetryCounterCache && msgRetryCache.close) {
            msgRetryCache.close();
        }
        if (!config.callOfferCache && callOfferCache.close) {
            callOfferCache.close();
        }
        for (const call of calls.values())
            finishCall(call);
        calls.clear();
        identityAssertDebounce.close();
        sendActiveReceipts = false;
    });
    async function pruneExpiredTcTokens() {
        try {
            await tcTokenIndexLoaded;
            // Union with the persisted index picks up JIDs added by other layers
            // (history sync) without needing inter-module wiring.
            const persisted = await readTcTokenIndex(authState.keys);
            const allJids = new Set(tcTokenKnownJids);
            for (const jid of persisted)
                allJids.add(jid);
            if (!allJids.size)
                return;
            const jids = [...allJids];
            const allTokens = await authState.keys.get('tctoken', jids);
            const writes = {};
            const survivors = new Set();
            let mutated = 0;
            for (const jid of jids) {
                const entry = allTokens[jid];
                if (!entry) {
                    // Tracked but nothing in store — drop from index.
                    mutated++;
                    continue;
                }
                const hasPeerToken = !!entry.token?.length;
                const peerTokenExpired = hasPeerToken && isTcTokenExpired(entry.timestamp);
                const hasSenderTs = entry.senderTimestamp !== undefined;
                const senderTsExpired = hasSenderTs && isTcTokenExpired(entry.senderTimestamp);
                const keepPeerToken = hasPeerToken && !peerTokenExpired;
                const keepSenderTs = hasSenderTs && !senderTsExpired;
                if (!keepPeerToken && !keepSenderTs) {
                    writes[jid] = null;
                    mutated++;
                }
                else if (peerTokenExpired && keepSenderTs) {
                    writes[jid] = { token: Buffer.alloc(0), senderTimestamp: entry.senderTimestamp };
                    survivors.add(jid);
                    mutated++;
                }
                else {
                    survivors.add(jid);
                }
            }
            if (mutated === 0)
                return;
            await authState.keys.set({
                tctoken: {
                    ...writes,
                    [TC_TOKEN_INDEX_KEY]: {
                        token: packr.pack([...survivors])
                    }
                }
            });
            tcTokenKnownJids.clear();
            for (const jid of survivors)
                tcTokenKnownJids.add(jid);
            if (logger)
                logger.debug({ mutated, remaining: survivors.size }, 'pruned expired tctokens');
        }
        catch (err) {
            if (logger)
                logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'failed to prune expired tctokens');
        }
    }
    return {
        ...sock,
        sendMessageAck,
        sendRetryRequest,
        rejectCall,
        terminateCall,
        offerCall,
        startCall,
        acceptCall,
        endCall,
        enableCamera,
        disableCamera,
        acceptVideoUpgrade,
        rejectVideoUpgrade,
        playInCall,
        queueAudioFileInCall,
        setCallVolume,
        pauseCallMedia,
        resumeCallMedia,
        calls,
        createCallMediaStream,
        fetchMessageHistory,
        requestPlaceholderResend,
        messageRetryManager
    };
};
//# sourceMappingURL=receive.js.map