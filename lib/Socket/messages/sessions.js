import { parseAndInjectE2ESessions } from '../../Utils/index.js';
import { isHostedLidUser, isHostedPnUser, isJidMetaAI, isLidUser, isPnUser, S_WHATSAPP_NET } from '../../WABinary/index.js';
export const makeSessionManager = ({ query, signalRepository, logger }) => {
    const assertSessions = async (jids, force) => {
        let didFetchNewSession = false;
        const uniqueJids = [...new Set(jids)];
        logger?.debug({ jids }, 'assertSessions call with jids');
        const validations = force ? [] : await Promise.all(uniqueJids.map(jid => signalRepository.validateSession(jid)));
        const jidsRequiringFetch = force ? uniqueJids : uniqueJids.filter((_, index) => !validations[index]?.exists);
        if (jidsRequiringFetch.length) {
            const wireJids = [
                ...jidsRequiringFetch.filter(jid => isLidUser(jid) || isHostedLidUser(jid) || !!isJidMetaAI(jid)),
                ...((await signalRepository.lidMapping.getLIDsForPNs(jidsRequiringFetch.filter(jid => isPnUser(jid) || isHostedPnUser(jid)))) || []).map(a => a.lid)
            ];
            logger?.debug({ jidsRequiringFetch, wireJids }, 'fetching sessions');
            const result = await query({
                tag: 'iq',
                attrs: { xmlns: 'encrypt', type: 'get', to: S_WHATSAPP_NET },
                content: [
                    {
                        tag: 'key',
                        attrs: {},
                        content: wireJids.map(jid => {
                            const attrs = { jid };
                            if (force)
                                attrs.reason = 'identity';
                            return { tag: 'user', attrs };
                        })
                    }
                ]
            });
            await parseAndInjectE2ESessions(result, signalRepository);
            didFetchNewSession = true;
        }
        return didFetchNewSession;
    };
    return { assertSessions };
};
//# sourceMappingURL=sessions.js.map