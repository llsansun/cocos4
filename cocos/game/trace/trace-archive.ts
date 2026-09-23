/* Copyright (c) 2026 Xiamen Yaji Software Co., Ltd. */
import type { TraceCommand, TraceFile, TraceValue } from './trace';

/** Platform adapters must append, never overwrite, and report write/flush failures. */
export interface TraceArchiveStorage {
    /** Missing means synchronous; worker-async explicitly requires an external drain() barrier. */
    delivery?: 'synchronous-api' | 'worker-async';
    appendText: (line: string) => void;
    appendBinary: (bytes: Uint8Array) => void;
    /** Commit synchronously, or request commit when delivery is worker-async. No implicit fsync guarantee. */
    flush: () => void;
}
export interface TraceJournal {
    start: (file: TraceFile) => void;
    begin: (command: TraceCommand) => void;
    end: (command: TraceCommand) => void;
    event: (command: TraceCommand) => void;
    stop: (reason: string) => void;
}
interface BlobRecord { record: 'blob'; id: string; offset: number; length: number; checksum: number }
type JournalRecord =
    | { record: 'header'; version: 1; capture: string; metadata: Record<string, string>; baseline: TraceValue }
    | { record: 'begin' | 'end' | 'event'; command: TraceCommand }
    | { record: 'stop'; reason: string }
    | BlobRecord;
const magic = new Uint8Array([67, 67, 84, 82, 65, 67, 69, 1]); // CCTRACE + version

/** CRC32 detects accidental corruption, not malicious modification. */
function checksum (bytes: Uint8Array): number {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; ++i) {
        crc ^= bytes[i];
        for (let bit = 0; bit < 8; ++bit) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Append-only trace.txt (JSON Lines) + trace.bin. Platform owns exclusive creation of the pair.
 * A completed method needs BEGIN before execution and END after return; a single post-call line
 * cannot identify a method that crashed before returning.
 */
export class TraceArchiveWriter implements TraceJournal {
    private _offset: number;
    private _started = false;
    private _failed = false;
    private _stopped = false;
    private _blobs = new Set<string>();
    constructor (private _storage: TraceArchiveStorage, private _capture: string) {
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(_capture)) throw new Error('Capture ID must be 1-128 ASCII letters, digits, underscores or hyphens');
        this._offset = magic.length + 4 + _capture.length;
    }
    public start (file: TraceFile): void {
        if (this._started) throw new Error('Archive writer cannot be reused');
        this._started = true;
        this._write(() => {
            const binaryHeader = new Uint8Array(this._offset);
            binaryHeader.set(magic);
            new DataView(binaryHeader.buffer).setUint32(magic.length, this._capture.length, true);
            for (let i = 0; i < this._capture.length; ++i) binaryHeader[magic.length + 4 + i] = this._capture.charCodeAt(i);
            this._storage.appendBinary(binaryHeader);
            this._storage.flush();
            this._line({ record: 'header', version: 1, capture: this._capture, metadata: { ...file.metadata, storageDelivery: this._storage.delivery || 'synchronous-api' }, baseline: { $blob: '@baseline' } });
            // ASCII JSON escapes avoid requiring TextEncoder on native JS runtimes.
            const json = JSON.stringify(file.baseline).replace(/[\u007f-\uffff]/g, (char) => `\\u${(`0000${char.charCodeAt(0).toString(16)}`).slice(-4)}`);
            this.putResource('@baseline', Uint8Array.from(json, (char) => char.charCodeAt(0)));
        });
    }
    /** Store actual bytes before publishing their reference in trace.txt. IDs must be immutable. */
    public putResource (id: string, bytes: Uint8Array): void {
        if (!id || this._blobs.has(id)) throw new Error(`Duplicate/empty trace resource: ${id}`);
        const data = bytes.slice(); // Worker queues must not observe later mutations of the caller's buffer.
        this._write(() => {
            this._storage.appendBinary(data);
            this._storage.flush();
            this._line({ record: 'blob', id, offset: this._offset, length: data.length, checksum: checksum(data) });
            this._offset += data.length;
            this._blobs.add(id);
        });
    }
    public begin (command: TraceCommand): void { this._write(() => this._line({ record: 'begin', command })); }
    public end (command: TraceCommand): void { this._write(() => this._line({ record: 'end', command })); }
    public event (command: TraceCommand): void { this._write(() => this._line({ record: 'event', command })); }
    public stop (reason: string): void {
        if (this._stopped) return;
        this._write(() => this._line({ record: 'stop', reason }));
        this._stopped = true;
    }
    private _line (record: JournalRecord): void {
        this._storage.appendText(`${JSON.stringify(record)}\n`);
        this._storage.flush();
    }
    private _write (write: () => void): void {
        if (!this._started || this._failed || this._stopped) throw new Error('Trace archive is not writable');
        try { write(); } catch (error) { this._failed = true; throw error; }
    }
}

