import { readTraceArchive, TraceArchiveStorage, TraceArchiveWriter } from '../../cocos/game/trace/trace-archive';
import { TraceRuntime } from '../../cocos/game/trace/trace';

function storage () {
    let text = '';
    const binary: number[] = [];
    const operations: string[] = [];
    const sink: TraceArchiveStorage = {
        appendText: (line) => { operations.push(JSON.parse(line).record); text += line; },
        appendBinary: (bytes) => { operations.push('binary'); for (const byte of bytes) binary.push(byte); },
        flush: () => { operations.push('flush'); },
    };
    return { sink, operations, text: () => text, binary: () => new Uint8Array(binary) };
}
class API {
    call (value: number): number { return value + 1; }
    fail (): never { throw new Error('fault'); }
}
let runtime: TraceRuntime;
beforeEach(() => { runtime = new TraceRuntime(); });
afterEach(() => runtime.dispose());

function setup (id = 'capture-1') {
    const data = storage();
    const writer = new TraceArchiveWriter(data.sink, id);
    const api = new API();
    runtime.bind('api', api);
    runtime.instrument(API.prototype, 'call', 'API.call');
    runtime.instrument(API.prototype, 'fail', 'API.fail');
    runtime.start({ engine: 'test' }, { name: '场景 🎮', node: 1 }, { journal: writer });
    return { data, writer, api };
}

test('writes and flushes BEGIN before executing, END after returning, without frame flush', () => {
    const data = storage();
    const writer = new TraceArchiveWriter(data.sink, 'call-order');
    const api = { call: () => {
        const records = data.text().trim().split('\n').map((line) => JSON.parse(line));
        expect(records[records.length - 1].record).toBe('begin');
        expect(data.operations.slice(-2)).toEqual(['begin', 'flush']);
        return 42;
    } };
    runtime.bind('api', api);
    runtime.instrument(api, 'call', 'call');
    runtime.start({}, null, { journal: writer });
    expect(api.call()).toBe(42);
    expect(data.operations.slice(-2)).toEqual(['end', 'flush']);
    const recovered = readTraceArchive(data.text(), data.binary());
    expect(recovered.file.commands[0].result).toBe(42);
    expect(recovered.unfinished).toEqual([]);
});

test('binary contains baseline and actual immutable resource bytes; pair round trips', () => {
    const { data, writer, api } = setup();
    const bytes = new Uint8Array([10, 20, 30]);
    writer.putResource('image', bytes);
    bytes[0] = 99;
    api.call(2);
    runtime.stop();
    const recovered = readTraceArchive(data.text(), data.binary());
    expect(recovered.file.baseline).toEqual({ name: '场景 🎮', node: 1 });
    expect(recovered.resources.get('image')).toEqual(new Uint8Array([10, 20, 30]));
    expect(recovered.file.commands[0].result).toBe(3);
    expect(recovered.file.stopped).toBe('stopped');
});

test('recovers a crash with BEGIN but no END and ignores only a partial trailing line', () => {
    const { data, api } = setup();
    api.call(1);
    api.call(2);
    const lines = data.text().trimEnd().split('\n');
    lines.pop(); // interrupted END write
    const recovered = readTraceArchive(`${lines.join('\n')}\n{"record":"en`, data.binary());
    expect(recovered.unfinished).toEqual([1]);
    expect(recovered.discardedTail).toBe(true);
    expect(recovered.file.commands[0].result).toBe(2);
    runtime.stop();
    expect(() => runtime.execute(recovered.file.commands[1])).toThrow('did not complete');
});

test('preserves the exact API exception and writes its completed END', () => {
    const { data, api } = setup();
    expect(() => api.fail()).toThrow('fault');
    const recovered = readTraceArchive(data.text(), data.binary());
    expect(recovered.file.commands[0].error!.message).toBe('fault');
    expect(recovered.unfinished).toEqual([]);
});

test('rejects mixed file pairs, committed corrupt lines and corrupt binary data', () => {
    const { data } = setup('pair-a');
    const other = storage();
    new TraceArchiveWriter(other.sink, 'pair-b').start(runtime.file!);
    expect(() => readTraceArchive(data.text(), other.binary())).toThrow('different captures');
    expect(() => readTraceArchive(`${data.text()}{broken}\n`, data.binary())).toThrow();
    const corrupt = data.binary(); corrupt[corrupt.length - 1] ^= 1;
    expect(() => readTraceArchive(data.text(), corrupt)).toThrow('Corrupt trace resource');
});

test('resource data is flushed before its reference is committed', () => {
    const { data, writer } = setup();
    const start = data.operations.length;
    writer.putResource('mesh', new Uint8Array([1, 2]));
    expect(data.operations.slice(start)).toEqual(['binary', 'flush', 'blob', 'flush']);
});

test('a failed disk stops journal writes, exposes failure and preserves the live result', () => {
    const { api, data } = setup();
    data.sink.appendText = () => { throw new Error('disk full'); };
    expect(api.call(9)).toBe(10);
    expect(runtime.persistenceError).toBe('disk full');
    expect(() => api.fail()).toThrow('fault');
});

test('a truncated unreferenced binary tail does not invalidate committed commands', () => {
    const { data, api } = setup();
    api.call(3);
    const bytes = new Uint8Array(data.binary().length + 3);
    bytes.set(data.binary());
    const recovered = readTraceArchive(data.text(), bytes);
    expect(recovered.discardedTail).toBe(true);
    expect(recovered.file.commands[0].result).toBe(4);
});
