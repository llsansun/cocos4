/* Copyright (c) 2026 Xiamen Yaji Software Co., Ltd. */
import { TraceArchiveStorage, TraceArchiveWriter } from './trace-archive';

export interface TracePair { text: string; binary: Uint8Array }
export interface TraceStorageStatus { delivery: 'synchronous-api' | 'worker-async'; queued: number; committed: number; error: string }
export interface TraceCapture {
    id: string;
    location: string;
    writer: TraceArchiveWriter;
    status: TraceStorageStatus;
    drain: () => Promise<void>;
    read: () => Promise<TracePair>;
    /** Recovery only: settle accepted writes, then read the committed prefix even after a write failure. */
    readCommitted?: () => Promise<TracePair>;
    close: () => Promise<void>;
}
export interface WeChatTraceFS {
    accessSync: (path: string) => void;
    mkdirSync: (path: string, recursive?: boolean) => void;
    writeFileSync: (path: string, data: string | ArrayBuffer, encoding?: string) => void;
    appendFileSync: (path: string, data: string | ArrayBuffer, encoding?: string) => void;
    readFileSync: (path: string, encoding?: string) => string | ArrayBuffer;
}
export interface WeChatTraceHost { env: { USER_DATA_PATH: string }; getFileSystemManager: () => WeChatTraceFS }
export function getWeChatTraceHost (): WeChatTraceHost | null {
    const host = (globalThis as any).wx as WeChatTraceHost | undefined;
    return host?.env?.USER_DATA_PATH && typeof host.getFileSystemManager === 'function' ? host : null;
}
export function newTraceCaptureId (): string { return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`; }
function validateId (id: string): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid trace capture ID');
}

/** The code package is read-only. Results live in a new sandbox folder, never over a previous capture. */
export function createWeChatTraceCapture (host: WeChatTraceHost, id = newTraceCaptureId()): TraceCapture {
    validateId(id);
    const fs = host.getFileSystemManager();
    const location = `${host.env.USER_DATA_PATH}/cocos-trace/${id}`;
    let exists = false;
    try { fs.accessSync(location); exists = true; } catch { /* Directory does not exist. */ }
    if (exists) throw new Error('Trace capture directory already exists');
    fs.mkdirSync(location, true);
    fs.writeFileSync(`${location}/trace.txt`, '', 'utf8');
    fs.writeFileSync(`${location}/trace.bin`, new ArrayBuffer(0));
    const status: TraceStorageStatus = { delivery: 'synchronous-api', queued: 0, committed: 0, error: '' };
    let closed = false;
    const append = (name: string, data: string | ArrayBuffer): void => {
        if (closed || status.error) throw new Error(status.error || 'Trace storage is closed');
        ++status.queued;
        try { fs.appendFileSync(`${location}/${name}`, data, typeof data === 'string' ? 'utf8' : undefined); ++status.committed; }
        catch (error) { status.error = String(error); throw error; }
    };
    const storage: TraceArchiveStorage = {
        delivery: status.delivery,
        appendText: (line) => append('trace.txt', line),
        appendBinary: (bytes) => append('trace.bin', bytes.slice().buffer),
        // appendFileSync has returned. WeChat exposes no separate fsync/power-loss guarantee here.
        flush: () => {},
    };
    const drain = async (): Promise<void> => { if (status.error) throw new Error(status.error); };
    return { id, location, status, writer: new TraceArchiveWriter(storage, id), drain,
        read: async () => { await drain(); return readWeChatTracePair(host, location); },
        close: async () => { await drain(); closed = true; } };
}
export function readWeChatTracePair (host: WeChatTraceHost, directory: string): TracePair {
    const fs = host.getFileSystemManager();
    const path = directory.replace(/\/$/, '');
    const text = fs.readFileSync(`${path}/trace.txt`, 'utf8');
    const binary = fs.readFileSync(`${path}/trace.bin`);
    if (typeof text !== 'string' || !(binary instanceof ArrayBuffer)) throw new Error('Invalid trace file types');
    return { text, binary: new Uint8Array(binary) };
}

// Self-contained worker source: ccbuild need not discover a separate worker bundle.
// Every transaction completes before the next queued write, so resource references cannot overtake their bytes.
export const TRACE_STORAGE_WORKER = `
let db, capture, failed = '', running = false;
const queue = [];
function request(r) { return new Promise((resolve, reject) => { r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); }); }
function complete(tx) { return new Promise((resolve,reject)=>{ tx.oncomplete=resolve; tx.onabort=()=>reject(tx.error || Error('Transaction aborted')); tx.onerror=()=>{}; }); }
async function open() {
    const r=indexedDB.open('cocos-trace-v1',1);
    r.onupgradeneeded=()=>{ r.result.createObjectStore('captures'); r.result.createObjectStore('chunks'); };
    db=await request(r);
}
async function handle(m) {
    if (!db) await open();
    if (m.kind==='init') {
        capture=m.capture;
        const tx=db.transaction('captures','readwrite'); const done=complete(tx);
        tx.objectStore('captures').add({id:capture,createdAt:Date.now()},capture); await done;
        return null;
    }
    if (m.kind==='append') {
        if (failed) throw Error(failed);
        const tx=db.transaction('chunks','readwrite'); const done=complete(tx);
        tx.objectStore('chunks').add({file:m.file,data:m.data},[capture,m.sequence]); await done;
        return null;
    }
    if (m.kind==='list') return request(db.transaction('captures').objectStore('captures').getAll());
    if (m.kind==='read') {
        const rows=await request(db.transaction('chunks').objectStore('chunks').getAll(IDBKeyRange.bound([m.capture,0],[m.capture,Number.MAX_SAFE_INTEGER])));
        let text='',size=0; const chunks=[];
        for (const row of rows) {
            const exceeds = row.file==='text' ? text.length+row.data.length>64*1024*1024 : size+row.data.byteLength>256*1024*1024;
            if (exceeds) {
                if (m.prefix) break;
                throw Error('Trace export exceeds memory budget');
            }
            if (row.file==='text') text+=row.data;
            else { const bytes=new Uint8Array(row.data); chunks.push(bytes); size+=bytes.length; }
        }
        const binary=new Uint8Array(size); let offset=0;
        for(const bytes of chunks) { binary.set(bytes,offset); offset+=bytes.length; }
        return {text,binary};
    }
    throw Error('Unknown storage operation');
}
async function pump() {
    if (running) return;
    running = true;
    try {
        while (queue.length) {
            const first = queue.shift(); const batch = [first];
            if (first.kind === 'append') {
                while (batch.length < 1024 && queue[0]?.kind === 'append') batch.push(queue.shift());
            }
            try {
                let value;
                if (first.kind === 'append') {
                    if (failed) throw Error(failed);
                    const tx=db.transaction('chunks','readwrite'); const done=complete(tx);
                    for (const m of batch) tx.objectStore('chunks').add({file:m.file,data:m.data},[capture,m.sequence]);
                    await done;
                } else value = await handle(first);
                self.postMessage({requests:batch.map(m=>m.request),value});
            } catch(e) {
                if(first.kind==='append') failed=String(e);
                self.postMessage({requests:batch.map(m=>m.request),error:String(e)});
            }
        }
    } finally { running = false; }
}
self.onmessage=(event)=>{ queue.push(event.data); pump(); };