export interface RecoveredTraceArchive {
    capture: string;
    file: TraceFile;
    resources: Map<string, Uint8Array>;
    /** BEGIN was committed but END was absent; this is evidence, not proof of the crash's cause. */
    unfinished: number[];
    discardedTail: boolean;
}

/** Recover only complete lines. A malformed complete line is corruption, not a skippable tail. */
export function readTraceArchive (text: string, binary: Uint8Array): RecoveredTraceArchive {
    if (binary.length < magic.length || magic.some((value, index) => binary[index] !== value)) throw new Error('Invalid trace.bin header');
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline < 0) throw new Error('No complete trace header');
    const lines = text.slice(0, lastNewline).split('\n');
    const header = JSON.parse(lines.shift()!) as JournalRecord;
    if (header.record !== 'header' || header.version !== 1 || !header.capture || !header.metadata) throw new Error('Invalid trace.txt header');
    const file: TraceFile = { version: 1, metadata: header.metadata, baseline: header.baseline, commands: [] };
    const resources = new Map<string, Uint8Array>();
    const pending = new Set<number>();
    if (binary.length < magic.length + 4) throw new Error('Incomplete trace.bin capture ID');
    const captureLength = new DataView(binary.buffer, binary.byteOffset, binary.byteLength).getUint32(magic.length, true);
    let binaryEnd = magic.length + 4 + captureLength;
    if (captureLength > 128 || binaryEnd > binary.length) throw new Error('Invalid trace.bin capture ID');
    let binaryCapture = '';
    for (let i = magic.length + 4; i < binaryEnd; ++i) binaryCapture += String.fromCharCode(binary[i]);
    if (binaryCapture !== header.capture) throw new Error('trace.txt and trace.bin belong to different captures');
    let frame = 0;
    let stopped = false;
    for (const line of lines) {
        const record = JSON.parse(line) as JournalRecord;
        if (stopped) throw new Error('Records after trace stop');
        if (record.record === 'blob') {
            if (!record.id || resources.has(record.id) || record.offset !== binaryEnd || !Number.isSafeInteger(record.length)
                || record.length < 0 || record.length > binary.length - record.offset) throw new Error(`Missing/truncated trace resource: ${record.id}`);
            const data = binary.slice(record.offset, record.offset + record.length);
            if (checksum(data) !== record.checksum) throw new Error(`Corrupt trace resource: ${record.id}`);
            resources.set(record.id, data);
            binaryEnd += record.length;
        } else if (record.record === 'stop') {
            if (typeof record.reason !== 'string') throw new Error('Invalid stop record');
            file.stopped = record.reason;
            stopped = true;
        } else if (record.record === 'begin' || record.record === 'end' || record.record === 'event') {
            const command = record.command;
            if (!command || !Number.isInteger(command.index) || !Number.isInteger(command.frame) || !Array.isArray(command.args)
                || typeof command.target !== 'string' || typeof command.api !== 'string'
                || !['call', 'create', 'frame', 'error'].includes(command.kind)) throw new Error('Invalid command record');
            if (record.record === 'end') {
                const begin = file.commands[command.index];
                if (!pending.delete(command.index) || !begin || begin.frame !== command.frame || begin.target !== command.target
                    || begin.api !== command.api || begin.kind !== command.kind || JSON.stringify(begin.args) !== JSON.stringify(command.args)) {
                    throw new Error(`Unmatched command END: ${command.index}`);
                }
                file.commands[command.index] = command;
            } else {
                if (command.index !== file.commands.length || command.frame < frame) throw new Error('Nonsequential command record');
                frame = command.frame;
                file.commands.push(command);
                if (record.record === 'begin') pending.add(command.index);
            }
        } else throw new Error('Unknown trace record');
    }
    // An unindexed binary suffix is an interrupted resource write; no committed record references it.
    const baselineBytes = resources.get('@baseline');
    if (!baselineBytes) throw new Error('Trace baseline did not finish writing');
    let baselineJSON = '';
    for (const byte of baselineBytes) {
        if (byte > 127) throw new Error('Invalid baseline encoding');
        baselineJSON += String.fromCharCode(byte);
    }
    file.baseline = JSON.parse(baselineJSON) as TraceValue;
    const unfinished = Array.from(pending).sort((a, b) => a - b);
    for (const index of unfinished) file.commands[index].incomplete = true;
    return { capture: header.capture, file, resources, unfinished,
        discardedTail: lastNewline !== text.length - 1 || binaryEnd !== binary.length };
}
