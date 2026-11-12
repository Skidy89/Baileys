export default function queueJob<T>(bucket: string | number, awaitable: () => Promise<T>): Promise<T>;
export declare function cleanupQueues(): void;
//# sourceMappingURL=queue-job.d.ts.map