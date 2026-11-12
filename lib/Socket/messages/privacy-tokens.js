import { unixTimestampSeconds } from '../../Utils/index.js';
import { jidNormalizedUser, S_WHATSAPP_NET } from '../../WABinary/index.js';
export const makePrivacyTokenIssuer = (query) => async (jids, timestamp) => {
    const t = (timestamp ?? unixTimestampSeconds()).toString();
    return query({
        tag: 'iq',
        attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'privacy' },
        content: [
            {
                tag: 'tokens',
                attrs: {},
                content: jids.map(jid => ({
                    tag: 'token',
                    attrs: { jid: jidNormalizedUser(jid), t, type: 'trusted_contact' }
                }))
            }
        ]
    });
};
//# sourceMappingURL=privacy-tokens.js.map