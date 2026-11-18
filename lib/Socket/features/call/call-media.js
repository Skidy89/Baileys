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
var _CallMediaStream_instances, _CallMediaStream_useOpus, _CallMediaStream_encoder, _CallMediaStream_engine, _CallMediaStream_channel, _CallMediaStream_socket, _CallMediaStream_relay, _CallMediaStream_startedAt, _CallMediaStream_audio, _CallMediaStream_readQueue, _CallMediaStream_onVideo, _CallMediaStream_queuedBytes, _CallMediaStream_udpSent, _CallMediaStream_opusFile, _CallMediaStream_audioIn, _CallMediaStream_audioPos, _CallMediaStream_readQueueBytes, _CallMediaStream_bound, _CallMediaStream_started, _CallMediaStream_timer, _CallMediaStream_micTimer, _CallMediaStream_videoTimer, _CallMediaStream_closed, _CallMediaStream_connected, _CallMediaStream_videoEnabled, _CallMediaStream_paused, _CallMediaStream_gain, _CallMediaStream_videoFrames, _CallMediaStream_videoFrame, _CallMediaStream_videoFps, _CallMediaStream_now, _CallMediaStream_sendAudioFrame, _CallMediaStream_startMic, _CallMediaStream_markConnected, _CallMediaStream_drain, _CallMediaStream_startVideo;
// Based on velowa (https://github.com/7ucg/velowa) by Baron - velowa License
import { CallEngine, RelayChannel } from '@skidy89/signal-protocol';
import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { createSocket } from 'node:dgram';
import { performance } from 'node:perf_hooks';
const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 960;
const FRAME_MS = 60;
// At 24 kbit/s constant bitrate, each 60 ms Opus packet occupies 180 bytes.
const OPUS_PACKET_BYTES = 180;
const MAX_QUEUED_AUDIO_BYTES = (SAMPLE_RATE * 2) / 2;
/**
 * RelayChannel transport around skid-signal's Rust call engine.
 * Writable input and readable output are 16 kHz, mono, signed 16-bit little-endian PCM.
 */
