import { TraceRuntime, TracePlayer } from '../../cocos/game/trace/trace';
import { TraceNavigation } from '../../cocos/game/trace/trace-navigation';

function fixture (fail = false) {
    const runtime = new TraceRuntime();
    class Counter { value = 0; add (n: number): number { return this.value += n; } }
    let counter = new Counter(); runtime.bind('counter', counter); runtime.instrument(Counter.prototype, 'add', 'Counter.add');
    runtime.start({}, null);
    for (let i = 0; i < 3; ++i) { runtime.beginFrame(0.016); counter.add(i + 1); }
    runtime.stop();
    const file = JSON.parse(JSON.stringify(runtime.file));
    if (fail) file.commands[3].unsupported = 'missing resource';
    const render = jest.fn();
    const reopen = jest.fn(() => {
        runtime.resetObjects(); counter = new Counter(); runtime.bind('counter', counter);
        return new TracePlayer(file, runtime, render);
    });
    const nav = new TraceNavigation(reopen(), reopen); reopen.mockClear();
    return { runtime, nav, render, reopen, value: () => counter.value };
}

test('inclusive seek and rewind rebuild state, previous frame ends before current frame', async () => {
    const f = fixture();
    try {
        await f.nav.seek(5); expect(f.value()).toBe(6); expect(f.render.mock.calls.filter((c) => c[1] === true)).toHaveLength(1);
        expect(f.nav.previousFrame()).toBe(3);
        await f.nav.seek(f.nav.previousFrame()); expect(f.value()).toBe(3); expect(f.reopen).toHaveBeenCalledTimes(1);
        await f.nav.seek(f.nav.previousCommand()); expect(f.value()).toBe(1);
        await f.nav.seek(-1); expect(f.value()).toBe(0); expect(f.nav.player.cursor).toBe(0);
        await f.nav.seek(f.nav.nextFrame()); expect(f.value()).toBe(1);
        await expect(f.nav.seek(6)).rejects.toThrow('超出范围');
    } finally { f.runtime.dispose(); }
});

test('seek halts at unsupported command and rewind can restart before the failure', async () => {
    const f = fixture(true);
    try {
        await expect(f.nav.seek(5)).rejects.toThrow('missing resource');
        expect(f.nav.player.cursor).toBe(3); expect(f.nav.player.halted).toBe(true); expect(f.value()).toBe(1);
        await f.nav.seek(1); expect(f.nav.player.halted).toBe(false); expect(f.value()).toBe(1);
    } finally { f.runtime.dispose(); }
});

test('cancel before queued work prevents rebuilding or rendering a disposed scene', async () => {
    const f = fixture();
    try {
        const pending = f.nav.seek(5); f.nav.cancel(); await pending;
        expect(f.nav.player.cursor).toBe(0); expect(f.render).not.toHaveBeenCalled(); expect(f.nav.busy).toBe(false);
    } finally { f.runtime.dispose(); }
});
