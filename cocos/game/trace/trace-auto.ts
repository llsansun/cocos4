/* Copyright (c) 2026 Xiamen Yaji Software Co., Ltd. */
import { createSceneTracePanel } from './trace-panel';
import { SceneTraceOptions } from './scene-trace';
import { createWebTraceCapture, createWeChatTraceCapture, getWeChatTraceHost, TraceCapture } from './trace-storage';

/** Generated build markers are distinguishable from captured JSONL and SPA fallback pages. */
export const TRACE_ENABLE_MARKER = 'COCOS_TRACE_ENABLE_V1';
export function isTraceEnableMarker (text: string): boolean {
    return text.length <= 256 && (text.trim() === '' || text.trim() === TRACE_ENABLE_MARKER);
}
let activeCapture: TraceCapture | null = null;
let initializationError = '';
let removeAutomaticPanel: (() => void) | null = null;
export function getSceneTraceCapture (): TraceCapture | null { return activeCapture; }
export function getSceneTraceInitializationError (): string { return initializationError; }

export async function createSceneTraceArchiveCapture (): Promise<TraceCapture> {
    if (activeCapture) await activeCapture.close();
    const host = getWeChatTraceHost();
    activeCapture = host ? createWeChatTraceCapture(host) : await createWebTraceCapture();
    return activeCapture;
}

/** Runtime roots are the deployed page/code package roots, not the Creator source project directory. */
export async function detectTraceMarker (): Promise<boolean> {
    const host = getWeChatTraceHost();
    if (host) {
        try {
            const marker = host.getFileSystemManager().readFileSync('trace.txt', 'utf8');
            return typeof marker === 'string' && isTraceEnableMarker(marker);
        } catch { return false; }
    }
    if (typeof document === 'undefined' || typeof fetch === 'undefined') return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
        const response = await fetch(new URL('trace.txt', document.baseURI).href, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) return false;
        const size = response.headers.get('content-length');
        if (size && Number(size) > 256) return false;
        return isTraceEnableMarker(await response.text());
    } catch { return false; } finally { clearTimeout(timer); }
}

/** Failure to initialize diagnostics must not prevent the game from starting. */
export async function resolveSceneTraceOptions (
    explicit: boolean | SceneTraceOptions | undefined, automatic = true,
): Promise<boolean | SceneTraceOptions | undefined> {
    if (explicit !== undefined || !automatic) return explicit;
    if (!await detectTraceMarker()) return undefined;
    try {
        activeCapture = await createSceneTraceArchiveCapture();
        initializationError = '';
        return { maxCommands: 200000, archive: activeCapture.writer, onStarted: getWeChatTraceHost() ? undefined : () => {
            removeAutomaticPanel?.();
            removeAutomaticPanel = createSceneTracePanel();
        } };
    } catch (error) {
        initializationError = String(error);
        console.warn(`Scene trace could not start: ${initializationError}`);
        return false;
    }
}
