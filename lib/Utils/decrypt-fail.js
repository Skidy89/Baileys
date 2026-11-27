import { proto } from '../../WAProto';
import { normalizeMessageContent } from './messages/content.js';
const hiddenSecretTypes = new Set([
    proto.Message.SecretEncryptedMessage.SecretEncType.EVENT_EDIT,
    proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT,
    proto.Message.SecretEncryptedMessage.SecretEncType.POLL_ADD_OPTION,
    proto.Message.SecretEncryptedMessage.SecretEncType.POLL_EDIT
]);
export function getDecryptFailAttribute(message) {
    const content = normalizeMessageContent(message) || message;
    const protocol = content.protocolMessage;
    const protocolType = proto.Message.ProtocolMessage.Type;
    if (content.reactionMessage ||
        content.encReactionMessage ||
        content.pollUpdateMessage?.vote ||
        content.keepInChatMessage ||
        content.editedMessage ||
        content.pinInChatMessage ||
        content.botInvokeMessage?.message?.protocolMessage?.type === protocolType.REQUEST_WELCOME_MESSAGE ||
        content.encEventResponseMessage ||
        (content.secretEncryptedMessage?.secretEncType != null &&
            hiddenSecretTypes.has(content.secretEncryptedMessage.secretEncType)) ||
        content.messageHistoryNotice ||
        content.conditionalRevealMessage ||
        content.statusNotificationMessage ||
        (protocol &&
            (protocol.type === protocolType.EPHEMERAL_SYNC_RESPONSE ||
                protocol.type === protocolType.REQUEST_WELCOME_MESSAGE ||
                !!protocol.editedMessage ||
                protocol.type === protocolType.GROUP_MEMBER_LABEL_CHANGE ||
                protocol.type === protocolType.MESSAGE_UNSCHEDULE ||
                !!protocol.aiMetadataOperation))) {
        return 'hide';
    }
}
//# sourceMappingURL=decrypt-fail.js.map