import { assertNodeErrorFree, getBinaryNodeChild } from '../../WABinary/index.js';
export class USyncDeviceProtocol {
    constructor() {
        this.name = 'devices';
    }
    getQueryElement() {
        return {
            tag: 'devices',
            attrs: {
                version: '2'
            }
        };
    }
    getUserElement(user) {
        const deviceHash = user.deviceHash || undefined;
        if (deviceHash === undefined && user.ts == null && user.expectedTs == null)
            return null;
        const attrs = {};
        if (deviceHash !== undefined)
            attrs.device_hash = deviceHash;
        if (user.ts != null)
            attrs.ts = String(user.ts);
        if (user.expectedTs != null)
            attrs.expected_ts = String(user.expectedTs);
        return { tag: 'devices', attrs };
    }
    parser(node) {
        const deviceList = [];
        let keyIndex = undefined;
        if (node.tag === 'devices') {
            assertNodeErrorFree(node);
            const deviceListNode = getBinaryNodeChild(node, 'device-list');
            const keyIndexNode = getBinaryNodeChild(node, 'key-index-list');
            if (Array.isArray(deviceListNode?.content)) {
                for (const { tag, attrs } of deviceListNode.content) {
                    const id = +attrs.id;
                    const keyIndex = +attrs['key-index'];
                    if (tag === 'device') {
                        deviceList.push({
                            id,
                            keyIndex,
                            isHosted: !!(attrs['is_hosted'] && attrs['is_hosted'] === 'true')
                        });
                    }
                }
            }
            if (keyIndexNode?.tag === 'key-index-list') {
                keyIndex = {
                    timestamp: +keyIndexNode.attrs['ts'],
                    signedKeyIndex: keyIndexNode?.content,
                    expectedTimestamp: keyIndexNode.attrs['expected_ts'] ? +keyIndexNode.attrs['expected_ts'] : undefined
                };
            }
        }
        return {
            deviceList,
            keyIndex
        };
    }
}
//# sourceMappingURL=USyncDeviceProtocol.js.map