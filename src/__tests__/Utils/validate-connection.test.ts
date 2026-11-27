import { proto } from '../../../WAProto'
import { generateRegistrationNode } from '../../Utils/validate-connection'
import type { SignalCreds, SocketConfig } from '../../Types'

const creds = {
	registrationId: 1,
	signedPreKey: { keyId: 1, keyPair: { public: Buffer.alloc(32) }, signature: Buffer.alloc(64) },
	signedIdentityKey: { public: Buffer.alloc(32) }
} as unknown as SignalCreds

const deviceProps = (supportGroupHistory?: boolean) => {
	const payload = generateRegistrationNode(creds, {
		version: [2, 3000, 1],
		browser: ['Mac OS', 'Safari', '14.0.0'],
		syncFullHistory: false,
		supportGroupHistory
	} as SocketConfig)
	return proto.DeviceProps.decode(Buffer.from(payload.devicePairingData!.deviceProps!))
}

describe('generateRegistrationNode', () => {
	it('uses the configured group-history capability instead of advertising it unconditionally', () => {
		expect(deviceProps().historySyncConfig?.supportGroupHistory).toBe(false)
		expect(deviceProps(true).historySyncConfig?.supportGroupHistory).toBe(true)
	})
})
