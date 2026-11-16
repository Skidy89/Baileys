import type { Readable, Writable } from 'node:stream';
export declare function splitAnnexB(data: Uint8Array): Uint8Array[];
export interface MediaFileOptions {
    /** Play at most this many seconds of the file (default 600). */
    maxSeconds?: number;
}
export interface QueueAudioFileOptions extends MediaFileOptions {
    signal?: AbortSignal;
}
export interface VideoFileOptions extends MediaFileOptions {
    /** Frames per second to send (default 15). */
    fps?: number;
    /** The picture is scaled to fit this width, keeping its aspect ratio (default 480; the height is even). */
    width?: number;
}
/** Files the call options can name instead of raw audio and video. */
export interface CallFileOptions {
    /** An audio file (mp3, ogg, wav, m4a, ...) to say into the call. It plays once; silence follows. */
    audioFile?: string;
    /** A video file (mp4, ...) to send as the picture, looped. Its sound plays too unless `audioFile` is given. */
    videoFile?: string;
    fileOptions?: VideoFileOptions;
}
/** Decode any audio (or the sound of a video) to 16 kHz mono PCM. */
export declare function decodeAudioFile(path: string, o?: MediaFileOptions): Promise<Int16Array>;
/** Decode in an ffmpeg child and enqueue PCM at playback speed; calls on one stream run in order. */
export declare function queueAudioFile(media: Writable, source: string | Readable, o?: QueueAudioFileOptions): Promise<void>;
/** Decode a video to H.264 access units (Annex-B, baseline, a keyframe every two seconds). */
export declare function decodeVideoFile(path: string, o?: VideoFileOptions): Promise<{
    frames: Uint8Array[];
    fps: number;
}>;
/** Turn `audioFile` / `videoFile` into the `audioIn` / `videoFrames` the media session takes. */
export declare function resolveCallFiles<T extends CallFileOptions & {
    audioIn?: Int16Array;
    videoFrames?: Uint8Array[];
    videoFps?: number;
}>(o: T): Promise<T>;
//# sourceMappingURL=media-file.d.ts.map