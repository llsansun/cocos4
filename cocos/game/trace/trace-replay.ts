/* Copyright (c) 2026 Xiamen Yaji Software Co., Ltd. */
import { ccclass, serializable, editable, menu } from 'cc.decorator';
import { Component } from '../../scene-graph/component';
import { director } from '../director';
import { cclegacy } from '../../core';
import { inspectSceneTrace, closeSceneTrace, openSceneTraceArchive } from './scene-trace';
import { getWeChatTraceHost, readWeChatTracePair, TracePair } from './trace-storage';
import { TraceNavigation } from './trace-navigation';
import { TracePlayer } from './trace';

@ccclass('cc.TraceReplay')
@menu('Debug/TraceReplay')
export class TraceReplay extends Component {
    @serializable
    @editable
    public directory = '';
    @serializable
    @editable
    public loadOnStart = false;
    public player: TracePlayer | null = null;
    public error = '';
    private _loading = false;
    private _navigation: TraceNavigation | null = null;
    public seekProgress = 0;
    private _generation = 0;
    protected start (): void {
        if (this.loadOnStart) this.loadDirectory().catch((error) => { this.error = String(error); });
    }
    public async loadDirectory (directory = this.directory): Promise<void> {
        if (this._loading) throw new Error('Trace is loading');
        if (!directory) throw new Error('Choose a trace folder URL or WeChat sandbox directory');
        this._loading = true; const generation = ++this._generation;
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeout = setTimeout(() => controller?.abort(), 15000);
        try {
            const host = getWeChatTraceHost(); let pair: TracePair;
            if (host) pair = readWeChatTracePair(host, directory);
            else {
                const base = new URL(`${directory.replace(/\/$/, '')}/`, document.baseURI);
                const read = async (name: string): Promise<Response> => {
                    const response = await fetch(new URL(name, base).href, { signal: controller?.signal });
                    if (!response.ok) throw new Error(`Cannot load ${name}: HTTP ${response.status}`);
                    return response;
                };
                const [text, binary] = await Promise.all([read('trace.txt'), read('trace.bin')]);
                pair = { text: await text.text(), binary: new Uint8Array(await binary.arrayBuffer()) };
            }
            if (generation !== this._generation || !this.isValid) return;
            this.loadPair(pair);
        } catch (error) { this.error = String(error); throw error; }
        finally { clearTimeout(timeout); this._loading = false; }
    }
    public loadPair (pair: TracePair): void {
        if (pair.text.length > 64 * 1024 * 1024 || pair.binary.length > 256 * 1024 * 1024) throw new Error('Trace exceeds import memory budget');
        if (this.node.parent !== director.getScene()) throw new Error('TraceReplay must be on a root node of the replay scene');
        // Keep controls alive when replacing the scene with the captured hierarchy.
        cclegacy.game.addPersistRootNode(this.node);
        this.close();
        try {
            this.player = openSceneTraceArchive(pair.text, pair.binary); this.error = '';
            this._navigation = new TraceNavigation(this.player, () => {
                closeSceneTrace();
                this.player = openSceneTraceArchive(pair.text, pair.binary);
                return this.player;
            });
        }
        catch (error) { this.error = String(error); throw error; }
    }
    public stepCommand (): void { if (this._navigation?.busy) throw new Error('回放正在跳转'); if (!this.player) throw new Error('Load trace first'); this.player.stepCommand(); }
    public stepFrame (): void { if (this._navigation?.busy) throw new Error('回放正在跳转'); if (!this.player) throw new Error('Load trace first'); this.player.stepFrame(); }
    /** Execute through the zero-based command index; -1 restores the baseline. */
    public async seekCommand (index: number): Promise<void> {
        const navigation = this._navigation;
        if (!navigation) throw new Error('Load trace first');
        try {
            await navigation.seek(index, (cursor) => { this.seekProgress = cursor; });
            this.error = '';
        } catch (error) { this.error = String(error); throw error; }
        finally { if (this._navigation === navigation) this.player = navigation.player; }
    }
    public previousCommand (): Promise<void> {
        if (!this._navigation) throw new Error('Load trace first');
        return this.seekCommand(this._navigation.previousCommand());
    }
    public previousFrame (): Promise<void> {
        if (!this._navigation) throw new Error('Load trace first');
        return this.seekCommand(this._navigation.previousFrame());
    }
    public inspect (): unknown {
        return { cursor: this.player?.cursor, lastStep: this.player?.lastStep, warnings: this.player?.warnings, ...inspectSceneTrace() };
    }
    public close (): void { this._navigation?.cancel(); this._navigation = null; if (this.player) closeSceneTrace(); this.player = null; }
    protected onDestroy (): void { ++this._generation; this.close(); }
}
