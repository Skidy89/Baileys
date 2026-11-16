import { binaryNodeToString } from '../../WABinary/index.js';
import { DEF_CALLBACK_PREFIX, DEF_TAG_PREFIX } from '../../Defaults/index.js';
export const dispatchWebSocketFrame = (ws, frame, logger) => {
    let anyTriggered = ws.emit('frame', frame);
    if (frame instanceof Uint8Array)
        return;
    if (logger?.level === 'trace')
        logger.trace({ xml: binaryNodeToString(frame), msg: 'recv xml' });
    const msgId = frame.attrs.id;
    anyTriggered = ws.emit(`${DEF_TAG_PREFIX}${msgId}`, frame) || anyTriggered;
    const l0 = frame.tag;
    const l1 = frame.attrs;
    const l2 = Array.isArray(frame.content) ? frame.content[0]?.tag : '';
    for (const key of Object.keys(l1)) {
        anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]},${l2}`, frame) || anyTriggered;
        anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}:${l1[key]}`, frame) || anyTriggered;
        anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},${key}`, frame) || anyTriggered;
    }
    anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0},,${l2}`, frame) || anyTriggered;
    anyTriggered = ws.emit(`${DEF_CALLBACK_PREFIX}${l0}`, frame) || anyTriggered;
    if (!anyTriggered && logger?.level === 'debug') {
        logger.debug({ unhandled: true, msgId: frame.attrs.id, fromMe: false, frame }, 'communication recv');
    }
};
//# sourceMappingURL=websocket.js.map