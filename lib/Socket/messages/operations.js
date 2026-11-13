import { Boom } from '@hapi/boom';
import { proto } from '../../../WAProto/index.js';
import { unixTimestampSeconds } from '../../Utils/index.js';
import { jidNormalizedUser } from '../../WABinary/index.js';
export const makeMessageOperations = (getMeId, relayMessage) => {
    const updateMemberLabel = (jid, memberLabel) => relayMessage(jid, {
        protocolMessage: {
            type: proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE,
            memberLabel: { label: memberLabel?.slice(0, 30), labelTimestamp: unixTimestampSeconds() }
        }
    }, {
        additionalNodes: [
            { tag: 'meta', attrs: { tag_reason: 'user_update', appdata: 'member_tag' }, content: undefined }
        ]
    });
    const sendPeerDataOperationMessage = async (pdoMessage) => {
        const meId = getMeId();
        if (!meId)
            throw new Boom('Not authenticated');
        const protocolMessage = {
            protocolMessage: {
                peerDataOperationRequestMessage: pdoMessage,
                type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
            }
        };
        return relayMessage(jidNormalizedUser(meId), protocolMessage, {
            additionalAttributes: { category: 'peer', push_priority: 'high_force' },
            additionalNodes: [{ tag: 'meta', attrs: { appdata: 'default' } }]
        });
    };
    return { updateMemberLabel, sendPeerDataOperationMessage };
};
//# sourceMappingURL=operations.js.map