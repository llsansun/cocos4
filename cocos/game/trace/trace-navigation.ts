/* Copyright (c) 2026 Xiamen Yaji Software Co., Ltd. */
import { TracePlayer } from './trace';

/** Rewind rebuilds the baseline; engine calls (especially destruction) cannot be undone safely. */
export class TraceNavigation {
    public busy = false;
    private _generation = 0;
    constructor (public player: TracePlayer, private _reopen: () => TracePlayer | Promise<TracePlayer>) {}
    public cancel (): void { ++this._generation; }
    /** Zero-based command index, inclusive. -1 denotes the baseline before any command. */
    public async seek (index: number, progress?: (cursor: number, target: number) => void): Promise<void> {
        if (this.busy) throw new Error('回放正在跳转');
        if (!Number.isInteger(index) || index < -1 || index >= this.player.file.commands.length) throw new Error('指令编号超出范围');
        const target = index + 1; const generation = ++this._generation;
        this.busy = true;
        try {
            progress?.(this.player.cursor, target);
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (generation !== this._generation) return;
            if (target < this.player.cursor || this.player.halted) this.player = await this._reopen();
            while (this.player.cursor < target && !this.player.halted && generation === this._generation) {
                const start = Date.now(); let count = 0;
                do { this.player.stepCommand(false); ++count; }
                while (this.player.cursor < target && !this.player.halted && count < 500 && Date.now() - start < 12);
                progress?.(this.player.cursor, target);
                if (this.player.cursor < target && !this.player.halted) await new Promise<void>((resolve) => setTimeout(resolve, 0));
            }
        } finally {
            this.busy = false;
            if (generation === this._generation) this.player.renderCurrent();
        }
    }
    public previousCommand (): number { return Math.max(-1, this.player.cursor - 2); }
    public previousFrame (): number {
        if (!this.player.cursor) return -1;
        const commands = this.player.file.commands; const frame = commands[this.player.cursor - 1].frame;
        let cursor = this.player.cursor;
        while (cursor > 0 && commands[cursor - 1].frame === frame) --cursor;
        return cursor - 1;
    }
    public nextFrame (): number {
        const commands = this.player.file.commands; let cursor = this.player.cursor;
        if (cursor === commands.length) return cursor - 1;
        const frame = commands[cursor].frame;
        while (cursor < commands.length && commands[cursor].frame === frame) ++cursor;
        return cursor - 1;
    }
}
