import { Boom } from '@hapi/boom';
import { proto } from '../../../WAProto/index.js';
import { writeRandomPadMax16 } from '../../Utils/generics.js';
import { makeKeyedMutex } from '../../Utils/make-mutex.js';
import { jidDecode } from '../../WABinary/index.js';
export const makeParticipantNodeCreator = ({ patchMessageBeforeSending, authState, signalRepository, encryptionMutex, logger }) => async (recipientJids, message, extraAttrs, dsmMessage) => {
    if (!recipientJids.length)
        return { nodes: [], shouldIncludeDeviceIdentity: false };
    const patched = await patchMessageBeforeSending(message, recipientJids);
    const patchedMessages = Array.isArray(patched)
        ? patched
        : undefined;
    let shouldIncludeDeviceIdentity = false;
    const meId = authState.creds.me.id;
    const mePnUser = jidDecode(meId)?.user;
    const meLid = authState.creds.me?.lid;
    const meLidUser = meLid ? jidDecode(meLid)?.user : null;
    const encodedMessages = new WeakMap();
    const encryptRecipient = async (jid, patchedMessage) => {
        try {
            if (!jid)
                return null;
            let msgToEncrypt = patchedMessage;
            if (dsmMessage) {
                const { user: targetUser } = jidDecode(jid);
                const isOwnUser = targetUser === mePnUser || (meLidUser && targetUser === meLidUser);
                const isExactSenderDevice = jid === meId || (meLid && jid === meLid);
                if (isOwnUser && !isExactSenderDevice) {
                    msgToEncrypt = dsmMessage;
                    logger?.debug({ jid, targetUser }, 'Using DSM for own device');
                }
            }
            let encoded = encodedMessages.get(msgToEncrypt);
            if (!encoded) {
                encoded = proto.Message.encode(msgToEncrypt).finish();
                encodedMessages.set(msgToEncrypt, encoded);
            }
            const bytes = writeRandomPadMax16(encoded);
            return await encryptionMutex.mutex(jid, async () => {
                const { type, ciphertext } = await signalRepository.encryptMessage({ jid, data: bytes });
                if (type === 'pkmsg')
                    shouldIncludeDeviceIdentity = true;
                return {
                    tag: 'to',
                    attrs: { jid },
                    content: [{ tag: 'enc', attrs: { v: '2', type, ...(extraAttrs || {}) }, content: ciphertext }]
                };
            });
        }
        catch (err) {
            logger?.error({ jid, err }, 'Failed to encrypt for recipient');
            return null;
        }
    };
    const encryptionPromises = patchedMessages
        ? patchedMessages.map(({ recipientJid, message }) => encryptRecipient(recipientJid, message))
        : recipientJids.map(jid => encryptRecipient(jid, patched));
    const nodes = (await Promise.all(encryptionPromises)).filter(node => node !== null);
    if (recipientJids.length > 0 && nodes.length === 0)
        throw new Boom('All encryptions failed', { statusCode: 500 });
    return { nodes, shouldIncludeDeviceIdentity };
};
//# sourceMappingURL=participant-nodes.js.map