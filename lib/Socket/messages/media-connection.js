import { getBinaryNodeChild, getBinaryNodeChildren, S_WHATSAPP_NET } from '../../WABinary/index.js';
export const makeMediaConnectionManager = (query, logger, defaultMediaHost) => {
    let mediaConn;
    let refreshing;
    let mediaHost = defaultMediaHost;
    const refreshMediaConn = async (forceGet = false) => {
        if (refreshing)
            return refreshing;
        if (mediaConn) {
            const media = await mediaConn;
            if (!forceGet && Date.now() - media.fetchDate.getTime() <= media.ttl * 1000) {
                return media;
            }
            if (refreshing)
                return refreshing;
        }
        const request = (async () => {
            const result = await query({
                tag: 'iq',
                attrs: { type: 'set', xmlns: 'w:m', to: S_WHATSAPP_NET },
                content: [{ tag: 'media_conn', attrs: {} }]
            });
            const mediaConnNode = getBinaryNodeChild(result, 'media_conn');
            const node = {
                hosts: getBinaryNodeChildren(mediaConnNode, 'host').map(({ attrs }) => ({
                    hostname: attrs.hostname,
                    maxContentLengthBytes: +attrs.maxContentLengthBytes
                })),
                auth: mediaConnNode.attrs.auth,
                ttl: +mediaConnNode.attrs.ttl,
                fetchDate: new Date()
            };
            logger?.debug('fetched media conn');
            if (node.hosts[0])
                mediaHost = node.hosts[0].hostname;
            return node;
        })();
        refreshing = request;
        mediaConn = request;
        try {
            return await request;
        }
        catch (error) {
            if (mediaConn === request)
                mediaConn = undefined;
            throw error;
        }
        finally {
            if (refreshing === request)
                refreshing = undefined;
        }
    };
    return {
        refreshMediaConn,
        getMediaHost: () => mediaHost,
        reset: () => {
            mediaConn = undefined;
            refreshing = undefined;
        }
    };
};
//# sourceMappingURL=media-connection.js.map