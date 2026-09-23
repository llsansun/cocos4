/* Copyright (c) 2026 Xiamen Yaji Software Co., Ltd. */

import type { TraceJournal } from './trace-archive';

/** JSON-only, versioned diagnostic trace. No executable code is stored in a trace. */
export type TraceValue = null | boolean | number | string | TraceValue[] | { [key: string]: TraceValue };
export interface TraceError { name: string; message: string; stack?: string }
export interface TraceCommand {
    index: number;
    frame: number;
    kind: 'call' | 'create' | 'frame' | 'error';
    target: string;
    api: string;
    args: TraceValue[];
    result?: TraceValue;
    error?: TraceError;
    unsupported?: string;
    argumentTypes?: string[];
    serializationErrors?: { stage: string; message: string }[];
    bindResult?: string;
    image?: string;
    imageError?: string;
    incomplete?: boolean;
}
export interface TraceFile {
    version: 1;
    metadata: Record<string, string>;
    baseline: TraceValue;
    commands: TraceCommand[];
    stopped?: string;
}
export interface TraceOptions {
    /** Default: 20000. Stop rather than discard the prefix required for replay. */
    maxCommands?: number;
    /** Append each BEGIN before the API executes, and END after it returns. */
    journal?: TraceJournal;
    /** Optional image evidence, captured after rendering each recorded frame. */
    captureFrame?: () => string;
    /** Called synchronously at frame boundaries, errors and stop. Must not throw. */
    save?: (json: string) => void;
}
export interface TraceCodec {
    name: string;
    test: (value: object) => boolean;
    encode: (value: any) => TraceValue;
    decode: (value: TraceValue) => unknown;
}
export interface TraceStep {
    command: TraceCommand;
    actual?: TraceValue;
    error?: TraceError;
    mismatch?: string;
}

function describeError (value: unknown): TraceError {
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    return { name: 'ThrownValue', message: String(value) };
}

/** Shared recording/replay registry. APIs must be explicitly registered, never resolved from a file. */
export class TraceRuntime {
    public file: TraceFile | null = null;
    public recording = false;
    public onBindResult: ((value: object, id: string) => void) | null = null;
    public hasObject (value: object): boolean { return this._ids.has(value); }
    public describeValue: ((value: unknown) => string) | null = null;
    public adoptResult: ((value: unknown) => boolean) | null = null;
    public replaying = false;
    public persistenceError = '';
    /** Opt-in DevTools pauses. Open developer tools before enabling. */
    public debugNextReplayCommand = false;
    public debugReplayErrors = false;
    public replayDebugContext: { command: TraceCommand; target: unknown; args: unknown[]; result?: unknown; error?: unknown } | null = null;
    private _activeCalls = 0;
    private _pendingStop: string | null = null;
    private _journaling = false;
    private _journalFailed = false;
    private _saving = false;
    private _frame = 0;
    private _depth = 0;
    private _nextId = 0;
    private _options: TraceOptions = {};
    private _ids = new WeakMap<object, string>();
    private _objects = new Map<string, object>();
    private _apis = new Map<string, (target: any, args: any[]) => unknown>();
    private _factories = new Map<string, (args: any[]) => object>();
    private _codecs: TraceCodec[] = [];
    private _restore: (() => void)[] = [];

    public addCodec (codec: TraceCodec): void {
        if (this._codecs.some((entry) => entry.name === codec.name)) throw new Error(`Duplicate trace codec: ${codec.name}`);
        this._codecs.push(codec);
    }

    public bind (id: string, object: object): void {
        if (this._objects.has(id) && this._objects.get(id) !== object) throw new Error(`Duplicate trace object: ${id}`);
        this._objects.set(id, object);
        this._ids.set(object, id);
    }

    public resetObjects (): void {
        this.replayDebugContext = null;
        this.debugNextReplayCommand = false;
        this._objects.clear();
        this._ids = new WeakMap();
        this._nextId = 0;
    }

    public factory (name: string, create: (args: any[]) => object): void { this._factories.set(name, create); }

    /** Called by supported constructors; nested construction belongs to the outer API. */
    public constructed (api: string, object: object, args: unknown[]): void {
        if (!this.recording || this._depth) return;
        const target = `new:${++this._nextId}`;
        this.bind(target, object);
        const command = this._append('create', target, api);
        if (command) {
            this._capture(command, () => { command.args = args.map((arg) => this.encode(arg)); });
            this._journal((journal) => journal.event(command));
        }
    }

