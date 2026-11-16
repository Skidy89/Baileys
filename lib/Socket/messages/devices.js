import { extractDeviceJids } from '../../Utils/index.js';
import { isHostedLidUser, isLidUser, jidDecode, jidEncode } from '../../WABinary/index.js';
import { USyncQuery, USyncUser } from '../../WAUSync/index.js';
export const makeDeviceResolver = (dependencies) => {
    const { authState, userDevicesCache, devicesMutex, signalRepository, assertSessions, executeUSyncQuery, logger } = dependencies;
    const getUSyncDevices = async (jids, useCache, ignoreZeroDevices) => {
        const deviceResults = [];
        if (!useCache) {
            if (logger)
                logger.debug('not using cache for devices');
        }
        const toFetch = [];
        const jidsWithUser = [];
        const usersToFetch = useCache ? new Set() : undefined;
        for (const jid of jids) {
            const decoded = jidDecode(jid);
            const user = decoded?.user;
            const device = decoded?.device;
            const isExplicitDevice = typeof device === 'number' && device >= 0;
            if (isExplicitDevice && user) {
                deviceResults.push({ user, device, jid });
                continue;
            }
            const normalizedJid = decoded
                ? jidEncode(decoded.user, decoded.server === 'c.us' ? 's.whatsapp.net' : decoded.server)
                : '';
            jidsWithUser.push({ jid: normalizedJid, user });
            if (user)
                usersToFetch?.add(user);
        }
        let mgetDevices;
        const userKeysToFetch = usersToFetch ? [...usersToFetch] : [];
        if (useCache && userDevicesCache.mget) {
            mgetDevices = await userDevicesCache.mget(userKeysToFetch);
        }
        const cachedDeviceLists = useCache && !userDevicesCache.mget
            ? new Map(await Promise.all(userKeysToFetch.map(async (user) => [user, (await userDevicesCache.get(user))])))
            : undefined;
        for (let i = 0; i < jidsWithUser.length; i++) {
            const { jid, user } = jidsWithUser[i];
            if (useCache) {
                const devices = mgetDevices?.[user] || cachedDeviceLists?.get(user);
                if (devices) {
                    const devicesWithJid = devices.map(d => ({
                        ...d,
                        jid: jidEncode(d.user, d.server, d.device)
                    }));
                    deviceResults.push(...devicesWithJid);
                    if (logger)
                        logger.trace({ user }, 'using cache for devices');
                }
                else {
                    toFetch.push(jid);
                }
            }
            else {
                toFetch.push(jid);
            }
        }
        if (!toFetch.length) {
            return deviceResults;
        }
        const requestedLidUsers = new Set();
        for (const jid of toFetch) {
            if (isLidUser(jid) || isHostedLidUser(jid)) {
                const user = jidDecode(jid)?.user;
                if (user)
                    requestedLidUsers.add(user);
            }
        }
        const query = new USyncQuery().withContext('message').withDeviceProtocol().withLIDProtocol();
        for (const jid of toFetch) {
            query.withUser(new USyncUser().withId(jid)); // todo: investigate - the idea here is that <user> should have an inline lid field with the lid being the pn equivalent
        }
        const result = await executeUSyncQuery(query);
        if (result) {
            const lidResults = result.list.filter(a => !!a.lid);
            if (lidResults.length > 0) {
                if (logger)
                    logger.trace('Storing LID maps from device call');
                const mappings = lidResults.flatMap(a => {
                    const lid = a.lid;
                    const pn = a.id;
                    const decodedLid = jidDecode(lid);
                    const decodedPn = jidDecode(pn);
                    const devices = a.devices
                        ?.deviceList;
                    return [
                        { lid, pn },
                        ...(decodedLid && decodedPn
                            ? (devices ?? []).filter(device => device.id > 0).map(({ id, isHosted }) => ({
                                lid: jidEncode(decodedLid.user, isHosted ? 'hosted.lid' : 'lid', id),
                                pn: jidEncode(decodedPn.user, isHosted ? 'hosted' : decodedPn.server, id)
                            }))
                            : [])
                    ];
                });
                await signalRepository.lidMapping.storeLIDPNMappings(mappings);
                // Force-refresh sessions for newly mapped LIDs to align identity addressing
                try {
                    const lids = mappings.map(({ lid }) => lid);
                    if (lids.length) {
                        await assertSessions(lids, true);
                    }
                }
                catch (e) {
                    if (logger)
                        logger.warn({ e, count: lidResults.length }, 'failed to assert sessions for newly mapped LIDs');
                }
            }
            const extracted = extractDeviceJids(result?.list, authState.creds.me.id, authState.creds.me.lid, ignoreZeroDevices);
            const deviceMap = {};
            for (const item of extracted) {
                deviceMap[item.user] = deviceMap[item.user] || [];
                deviceMap[item.user]?.push(item);
            }
            // Process each user's devices as a group for bulk LID migration
            for (const [user, userDevices] of Object.entries(deviceMap)) {
                const isLidUser = requestedLidUsers.has(user);
                // Process all devices for this user
                for (const item of userDevices) {
                    const finalJid = isLidUser
                        ? jidEncode(user, item.server, item.device)
                        : jidEncode(item.user, item.server, item.device);
                    deviceResults.push({
                        ...item,
                        jid: finalJid
                    });
                    if (logger)
                        logger.debug({
                            user: item.user,
                            device: item.device,
                            finalJid,
                            usedLid: isLidUser
                        }, 'Processed device with LID priority');
                }
            }
            await devicesMutex.mutex(async () => {
                if (userDevicesCache.mset) {
                    // if the cache supports mset, we can set all devices in one go
                    await userDevicesCache.mset(Object.entries(deviceMap).map(([key, value]) => ({ key, value })));
                }
                else {
                    for (const key in deviceMap) {
                        if (deviceMap[key])
                            await userDevicesCache.set(key, deviceMap[key]);
                    }
                }
            });
            const userDeviceUpdates = {};
            for (const [userId, devices] of Object.entries(deviceMap)) {
                if (devices && devices.length > 0) {
                    userDeviceUpdates[userId] = devices.map(d => d.device?.toString() || '0');
                }
            }
            const updatedUserIds = Object.keys(userDeviceUpdates);
            if (updatedUserIds.length > 0) {
                try {
                    await authState.keys.set({ 'device-list': userDeviceUpdates });
                    if (logger)
                        logger.debug({ userCount: updatedUserIds.length }, 'stored user device lists for bulk migration');
                }
                catch (error) {
                    if (logger)
                        logger.warn({ error }, 'failed to store user device lists');
                }
            }
        }
        return deviceResults;
    };
    return { getUSyncDevices };
};
//# sourceMappingURL=devices.js.map