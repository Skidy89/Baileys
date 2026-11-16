export * from './auth-types/index.js';
export * from './chats/index.js';
export * from './event-types/index.js';
export * from './groups/index.js';
export * from './labels/index.js';
export * from './messages/index.js';
export * from './products/index.js';
export * from './signal-types/index.js';
export * from './socket-types/index.js';
export var DisconnectReason;
(function (DisconnectReason) {
    DisconnectReason[DisconnectReason["connectionClosed"] = 428] = "connectionClosed";
    DisconnectReason[DisconnectReason["connectionLost"] = 408] = "connectionLost";
    DisconnectReason[DisconnectReason["connectionReplaced"] = 440] = "connectionReplaced";
    DisconnectReason[DisconnectReason["timedOut"] = 408] = "timedOut";
    DisconnectReason[DisconnectReason["loggedOut"] = 401] = "loggedOut";
    DisconnectReason[DisconnectReason["badSession"] = 500] = "badSession";
    DisconnectReason[DisconnectReason["restartRequired"] = 515] = "restartRequired";
    DisconnectReason[DisconnectReason["multideviceMismatch"] = 411] = "multideviceMismatch";
    DisconnectReason[DisconnectReason["forbidden"] = 403] = "forbidden";
    DisconnectReason[DisconnectReason["unavailableService"] = 503] = "unavailableService";
})(DisconnectReason || (DisconnectReason = {}));
//# sourceMappingURL=index.js.map