    /** Install one method or setter; descriptor and receiver semantics are preserved. */
    public instrument (prototype: object, name: string, api: string, setter = false): void {
        if (this._apis.has(api)) return;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
        const original = setter ? descriptor?.set : descriptor?.value;
        if (!descriptor || typeof original !== 'function' || !descriptor.configurable) return;
        this._apis.set(api, (target, args) => original.apply(target, args));
        const runtime = this;
        const wrapped = function (this: object, ...args: unknown[]): unknown {
            if (!runtime.recording || runtime._depth) return original.apply(this, args);
            const target = runtime._ids.get(this) || '';
            const command = runtime._append('call', target, api);
            if (!command) return original.apply(this, args);
            runtime._capture(command, () => {
                if (!target) throw new Error('Target is not in the baseline or a supported constructor result');
                if (runtime.describeValue) command.argumentTypes = args.map((arg) => runtime.describeValue!(arg));
                command.args = args.map((arg) => runtime.encode(arg));
            }, 'arguments');
            runtime._journal((journal) => journal.begin(command));
            ++runtime._depth;
            ++runtime._activeCalls;
            try {
                const result = original.apply(this, args);
                runtime._capture(command, () => {
                    if (result && runtime.adoptResult?.(result) && !runtime._ids.has(result)) {
                        command.bindResult = `new:${++runtime._nextId}`;
                        runtime.bind(command.bindResult, result);
                        runtime.onBindResult?.(result, command.bindResult);
                    }
                    command.result = runtime.encode(result);
                }, 'result');
                return result;
            } catch (error) {
                command.error = describeError(error);
                runtime.flush();
                throw error;
            } finally {
                runtime._journal((journal) => journal.end(command));
                --runtime._depth;
                --runtime._activeCalls;
                if (!runtime._activeCalls && runtime._pendingStop !== null) {
                    const reason = runtime._pendingStop;
                    runtime._pendingStop = null;
                    runtime._journal((journal) => journal.stop(reason));
                }
            }
        };
        Object.defineProperty(prototype, name, setter ? { ...descriptor, set: wrapped } : { ...descriptor, value: wrapped });
        this._restore.push(() => { Object.defineProperty(prototype, name, descriptor); });
    }

    public start (metadata: Record<string, string>, baseline: TraceValue, options: TraceOptions = {}): void {
        const limit = options.maxCommands === undefined ? 20000 : options.maxCommands;
        if (!Number.isInteger(limit) || limit < 1) throw new Error('trace.maxCommands must be a positive integer');
        this._options = { ...options, maxCommands: limit };
        this._frame = 0;
        this._journalFailed = false;
        this.persistenceError = '';
        this.file = { version: 1, metadata: { ...metadata }, baseline, commands: [] };
        this.recording = true;
        this._journal((journal) => journal.start(this.file!));
        this.flush();
    }

    /** User lifecycle callbacks are separate commands even when called from an engine API. */
    public external<T> (operation: () => T): T {
        const depth = this._depth;
        this._depth = 0;
        try { return operation(); } finally { this._depth = depth; }
    }

    public boundary (api: 'deferredDestroy' | 'endFrame'): void {
        const command = this._append('frame', '', api);
        if (command && api === 'endFrame' && this._options.captureFrame) {
            try { command.image = this._options.captureFrame(); }
            catch (error) { command.imageError = describeError(error).message; }
        }
        if (command) this._journal((journal) => journal.event(command));
    }

    public beginFrame (dt: number): void {
        if (!this.recording) return;
        ++this._frame;
        const command = this._append('frame', '', 'beginFrame');
        if (command) {
            command.args = [dt];
            this._journal((journal) => journal.event(command));
        }
    }

    public recordError (error: unknown): void {
        if (this._saving || this._journaling) return;
        const command = this._append('error', '', 'runtime');
        if (command) {
            command.error = describeError(error);
            this._journal((journal) => journal.event(command));
        }
        this.flush();
    }

    public flush (): void {
        if (!this.file || !this._options.save || this._saving) return;
        this._saving = true;
        // A persistence adapter must never change the outcome of a game API.
        ++this._depth;
        try { this._options.save(JSON.stringify(this.file)); } catch (error) { this.persistenceError = describeError(error).message; }
        finally { --this._depth; this._saving = false; }
    }

    public stop (reason = 'stopped'): void {
        if (this.recording) {
            if (this._activeCalls) this._pendingStop = reason;
            else this._journal((journal) => journal.stop(reason));
        }
        this.recording = false;
        if (this.file && !this.file.stopped) this.file.stopped = reason;
        this.flush();
    }

    public dispose (): void {
        this.stop();
        this._restore.reverse().forEach((restore) => restore());
        this._restore = [];
        this._apis.clear();
        this.resetObjects();
    }