export class CallMediaStream extends Duplex {
    constructor(config, options = {}, logger) {
        const { onVideo, ...streamOptions } = options;
        super({ ...streamOptions, allowHalfOpen: false });
        _CallMediaStream_instances.add(this);
        _CallMediaStream_useOpus.set(this, void 0);
        _CallMediaStream_encoder.set(this, void 0);
        _CallMediaStream_engine.set(this, void 0);
        _CallMediaStream_channel.set(this, void 0);
        _CallMediaStream_socket.set(this, void 0);
        _CallMediaStream_relay.set(this, void 0);
        _CallMediaStream_startedAt.set(this, performance.now());
        _CallMediaStream_audio.set(this, []);
        _CallMediaStream_readQueue.set(this, []);
        _CallMediaStream_onVideo.set(this, void 0);
        _CallMediaStream_queuedBytes.set(this, 0);
        _CallMediaStream_udpSent.set(this, 0);
        _CallMediaStream_opusFile.set(this, void 0);
        _CallMediaStream_audioIn.set(this, void 0);
        _CallMediaStream_audioPos.set(this, 0);
        _CallMediaStream_readQueueBytes.set(this, 0);
        _CallMediaStream_bound.set(this, false);
        _CallMediaStream_started.set(this, false);
        _CallMediaStream_timer.set(this, void 0);
        _CallMediaStream_micTimer.set(this, void 0);
        _CallMediaStream_videoTimer.set(this, void 0);
        _CallMediaStream_closed.set(this, false);
        _CallMediaStream_connected.set(this, false);
        _CallMediaStream_videoEnabled.set(this, false);
        _CallMediaStream_paused.set(this, false);
        _CallMediaStream_gain.set(this, 1);
        _CallMediaStream_videoFrames.set(this, []);
        _CallMediaStream_videoFrame.set(this, 0);
        _CallMediaStream_videoFps.set(this, 15);
        this.logger = logger ?? options.logger;
        __classPrivateFieldSet(this, _CallMediaStream_useOpus, 'audio' in config && config.audio === 'opus', "f");
        __classPrivateFieldSet(this, _CallMediaStream_engine, 'engine' in config ? config.engine : CallEngine.create(config), "f");
        __classPrivateFieldSet(this, _CallMediaStream_relay, { address: config.relayIp, port: config.relayPort }, "f");
        __classPrivateFieldSet(this, _CallMediaStream_channel, new RelayChannel(config.relayIp, config.relayPort), "f");
        __classPrivateFieldSet(this, _CallMediaStream_onVideo, onVideo, "f");
        __classPrivateFieldSet(this, _CallMediaStream_socket, createSocket(config.relayIp.includes(':') ? 'udp6' : 'udp4'), "f");
        this.logger?.info({
            relayIp: config.relayIp,
            relayPort: config.relayPort,
            ipVersion: config.relayIp.includes(':') ? 'udp6' : 'udp4',
            engineProvided: 'engine' in config
        }, 'Call media stream created');
        __classPrivateFieldGet(this, _CallMediaStream_socket, "f").on('message', (packet) => {
            if (__classPrivateFieldGet(this, _CallMediaStream_closed, "f"))
                return;
            const error = __classPrivateFieldGet(this, _CallMediaStream_channel, "f").handleDatagram(__classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this), packet);
            if (error) {
                this.logger?.error({ error, bytes: packet.length }, 'Failed to handle relay datagram');
                return this.destroy(new Error(`Call relay: ${error}`));
            }
            __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_drain).call(this);
        });
        __classPrivateFieldGet(this, _CallMediaStream_socket, "f").on('error', error => {
            this.logger?.error({ err: error }, 'UDP socket error');
            this.destroy(error);
        });
        __classPrivateFieldGet(this, _CallMediaStream_socket, "f").bind(0, () => {
            __classPrivateFieldSet(this, _CallMediaStream_bound, true, "f");
            if (__classPrivateFieldGet(this, _CallMediaStream_closed, "f")) {
                this.logger?.debug('UDP socket bound after the stream was closed, closing socket');
                __classPrivateFieldGet(this, _CallMediaStream_socket, "f").close();
                return;
            }
            this.logger?.debug({ relayIp: __classPrivateFieldGet(this, _CallMediaStream_relay, "f").address, relayPort: __classPrivateFieldGet(this, _CallMediaStream_relay, "f").port }, 'UDP socket bound');
            __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_drain).call(this);
        });
    }
    get elapsedMs() {
        return __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this);
    }
    get connected() {
        return __classPrivateFieldGet(this, _CallMediaStream_connected, "f");
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
            if (__classPrivateFieldGet(this, _CallMediaStream_queuedBytes, "f") > MAX_QUEUED_AUDIO_BYTES) {
                this.logger?.debug({
                    queuedBytes: __classPrivateFieldGet(this, _CallMediaStream_queuedBytes, "f"),
                    maxBytes: MAX_QUEUED_AUDIO_BYTES,
                    droppedBytes: __classPrivateFieldGet(this, _CallMediaStream_queuedBytes, "f") - MAX_QUEUED_AUDIO_BYTES
                }, 'Outgoing audio queue is full, dropping oldest audio');
            }
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
        this.logger?.debug('Writable side finished, destroying call media stream');
        this.destroy();
        callback();
    }
    playOpusFile(packets) {
        if (!__classPrivateFieldGet(this, _CallMediaStream_useOpus, "f") || !packets.length || packets.length % OPUS_PACKET_BYTES)
            throw new Error('Invalid Opus playback');
        this.clearAudio();
        __classPrivateFieldSet(this, _CallMediaStream_opusFile, packets, "f");
    }
    /** Queue PCM frames directly for the 60 ms microphone tick, bypassing Writable buffering. */
    speak(pcm, replace = false) {
        if (replace)
            this.clearAudio();
        const rest = !replace && __classPrivateFieldGet(this, _CallMediaStream_audioIn, "f") ? __classPrivateFieldGet(this, _CallMediaStream_audioIn, "f").subarray(__classPrivateFieldGet(this, _CallMediaStream_audioPos, "f")) : new Int16Array(0);
        const next = new Int16Array(rest.length + pcm.length);
        next.set(rest);
        next.set(pcm, rest.length);
        __classPrivateFieldSet(this, _CallMediaStream_audioIn, next, "f");
        __classPrivateFieldSet(this, _CallMediaStream_audioPos, 0, "f");
    }
    /** Send one H.264 Annex-B access unit; call `enableVideo()` first. */
    writeVideoFrame(frame) {
        if (!__classPrivateFieldGet(this, _CallMediaStream_videoEnabled, "f") && !this.enableVideo()) {
            this.logger?.warn('Cannot write video frame, this call does not support video');
            throw new Error('This call does not support video');
        }
        this.logger?.trace({ bytes: frame.length }, 'Sending video frame to peer');
        __classPrivateFieldGet(this, _CallMediaStream_engine, "f").handleVideoFrame(__classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this), Buffer.from(frame));
        __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_drain).call(this);
    }
    startVideoFrames(frames, fps = 15, gated = false) {
        if (!frames.length) {
            this.logger?.warn('Cannot start video playback, no frames were provided');
            return false;
        }
        if (!this.enableVideo(gated)) {
            this.logger?.warn({ gated }, 'Cannot start video playback, video could not be enabled');
            return false;
        }
        this.logger?.info({ frames: frames.length, fps, gated }, 'Starting video frame playback');
        __classPrivateFieldSet(this, _CallMediaStream_videoFrames, frames, "f");
        __classPrivateFieldSet(this, _CallMediaStream_videoFrame, 0, "f");
        __classPrivateFieldSet(this, _CallMediaStream_videoFps, fps, "f");
        if (__classPrivateFieldGet(this, _CallMediaStream_videoTimer, "f"))
            clearInterval(__classPrivateFieldGet(this, _CallMediaStream_videoTimer, "f"));
        __classPrivateFieldSet(this, _CallMediaStream_videoTimer, undefined, "f");
        __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_startVideo).call(this);
        return true;
    }
    releaseVideo() {
        this.logger?.debug('Releasing video');
        __classPrivateFieldSet(this, _CallMediaStream_videoEnabled, __classPrivateFieldGet(this, _CallMediaStream_engine, "f").enableVideo(false), "f");
        __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_drain).call(this);
    }
    stopVideo() {
        this.logger?.info('Stopping video');
        if (__classPrivateFieldGet(this, _CallMediaStream_videoTimer, "f"))
            clearInterval(__classPrivateFieldGet(this, _CallMediaStream_videoTimer, "f"));
        __classPrivateFieldSet(this, _CallMediaStream_videoTimer, undefined, "f");
        __classPrivateFieldSet(this, _CallMediaStream_videoFrames, [], "f");
        this.disableVideo();
    }
    pauseMedia() {
        this.logger?.debug('Media paused');
        __classPrivateFieldSet(this, _CallMediaStream_paused, true, "f");
    }
    resumeMedia() {
        this.logger?.debug('Media resumed');
        __classPrivateFieldSet(this, _CallMediaStream_paused, false, "f");
    }
    clearAudio() {
        this.logger?.debug({ clearedBytes: __classPrivateFieldGet(this, _CallMediaStream_queuedBytes, "f"), clearedSamples: __classPrivateFieldGet(this, _CallMediaStream_audioIn, "f") ? __classPrivateFieldGet(this, _CallMediaStream_audioIn, "f").length - __classPrivateFieldGet(this, _CallMediaStream_audioPos, "f") : 0 }, 'Clearing queued outgoing audio');
        __classPrivateFieldGet(this, _CallMediaStream_audio, "f").length = 0;
        __classPrivateFieldSet(this, _CallMediaStream_queuedBytes, 0, "f");
        __classPrivateFieldSet(this, _CallMediaStream_opusFile, undefined, "f");
        __classPrivateFieldSet(this, _CallMediaStream_audioIn, undefined, "f");
        __classPrivateFieldSet(this, _CallMediaStream_audioPos, 0, "f");
    }
    setVolume(gain) {
        if (!Number.isFinite(gain) || gain < 0 || gain > 2) {
            this.logger?.warn({ gain }, 'Invalid call volume, must be between 0 and 2');
            throw new RangeError('Call volume must be between 0 and 2');
        }
        this.logger?.debug({ previous: __classPrivateFieldGet(this, _CallMediaStream_gain, "f"), gain }, 'Call volume changed');
        __classPrivateFieldSet(this, _CallMediaStream_gain, gain, "f");
    }
    get volume() {
        return __classPrivateFieldGet(this, _CallMediaStream_gain, "f");
    }
    get paused() {
        return __classPrivateFieldGet(this, _CallMediaStream_paused, "f");
    }
    get queuedSeconds() {
        return (__classPrivateFieldGet(this, _CallMediaStream_queuedBytes, "f") + (__classPrivateFieldGet(this, _CallMediaStream_audioIn, "f") ? (__classPrivateFieldGet(this, _CallMediaStream_audioIn, "f").length - __classPrivateFieldGet(this, _CallMediaStream_audioPos, "f")) * 2 : 0)) / (SAMPLE_RATE * 2);
    }
    enableVideo(gated = false) {
        __classPrivateFieldSet(this, _CallMediaStream_videoEnabled, __classPrivateFieldGet(this, _CallMediaStream_engine, "f").enableVideo(gated), "f");
        this.logger?.debug({ gated, enabled: __classPrivateFieldGet(this, _CallMediaStream_videoEnabled, "f") }, 'Video enable requested');
        __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_drain).call(this);
        return __classPrivateFieldGet(this, _CallMediaStream_videoEnabled, "f");
    }
    rekeyRecv(peerLid) {
        const result = __classPrivateFieldGet(this, _CallMediaStream_engine, "f").rekeyRecv(peerLid);
        this.logger?.debug({ peerLid, result }, 'Receive key rotation requested');
        return result;
    }
    disableVideo() {
        this.logger?.debug('Disabling video');
        __classPrivateFieldSet(this, _CallMediaStream_videoEnabled, false, "f");
        __classPrivateFieldGet(this, _CallMediaStream_engine, "f").disableVideo();
        __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_drain).call(this);
    }
    get stats() {
        return __classPrivateFieldGet(this, _CallMediaStream_engine, "f").mediaStats();
    }
    _destroy(error, callback) {
        if (error)
            this.logger?.error({ err: error, elapsedMs: __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this) }, 'Call media stream destroyed with error');
        else
            this.logger?.info({ elapsedMs: __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this) }, 'Call media stream destroyed');
        __classPrivateFieldSet(this, _CallMediaStream_closed, true, "f");
        __classPrivateFieldGet(this, _CallMediaStream_encoder, "f")?.stdin?.destroy();
        __classPrivateFieldGet(this, _CallMediaStream_encoder, "f")?.kill();
        if (__classPrivateFieldGet(this, _CallMediaStream_timer, "f"))
            clearTimeout(__classPrivateFieldGet(this, _CallMediaStream_timer, "f"));
        if (__classPrivateFieldGet(this, _CallMediaStream_micTimer, "f"))
            clearTimeout(__classPrivateFieldGet(this, _CallMediaStream_micTimer, "f"));
        if (__classPrivateFieldGet(this, _CallMediaStream_videoTimer, "f"))
            clearInterval(__classPrivateFieldGet(this, _CallMediaStream_videoTimer, "f"));
        if (__classPrivateFieldGet(this, _CallMediaStream_bound, "f")) {
            try {
                __classPrivateFieldGet(this, _CallMediaStream_socket, "f").close();
            }
            catch {
                // The UDP socket may already be closing after an error.
                this.logger?.debug('UDP socket was already closing');
            }
        }
        __classPrivateFieldGet(this, _CallMediaStream_channel, "f").close(__classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this));
        callback(error);
    }
}
_CallMediaStream_useOpus = new WeakMap(), _CallMediaStream_encoder = new WeakMap(), _CallMediaStream_engine = new WeakMap(), _CallMediaStream_channel = new WeakMap(), _CallMediaStream_socket = new WeakMap(), _CallMediaStream_relay = new WeakMap(), _CallMediaStream_startedAt = new WeakMap(), _CallMediaStream_audio = new WeakMap(), _CallMediaStream_readQueue = new WeakMap(), _CallMediaStream_onVideo = new WeakMap(), _CallMediaStream_queuedBytes = new WeakMap(), _CallMediaStream_udpSent = new WeakMap(), _CallMediaStream_opusFile = new WeakMap(), _CallMediaStream_audioIn = new WeakMap(), _CallMediaStream_audioPos = new WeakMap(), _CallMediaStream_readQueueBytes = new WeakMap(), _CallMediaStream_bound = new WeakMap(), _CallMediaStream_started = new WeakMap(), _CallMediaStream_timer = new WeakMap(), _CallMediaStream_micTimer = new WeakMap(), _CallMediaStream_videoTimer = new WeakMap(), _CallMediaStream_closed = new WeakMap(), _CallMediaStream_connected = new WeakMap(), _CallMediaStream_videoEnabled = new WeakMap(), _CallMediaStream_paused = new WeakMap(), _CallMediaStream_gain = new WeakMap(), _CallMediaStream_videoFrames = new WeakMap(), _CallMediaStream_videoFrame = new WeakMap(), _CallMediaStream_videoFps = new WeakMap(), _CallMediaStream_instances = new WeakSet(), _CallMediaStream_now = function _CallMediaStream_now() {
    return performance.now() - __classPrivateFieldGet(this, _CallMediaStream_startedAt, "f");
}, _CallMediaStream_sendAudioFrame = function _CallMediaStream_sendAudioFrame() {
    if (__classPrivateFieldGet(this, _CallMediaStream_closed, "f"))
        return;
    if (__classPrivateFieldGet(this, _CallMediaStream_opusFile, "f") && !__classPrivateFieldGet(this, _CallMediaStream_paused, "f")) {
        __classPrivateFieldGet(this, _CallMediaStream_engine, "f").handleEncodedAudio(__classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this), __classPrivateFieldGet(this, _CallMediaStream_opusFile, "f").subarray(0, OPUS_PACKET_BYTES));
        __classPrivateFieldSet(this, _CallMediaStream_opusFile, __classPrivateFieldGet(this, _CallMediaStream_opusFile, "f").length > OPUS_PACKET_BYTES ? __classPrivateFieldGet(this, _CallMediaStream_opusFile, "f").subarray(OPUS_PACKET_BYTES) : undefined, "f");
        const remaining = (__classPrivateFieldGet(this, _CallMediaStream_opusFile, "f")?.length ?? 0) / OPUS_PACKET_BYTES;
        if (remaining % 100 === 0)
            this.logger?.debug({ remaining, udpSent: __classPrivateFieldGet(this, _CallMediaStream_udpSent, "f") }, 'Prepared Opus playback progress');
        __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_drain).call(this);
        return;
    }
    const frame = new Int16Array(FRAME_SAMPLES);
    if (!__classPrivateFieldGet(this, _CallMediaStream_paused, "f") && __classPrivateFieldGet(this, _CallMediaStream_audioIn, "f")) {
        const samples = __classPrivateFieldGet(this, _CallMediaStream_audioIn, "f").subarray(__classPrivateFieldGet(this, _CallMediaStream_audioPos, "f"), __classPrivateFieldGet(this, _CallMediaStream_audioPos, "f") + FRAME_SAMPLES);
        frame.set(samples);
        __classPrivateFieldSet(this, _CallMediaStream_audioPos, __classPrivateFieldGet(this, _CallMediaStream_audioPos, "f") + samples.length, "f");
        if (__classPrivateFieldGet(this, _CallMediaStream_audioPos, "f") >= __classPrivateFieldGet(this, _CallMediaStream_audioIn, "f").length) {
            __classPrivateFieldSet(this, _CallMediaStream_audioIn, undefined, "f");
            __classPrivateFieldSet(this, _CallMediaStream_audioPos, 0, "f");
        }
    }
    else if (!__classPrivateFieldGet(this, _CallMediaStream_paused, "f")) {
        const bytes = Buffer.from(frame.buffer);
        let offset = 0;
        while (offset < bytes.length && __classPrivateFieldGet(this, _CallMediaStream_audio, "f").length) {
            const first = __classPrivateFieldGet(this, _CallMediaStream_audio, "f")[0];
            const length = Math.min(bytes.length - offset, first.length);
            first.copy(bytes, offset, 0, length);
            offset += length;
            __classPrivateFieldSet(this, _CallMediaStream_queuedBytes, __classPrivateFieldGet(this, _CallMediaStream_queuedBytes, "f") - length, "f");
            if (length === first.length)
                __classPrivateFieldGet(this, _CallMediaStream_audio, "f").shift();
            else
                __classPrivateFieldGet(this, _CallMediaStream_audio, "f")[0] = first.subarray(length);
        }
    }
    const pcm = Array.from(frame, sample => Math.max(-32768, Math.min(32767, Math.round(sample * (__classPrivateFieldGet(this, _CallMediaStream_paused, "f") ? 0 : __classPrivateFieldGet(this, _CallMediaStream_gain, "f"))))));
    if (__classPrivateFieldGet(this, _CallMediaStream_encoder, "f")?.stdin) {
        if (__classPrivateFieldGet(this, _CallMediaStream_encoder, "f").stdin.writableNeedDrain)
            return;
        __classPrivateFieldGet(this, _CallMediaStream_encoder, "f").stdin.write(Buffer.from(Int16Array.from(pcm).buffer));
        return;
    }
    __classPrivateFieldGet(this, _CallMediaStream_engine, "f").handleMicFrame(__classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this), pcm);
    __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_drain).call(this);
}, _CallMediaStream_startMic = function _CallMediaStream_startMic() {
    if (!__classPrivateFieldGet(this, _CallMediaStream_micTimer, "f")) {
        if (__classPrivateFieldGet(this, _CallMediaStream_useOpus, "f")) {
            const encoder = spawn('ffmpeg', [
                '-loglevel',
                'error',
                '-f',
                's16le',
                '-ar',
                '16000',
                '-ac',
                '1',
                '-probesize',
                '32',
                '-analyzeduration',
                '0',
                '-i',
                'pipe:0',
                '-map',
                '0:a:0',
                '-c:a',
                'libopus',
                '-application',
                'voip',
                '-frame_duration',
                '60',
                '-b:a',
                '24000',
                '-vbr',
                'off',
                '-flush_packets',
                '1',
                '-f',
                'data',
                'pipe:1'
            ], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
            __classPrivateFieldSet(this, _CallMediaStream_encoder, encoder, "f");
            let pending = Buffer.alloc(0);
            let first = true;
            encoder.stdout.on('data', (chunk) => {
                if (__classPrivateFieldGet(this, _CallMediaStream_closed, "f") || (__classPrivateFieldGet(this, _CallMediaStream_opusFile, "f") && !__classPrivateFieldGet(this, _CallMediaStream_paused, "f")))
                    return;
                const data = Buffer.concat([pending, chunk]);
                let offset = 0;
                while (offset + OPUS_PACKET_BYTES <= data.length && !__classPrivateFieldGet(this, _CallMediaStream_closed, "f")) {
                    __classPrivateFieldGet(this, _CallMediaStream_engine, "f").handleEncodedAudio(__classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this), data.subarray(offset, offset + OPUS_PACKET_BYTES));
                    offset += OPUS_PACKET_BYTES;
                    if (first) {
                        first = false;
                        this.logger?.debug('First Opus packet submitted');
                    }
                    __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_drain).call(this);
                }
                pending = Buffer.from(data.subarray(offset));
            });
            encoder.on('error', err => this.destroy(err));
            encoder.stdin.on('error', err => {
                if (!__classPrivateFieldGet(this, _CallMediaStream_closed, "f"))
                    this.destroy(err);
            });
            encoder.on('close', code => {
                if (!__classPrivateFieldGet(this, _CallMediaStream_closed, "f"))
                    this.destroy(new Error('Opus encoder stopped: ' + code));
            });
        }
        this.logger?.debug({ frameMs: FRAME_MS }, 'Starting microphone frame timer');
        let deadline = __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this) + FRAME_MS;
        const tick = () => {
            if (__classPrivateFieldGet(this, _CallMediaStream_closed, "f"))
                return;
            __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_sendAudioFrame).call(this);
            if (__classPrivateFieldGet(this, _CallMediaStream_closed, "f"))
                return;
            const now = __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this);
            // Keep the media clock steady, restarting after a stall instead of bursting overdue packets.
            deadline = deadline + FRAME_MS > now ? deadline + FRAME_MS : now + FRAME_MS;
            __classPrivateFieldSet(this, _CallMediaStream_micTimer, setTimeout(tick, Math.ceil(deadline - now)), "f");
        };
        __classPrivateFieldSet(this, _CallMediaStream_micTimer, setTimeout(tick, FRAME_MS), "f");
    }
}, _CallMediaStream_markConnected = function _CallMediaStream_markConnected(now, event) {
    if (__classPrivateFieldGet(this, _CallMediaStream_connected, "f"))
        return;
    __classPrivateFieldSet(this, _CallMediaStream_connected, true, "f");
    this.logger?.info({ event: event ?? 'engine allocated', elapsedMs: now }, 'Call media connected');
    this.emit('connected');
    __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_startMic).call(this);
    __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_startVideo).call(this);
}, _CallMediaStream_drain = function _CallMediaStream_drain() {
    if (__classPrivateFieldGet(this, _CallMediaStream_closed, "f"))
        return;
    const now = __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this);
    for (let i = 0; i < 1000; i++) {
        let moved = false;
        for (let packet = __classPrivateFieldGet(this, _CallMediaStream_channel, "f").pollTransmit(); packet; packet = __classPrivateFieldGet(this, _CallMediaStream_channel, "f").pollTransmit()) {
            moved = true;
            __classPrivateFieldGet(this, _CallMediaStream_socket, "f").send(packet, __classPrivateFieldGet(this, _CallMediaStream_relay, "f").port, __classPrivateFieldGet(this, _CallMediaStream_relay, "f").address, error => {
                var _a;
                if (error) {
                    this.logger?.error({ err: error, relayIp: __classPrivateFieldGet(this, _CallMediaStream_relay, "f").address, relayPort: __classPrivateFieldGet(this, _CallMediaStream_relay, "f").port }, 'Failed to send datagram to relay');
                    this.destroy(error);
                }
                else
                    __classPrivateFieldSet(this, _CallMediaStream_udpSent, (_a = __classPrivateFieldGet(this, _CallMediaStream_udpSent, "f"), _a++, _a), "f");
            });
        }
        if (!__classPrivateFieldGet(this, _CallMediaStream_started, "f") && __classPrivateFieldGet(this, _CallMediaStream_channel, "f").isOpen()) {
            __classPrivateFieldSet(this, _CallMediaStream_started, true, "f");
            this.logger?.info('Relay channel is open, starting call engine');
            __classPrivateFieldGet(this, _CallMediaStream_engine, "f").start(now, Date.now());
            moved = true;
        }
        for (let packet = __classPrivateFieldGet(this, _CallMediaStream_channel, "f").pollInbound(); packet; packet = __classPrivateFieldGet(this, _CallMediaStream_channel, "f").pollInbound()) {
            __classPrivateFieldGet(this, _CallMediaStream_engine, "f").handleRelayPacket(now, packet);
            moved = true;
        }
        if (__classPrivateFieldGet(this, _CallMediaStream_started, "f") && __classPrivateFieldGet(this, _CallMediaStream_engine, "f").isAllocated())
            __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_markConnected).call(this, now);
        if (__classPrivateFieldGet(this, _CallMediaStream_started, "f")) {
            const output = __classPrivateFieldGet(this, _CallMediaStream_engine, "f").pollOutput();
            if (output.kind)
                moved = true;
            if (output.kind === 1 && output.data) {
                const error = __classPrivateFieldGet(this, _CallMediaStream_channel, "f").write(now, output.data);
                if (error) {
                    this.logger?.error({ error }, 'Failed to write engine output to relay channel');
                    return this.destroy(new Error(`Call relay: ${error}`));
                }
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
                if (__classPrivateFieldGet(this, _CallMediaStream_readQueueBytes, "f") > MAX_QUEUED_AUDIO_BYTES) {
                    this.logger?.debug({ queuedBytes: __classPrivateFieldGet(this, _CallMediaStream_readQueueBytes, "f"), maxBytes: MAX_QUEUED_AUDIO_BYTES }, 'Incoming audio queue is full, dropping oldest audio');
                }
                while (__classPrivateFieldGet(this, _CallMediaStream_readQueueBytes, "f") > MAX_QUEUED_AUDIO_BYTES) {
                    __classPrivateFieldSet(this, _CallMediaStream_readQueueBytes, __classPrivateFieldGet(this, _CallMediaStream_readQueueBytes, "f") - __classPrivateFieldGet(this, _CallMediaStream_readQueue, "f").shift().length, "f");
                }
                this._read();
                moved = true;
            }
            else if (output.kind === 3 && output.event) {
                this.logger?.info({ event: output.event }, 'Media event received');
                this.emit('media-event', output.event);
                if (output.event === 'MediaConnected' || output.event === 'RelayAllocated') {
                    __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_markConnected).call(this, now, output.event);
                }
                if (output.event === 'RelayAllocateFailed' ||
                    output.event === 'RelayAllocateTimedOut' ||
                    output.event === 'MediaSetupFailed') {
                    this.logger?.error({ event: output.event }, 'Call media setup failed');
                    this.destroy(new Error(`Call media setup failed: ${output.event}`));
                    return;
                }
            }
            else if (output.kind === 4 && output.data) {
                const frame = Buffer.from(output.data);
                this.logger?.trace({ bytes: frame.length }, 'Received video frame from peer');
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
            if (error) {
                this.logger?.error({ error }, 'Relay channel timeout handling failed');
                return this.destroy(new Error(`Call relay: ${error}`));
            }
            if (__classPrivateFieldGet(this, _CallMediaStream_started, "f"))
                __classPrivateFieldGet(this, _CallMediaStream_engine, "f").handleTimeout(now);
            __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_drain).call(this);
        }, Math.max(0, Math.min(...timeouts) - __classPrivateFieldGet(this, _CallMediaStream_instances, "m", _CallMediaStream_now).call(this))), "f");
    }
}, _CallMediaStream_startVideo = function _CallMediaStream_startVideo() {
    if (!__classPrivateFieldGet(this, _CallMediaStream_connected, "f") || __classPrivateFieldGet(this, _CallMediaStream_videoTimer, "f") || !__classPrivateFieldGet(this, _CallMediaStream_videoFrames, "f").length)
        return;
    this.logger?.debug({ frames: __classPrivateFieldGet(this, _CallMediaStream_videoFrames, "f").length, fps: __classPrivateFieldGet(this, _CallMediaStream_videoFps, "f") }, 'Starting video frame timer');
    __classPrivateFieldSet(this, _CallMediaStream_videoTimer, setInterval(() => {
        var _a;
        if (!__classPrivateFieldGet(this, _CallMediaStream_paused, "f") && __classPrivateFieldGet(this, _CallMediaStream_videoFrames, "f").length) {
            this.writeVideoFrame(__classPrivateFieldGet(this, _CallMediaStream_videoFrames, "f")[__classPrivateFieldGet(this, _CallMediaStream_videoFrame, "f") % __classPrivateFieldGet(this, _CallMediaStream_videoFrames, "f").length]);
            __classPrivateFieldSet(this, _CallMediaStream_videoFrame, (_a = __classPrivateFieldGet(this, _CallMediaStream_videoFrame, "f"), _a++, _a), "f");
        }
    }, Math.max(1, Math.round(1000 / Math.min(30, Math.max(1, __classPrivateFieldGet(this, _CallMediaStream_videoFps, "f")))))), "f");
};
export const createCallMediaStream = (config, options) => new CallMediaStream(config, options);
export const createCallMediaStreamFromEngine = (engine, relayIp, relayPort, options) => new CallMediaStream({ engine, relayIp, relayPort }, options, options?.logger);
//# sourceMappingURL=call-media.js.map