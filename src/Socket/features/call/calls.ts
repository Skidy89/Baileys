// Based on velowa (https://github.com/7ucg/velowa) by Baron - velowa License
import { randomBytes, hkdfSync } from 'node:crypto'
import type { GroupSession } from '@skidy89/signal-protocol'
import { proto } from '../../../../WAProto/index.js'
import { unpadRandomMax16 } from '../../../Utils/generics'
import { type BinaryNode, getBinaryNodeChild, getBinaryNodeChildren } from '../../../WABinary'
import type { VoipConfig } from '@skidy89/signal-protocol'
import type { CallMediaStream } from './call-media'

export type CallState = {
	callId: string
	peer: string
	group?: string
	creator: string
	direction: 'incoming' | 'outgoing'
	video: boolean
	lightweight?: boolean
	devices: string[]
	status: 'calling' | 'ringing' | 'connected' | 'ended'
	startedAt: number
	offer?: BinaryNode
	offerFrom?: string
	relay?: BinaryNode
	callKey?: Buffer
	media?: CallMediaStream
	groupSession?: GroupSession
	peerDevice?: string
	videoRequest?: boolean
}

const CAPABILITY_AUDIO = Buffer.from([1, 5, 247, 9, 224, 59, 19])
const CAPABILITY_VIDEO = Buffer.from([1, 5, 247, 9, 224, 59, 83])
const CAPABILITY_PREACCEPT = Buffer.from([1, 5, 247, 9, 224, 59, 7])
const OPUS_SETTINGS = Buffer.from(
	'{"encode":{"use_mlow_codec_v1":"false"},"options":{"enable_48khz_rtp_clock":"false"}}'
)

export const newCallId = () => `00${randomBytes(15).toString('hex')}`

export const buildOffer = (o: {
	callId: string
	to: string
	creator: string
	id: string
	video: boolean
	keys: Array<{ jid: string; type: 'msg' | 'pkmsg'; ciphertext: Uint8Array }>
	deviceIdentity?: Uint8Array
}): BinaryNode => {
	const enc = (key: (typeof o.keys)[number]): BinaryNode => ({
		tag: 'enc',
		attrs: { v: '2', type: key.type, count: '0' },
		content: key.ciphertext
	})
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
	}
}

export const buildPreaccept = (
	callId: string,
	to: string,
	creator: string,
	id: string,
	video: boolean
): BinaryNode => ({
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
})

export const buildAccept = (callId: string, to: string, creator: string, id: string, video: boolean): BinaryNode => ({
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
})

export const buildTerminate = (callId: string, to: string, creator: string, id: string): BinaryNode => ({
	tag: 'call',
	attrs: { id, to },
	content: [{ tag: 'terminate', attrs: { 'call-id': callId, 'call-creator': creator } }]
})

export const buildVideoState = (
	callId: string,
	to: string,
	creator: string,
	id: string,
	state: number,
	o: { dec?: string; orientation?: number } = {}
): BinaryNode => ({
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
})

export const getCallKey = async (
	decryptMessage: (opts: { jid: string; type: 'msg' | 'pkmsg'; ciphertext: Uint8Array }) => Promise<Uint8Array>,
	from: string,
	enc: BinaryNode
) => {
	if (!(enc.content instanceof Uint8Array)) throw new Error('call offer has no encrypted key')
	const clear = await decryptMessage({
		jid: from,
		type: enc.attrs.type === 'pkmsg' ? 'pkmsg' : 'msg',
		ciphertext: enc.content
	})
	try {
		const callKey = proto.Message.decode(unpadRandomMax16(clear)).call?.callKey
		if (!callKey || callKey.length !== 32) throw new Error('call offer has an invalid call key')
		return Buffer.from(callKey)
	} finally {
		clear.fill(0)
	}
}

export const mediaConfigFromRelay = (
	relay: BinaryNode,
	callId: string,
	direction: 'incoming' | 'outgoing',
	selfLid: string,
	peerLid: string,
	callKey: Uint8Array,
	video: boolean
): VoipConfig => {
	const keyNode = getBinaryNodeChild(relay, 'key')
	const key = bytes(keyNode)
	const endpoints = [...getBinaryNodeChildren(relay, 'te2'), ...getBinaryNodeChildren(relay, 'te')]
	const endpoint = endpoints.find(
		n => n.content instanceof Uint8Array && (n.content.length === 6 || n.content.length === 18)
	)
	if (!key?.length || !endpoint || !(endpoint.content instanceof Uint8Array))
		throw new Error('call relay has no usable key or endpoint')
	const addressBytes = Buffer.from(endpoint.content)
	const ipv6 = addressBytes.length === 18
	const address = ipv6
		? Array.from({ length: 8 }, (_, i) => addressBytes.readUInt16BE(i * 2).toString(16)).join(':')
		: Array.from(addressBytes.subarray(0, 4)).join('.')
	const port = addressBytes.readUInt16BE(addressBytes.length - 2)
	const tokens = getBinaryNodeChildren(relay, 'token')
	const authTokens = getBinaryNodeChildren(relay, 'auth_token')
	const tokenId = Number(endpoint.attrs.token_id || 0)
	const authTokenId = Number(endpoint.attrs.auth_token_id || 0)
	const relayToken = bytes(tokens.find((n, i) => Number(n.attrs.id ?? i) === tokenId))
	const authToken = bytes(authTokens.find((n, i) => Number(n.attrs.id ?? i) === authTokenId))
	if (!relayToken?.length) throw new Error('call relay has no token for its selected endpoint')
	const tagLenNode = getBinaryNodeChild(relay, 'warp_mi_tag_len')
	const tagLen = Number(relay.attrs.warp_mi_tag_len || (tagLenNode?.content ? String(tagLenNode.content) : '') || 4)
	if (!Number.isInteger(tagLen) || tagLen < 1 || tagLen > 20)
		throw new Error('call relay has an invalid integrity tag length')
	const salt = Buffer.alloc(4)
	const ssrc = Buffer.from(hkdfSync('sha256', Buffer.from(callId), salt, Buffer.from(selfLid), 4)).readUInt32LE(0)
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
	}
}

const bytes = (node: BinaryNode | undefined): Buffer | undefined => {
	if (!node?.content) return undefined
	if (typeof node.content === 'string') return Buffer.from(node.content)
	if (node.content instanceof Uint8Array) return Buffer.from(node.content)
	return undefined
}