    public encode (value: unknown, seen = new Set<object>(), budget = { remaining: 10000 }): TraceValue {
        if (--budget.remaining < 0 || seen.size > 64) throw new Error('Trace value exceeds serialization budget');
        if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
        if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : { $number: String(Object.is(value, -0) ? '-0' : value) };
        if (value === undefined) return { $undefined: true };
        if (typeof value !== 'object' && typeof value !== 'function') throw new Error(`Unsupported trace value: ${typeof value}`);
        const ref = this._ids.get(value);
        if (ref) return { $ref: ref };
        for (const codec of this._codecs) {
            if (codec.test(value)) return { $codec: codec.name, value: codec.encode(value) };
        }
        if (typeof value === 'function') throw new Error('Unsupported callback or constructor');
        if (seen.has(value)) throw new Error('Cyclic trace value');
        seen.add(value);
        try {
            if (Array.isArray(value)) return value.map((item) => this.encode(item, seen, budget));
            if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
                throw new Error(`Unsupported object: ${value.constructor?.name || 'unknown'}`);
            }
            // Use entries to keep application keys separate from tagged values and avoid __proto__ setters.
            const entries: TraceValue[] = [];
            for (const key of Object.keys(value)) {
                const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
                if (!('value' in descriptor)) throw new Error('Accessor in trace argument');
                entries.push([key, this.encode(descriptor.value, seen, budget)]);
            }
            return { $object: entries };
        } finally { seen.delete(value); }
    }

    public decode (value: TraceValue): any {
        if (value === null || typeof value !== 'object') return value;
        if (Array.isArray(value)) return value.map((item) => this.decode(item));
        if (value.$undefined === true) return undefined;
        if (typeof value.$ref === 'string') {
            if (!this._objects.has(value.$ref)) throw new Error(`Missing trace object: ${value.$ref}`);
            return this._objects.get(value.$ref);
        }
        if (typeof value.$number === 'string') {
            if (!['NaN', 'Infinity', '-Infinity', '-0'].includes(value.$number)) throw new Error('Invalid trace number');
            return Number(value.$number);
        }
        if (typeof value.$codec === 'string') {
            const codec = this._codecs.find((entry) => entry.name === value.$codec);
            if (!codec) throw new Error(`Unknown trace codec: ${value.$codec}`);
            return codec.decode(value.value);
        }
        if (Array.isArray(value.$object)) {
            const result = {};
            for (const entry of value.$object as [string, TraceValue][]) {
                Object.defineProperty(result, entry[0], { value: this.decode(entry[1]), enumerable: true, writable: true, configurable: true });
            }
            return result;
        }
        throw new Error('Invalid trace value');
    }

    public execute (command: TraceCommand): TraceStep {
        if (this.recording) throw new Error('Stop recording before replay');
        if (command.incomplete) throw new Error(`Command ${command.index} began but did not complete in the recording`);
        if (command.unsupported) {
            const missingType = command.api === 'Node.addComponent' && command.args.length === 0
                ? '; trace 中没有保存组件参数，不能推断或跳过此调用。请更新录制端后重新录制，并检查 argumentTypes / serializationErrors' : '';
            throw new Error(`Command ${command.index}: ${command.unsupported}${missingType}`);
        }
        const step: TraceStep = { command };
        if (command.kind === 'frame' || command.kind === 'error') {
            if (this.debugNextReplayCommand || (command.kind === 'error' && this.debugReplayErrors)) {
                this.debugNextReplayCommand = false;
                // eslint-disable-next-line no-debugger
                debugger;
            }
            return step;
        }
        const args = command.args.map((arg) => this.decode(arg));
        // Resolve outside the API try/catch: missing dependencies are not reproduced game exceptions.
        const api = this._apis.get(command.api);
        const target = this._objects.get(command.target);
        const factory = this._factories.get(command.api);
        if (command.kind === 'call' && (!api || !target)) throw new Error(`Unresolved trace API/target: ${command.api} / ${command.target}`);
        if (command.kind === 'create' && !factory) throw new Error(`Unknown trace constructor: ${command.api}`);
        this.replayDebugContext = { command, target, args };
        if (this.debugNextReplayCommand) {
            this.debugNextReplayCommand = false;
            // eslint-disable-next-line no-debugger
            debugger; // Inspect command, target and decoded args; step into api()/factory() below.
        }
        let result: unknown;
        try {
            if (command.kind === 'create') this.bind(command.target, factory!(args));
            else result = api!(target, args);
        } catch (error) {
            this.replayDebugContext.error = error;
            step.error = describeError(error);
            if (this.debugReplayErrors) {
                // eslint-disable-next-line no-debugger
                debugger;
            }
        }
        this.replayDebugContext.result = result;
        if (step.error?.name !== command.error?.name || step.error?.message !== command.error?.message) step.mismatch = 'Exception differs';
        if (command.kind === 'call' && !step.error && !command.error) {
            if (command.bindResult) {
                if (!result || typeof result !== 'object') throw new Error('Expected an object result');
                this.bind(command.bindResult, result);
                this.onBindResult?.(result, command.bindResult);
            }
            step.actual = this.encode(result);
            if (JSON.stringify(step.actual) !== JSON.stringify(command.result)) step.mismatch = 'Return value differs';
        }
        if (step.mismatch && this.debugReplayErrors) {
            // eslint-disable-next-line no-debugger
            debugger;
        }
        return step;
    }

    private _journal (operation: (journal: TraceJournal) => void): void {
        if (!this._options.journal || this._journalFailed || this._journaling) return;
        this._journaling = true;
        ++this._depth;
        try { operation(this._options.journal); }
        catch (error) {
            this._journalFailed = true;
            this.persistenceError = describeError(error).message;
            // Preserve the journal prefix; collecting more commands would imply they were saved.
            this.stop('persistence failed');
        }
        finally { --this._depth; this._journaling = false; }
    }

    private _capture (command: TraceCommand, operation: () => void, stage = 'capture'): void {
        try { operation(); } catch (error) {
            const message = describeError(error).message;
            if (!command.unsupported) command.unsupported = message;
            (command.serializationErrors ||= []).push({ stage, message });
        }
    }

    private _append (kind: TraceCommand['kind'], target: string, api: string): TraceCommand | null {
        if (!this.recording || !this.file) return null;
        if (this.file.commands.length >= this._options.maxCommands!) { this.stop('maxCommands reached'); return null; }
        const command: TraceCommand = { index: this.file.commands.length, frame: this._frame, kind, target, api, args: [] };
        this.file.commands.push(command);
        return command;
    }
}

