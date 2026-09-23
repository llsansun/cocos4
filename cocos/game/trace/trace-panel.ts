/* Copyright (c) 2026 Xiamen Yaji Software Co., Ltd. */
import { inspectSceneTrace, openSceneTraceArchive, closeSceneTrace, exportSceneTrace, openSceneTrace, stopSceneTrace } from './scene-trace';
import { TraceNavigation } from './trace-navigation';
import { TracePlayer, traceRuntime } from './trace';
import { getSceneTraceCapture, getSceneTraceInitializationError } from './trace-auto';
import { listWebTraceCaptures, readWebTraceCapture } from './trace-storage';

export interface SceneTracePanelOptions {
    /** Reload/reset the project fixture before importing; must leave the game paused at its baseline. */
    prepareReplay?: () => void | Promise<void>;
    storageKey?: string;
}

/** Web diagnostic overlay. The original game canvas displays the replay result. */
export function createSceneTracePanel (
    parent: HTMLElement = document.body, project = '', options: SceneTracePanelOptions = {},
): () => void {
    const panel = document.createElement('section');
    panel.setAttribute('aria-label', 'Cocos Scene Trace');
    panel.style.cssText = 'position:fixed;right:8px;top:8px;width:380px;max-height:90vh;overflow:auto;z-index:2147483647;'
        + 'background:#17202eee;color:#e9eef5;padding:12px;font:12px monospace;border:1px solid #718096;border-radius:6px';
    const title = document.createElement('strong');
    title.textContent = 'Cocos Scene Trace';
    panel.appendChild(title);
    const status = document.createElement('p');
    const message = document.createElement('p');
    message.style.color = '#ffcc80';
    const details = document.createElement('pre');
    details.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;max-height:35vh;overflow:auto';
    const evidence = document.createElement('img');
    evidence.alt = '录制端该帧的原始画面';
    evidence.style.cssText = 'width:100%;display:none';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,.txt,.bin';
    input.multiple = true;
    input.setAttribute('aria-label', '加载 trace.txt 和 trace.bin，或旧版 JSON');
    let player: TracePlayer | null = null;
    let loadedPair: { text: string; binary: Uint8Array } | null = null;
    let navigation: TraceNavigation | null = null;
    let loadedJSON: string | null = null;
    let selected = -1;
    let page = 0;
    let playing = false;
    const breakpoints = new Set<number>();
    let pausedBreakpoint = -1;
    const pageSize = 80;
    const list = document.createElement('div');
    list.setAttribute('aria-label', '命令列表');
    list.style.cssText = 'max-height:240px;overflow:auto';
    const pageInfo = document.createElement('span');
    const filter = document.createElement('input');
    filter.placeholder = '搜索 API 名称或指令编号';
    filter.setAttribute('aria-label', '搜索命令');
    const renderList = (): void => {
        list.replaceChildren();
        const commands = player?.file.commands || [];
        const query = filter.value.trim().toLowerCase();
        const matches = commands.filter((command) => !query || command.api.toLowerCase().includes(query) || String(command.index) === query);
        page = Math.max(0, Math.min(page, Math.ceil(matches.length / pageSize) - 1));
        pageInfo.textContent = ` ${page + 1}/${Math.max(1, Math.ceil(matches.length / pageSize))} 页 · ${matches.length} 条 `;
        for (const command of matches.slice(page * pageSize, (page + 1) * pageSize)) {
            const row = document.createElement('button');
            row.textContent = `${breakpoints.has(command.index) ? '● ' : ''}#${command.index} · 帧 ${command.frame} · ${command.api}`;
            row.setAttribute('aria-pressed', String(command.index === selected));
            row.style.cssText = `display:block;width:100%;text-align:left;padding:5px;color:inherit;border:0;cursor:pointer;background:${command.index === selected ? '#345878' : 'transparent'}`;
            row.onclick = (): void => { selected = command.index; show(); };
            list.appendChild(row);
        }
    };
    filter.oninput = (): void => { page = 0; renderList(); };
    const setupNavigation = (): void => {
        selected = -1; page = 0; playing = false; breakpoints.clear(); pausedBreakpoint = -1;
        navigation?.cancel();
        navigation = new TraceNavigation(player!, async () => {
            if (!loadedPair && (!loadedJSON || !options.prepareReplay)) throw new Error('旧版 JSON 后退需要 prepareReplay 重载原场景；请使用 trace.txt 和 trace.bin');
            closeSceneTrace(); player = null;
            if (loadedPair) player = openSceneTraceArchive(loadedPair.text, loadedPair.binary);
            else { await options.prepareReplay!(); if (disposed) throw new Error('面板已关闭'); player = openSceneTrace(loadedJSON!, project); }
            return player;
        });
    };
    const seek = async (index: number): Promise<void> => {
        if (!navigation) throw new Error('请先加载 trace');
        loading = true;
        try {
            await navigation.seek(index, (cursor, target) => {
                message.textContent = `正在跳转：${cursor}/${target} 条指令……`;
            });
            player = navigation.player;
            selected = player.lastStep?.command.index ?? -1;
            if (!filter.value) page = Math.max(0, Math.floor(selected / pageSize));
            message.textContent = player.halted ? '在错误／差异指令处停止，未跳过错误。' : selected < 0 ? '已回到起始场景。' : `已执行到指令 #${selected}，画布显示该指令之后的状态。`;
        } finally {
            player = navigation.player;
            if (player.halted) selected = player.lastStep?.command.index ?? selected;
            loading = false; show();
        }
    };
    let disposed = false;
    let loading = false;
    const refreshStatus = (): void => {
        const capture = getSceneTraceCapture();
        status.textContent = player
            ? `指令 ${player.cursor}/${player.file.commands.length} · 帧 ${player.lastStep?.command.frame ?? 0}${player.halted ? ' · 已停止' : ''}${player.done ? ' · 已完成' : ''}`
            : `录制：${traceRuntime.recording ? '进行中' : traceRuntime.file ? '已停止' : '未开启'} · ${traceRuntime.file?.commands.length || 0} 条指令`
                + (traceRuntime.file?.stopped ? ` · 停止原因：${({ stopped: '手动停止', 'maxCommands reached': '达到指令数量上限', 'persistence failed': '日志写入失败' })[traceRuntime.file.stopped] || traceRuntime.file.stopped}` : '')
                + (capture && capture.status.committed < capture.status.queued ? ' · 后台仍在处理已排队日志' : '')
                + (traceRuntime.persistenceError ? ` · 保存失败：${traceRuntime.persistenceError}` : '')
                + (capture ? ` · 写入确认 ${capture.status.committed}/${capture.status.queued} (${capture.status.delivery})${capture.status.error ? ` · ${capture.status.error}` : ''}` : '')
                + (getSceneTraceInitializationError() ? ` · ${getSceneTraceInitializationError()}` : '');
    };
    const show = (): void => {
        refreshStatus();
        renderList();
        const chosen = player?.file.commands[selected] || player?.lastStep?.command;
        if (!chosen) { details.textContent = '选择列表中的 API 查看详情，再点击跳转。编号从 0 开始。'; return; }
        const { image, ...command } = chosen;
        const step = player?.lastStep?.command.index === chosen.index ? player.lastStep : undefined;
        details.textContent = JSON.stringify({ ...(step || {}), command }, null, 2);
        const frame = command.frame;
        const recordedImage = player!.file.commands.find((entry) => entry.frame === frame && entry.image)?.image;
        if (recordedImage && /^data:image\/(png|jpeg);base64,/.test(recordedImage)) {
            evidence.src = recordedImage;
            evidence.style.display = 'block';
        } else {
            evidence.removeAttribute('src');
            evidence.style.display = 'none';
        }
    };
    const button = (label: string, action: () => void | Promise<void>): void => {
        const element = document.createElement('button');
        element.textContent = label;
        element.style.cssText = 'margin:4px;padding:4px 8px;cursor:pointer';
        element.onclick = (): void => {
            if (loading || playing) { message.textContent = '正在处理，请稍候；可点击暂停播放。'; return; }
            message.textContent = '';
            Promise.resolve().then(action).then(show).catch((error) => { show(); message.textContent = String(error); });
        };
        panel.appendChild(element);
    };
    const load = async (json: string): Promise<void> => {
        if (loading) throw new Error('Trace is loading');
        loading = true;
        try {
            // Keep the previous file available if preparing a new fixture fails.
            closeSceneTrace();
            player = null;
            stopSceneTrace();
            await options.prepareReplay?.();
            if (disposed) return;
            player = openSceneTrace(json, project);
            loadedPair = null; loadedJSON = json; setupNavigation();
            message.textContent = `录制结束原因：${player.file.stopped || '导出的进行中记录'}；原始画面（如有）显示在下方。`;
            details.textContent = '使用下一条指令或下一帧；游戏画布显示当前回放结果。';
            show();
        } finally { loading = false; }
    };
    const loadPair = async (text: string, binary: Uint8Array): Promise<void> => {
        if (loading) throw new Error('Trace is loading');
        loading = true;
        try {
            closeSceneTrace(); player = null; stopSceneTrace();
            loadedPair = { text, binary };
            player = openSceneTraceArchive(text, binary);
            loadedJSON = null; setupNavigation();
            message.textContent = ['已从两文件重建支持的场景；选择下一条指令或下一帧。', ...player.warnings].join('\n');
            show();
        } finally { loading = false; }
    };
    button('停止录制', () => {
        const wasRecording = traceRuntime.recording;
        stopSceneTrace();
        message.textContent = `${wasRecording ? '已停止录制。' : traceRuntime.file ? '录制此前已经停止。' : '当前没有正在进行的录制。'}停止录制不会暂停游戏。`
            + (getSceneTraceCapture()?.status.error ? '日志写入失败；保存按钮将尝试导出已提交的部分记录，尾部可能不完整。' : '已排队日志继续在后台写入，保存时会等待写入完成。');
    });
    const download = (name: string, data: BlobPart): void => {
        const url = URL.createObjectURL(new Blob([data]));
        const link = document.createElement('a'); link.href = url; link.download = name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const savePair = async (name: 'trace.txt' | 'trace.bin'): Promise<void> => {
        stopSceneTrace();
        loading = true;
        try {
            const capture = getSceneTraceCapture();
            let recovered = false;
            if (!loadedPair && capture) {
                message.textContent = '录制已停止，正在等待后台写入并准备下载……';
                refreshStatus();
                try { loadedPair = await capture.read(); }
                catch (error) {
                    if (!capture.readCommitted) throw error;
                    loadedPair = await capture.readCommitted();
                    recovered = true;
                }
            }
            if (!loadedPair) throw new Error('当前没有两文件录制');
            if (disposed) return;
            download(name, name === 'trace.txt' ? loadedPair.text : loadedPair.binary);
            message.textContent = recovered || capture?.status.error
                ? '已导出已提交的部分记录；写入失败后的尾部不完整。请同时保存 trace.txt 和 trace.bin，回放遇到未完成指令会停止。'
                : `已准备 ${name} 下载；请同时保存另一份文件。`;
        } finally { loading = false; }
    };
    button('保存 trace.txt', () => savePair('trace.txt'));
    button('保存 trace.bin', () => savePair('trace.bin'));
    button('恢复最近的后台记录', async () => {
        const captures = await listWebTraceCaptures();
        const latest = captures.sort((a, b) => b.createdAt - a.createdAt)[0];
        if (!latest) throw new Error('没有后台记录');
        const pair = await readWebTraceCapture(latest.id);
        await loadPair(pair.text, pair.binary);
    });
    button('导出 JSON', () => {
        const url = URL.createObjectURL(new Blob([player ? JSON.stringify(player.file, null, 2) : exportSceneTrace()], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'cocos-scene-trace.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    button('加载本机记录', async () => {
        const json = localStorage.getItem(options.storageKey || 'cocos.scene-trace');
        if (!json) throw new Error('本机没有保存的 trace');
        await load(json);
    });
    panel.appendChild(input);
    input.onchange = (): void => {
        const files = Array.from(input.files || []);
        if (!files.length || loading) return;
        const read = async (): Promise<void> => {
            let json: string;
            if (files.length === 1 && files[0].name.endsWith('.json')) {
                if (files[0].size > 32 * 1024 * 1024) throw new Error('Trace exceeds 32 MiB');
                json = await files[0].text();
            } else {
                const text = files.find((file) => file.name === 'trace.txt');
                const binary = files.find((file) => file.name === 'trace.bin');
                if (!text || !binary || files.length !== 2) throw new Error('请同时选择 trace.txt 和 trace.bin');
                if (text.size > 64 * 1024 * 1024 || binary.size > 256 * 1024 * 1024) throw new Error('Trace exceeds import memory budget');
                await loadPair(await text.text(), new Uint8Array(await binary.arrayBuffer()));
                return;
            }
            if (!disposed) await load(json);
        };
        read().catch((error) => { if (!disposed) message.textContent = String(error); });
        input.value = '';
    };
    const tree = document.createElement('pre');
    tree.style.cssText = 'white-space:pre-wrap;max-height:25vh;overflow:auto';
    panel.appendChild(tree);
    button('节点与属性', () => { tree.textContent = JSON.stringify(inspectSceneTrace(), null, 2); });
    button('上一条指令', async () => { if (!navigation) throw new Error('请先加载 trace'); await seek(navigation.previousCommand()); });
    button('下一条指令', async () => { if (!player) throw new Error('请先加载 trace'); if (!player.done) await seek(player.cursor); });
    button('上一帧', async () => { if (!navigation) throw new Error('请先加载 trace'); await seek(navigation.previousFrame()); });
    button('下一帧', async () => { if (!navigation) throw new Error('请先加载 trace'); await seek(navigation.nextFrame()); });
    button('播放', async () => {
        if (!navigation || !player) throw new Error('请先加载 trace');
        if (player.halted) throw new Error('回放已在错误处停止，请后退或重新加载');
        playing = true;
        try {
            while (playing && !disposed && !navigation.player.done && !navigation.player.halted) {
                const frameEnd = navigation.nextFrame();
                const nextBreakpoint = Array.from(breakpoints).sort((a, b) => a - b)
                    .find((index) => index >= navigation!.player.cursor && index <= frameEnd && index !== pausedBreakpoint);
                pausedBreakpoint = -1;
                if (nextBreakpoint !== undefined) {
                    await seek(nextBreakpoint - 1);
                    pausedBreakpoint = nextBreakpoint; selected = nextBreakpoint; playing = false;
                    message.textContent = `已停在断点 #${nextBreakpoint} 执行前。点击“调试下一条”进入开发者工具，或“播放”继续。`;
                    show(); break;
                }
                await seek(frameEnd);
                if (playing) await new Promise<void>((resolve) => setTimeout(resolve, 16));
            }
        } finally { playing = false; }
    });
    const pause = document.createElement('button'); pause.textContent = '暂停播放';
    pause.onclick = (): void => { playing = false; message.textContent = '将在当前跳转完成后暂停。'; };
    panel.appendChild(pause);
    panel.appendChild(filter);
    button('命令上一页', () => { --page; }); panel.appendChild(pageInfo);
    button('命令下一页', () => { ++page; });
    panel.appendChild(list);
    button('跳转到所选指令', async () => { if (selected < 0) throw new Error('请先选择指令'); await seek(selected); });
    button('运行到所选指令前', async () => {
        if (selected < 0) throw new Error('请先选择指令');
        const target = selected; await seek(target - 1); selected = target;
        message.textContent = `已停在 #${target} 执行前，可调试下一条。`;
    });
    button('设置／取消断点', () => {
        if (selected < 0) throw new Error('请先选择指令');
        if (breakpoints.has(selected)) breakpoints.delete(selected); else breakpoints.add(selected);
        message.textContent = '● 表示断点；播放时会停在该指令执行前。';
    });
    button('调试下一条', () => {
        if (!player || player.done) throw new Error('没有待执行的指令');
        if (player.halted) throw new Error('请先后退到出错指令之前');
        traceRuntime.debugNextReplayCommand = true;
        try { player.stepCommand(); selected = player.lastStep?.command.index ?? -1; }
        finally { traceRuntime.debugNextReplayCommand = false; }
        message.textContent = '已执行一条指令。请先打开浏览器开发者工具，debugger 才会暂停；暂停后可查看 command、target、args 并单步进入引擎 API。';
    });
    const errorPauseLabel = document.createElement('label');
    const errorPause = document.createElement('input'); errorPause.type = 'checkbox';
    errorPause.checked = traceRuntime.debugReplayErrors;
    errorPause.onchange = (): void => { traceRuntime.debugReplayErrors = errorPause.checked; };
    errorPauseLabel.append(errorPause, '异常／返回差异时进入调试器（需打开 DevTools）');
    panel.appendChild(errorPauseLabel);

    button('关闭回放', () => {
        playing = false; navigation?.cancel(); navigation = null; selected = -1;
        closeSceneTrace(); player = null; loadedPair = null; loadedJSON = null; evidence.style.display = 'none';
        details.textContent = '重新回放前，请重新加载原始场景。';
    });
    panel.appendChild(status);
    panel.appendChild(message);
    panel.appendChild(details);
    panel.appendChild(evidence);
    parent.appendChild(panel);
    show();
    const timer = setInterval(refreshStatus, 500);
    return (): void => { disposed = true; playing = false; navigation?.cancel(); clearInterval(timer); panel.remove(); closeSceneTrace(); };
}
