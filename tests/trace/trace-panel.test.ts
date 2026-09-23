import { createSceneTracePanel } from '../../cocos/game/trace/trace-panel';
import { traceRuntime } from '../../cocos/game/trace/trace';
import * as auto from '../../cocos/game/trace/trace-auto';

const settle = async (): Promise<void> => { for (let i = 0; i < 20; ++i) await Promise.resolve(); };
let dispose: () => void;
function click (text: string): void {
    const button = Array.from(document.querySelectorAll('button')).find((item) => item.textContent === text)!;
    expect(button).toBeTruthy(); button.click();
}
afterEach(() => { dispose?.(); traceRuntime.stop(); jest.restoreAllMocks(); });

test('stop explains an automatic limit and does not present a stopped recording as never started', async () => {
    traceRuntime.start({}, null); traceRuntime.stop('maxCommands reached');
    dispose = createSceneTracePanel();
    expect(document.body.textContent).toContain('录制：已停止');
    expect(document.body.textContent).toContain('达到指令数量上限');
    click('停止录制'); await settle();
    expect(document.body.textContent).toContain('录制此前已经停止');
    expect(document.body.textContent).toContain('停止录制不会暂停游戏');
});

test('save waits visibly and exports the same recovered pair after persistence failure', async () => {
    let finish: (value: any) => void;
    const pair = { text: 'committed prefix', binary: new Uint8Array([1, 2]) };
    const capture: any = { status: { error: 'queue full', queued: 5, committed: 3, delivery: 'worker-async' },
        read: jest.fn().mockRejectedValue(Error('queue full')),
        readCommitted: jest.fn(() => new Promise((resolve) => { finish = resolve; })) };
    jest.spyOn(auto, 'getSceneTraceCapture').mockReturnValue(capture);
    const oldCreate = URL.createObjectURL; const oldRevoke = URL.revokeObjectURL;
    URL.createObjectURL = jest.fn(() => 'blob:test'); URL.revokeObjectURL = jest.fn();
    const download = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    try {
        traceRuntime.start({}, null); dispose = createSceneTracePanel();
        click('保存 trace.txt'); await settle();
        expect(traceRuntime.recording).toBe(false);
        expect(document.body.textContent).toContain('正在等待后台写入');
        expect(download).not.toHaveBeenCalled();
        finish!(pair); await settle();
        expect(download).toHaveBeenCalledTimes(1);
        expect(document.body.textContent).toContain('部分记录');
        click('保存 trace.bin'); await settle();
        expect(download).toHaveBeenCalledTimes(2);
        expect(capture.readCommitted).toHaveBeenCalledTimes(1);
    } finally { URL.createObjectURL = oldCreate; URL.revokeObjectURL = oldRevoke; }
});

test('command list selection, seek, rewind and playback breakpoint use inclusive indexes', async () => {
    const scene = require('../../cocos/game/trace/scene-trace');
    const { TraceRuntime, TracePlayer } = require('../../cocos/game/trace/trace');
    const runtime = new TraceRuntime();
    class Counter { value = 0; add (n: number): number { return this.value += n; } }
    let counter = new Counter(); runtime.bind('counter', counter); runtime.instrument(Counter.prototype, 'add', 'Counter.add');
    runtime.start({}, null); counter.add(1); counter.add(2); counter.add(3); runtime.stop();
    const file = JSON.parse(JSON.stringify(runtime.file));
    jest.spyOn(scene, 'openSceneTrace').mockImplementation(() => {
        runtime.resetObjects(); counter = new Counter(); runtime.bind('counter', counter);
        return new TracePlayer(file, runtime, jest.fn());
    });
    localStorage.setItem('test-navigation', JSON.stringify(file));
    const idle = async (): Promise<void> => { await settle(); await new Promise((resolve) => setTimeout(resolve, 10)); await settle(); };
    try {
        dispose = createSceneTracePanel(document.body, '', { storageKey: 'test-navigation', prepareReplay: () => {} });
        click('加载本机记录'); await settle();
        click('#2 · 帧 0 · Counter.add');
        expect(document.body.textContent).toContain('"index": 2'); expect(counter.value).toBe(0);
        click('跳转到所选指令'); await idle(); expect(counter.value).toBe(6);
        click('上一条指令'); await idle(); expect(counter.value).toBe(3);
        click('上一帧'); await idle(); expect(counter.value).toBe(0);
        click('#1 · 帧 0 · Counter.add'); click('设置／取消断点'); await settle();
        click('播放'); await idle(); expect(counter.value).toBe(1);
        expect(document.body.textContent).toContain('已停在断点 #1 执行前');
    } finally { runtime.dispose(); localStorage.removeItem('test-navigation'); }
});
