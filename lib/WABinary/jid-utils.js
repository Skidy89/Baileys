export const S_WHATSAPP_NET = '@s.whatsapp.net';
export const OFFICIAL_BIZ_JID = '16505361212@c.us';
export const SERVER_JID = 'server@c.us';
export const PSA_WID = '0@c.us';
export const STORIES_JID = 'status@broadcast';
export const META_AI_JID = '13135550002@c.us';
export var WAJIDDomains;
(function (WAJIDDomains) {
    WAJIDDomains[WAJIDDomains["WHATSAPP"] = 0] = "WHATSAPP";
    WAJIDDomains[WAJIDDomains["LID"] = 1] = "LID";
    WAJIDDomains[WAJIDDomains["HOSTED"] = 128] = "HOSTED";
    WAJIDDomains[WAJIDDomains["HOSTED_LID"] = 129] = "HOSTED_LID";
})(WAJIDDomains || (WAJIDDomains = {}));
export const getServerFromDomainType = (initialServer, domainType) => {
    switch (domainType) {
        case WAJIDDomains.LID:
            return 'lid';
        case WAJIDDomains.HOSTED:
            return 'hosted';
        case WAJIDDomains.HOSTED_LID:
            return 'hosted.lid';
        case WAJIDDomains.WHATSAPP:
        default:
            return initialServer;
    }
};
export const jidEncode = (user, server, device, agent) => {
    return `${user || ''}${!!agent ? `_${agent}` : ''}${!!device ? `:${device}` : ''}@${server}`;
};
export const jidDecode = (jid) => {
    if (typeof jid !== 'string')
        return undefined;
    const sepIdx = jid.indexOf('@');
    if (sepIdx < 0) {
        return undefined;
    }
    const server = jid.slice(sepIdx + 1);
    const colonIdx = jid.indexOf(':');
    const deviceIdx = colonIdx >= 0 && colonIdx < sepIdx ? colonIdx : -1;
    const userAgentEnd = deviceIdx >= 0 ? deviceIdx : sepIdx;
    const underscoreIdx = jid.indexOf('_');
    const agentIdx = underscoreIdx >= 0 && underscoreIdx < userAgentEnd ? underscoreIdx : -1;
    const user = jid.slice(0, agentIdx >= 0 ? agentIdx : userAgentEnd);
    let domainType = WAJIDDomains.WHATSAPP;
    if (server === 'lid') {
        domainType = WAJIDDomains.LID;
    }
    else if (server === 'hosted') {
        domainType = WAJIDDomains.HOSTED;
    }
    else if (server === 'hosted.lid') {
        domainType = WAJIDDomains.HOSTED_LID;
    }
    else if (agentIdx >= 0) {
        const nextUnderscore = jid.indexOf('_', agentIdx + 1);
        const agentEnd = nextUnderscore >= 0 && nextUnderscore < userAgentEnd ? nextUnderscore : userAgentEnd;
        const agent = jid.slice(agentIdx + 1, agentEnd);
        if (agent)
            domainType = parseInt(agent);
    }
    let device;
    if (deviceIdx >= 0) {
        const nextColon = jid.indexOf(':', deviceIdx + 1);
        const deviceEnd = nextColon >= 0 && nextColon < sepIdx ? nextColon : sepIdx;
        const deviceValue = jid.slice(deviceIdx + 1, deviceEnd);
        device = deviceValue ? +deviceValue : undefined;
    }
    return {
        server: server,
        user,
        domainType,
        device
    };
};
/** is the jid a user */
export const areJidsSameUser = (jid1, jid2) => jid1 === jid2 || jidDecode(jid1)?.user === jidDecode(jid2)?.user;
/** is the jid Meta AI */
export const isJidMetaAI = (jid) => jid?.endsWith('@bot');
/** is the jid a PN user */
export const isPnUser = (jid) => jid?.endsWith('@s.whatsapp.net');
/** is the jid a LID */
export const isLidUser = (jid) => jid?.endsWith('@lid');
/** is the jid a broadcast */
export const isJidBroadcast = (jid) => jid?.endsWith('@broadcast');
/** is the jid a group */
export const isJidGroup = (jid) => jid?.endsWith('@g.us');
/** is the jid the status broadcast */
export const isJidStatusBroadcast = (jid) => jid === 'status@broadcast';
/** is the jid a newsletter */
export const isJidNewsletter = (jid) => jid?.endsWith('@newsletter');
/** is the jid a hosted PN */
export const isHostedPnUser = (jid) => jid?.endsWith('@hosted');
/** is the jid a hosted LID */
export const isHostedLidUser = (jid) => jid?.endsWith('@hosted.lid');
export const isJidBot = (jid) => {
    if (jid?.length !== 16 || !jid.endsWith('@c.us'))
        return false;
    return jid.startsWith('1313555') || jid.startsWith('131655500');
};
export const jidNormalizedUser = (jid) => {
    if (typeof jid === 'string') {
        const separator = jid.indexOf('@');
        if (separator >= 0 && jid.indexOf(':') < 0 && jid.indexOf('_') < 0 && jid.slice(separator + 1) !== 'c.us') {
            return jid;
        }
    }
    const result = jidDecode(jid);
    if (!result) {
        return '';
    }
    const { user, server } = result;
    return jidEncode(user, server === 'c.us' ? 's.whatsapp.net' : server);
};
export const transferDevice = (fromJid, toJid) => {
    const fromDecoded = jidDecode(fromJid);
    const deviceId = fromDecoded?.device || 0;
    const { server, user } = jidDecode(toJid);
    // Device 99 belongs to the hosted PN/LID address pair.
    const targetServer = deviceId === 99 && server === 'lid' ? 'hosted.lid' : server;
    return jidEncode(user, targetServer, deviceId);
};
//# sourceMappingURL=jid-utils.js.map