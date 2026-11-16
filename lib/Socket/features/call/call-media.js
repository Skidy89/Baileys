var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
};
var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var _CallMediaStream_instances, _CallMediaStream_engine, _CallMediaStream_channel, _CallMediaStream_socket, _CallMediaStream_relay, _CallMediaStream_startedAt, _CallMediaStream_audio, _CallMediaStream_readQueue, _CallMediaStream_onVideo, _CallMediaStream_queuedBytes, _CallMediaStream_readQueueBytes, _CallMediaStream_bound, _CallMediaStream_started, _CallMediaStream_timer, _CallMediaStream_micTimer, _CallMediaStream_videoTimer, _CallMediaStream_closed, _CallMediaStream_videoEnabled, _CallMediaStream_paused, _CallMediaStream_gain, _CallMediaStream_videoFrames, _CallMediaStream_videoFrame, _CallMediaStream_now, _CallMediaStream_sendAudioFrame, _CallMediaStream_startMic, _CallMediaStream_drain;
// Based on velowa (https://github.com/7ucg/velowa) by Baron - velowa License
import { CallEngine, RelayChannel } from '@skidy89/signal-protocol';
import { Duplex } from 'node:stream';
import { createSocket } from 'node:dgram';
import { performance } from 'node:perf_hooks';
const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 960;
const FRAME_BYTES = FRAME_SAMPLES * 2;
const FRAME_MS = 60;
const MAX_QUEUED_AUDIO_BYTES = SAMPLE_RATE * 2 / 2;
/**
 * RelayChannel transport around skid-signal's Rust call engine.
 * Writable input and readable output are 16 kHz, mono, signed 16-bit little-endian PCM.
 */
