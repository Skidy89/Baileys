import { getCallStatusFromNode } from '../../../Utils/index.js';
export const parseCall = (node) => {
    const action = Array.isArray(node.content) ? node.content[0] : undefined;
    const id = action?.attrs['call-id'];
    const from = node.attrs.from;
    if (!action || !id || !from)
        return undefined;
    if (![
        'offer',
        'offer_notice',
        'preaccept',
        'ringing',
        'accept',
        'reject',
        'terminate',
        'timeout',
        'transport',
        'relaylatency',
        'video',
        'group_update',
        'enc_rekey'
    ].includes(action.tag))
        return undefined;
    const groupJid = action.attrs['group-jid'];
    const timestamp = Number(node.attrs.t);
    return {
        id,
        from,
        ...(action.attrs['call-creator'] && { creator: action.attrs['call-creator'] }),
        chatId: groupJid || from,
        ...(action.attrs.caller_pn && { callerPn: action.attrs.caller_pn }),
        ...(groupJid && { groupJid }),
        ...((action.attrs.type === 'group' ||
            groupJid ||
            (Array.isArray(action.content) && action.content.some(child => child.tag === 'group_info'))) && {
            isGroup: true
        }),
        ...(action.attrs.lightweight === '1' && { lightweight: true }),
        ...(action.tag === 'offer' && {
            isVideo: Array.isArray(action.content) && action.content.some(child => child.tag === 'video')
        }),
        ...(action.tag === 'video' &&
            /^\d{1,2}$/.test(action.attrs.state || '') && { videoState: Number(action.attrs.state) }),
        status: action.tag === 'timeout' ? 'timeout' : getCallStatusFromNode(action),
        date: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000) : new Date(),
        offline: node.attrs.offline === 'true' || node.attrs.offline === '1'
    };
};
export const callAckOrReceipt = (node) => {
    const action = Array.isArray(node.content) ? node.content[0] : undefined;
    if (action && ['offer', 'enc_rekey'].includes(action.tag))
        return undefined;
    if (action && ['accept', 'reject'].includes(action.tag))
        return callReceipt(node);
    return {
        tag: 'ack',
        attrs: {
            id: node.attrs.id || '',
            to: node.attrs.from || '',
            class: 'call',
            ...(action && { type: action.tag })
        }
    };
};
export const callReceipt = (node) => {
    const action = Array.isArray(node.content) ? node.content[0] : undefined;
    const callId = action?.attrs['call-id'];
    const creator = action?.attrs['call-creator'];
    if (!action || !['offer', 'accept', 'reject'].includes(action.tag) || !callId || !creator)
        return undefined;
    return {
        tag: 'receipt',
        attrs: { id: node.attrs.id || '', to: node.attrs.from || '' },
        content: [{ tag: action.tag, attrs: { 'call-id': callId, 'call-creator': creator } }]
    };
};
export const rejectCallNode = (callId, to, creator, id) => ({
    tag: 'call',
    attrs: { id, to },
    content: [{ tag: 'reject', attrs: { 'call-id': callId, 'call-creator': creator, count: '0' } }]
});
export const terminateCallNode = (callId, to, creator, id) => ({
    tag: 'call',
    attrs: { id, to },
    content: [{ tag: 'terminate', attrs: { 'call-id': callId, 'call-creator': creator } }]
});
//# sourceMappingURL=call-events.js.map