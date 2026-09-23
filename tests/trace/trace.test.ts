import { TraceRuntime, TracePlayer } from '../../cocos/game/trace/trace';

class Counter {
    public value = 0;
    public add (value: number): number { this.value += value; return this.value; }
    public twice (value: number): number { this.add(value); return this.add(value); }
    public fail (): never { throw new TypeError('original failure'); }
    public echo (value: unknown): unknown { return value; }
    public get amount (): number { return this.value; }
    public set amount (value: number) { this.value = value; }
}
let runtime: TraceRuntime;
let counter: Counter;
beforeEach(() => {
    runtime = new TraceRuntime();
    counter = new Counter();
    runtime.bind('counter', counter);
    ['add', 'twice', 'fail', 'echo'].forEach((name) => runtime.instrument(Counter.prototype, name, name));
    runtime.instrument(Counter.prototype, 'amount', 'amount=', true);
});
afterEach(() => runtime.dispose());
function replay (render = jest.fn()): TracePlayer {
    runtime.stop();
    const file = JSON.parse(JSON.stringify(runtime.file));
    runtime.resetObjects();
    counter = new Counter();
    runtime.bind('counter', counter);
    return new TracePlayer(file, runtime, render);
}

test('preserves nested API semantics and replays each operation only once', () => {
    runtime.start({}, null);
    runtime.beginFrame(0.016);
    expect(counter.twice(3)).toBe(6);
    counter.amount = 8;
    expect(runtime.file!.commands.map((command) => command.api)).toEqual(['beginFrame', 'twice', 'amount=']);
    const player = replay();
    player.stepFrame();
    expect(counter.value).toBe(8);
    expect(player.done).toBe(true);
    expect(player.lastStep!.mismatch).toBeUndefined();
});

test('frame stepping stops before the next frame, including empty frames', () => {
    runtime.start({}, null);
    runtime.beginFrame(0.01);
    counter.add(1);
    runtime.beginFrame(0.02);
    runtime.beginFrame(0.03);
    counter.add(4);
    const player = replay();
    expect(player.stepFrame()).toHaveLength(2);
    expect(counter.value).toBe(1);
    expect(player.stepFrame()).toHaveLength(1);
    expect(counter.value).toBe(1);
    player.stepCommand();
    expect(counter.value).toBe(1);
    player.stepCommand();
    expect(counter.value).toBe(5);
});

test('snapshots arguments before mutation and round trips special values and hostile keys', () => {
    runtime.start({}, null);
    const value = { values: [undefined, NaN, Infinity, -Infinity, -0], nested: { x: 1 }, $ref: 'application-key' };
    counter.echo(value);
    value.nested.x = 9;
    const restored = runtime.decode(runtime.file!.commands[0].args[0]);
    expect(restored.nested.x).toBe(1);
    expect(restored.values).toEqual([undefined, NaN, Infinity, -Infinity, -0]);
    expect(restored.$ref).toBe('application-key');
    const hostile = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(Object.getPrototypeOf(runtime.decode(runtime.encode(hostile)))).toBe(Object.prototype);
    expect(({} as any).polluted).toBeUndefined();
});

test('unsupported callbacks and cycles do not change live API behavior but block replay', () => {
    runtime.start({}, null);
    const callback = (): number => 1;
    expect(counter.echo(callback)).toBe(callback);
    const cycle: any = {}; cycle.self = cycle;
    expect(counter.echo(cycle)).toBe(cycle);
    expect(runtime.file!.commands.every((command) => command.unsupported)).toBe(true);
    const player = replay();
    expect(() => player.stepCommand()).toThrow('Unsupported');
    expect(player.cursor).toBe(0);
    expect(player.halted).toBe(true);
});

test('records the original error, rethrows it, and halts at the reproduced error', () => {
    const save = jest.fn();
    runtime.start({}, null, { save });
    expect(() => counter.fail()).toThrow(TypeError);
    expect(runtime.file!.commands[0].error!.message).toBe('original failure');
    expect(save).toHaveBeenCalledTimes(2);
    const player = replay();
    const step = player.stepCommand()!;
    expect(step.error!.message).toBe('original failure');
    expect(step.mismatch).toBeUndefined();
    expect(player.halted).toBe(true);
});

test('storage failure never changes successful calls or original exceptions', () => {
    runtime.start({}, null, { save: () => { throw new Error('disk full'); } });
    expect(counter.add(2)).toBe(2);
    expect(() => counter.fail()).toThrow('original failure');
    expect(runtime.persistenceError).toBe('disk full');
});