`;

class WebTraceConnection {
    private _worker: Worker;
    private _next = 0;
    private _closed = false;
    private _lastProgress = Date.now();
    private _watchdog: ReturnType<typeof setInterval>;
    private _pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    constructor () {
        if (typeof Worker === 'undefined' || typeof indexedDB === 'undefined') throw new Error('Web trace requires Worker and IndexedDB');
        const url = URL.createObjectURL(new Blob([TRACE_STORAGE_WORKER], { type: 'text/javascript' }));
        try { this._worker = new Worker(url); } finally { URL.revokeObjectURL(url); }
        this._watchdog = setInterval(() => {
            if (this._pending.size && Date.now() - this._lastProgress > 30000) this.close(new Error('Trace worker stopped making progress'));
        }, 5000);
        this._worker.onmessage = ({ data }): void => {
            this._lastProgress = Date.now();
            for (const request of data.requests || [data.request]) {
                const pending = this._pending.get(request);
                if (!pending) continue;
                this._pending.delete(request);
                if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data.value);
            }
        };
        this._worker.onerror = (event): void => { this.close(new Error(event.message || 'Trace storage worker failed')); };
    }
    public call (message: Record<string, unknown>): Promise<any> {
        if (this._closed) return Promise.reject(new Error('Trace worker closed'));
        const request = ++this._next;
        return new Promise((resolve, reject) => {
            if (!this._pending.size) this._lastProgress = Date.now();
            this._pending.set(request, { resolve, reject });
            try { this._worker.postMessage({ ...message, request }); }
            catch (error) { this._pending.delete(request); reject(error); }
        });
    }
    public close (error = new Error('Trace worker closed')): void {
        this._closed = true;
        this._worker.terminate();
        this._pending.forEach((pending) => pending.reject(error));
        this._pending.clear();
        clearInterval(this._watchdog);
    }
}

/** Buffered delivery is explicit. API execution never waits for the worker's IndexedDB commit. */
export async function createWebTraceCapture (id = newTraceCaptureId()): Promise<TraceCapture> {
    validateId(id);
    const connection = new WebTraceConnection();
    const timeout = setTimeout(() => connection.close(new Error('Trace storage initialization timed out')), 5000);
    try { await connection.call({ kind: 'init', capture: id }); }
    catch (error) { connection.close(); throw error; }
    finally { clearTimeout(timeout); }
    const status: TraceStorageStatus = { delivery: 'worker-async', queued: 0, committed: 0, error: '' };
    const pending = new Set<Promise<void>>();
    let pendingBytes = 0;
    let closed = false;
    const append = (file: string, data: string | ArrayBuffer): void => {
        if (closed || status.error) throw new Error(status.error || 'Trace storage is closed');
        const size = typeof data === 'string' ? data.length * 2 : data.byteLength;
        if (pendingBytes + size > 128 * 1024 * 1024) { status.error = 'Trace write queue exceeded 128 MiB'; throw new Error(status.error); }
        pendingBytes += size;
        const sequence = ++status.queued;
        const task: Promise<void> = connection.call({ kind: 'append', sequence, file, data }).then(() => {
            status.committed = sequence;
        }, (error) => { status.error = String(error); }).then(() => { pendingBytes -= size; pending.delete(task); });
        pending.add(task);
    };
    const drain = async (): Promise<void> => {
        await Promise.all(Array.from(pending));
        if (status.error) throw new Error(status.error);
    };
    const storage: TraceArchiveStorage = {
        delivery: status.delivery,
        appendText: (line) => append('text', line), appendBinary: (bytes) => append('binary', bytes.slice().buffer),
        // Writes are already posted. Only drain() can await actual commits, outside synchronous game APIs.
        flush: () => {},
    };
    return { id, location: `indexeddb:cocos-trace-v1/${id}`, status, writer: new TraceArchiveWriter(storage, id), drain,
        read: async () => { await drain(); return connection.call({ kind: 'read', capture: id }); },
        readCommitted: async () => {
            await Promise.all(Array.from(pending));
            return readWebTraceCapture(id, true);
        },
        close: async () => { closed = true; try { await drain(); } finally { connection.close(); } } };
}
export async function listWebTraceCaptures (): Promise<{ id: string; createdAt: number }[]> {
    const connection = new WebTraceConnection();
    try { return await connection.call({ kind: 'list' }); } finally { connection.close(); }
}
export async function readWebTraceCapture (id: string, recoverPrefix = false): Promise<TracePair> {
    validateId(id);
    const connection = new WebTraceConnection();
    try { return await connection.call({ kind: 'read', capture: id, prefix: recoverPrefix }); } finally { connection.close(); }
}
