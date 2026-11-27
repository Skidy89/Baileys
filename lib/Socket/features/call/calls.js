// Based on velowa (https://github.com/7ucg/velowa) by Baron - velowa License
import { randomBytes, hkdfSync } from 'node:crypto';
import { binaryMarshalPackedNode } from '@skidy89/signal-protocol';
import { proto } from '../../../../WAProto/index.js';
import { unpadRandomMax16 } from '../../../Utils/generics.js';
import { getBinaryNodeChild, getBinaryNodeChildren } from '../../../WABinary/index.js';
export const isCallActive = (calls, call) => call.status !== 'ended' && calls.get(call.callId) === call;
const CAPABILITY_AUDIO = Buffer.from([1, 5, 247, 9, 224, 59, 19]);
const CAPABILITY_VIDEO = Buffer.from([1, 5, 247, 9, 224, 59, 83]);
const CAPABILITY_PREACCEPT = Buffer.from([1, 5, 247, 9, 224, 59, 7]);
const OPUS_SETTINGS = Buffer.from('{"encode":{"use_mlow_codec_v1":"false"},"options":{"enable_48khz_rtp_clock":"false"}}');
export const newCallId = () => `00${randomBytes(15).toString('hex')}`;
export const packGroupCallNode = (node) => {
    const marshal = (value) => ({
        tag: value.tag,
        attrs: Object.entries(value.attrs).map(([key, attr]) => [key, { String: attr }]),
        content: Array.isArray(value.content)
            ? { Nodes: value.content.map(child => marshal(child)) }
            : value.content instanceof Uint8Array
                ? { Bytes: Array.from(value.content) }
                : typeof value.content === 'string'
                    ? { String: value.content }
                    : null
    });
    return binaryMarshalPackedNode(JSON.stringify(marshal(node)));
};
export function acknowledgeOffer(call, ack, stanzaId) {
    if (ack.tag !== 'ack' || ack.attrs.class !== 'call' || ack.attrs.id !== stanzaId)
        throw new Error('Unexpected call acknowledgement');
    if (ack.attrs.error && ack.attrs.error !== '0')
        throw new Error('Call offer rejected: ' + ack.attrs.error);
    if (call.status === 'offer_sent')
        call.status = 'server_ack';
}
export const buildOffer = (o) => {
    const enc = (key) => ({
        tag: 'enc',
        attrs: { v: '2', type: key.type, count: '0' },
        content: key.ciphertext
    });
    return {
        tag: 'call',
        attrs: { id: o.id, to: o.to },
        content: [
            {
                tag: 'offer',
                attrs: { 'call-id': o.callId, 'call-creator': o.creator },
                content: [
                    { tag: 'audio', attrs: { enc: 'opus', rate: '16000' } },
                    ...(o.video
                        ? [
                            {
                                tag: 'video',
                                attrs: { enc: 'h.264', dec: 'H264', screen_width: '0', screen_height: '0', device_orientation: '0' }
                            }
                        ]
                        : []),
                    { tag: 'net', attrs: { medium: '3' } },
                    { tag: 'capability', attrs: { ver: '1' }, content: o.video ? CAPABILITY_VIDEO : CAPABILITY_AUDIO },
                    ...(o.keys.length > 1
                        ? [
                            {
                                tag: 'destination',
                                attrs: {},
                                content: o.keys.map(key => ({ tag: 'to', attrs: { jid: key.jid }, content: [enc(key)] }))
                            }
                        ]
                        : o.keys[0]
                            ? [enc(o.keys[0])]
                            : []),
                    { tag: 'encopt', attrs: { keygen: '2' } },
                    ...(o.deviceIdentity ? [{ tag: 'device-identity', attrs: {}, content: o.deviceIdentity }] : [])
                ]
            }
        ]
    };
};
export const buildGroupOffer = (callId, id, creator, group, roster, video) => {
    const users = Array.from(roster, ([jid, devices]) => ({
        tag: 'user',
        attrs: { jid },
        content: devices.map(device => ({
            tag: 'device',
            attrs: { jid: device },
            ...(device === creator && {
                content: [{ tag: 'capability', attrs: { ver: '1' }, content: video ? CAPABILITY_VIDEO : CAPABILITY_AUDIO }]
            })
        }))
    }));
    return {
        tag: 'call',
        attrs: { to: callId + '@call', id },
        content: [
            {
                tag: 'offer',
                attrs: { 'call-id': callId, 'call-creator': creator, 'group-jid': group },
                content: [
                    { tag: 'audio', attrs: { enc: 'opus', rate: '16000' } },
                    ...(video
                        ? [
                            {
                                tag: 'video',
                                attrs: {
                                    enc: 'h.264',
                                    dec: 'H264',
                                    orientation: '0',
                                    screen_width: '1920',
                                    screen_height: '1080',
                                    device_orientation: '0'
                                }
                            }
                        ]
                        : []),
                    { tag: 'net', attrs: { medium: '3' } },
                    { tag: 'group_info', attrs: {}, content: users }
                ]
            }
        ]
    };
};
export const buildPreaccept = (callId, to, creator, id, video) => ({
    tag: 'call',
    attrs: { id, to },
    content: [
        {
            tag: 'preaccept',
            attrs: { 'call-id': callId, 'call-creator': creator },
            content: [
                { tag: 'audio', attrs: { enc: 'opus', rate: '16000' } },
                ...(video
                    ? [
                        {
                            tag: 'video',
                            attrs: { dec: 'H264', device_orientation: '0', screen_width: '0', screen_height: '0' }
                        }
                    ]
                    : []),
                { tag: 'encopt', attrs: { keygen: '2' } },
                { tag: 'capability', attrs: { ver: '1' }, content: video ? CAPABILITY_VIDEO : CAPABILITY_PREACCEPT }
            ]
        }
    ]
});
export const buildAccept = (callId, to, creator, id, video) => ({
    tag: 'call',
    attrs: { id, to },
    content: [
        {
            tag: 'accept',
            attrs: { 'call-id': callId, 'call-creator': creator },
            content: [
                { tag: 'audio', attrs: { enc: 'opus', rate: '16000' } },
                ...(video ? [{ tag: 'video', attrs: { dec: 'H264', device_orientation: '0' } }] : []),
                { tag: 'net', attrs: { medium: '2' } },
                { tag: 'encopt', attrs: { keygen: '2' } },
                ...(video ? [] : [{ tag: 'capability', attrs: { ver: '1' }, content: CAPABILITY_AUDIO }]),
                { tag: 'voip_settings', attrs: { uncompressed: '1' }, content: OPUS_SETTINGS }
            ]
        }
    ]
});
export const buildTerminate = (callId, to, creator, id) => ({
    tag: 'call',
    attrs: { id, to },
    content: [{ tag: 'terminate', attrs: { 'call-id': callId, 'call-creator': creator } }]
});
export const buildVideoState = (callId, to, creator, id, state, o = {}) => ({
    tag: 'call',
    attrs: { id, to },
    content: [
        {
            tag: 'video',
            attrs: {
                'call-id': callId,
                'call-creator': creator,
                state: String(state),
                ...(o.dec && { dec: o.dec }),
                ...(state === 11 && { voip_settings: 'video' }),
                ...(o.orientation !== undefined && { device_orientation: String(o.orientation) })
            }
        }
    ]
});
export const getCallKey = async (decryptMessage, from, enc) => {
    if (!(enc.content instanceof Uint8Array))
        throw new Error('call offer has no encrypted key');
    const clear = await decryptMessage({
        jid: from,
        type: enc.attrs.type === 'pkmsg' ? 'pkmsg' : 'msg',
        ciphertext: enc.content
    });
    try {
        const callKey = proto.Message.decode(unpadRandomMax16(clear)).call?.callKey;
        if (!callKey || callKey.length !== 32)
            throw new Error('call offer has an invalid call key');
        return Buffer.from(callKey);
    }
    finally {
        clear.fill(0);
    }
};
export const getCallOfferEnc = (action, ownJids) => {
    const content = Array.isArray(action.content) ? action.content : [];
    const direct = content.find(child => child.tag === 'enc');
    if (direct)
        return direct;
    const destination = content.find(child => child.tag === 'destination');
    const device = getBinaryNodeChildren(destination, 'to').find(child => ownJids.includes(child.attrs.jid || ''));
    return getBinaryNodeChildren(device, 'enc')[0];
};
export const mediaConfigFromRelay = (relay, callId, direction, selfLid, peerLid, callKey, video) => {
    const keyNode = getBinaryNodeChild(relay, 'key');
    const key = bytes(keyNode);
    const endpoints = [...getBinaryNodeChildren(relay, 'te2'), ...getBinaryNodeChildren(relay, 'te')];
    const tokens = getBinaryNodeChildren(relay, 'token');
    const usable = endpoints.filter(n => n.content instanceof Uint8Array &&
        (n.content.length === 6 || n.content.length === 18) &&
        tokens.some((token, i) => Number(token.attrs.id ?? i) === Number(n.attrs.token_id || 0) && bytes(token)?.length));
    const endpoint = usable.find(n => {
        const address = Buffer.from(n.content);
        return address.readUInt16BE(address.length - 2) === 3480;
    }) ??
        usable.find(n => n.attrs.is_fna !== '1' && Number(n.attrs.auth_token_id || 0) !== 0) ??
        usable.find(n => n.attrs.is_fna !== '1') ??
        usable[0];
    if (!key?.length || !endpoint || !(endpoint.content instanceof Uint8Array))
        throw new Error('call relay has no usable key or endpoint');
    const addressBytes = Buffer.from(endpoint.content);
    const ipv6 = addressBytes.length === 18;
    const address = ipv6
        ? Array.from({ length: 8 }, (_, i) => addressBytes.readUInt16BE(i * 2).toString(16)).join(':')
        : Array.from(addressBytes.subarray(0, 4)).join('.');
    const port = addressBytes.readUInt16BE(addressBytes.length - 2);
    const authTokens = getBinaryNodeChildren(relay, 'auth_token');
    const tokenId = Number(endpoint.attrs.token_id || 0);
    const authTokenId = Number(endpoint.attrs.auth_token_id || 0);
    const relayToken = bytes(tokens.find((n, i) => Number(n.attrs.id ?? i) === tokenId));
    const authToken = bytes(authTokens.find((n, i) => Number(n.attrs.id ?? i) === authTokenId));
    if (!relayToken?.length)
        throw new Error('call relay has no token for its selected endpoint');
    const tagLenNode = getBinaryNodeChild(relay, 'warp_mi_tag_len');
    const tagLen = Number(relay.attrs.warp_mi_tag_len || (tagLenNode?.content ? String(tagLenNode.content) : '') || 4);
    if (!Number.isInteger(tagLen) || tagLen < 1 || tagLen > 20)
        throw new Error('call relay has an invalid integrity tag length');
    const salt = Buffer.alloc(4);
    const ssrc = Buffer.from(hkdfSync('sha256', Buffer.from(callId), salt, Buffer.from(selfLid), 4)).readUInt32LE(0);
    return {
        callId,
        direction,
        selfLid,
        peerLid,
        callKey: Buffer.from(callKey),
        ssrc,
        relayToken,
        ...(authToken?.length && { authToken }),
        relayIp: address,
        relayPort: port,
        integrityKey: key,
        warpMiTagLen: tagLen,
        enableMedia: true,
        enableVideo: video,
        enableSframe: true,
        audio: 'opus'
    };
};
export const groupRelayEndpointFromNode = (relay) => {
    const tokens = getBinaryNodeChildren(relay, 'token').reduce((indexed, token) => {
        const value = bytes(token);
        const id = Number(token.attrs.id ?? indexed.length);
        if (value?.length && Number.isInteger(id) && id >= 0 && id < 64)
            indexed[id] = value;
        return indexed;
    }, []);
    const usable = getBinaryNodeChildren(relay, 'te2').filter(endpoint => {
        const id = Number(endpoint.attrs.token_id);
        return (endpoint.attrs.is_fna !== '1' &&
            endpoint.content instanceof Uint8Array &&
            endpoint.content.length === 6 &&
            Buffer.from(endpoint.content).readUInt16BE(4) !== 0 &&
            Number.isInteger(id) &&
            !!tokens[id]?.length);
    });
    const endpoint = usable.find(item => Buffer.from(item.content).readUInt16BE(4) === 3480) ?? usable[0];
    if (!endpoint)
        throw new Error('group relay has no usable media endpoint');
    const address = Buffer.from(endpoint.content);
    return { relayIp: Array.from(address.subarray(0, 4)).join('.'), relayPort: address.readUInt16BE(4) };
};
export const buildGroupEncRekey = (o) => {
    if (!Number.isInteger(o.transactionId) || o.transactionId < 1 || o.transactionId > 0xffffffff)
        throw new Error('Invalid group epoch transaction ID');
    if (!o.encrypted.ciphertext.length || (o.encrypted.type === 'pkmsg' && !o.deviceIdentity?.length))
        throw new Error('Invalid encrypted group epoch');
    return {
        tag: 'call',
        attrs: { to: o.to, id: o.id },
        content: [
            {
                tag: 'enc_rekey',
                attrs: { 'call-id': o.callId, 'call-creator': o.creator, 'transaction-id': String(o.transactionId) },
                content: [
                    { tag: 'encopt', attrs: { keygen: '2' } },
                    { tag: 'enc', attrs: { v: '2', type: o.encrypted.type, count: '0' }, content: o.encrypted.ciphertext },
                    ...(o.deviceIdentity ? [{ tag: 'device-identity', attrs: {}, content: o.deviceIdentity }] : [])
                ]
            }
        ]
    };
};
const bytes = (node) => {
    if (!node?.content)
        return undefined;
    if (typeof node.content === 'string')
        return Buffer.from(node.content);
    if (node.content instanceof Uint8Array)
        return Buffer.from(node.content);
    return undefined;
};
//# sourceMappingURL=calls.js.map