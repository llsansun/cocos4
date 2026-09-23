import { createWeChatTraceCapture, readWeChatTracePair, WeChatTraceHost } from '../../cocos/game/trace/trace-storage';
import { readTraceArchive } from '../../cocos/game/trace/trace-archive';
import { TraceRuntime } from '../../cocos/game/trace/trace';
import { isTraceEnableMarker, detectTraceMarker, resolveSceneTraceOptions } from '../../cocos/game/trace/trace-auto';

function mockHost () {
    const files = new Map<string, string | ArrayBuffer>();
    const directories = new Set<string>();
    const fs = {
        accessSync: (path: string) => { if (!directories.has(path)) throw Error('ENOENT'); },
        mkdirSync: (path: string) => { directories.add(path); },
        writeFileSync: (path: string, value: string | ArrayBuffer) => { files.set(path, value); },
        appendFileSync: jest.fn((path: string, value: string | ArrayBuffer) => {
            const before = files.get(path)!;
            if (typeof before === 'string' && typeof value === 'string') files.set(path, before + value);
            else {
                const a = new Uint8Array(before as ArrayBuffer); const b = new Uint8Array(value as ArrayBuffer);
                const bytes = new Uint8Array(a.length + b.length); bytes.set(a); bytes.set(b, a.length); files.set(path, bytes.buffer);
            }
        }),
        readFileSync: (path: string) => { if (!files.has(path)) throw Error('ENOENT'); return files.get(path)!; },
    };
    const host: WeChatTraceHost = { env: { USER_DATA_PATH: '/sandbox' }, getFileSystemManager: () => fs };
    return { host, fs, files };
}

test('WeChat writes BEGIN before live API and recovers a pair without waiting for a frame', async () => {
    const { host, files } = mockHost();
    const capture = createWeChatTraceCapture(host, 'test');
    const runtime = new TraceRuntime();
    const api = { call: () => {
        expect((files.get(`${capture.location}/trace.txt`) as string).trim().split('\n').map(JSON.parse as any).pop().record).toBe('begin');
        expect(capture.status.committed).toBe(capture.status.queued);
        return 7;
    } };
    runtime.bind('api', api); runtime.instrument(api, 'call', 'call');
    try {
        runtime.start({}, { name: '微信' }, { journal: capture.writer }); api.call(); runtime.stop();
        const pair = await capture.read(); const archive = readTraceArchive(pair.text, pair.binary);
        expect(archive.file.commands[0].result).toBe(7);
        expect(archive.file.baseline).toEqual({ name: '微信' });
        expect(archive.file.metadata.storageDelivery).toBe('synchronous-api');
        expect(files.size).toBe(2);
        expect(() => createWeChatTraceCapture(host, 'test')).toThrow('already exists');
    } finally { runtime.dispose(); await capture.close(); }
});

test('WeChat storage failure preserves live return and exposes failed persistence', async () => {
    const { host, fs } = mockHost(); const capture = createWeChatTraceCapture(host, 'failure');
    const runtime = new TraceRuntime(); const api = { call: () => 42 };
    runtime.bind('api', api); runtime.instrument(api, 'call', 'call');
    try {
        runtime.start({}, null, { journal: capture.writer });
        fs.appendFileSync.mockImplementation(() => { throw Error('quota'); });
        expect(api.call()).toBe(42);
        expect(capture.status.error).toContain('quota');
        await expect(capture.drain()).rejects.toThrow('quota');
        expect(runtime.persistenceError).toContain('quota');
    } finally { runtime.dispose(); }
});

test('root marker accepts empty file and generated signature, rejects a trace and HTML', async () => {
    expect(isTraceEnableMarker('\ufeff\n')).toBe(true);
    expect(isTraceEnableMarker('COCOS_TRACE_ENABLE_V1\n')).toBe(true);
    expect(isTraceEnableMarker('<html></html>')).toBe(false);
    expect(isTraceEnableMarker('{"record":"header"}')).toBe(false);
    expect(isTraceEnableMarker(' '.repeat(257))).toBe(false);
    const { host, files } = mockHost(); const previous = (globalThis as any).wx;
    (globalThis as any).wx = host;
    try {
        expect(await detectTraceMarker()).toBe(false);
        files.set('trace.txt', ''); expect(await detectTraceMarker()).toBe(true);
        expect(await resolveSceneTraceOptions(false)).toBe(false);
        expect(files.size).toBe(1);
        expect(() => readWeChatTracePair(host, '/missing')).toThrow('ENOENT');
    } finally { (globalThis as any).wx = previous; }
});
