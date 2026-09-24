/* Copyright (c) 2026 Xiamen Yaji Software Co., Ltd. */
import type { TraceRuntime } from './trace/trace';
import type { SceneTraceOptions } from './trace/scene-trace';

/** Core only knows this bridge. The optional scene-trace feature installs its implementation. */
export const traceHooks: {
    runtime?: TraceRuntime;
    initialize?: (options: boolean | SceneTraceOptions | undefined, automatic: boolean) => Promise<void>;
} = {};
