import { Boom } from '@hapi/boom';
import { aggregateMessageKeysNotFromMe, unixTimestampSeconds } from '../../Utils/index.js';
import { isLidUser, isPnUser } from '../../WABinary/index.js';
export const makeMessageReceipts = ({ logger, sendNode, fetchPrivacySettings }) => {
    const sendReceipt = async (jid, participant, messageIds, type) => {
        if (messageIds.length === 0)
            throw new Boom('missing ids in receipt');
        const node = { tag: 'receipt', attrs: { id: messageIds[0] } };
        if (type === 'read' || type === 'read-self')
            node.attrs.t = unixTimestampSeconds().toString();
        if (type === 'sender' && (isPnUser(jid) || isLidUser(jid))) {
            node.attrs.recipient = jid;
            node.attrs.to = participant;
        }
        else {
            node.attrs.to = jid;
            if (participant)
                node.attrs.participant = participant;
        }
        if (type)
            node.attrs.type = type;
        const remainingMessageIds = messageIds.slice(1);
        if (remainingMessageIds.length) {
            node.content = [
                { tag: 'list', attrs: {}, content: remainingMessageIds.map(id => ({ tag: 'item', attrs: { id } })) }
            ];
        }
        logger?.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages');
        await sendNode(node);
    };
    const sendReceipts = async (keys, type) => {
        for (const { jid, participant, messageIds } of aggregateMessageKeysNotFromMe(keys)) {
            await sendReceipt(jid, participant, messageIds, type);
        }
    };
    const readMessages = async (keys) => {
        const privacySettings = await fetchPrivacySettings();
        await sendReceipts(keys, privacySettings.readreceipts === 'all' ? 'read' : 'read-self');
    };
    return { sendReceipt, sendReceipts, readMessages };
};
//# sourceMappingURL=receipts.js.map