export class CallMediaStream extends Duplex {
    constructor(config, options = {}) {
        const { onVideo, ...streamOptions } = options;
        super({ ...streamOptions, allowHalfOpen: false });
        _CallMediaStream_instances.add(this);
        _CallMediaStream_engine.set(this, void 0);
        _CallMediaStream_channel.set(this, void 0);
        _CallMediaStream_socket.set(this, void 0);
        _CallMediaStream_relay.set(this, void 0);
        _CallMediaStream_startedAt.set(this, performance.now());
        _CallMediaStream_audio.set(this, []);
        _CallMediaStream_readQueue.set(this, []);
        _CallMediaStream_onVideo.set(this, void 0);
        _CallMediaStream_queuedBytes.set(this, 0);
        _CallMediaStream_readQueueBytes.set(this, 0);
        _CallMediaStream_bound.set(this, false);
        _CallMediaStream_started.set(this, false);
        _CallMediaStream_timer.set(this, void 0);
        _CallMediaStream_micTimer.set(this, void 0);
        _CallMediaStream_videoTimer.set(this, void 0);
        _CallMediaStream_closed.set(this, false);
        _CallMediaStream_videoEnabled.set(this, false);
        _CallMediaStream_paused.set(this, false);
        _CallMediaStream_gain.set(this, 1);
        _CallMediaStream_videoFrames.set(this, []);
        _CallMediaStream_videoFrame.set(this, 0);
        __classPrivateFieldSet(this, _CallMediaStream_engine, 'engine' in config ? config.engine : CallEngine.create(config), "f");
        __classPrivateFieldSet(this, _CallMediaStream_relay, { address: config.relayIp, port: config.relayPort }, "f");
        __classPrivateFieldSet(this, _CallMediaStream_channel, new RelayChannel(config.relayIp, config.relayPort), "f");
        __classPrivateFieldSet(this, _CallMediaStream_onVideo, onVideo, "f");
        __classPrivateFieldSet(this, _CallMediaStream_socket, createSocket(config.relayIp.includes(':') ? 'udp6' : 'udp4'), "f");
        __classPrivateFieldGet(this, _CallMediaStream_socket, "f").on('message', (packet) => {
            if (__classPrivateFieldGet(this, _CallMediaStream_closed, "f"))
                return;
            const error = __classPrivateFieldGet(this, _CallMediaStream_channel, "f").handleDatagram(__classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this), packet);
            if (error)
                return this.destroy(new Error(`Call relay: ${error}`));
            __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_drain).call(this);
        });
        __classPrivateFieldGet(this, _CallMediaStream_socket, "f").on('error', error => this.destroy(error));
        __classPrivateFieldGet(this, _CallMediaStream_socket, "f").bind(0, () => {
            __classPrivateFieldSet(this, _CallMediaStream_bound, true, "f");
            if (__classPrivateFieldGet(this, _CallMediaStream_closed, "f")) {
                __classPrivateFieldGet(this, _CallMediaStream_socket, "f").close();
                return;
            }
            __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_drain).call(this);
        });
    }
    get elapsedMs() {
        return __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this);
    }
    _read() {
        while (__classPrivateFieldGet(this, _CallMediaStream_readQueue, "f").length) {
            const chunk = __classPrivateFieldGet(this, _CallMediaStream_readQueue, "f").shift();
            __classPrivateFieldSet(this, _CallMediaStream_readQueueBytes, __classPrivateFieldGet(this, _CallMediaStream_readQueueBytes, "f") - chunk.length, "f");
            if (!this.push(chunk))
                return;
        }
    }
    _write(chunk, _encoding, callback) {
        if (chunk.length) {
            const copy = Buffer.from(chunk);
            __classPrivateFieldGet(this, _CallMediaStream_audio, "f").push(copy);
            __classPrivateFieldSet(this, _CallMediaStream_queuedBytes, __classPrivateFieldGet(this, _CallMediaStream_queuedBytes, "f") + copy.length, "f");
            while (__classPrivateFieldGet(this, _CallMediaStream_queuedBytes, "f") > MAX_QUEUED_AUDIO_BYTES) {
                const excess = __classPrivateFieldGet(this, _CallMediaStream_queuedBytes, "f") - MAX_QUEUED_AUDIO_BYTES;
                const first = __classPrivateFieldGet(this, _CallMediaStream_audio, "f")[0];
                if (first.length <= excess) {
                    __classPrivateFieldSet(this, _CallMediaStream_queuedBytes, __classPrivateFieldGet(this, _CallMediaStream_queuedBytes, "f") - first.length, "f");
                    __classPrivateFieldGet(this, _CallMediaStream_audio, "f").shift();
                }
                else {
                    __classPrivateFieldGet(this, _CallMediaStream_audio, "f")[0] = first.subarray(excess + (excess % 2));
                    __classPrivateFieldSet(this, _CallMediaStream_queuedBytes, __classPrivateFieldGet(this, _CallMediaStream_queuedBytes, "f") - (excess + (excess % 2)), "f");
                }
            }
        }
        callback();
    }
    _final(callback) {
        this.destroy();
        callback();
    }
    /** Send one H.264 Annex-B access unit; call `enableVideo()` first. */
    writeVideoFrame(frame) {
        if (!__classPrivateFieldGet(this, _CallMediaStream_videoEnabled, "f") && !this.enableVideo())
            throw new Error('This call does not support video');
        __classPrivateFieldGet(this, _CallMediaStream_engine, "f").handleVideoFrame(__classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this), Buffer.from(frame));
        __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_drain).call(this);
    }
    startVideoFrames(frames, fps = 15, gated = false) {
        if (!frames.length || !this.enableVideo(gated))
            return false;
        __classPrivateFieldSet(this, _CallMediaStream_videoFrames, frames, "f");
        __classPrivateFieldSet(this, _CallMediaStream_videoFrame, 0, "f");
        if (__classPrivateFieldGet(this, _CallMediaStream_videoTimer, "f"))
            clearInterval(__classPrivateFieldGet(this, _CallMediaStream_videoTimer, "f"));
        __classPrivateFieldSet(this, _CallMediaStream_videoTimer, setInterval(() => {
            var _a;
            if (!__classPrivateFieldGet(this, _CallMediaStream_paused, "f") && __classPrivateFieldGet(this, _CallMediaStream_videoFrames, "f").length) {
                this.writeVideoFrame(__classPrivateFieldGet(this, _CallMediaStream_videoFrames, "f")[__classPrivateFieldGet(this, _CallMediaStream_videoFrame, "f") % __classPrivateFieldGet(this, _CallMediaStream_videoFrames, "f").length]);
                __classPrivateFieldSet(this, _CallMediaStream_videoFrame, (_a = __classPrivateFieldGet(this, _CallMediaStream_videoFrame, "f"), _a++, _a), "f");
            }
        }, Math.max(1, Math.round(1000 / Math.min(30, Math.max(1, fps))))), "f");
        return true;
    }
    releaseVideo() {
        __classPrivateFieldSet(this, _CallMediaStream_videoEnabled, __classPrivateFieldGet(this, _CallMediaStream_engine, "f").enableVideo(false), "f");
        __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_drain).call(this);
    }
    stopVideo() {
        if (__classPrivateFieldGet(this, _CallMediaStream_videoTimer, "f"))
            clearInterval(__classPrivateFieldGet(this, _CallMediaStream_videoTimer, "f"));
        __classPrivateFieldSet(this, _CallMediaStream_videoTimer, undefined, "f");
        __classPrivateFieldSet(this, _CallMediaStream_videoFrames, [], "f");
        this.disableVideo();
    }
    pauseMedia() {
        __classPrivateFieldSet(this, _CallMediaStream_paused, true, "f");
    }
    resumeMedia() {
        __classPrivateFieldSet(this, _CallMediaStream_paused, false, "f");
    }
    clearAudio() {
        __classPrivateFieldGet(this, _CallMediaStream_audio, "f").length = 0;
        __classPrivateFieldSet(this, _CallMediaStream_queuedBytes, 0, "f");
    }
    setVolume(gain) {
        if (!Number.isFinite(gain) || gain < 0 || gain > 2)
            throw new RangeError('Call volume must be between 0 and 2');
        __classPrivateFieldSet(this, _CallMediaStream_gain, gain, "f");
    }
    get volume() {
        return __classPrivateFieldGet(this, _CallMediaStream_gain, "f");
    }
    get paused() {
        return __classPrivateFieldGet(this, _CallMediaStream_paused, "f");
    }
    get queuedSeconds() {
        return __classPrivateFieldGet(this, _CallMediaStream_queuedBytes, "f") / (SAMPLE_RATE * 2);
    }
    enableVideo(gated = false) {
        __classPrivateFieldSet(this, _CallMediaStream_videoEnabled, __classPrivateFieldGet(this, _CallMediaStream_engine, "f").enableVideo(gated), "f");
        __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_drain).call(this);
        return __classPrivateFieldGet(this, _CallMediaStream_videoEnabled, "f");
    }
    rekeyRecv(peerLid) {
        return __classPrivateFieldGet(this, _CallMediaStream_engine, "f").rekeyRecv(peerLid);
    }
    disableVideo() {
        __classPrivateFieldSet(this, _CallMediaStream_videoEnabled, false, "f");
        __classPrivateFieldGet(this, _CallMediaStream_engine, "f").disableVideo();
        __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_drain).call(this);
    }
    get stats() {
        return __classPrivateFieldGet(this, _CallMediaStream_engine, "f").mediaStats();
    }
    _destroy(error, callback) {
        __classPrivateFieldSet(this, _CallMediaStream_closed, true, "f");
        if (__classPrivateFieldGet(this, _CallMediaStream_timer, "f"))
            clearTimeout(__classPrivateFieldGet(this, _CallMediaStream_timer, "f"));
        if (__classPrivateFieldGet(this, _CallMediaStream_micTimer, "f"))
            clearInterval(__classPrivateFieldGet(this, _CallMediaStream_micTimer, "f"));
        if (__classPrivateFieldGet(this, _CallMediaStream_videoTimer, "f"))
            clearInterval(__classPrivateFieldGet(this, _CallMediaStream_videoTimer, "f"));
        if (__classPrivateFieldGet(this, _CallMediaStream_bound, "f")) {
            try {
                __classPrivateFieldGet(this, _CallMediaStream_socket, "f").close();
            }
            catch {
                // The UDP socket may already be closing after an error.
            }
        }
        __classPrivateFieldGet(this, _CallMediaStream_channel, "f").close(__classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this));
        callback(error);
    }
}
_CallMediaStream_engine = new WeakMap(), _CallMediaStream_channel = new WeakMap(), _CallMediaStream_socket = new WeakMap(), _CallMediaStream_relay = new WeakMap(), _CallMediaStream_startedAt = new WeakMap(), _CallMediaStream_audio = new WeakMap(), _CallMediaStream_readQueue = new WeakMap(), _CallMediaStream_onVideo = new WeakMap(), _CallMediaStream_queuedBytes = new WeakMap(), _CallMediaStream_readQueueBytes = new WeakMap(), _CallMediaStream_bound = new WeakMap(), _CallMediaStream_started = new WeakMap(), _CallMediaStream_timer = new WeakMap(), _CallMediaStream_micTimer = new WeakMap(), _CallMediaStream_videoTimer = new WeakMap(), _CallMediaStream_closed = new WeakMap(), _CallMediaStream_videoEnabled = new WeakMap(), _CallMediaStream_paused = new WeakMap(), _CallMediaStream_gain = new WeakMap(), _CallMediaStream_videoFrames = new WeakMap(), _CallMediaStream_videoFrame = new WeakMap(), _CallMediaStream_instances = new WeakSet(), _CallMediaStream_now = function _CallMediaStream_now() {
    return performance.now() - __classPrivateFieldGet(this, _CallMediaStream_startedAt, "f");
}, _CallMediaStream_sendAudioFrame = function _CallMediaStream_sendAudioFrame() {
    if (__classPrivateFieldGet(this, _CallMediaStream_closed, "f"))
        return;
    const frame = Buffer.alloc(FRAME_BYTES);
    let offset = 0;
    while (!__classPrivateFieldGet(this, _CallMediaStream_paused, "f") && offset < frame.length && __classPrivateFieldGet(this, _CallMediaStream_audio, "f").length) {
        const first = __classPrivateFieldGet(this, _CallMediaStream_audio, "f")[0];
        const length = Math.min(frame.length - offset, first.length);
        first.copy(frame, offset, 0, length);
        offset += length;
        __classPrivateFieldSet(this, _CallMediaStream_queuedBytes, __classPrivateFieldGet(this, _CallMediaStream_queuedBytes, "f") - length, "f");
        if (length === first.length)
            __classPrivateFieldGet(this, _CallMediaStream_audio, "f").shift();
        else
            __classPrivateFieldGet(this, _CallMediaStream_audio, "f")[0] = first.subarray(length);
    }
    const samples = new Int16Array(frame.buffer, frame.byteOffset, FRAME_SAMPLES);
    const pcm = Array.from(samples, sample => Math.max(-32768, Math.min(32767, Math.round(sample * (__classPrivateFieldGet(this, _CallMediaStream_paused, "f") ? 0 : __classPrivateFieldGet(this, _CallMediaStream_gain, "f"))))));
    __classPrivateFieldGet(this, _CallMediaStream_engine, "f").handleMicFrame(__classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this), pcm);
    __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_drain).call(this);
}, _CallMediaStream_startMic = function _CallMediaStream_startMic() {
    if (!__classPrivateFieldGet(this, _CallMediaStream_micTimer, "f"))
        __classPrivateFieldSet(this, _CallMediaStream_micTimer, setInterval(() => __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_sendAudioFrame).call(this), FRAME_MS), "f");
}, _CallMediaStream_drain = function _CallMediaStream_drain() {
    if (__classPrivateFieldGet(this, _CallMediaStream_closed, "f"))
        return;
    const now = __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this);
    for (let i = 0; i < 1000; i++) {
        let moved = false;
        for (let packet = __classPrivateFieldGet(this, _CallMediaStream_channel, "f").pollTransmit(); packet; packet = __classPrivateFieldGet(this, _CallMediaStream_channel, "f").pollTransmit()) {
            moved = true;
            __classPrivateFieldGet(this, _CallMediaStream_socket, "f").send(packet, __classPrivateFieldGet(this, _CallMediaStream_relay, "f").port, __classPrivateFieldGet(this, _CallMediaStream_relay, "f").address, error => error && this.destroy(error));
        }
        if (!__classPrivateFieldGet(this, _CallMediaStream_started, "f") && __classPrivateFieldGet(this, _CallMediaStream_channel, "f").isOpen()) {
            __classPrivateFieldSet(this, _CallMediaStream_started, true, "f");
            __classPrivateFieldGet(this, _CallMediaStream_engine, "f").start(now, Date.now());
            moved = true;
        }
        for (let packet = __classPrivateFieldGet(this, _CallMediaStream_channel, "f").pollInbound(); packet; packet = __classPrivateFieldGet(this, _CallMediaStream_channel, "f").pollInbound()) {
            __classPrivateFieldGet(this, _CallMediaStream_engine, "f").handleRelayPacket(now, packet);
            moved = true;
        }
        if (__classPrivateFieldGet(this, _CallMediaStream_started, "f")) {
            const output = __classPrivateFieldGet(this, _CallMediaStream_engine, "f").pollOutput();
            if (output.kind)
                moved = true;
            if (output.kind === 1 && output.data) {
                const error = __classPrivateFieldGet(this, _CallMediaStream_channel, "f").write(now, output.data);
                if (error)
                    return this.destroy(new Error(`Call relay: ${error}`));
                moved = true;
            }
            else if (output.kind === 2 && output.pcm?.length) {
                const pcm = Buffer.allocUnsafe(output.pcm.length * 2);
                for (let j = 0; j < output.pcm.length; j++) {
                    const sample = Math.max(-32768, Math.min(32767, Math.round(output.pcm[j])));
                    pcm.writeInt16LE(sample, j * 2);
                }
                __classPrivateFieldGet(this, _CallMediaStream_readQueue, "f").push(pcm);
                __classPrivateFieldSet(this, _CallMediaStream_readQueueBytes, __classPrivateFieldGet(this, _CallMediaStream_readQueueBytes, "f") + pcm.length, "f");
                while (__classPrivateFieldGet(this, _CallMediaStream_readQueueBytes, "f") > MAX_QUEUED_AUDIO_BYTES) {
                    __classPrivateFieldSet(this, _CallMediaStream_readQueueBytes, __classPrivateFieldGet(this, _CallMediaStream_readQueueBytes, "f") - __classPrivateFieldGet(this, _CallMediaStream_readQueue, "f").shift().length, "f");
                }
                this._read();
                moved = true;
            }
            else if (output.kind === 3 && output.event) {
                this.emit('media-event', output.event);
                if (output.event === 'MediaConnected' || output.event === 'RelayAllocated')
                    __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_startMic).call(this);
                if (output.event === 'RelayAllocateFailed' || output.event === 'RelayAllocateTimedOut' || output.event === 'MediaSetupFailed') {
                    this.destroy(new Error(`Call media setup failed: ${output.event}`));
                    return;
                }
            }
            else if (output.kind === 4 && output.data) {
                const frame = Buffer.from(output.data);
                __classPrivateFieldGet(this, _CallMediaStream_onVideo, "f")?.call(this, frame);
                this.emit('video', frame);
                moved = true;
            }
        }
        if (!moved)
            break;
    }
    if (__classPrivateFieldGet(this, _CallMediaStream_timer, "f"))
        clearTimeout(__classPrivateFieldGet(this, _CallMediaStream_timer, "f"));
    const relayTimeout = __classPrivateFieldGet(this, _CallMediaStream_channel, "f").pollTimeout();
    const engineTimeout = __classPrivateFieldGet(this, _CallMediaStream_started, "f") ? __classPrivateFieldGet(this, _CallMediaStream_engine, "f").pollTimeout() : null;
    const timeouts = [relayTimeout, engineTimeout].filter((timeout) => timeout !== null && timeout >= 0);
    if (timeouts.length && !__classPrivateFieldGet(this, _CallMediaStream_closed, "f")) {
        __classPrivateFieldSet(this, _CallMediaStream_timer, setTimeout(() => {
            const now = __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this);
            const error = __classPrivateFieldGet(this, _CallMediaStream_channel, "f").handleTimeout(now);
            if (error)
                return this.destroy(new Error(`Call relay: ${error}`));
            if (__classPrivateFieldGet(this, _CallMediaStream_started, "f"))
                __classPrivateFieldGet(this, _CallMediaStream_engine, "f").handleTimeout(now);
            __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_drain).call(this);
        }, Math.max(0, Math.min(...timeouts) - __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this))), "f");
    }
};
export const createCallMediaStream = (config, options) => new CallMediaStream(config, options);
export const createCallMediaStreamFromEngine = (engine, relayIp, relayPort, options) => new CallMediaStream({ engine, relayIp, relayPort }, options);
const mocked = new RelayChannel("127.0.0.1", 1234);
console.log(`Mocked call media stream created`);
console.log(mocked.isOpen());
console.log(mocked.handleTimeout(0));
console.log(mocked.close(0));
//# sourceMappingURL=call-media.js.map