test('limit stops recording without losing the prefix or skipping the live call', () => {
    runtime.start({}, null, { maxCommands: 1 });
    counter.add(1);
    expect(counter.add(2)).toBe(3);
    expect(runtime.file!.commands).toHaveLength(1);
    expect(runtime.file!.stopped).toBe('maxCommands reached');
    expect(runtime.recording).toBe(false);
});

test('divergent returns stop at the offending instruction', () => {
    runtime.start({}, null);
    counter.add(1);
    counter.add(2);
    const player = replay();
    counter.value = 10;
    expect(player.stepCommand()!.mismatch).toBe('Return value differs');
    expect(player.cursor).toBe(1);
    expect(() => player.stepCommand()).toThrow('halted');
});

test('constructor commands preserve reference identity across subsequent calls', () => {
    runtime.factory('Counter', () => new Counter());
    runtime.start({}, null);
    const other = new Counter();
    runtime.constructed('Counter', other, []);
    other.add(3);
    counter.echo(other);
    const player = replay();
    player.stepFrame();
    expect(player.done).toBe(true);
    expect(player.lastStep!.mismatch).toBeUndefined();
});

test('restores original descriptors on dispose; recording is opt-in', () => {
    counter.add(2);
    expect(runtime.file).toBeNull();
    runtime.start({}, null);
    runtime.dispose();
    counter.add(2);
    expect(runtime.file!.commands).toHaveLength(0);
    expect(Object.getOwnPropertyDescriptor(Counter.prototype, 'amount')!.get).toBeDefined();
});

test('rejects unregistered APIs instead of invoking arbitrary trace properties', () => {
    runtime.start({}, null);
    counter.add(1);
    const player = replay();
    player.file.commands[0].api = 'constructor';
    expect(() => player.stepCommand()).toThrow('Unresolved');
    expect(counter.value).toBe(0);
});

test('saves frame image evidence and preserves capture failures without stopping live calls', () => {
    runtime.start({}, null, { captureFrame: () => 'data:image/png;base64,example' });
    runtime.beginFrame(0.016);
    runtime.boundary('endFrame');
    expect(runtime.file!.commands[1].image).toBe('data:image/png;base64,example');
    runtime.stop();
    runtime.start({}, null, { captureFrame: () => { throw new Error('tainted canvas'); } });
    runtime.boundary('endFrame');
    expect(runtime.file!.commands[0].imageError).toBe('tainted canvas');
    expect(counter.add(1)).toBe(1);
});

test('malformed order and unknown format are rejected before stepping', () => {
    runtime.start({}, null);
    counter.add(1);
    const file = JSON.parse(JSON.stringify(runtime.file));
    expect(() => new TracePlayer({ ...file, version: 2 }, runtime, () => {})).toThrow('format');
    file.commands[0].index = 5;
    expect(() => new TracePlayer(file, runtime, () => {})).toThrow('command');
});

test('argument serialization failure is not overwritten by a failing return value', () => {
    class t {}
    const api = { addComponent: (_type: unknown) => new t() };
    runtime.bind('api', api); runtime.instrument(api, 'addComponent', 'Node.addComponent');
    runtime.start({}, null);
    expect(api.addComponent(t)).toBeInstanceOf(t);
    const command = runtime.file!.commands[0];
    expect(command.unsupported).toBe('Unsupported callback or constructor');
    expect(command.serializationErrors).toEqual([
        { stage: 'arguments', message: 'Unsupported callback or constructor' },
        { stage: 'result', message: 'Unsupported object: t' },
    ]);
    runtime.stop();
    expect(() => runtime.execute(command)).toThrow('请更新录制端后重新录制');
});

test('journal failure stops collection without changing the live call result', () => {
    runtime.start({}, null, { journal: { start: () => {}, begin: () => { throw Error('queue full'); },
        end: () => {}, event: () => {}, stop: () => {} } });
    expect(counter.add(3)).toBe(3);
    expect(runtime.recording).toBe(false);
    expect(runtime.file!.stopped).toBe('persistence failed');
    expect(runtime.persistenceError).toBe('queue full');
    const count = runtime.file!.commands.length;
    expect(counter.add(2)).toBe(5);
    expect(runtime.file!.commands.length).toBe(count);
});

test('replay debugger context exposes decoded args, live target and result', () => {
    runtime.start({}, null); counter.add(7);
    const player = replay(); runtime.debugNextReplayCommand = true;
    player.stepCommand();
    expect(runtime.debugNextReplayCommand).toBe(false);
    expect(runtime.replayDebugContext!.target).toBe(counter);
    expect(runtime.replayDebugContext!.args).toEqual([7]);
    expect(runtime.replayDebugContext!.result).toBe(7);
    runtime.resetObjects(); expect(runtime.replayDebugContext).toBeNull();
});