/** One cursor owns stepping. A failed/mismatching command stops playback at that exact index. */
export class TracePlayer {
    public readonly warnings: string[] = [];
    public cursor = 0;
    public lastStep: TraceStep | null = null;
    public halted = false;
    public close (): void { this.halted = true; }
    constructor (public readonly file: TraceFile, private _runtime: TraceRuntime, private _render: (command: TraceCommand, draw?: boolean) => void) {
        if (file.version !== 1 || !Array.isArray(file.commands)) throw new Error('Unsupported trace format');
        let frame = 0;
        file.commands.forEach((command, index) => {
            if (command.index !== index || !Number.isInteger(command.frame) || command.frame < frame
                || !['call', 'create', 'frame', 'error'].includes(command.kind) || !Array.isArray(command.args)
                || typeof command.api !== 'string' || typeof command.target !== 'string') throw new Error(`Invalid trace command ${index}`);
            frame = command.frame;
        });
    }
    public get done (): boolean { return this.cursor >= this.file.commands.length; }
    public stepCommand (draw = true): TraceStep | null {
        if (this.halted) throw new Error('Replay halted; reload the baseline to restart');
        if (this.done) return null;
        const command = this.file.commands[this.cursor];
        try {
            const step = this._runtime.execute(command);
            this.lastStep = step;
            ++this.cursor;
            this._render(command, draw);
            if (step.mismatch || step.error || command.error) this.halted = true;
            return step;
        } catch (error) {
            this.halted = true;
            this.lastStep = { command, mismatch: describeError(error).message };
            if (this._runtime.debugReplayErrors) {
                // eslint-disable-next-line no-debugger
                debugger;
            }
            throw error;
        }
    }
    public renderCurrent (): void {
        const command = this.lastStep?.command || { index: -1, frame: 0, kind: 'frame' as const, target: '', args: [] };
        this._render({ ...command, api: 'preview' }, true);
    }
    public stepFrame (): TraceStep[] {
        if (this.halted) throw new Error('Replay halted; reload the baseline to restart');
        if (this.done) return [];
        const frame = this.file.commands[this.cursor].frame;
        const steps: TraceStep[] = [];
        while (!this.done && !this.halted && this.file.commands[this.cursor].frame === frame) steps.push(this.stepCommand(false)!);
        if (steps.length) this._render({ ...steps[steps.length - 1].command, api: 'preview' }, true);
        return steps;
    }
}

/** Lightweight singleton imported by constructor hooks; no engine dependencies. */
export const traceRuntime = new TraceRuntime();
