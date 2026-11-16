import { describe, expect, it, jest } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'
import type { AuthenticationCreds, SignalKeyStoreWithTransaction, WAMessage } from '../../Types'

let historyResult: unknown
const downloadHistory = jest.fn(async () => historyResult)
jest.unstable_mockModule('../../Utils/history', () => ({
	downloadAndProcessHistorySyncNotification: downloadHistory
}))

const { default: processMessage } = await import('../../Utils/messages/process')

describe('history sync processing', () => {
	it('resolves trusted contact token JIDs in one LID mapping batch', async () => {
		const chats = [
			{ id: '111@s.whatsapp.net', tcToken: Buffer.from([1]), tcTokenTimestamp: 100 },
			{ id: '222@s.whatsapp.net', tcToken: Buffer.from([2]), tcTokenTimestamp: 200 },
			{ id: '444@s.whatsapp.net', tcToken: Buffer.from([4]), tcTokenTimestamp: 400 },
			{ id: '333@lid', tcToken: Buffer.from([3]), tcTokenTimestamp: 300 }
		]
		historyResult = { chats, contacts: [], messages: [] }
		const getLIDsForPNs = jest.fn(async (pns: string[]) =>
			pns.filter(pn => !pn.startsWith('444')).map(pn => ({ pn, lid: pn.replace('@s.whatsapp.net', '@lid') }))
		)
		const getLIDForPN = jest.fn()
		const keyStore = {
			get: jest.fn(async () => ({})),
			set: jest.fn(async () => {})
		} as unknown as SignalKeyStoreWithTransaction
		const signalRepository = {
			lidMapping: { getLIDsForPNs, getLIDForPN }
		} as never

		await processMessage(
			{
				key: { remoteJid: '999@s.whatsapp.net', id: 'history', fromMe: true },
				messageTimestamp: 1,
				message: {
					protocolMessage: {
						type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
						historySyncNotification: {
							syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP
						}
					}
				}
			} as WAMessage,
			{
				shouldProcessHistoryMsg: true,
				ev: { emit: jest.fn() } as never,
				creds: { me: { id: '999@s.whatsapp.net' }, accountSettings: {} } as AuthenticationCreds,
				signalRepository,
				keyStore,
				options: {},
				getMessage: async () => undefined
			}
		)

		expect(getLIDsForPNs).toHaveBeenCalledTimes(1)
		expect(getLIDsForPNs).toHaveBeenCalledWith(['111@s.whatsapp.net', '222@s.whatsapp.net', '444@s.whatsapp.net'])
		expect(getLIDForPN).not.toHaveBeenCalled()
		expect(keyStore.set).toHaveBeenCalledWith(
			expect.objectContaining({
				tctoken: expect.objectContaining({
					'111@lid': expect.objectContaining({ token: Buffer.from([1]) }),
					'222@lid': expect.objectContaining({ token: Buffer.from([2]) }),
					'444@s.whatsapp.net': expect.objectContaining({ token: Buffer.from([4]) }),
					'333@lid': expect.objectContaining({ token: Buffer.from([3]) })
				})
			})
		)
	})

	it('stores shared app state sync keys with one key-store write', async () => {
		const keyData = [
			{ keyData: Buffer.from([1]), timestamp: 1 },
			{ keyData: Buffer.from([2]), timestamp: 2 }
		]
		const set = jest.fn(async () => {})
		const transaction = jest.fn(async (work: () => Promise<void>) => work())
		const keyStore = {
			get: jest.fn(async () => ({})),
			set,
			transaction,
			isInTransaction: () => true
		} as unknown as SignalKeyStoreWithTransaction
		const emit = jest.fn()

		await processMessage(
			{
				key: { remoteJid: '999@s.whatsapp.net', id: 'sync', fromMe: true },
				messageTimestamp: 1,
				message: {
					protocolMessage: {
						type: proto.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_SHARE,
						appStateSyncKeyShare: {
							keys: keyData.map((keyData, index) => ({ keyData, keyId: { keyId: Buffer.from([index + 1]) } }))
						}
					}
				}
			} as WAMessage,
			{
				shouldProcessHistoryMsg: false,
				ev: { emit } as never,
				creds: { me: { id: '999@s.whatsapp.net' }, accountSettings: {} } as AuthenticationCreds,
				signalRepository: {} as never,
				keyStore,
				options: {},
				getMessage: async () => undefined
			}
		)

		expect(transaction).toHaveBeenCalledTimes(1)
		expect(set).toHaveBeenCalledTimes(1)
		expect(set).toHaveBeenCalledWith({
			'app-state-sync-key': {
				'AQ==': keyData[0],
				'Ag==': keyData[1]
			}
		})
		expect(emit).toHaveBeenCalledWith('creds.update', { myAppStateKeyId: 'Ag==' })
	})
})
