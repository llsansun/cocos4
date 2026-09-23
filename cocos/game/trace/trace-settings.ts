/* Copyright (c) 2026 Xiamen Yaji Software Co., Ltd. */
import { js } from '../../core';
import { traceRuntime, TraceValue } from './trace';

// Only data-only engine configuration classes are instantiated from archive data.
const configurationTypes = new Set(['cc.SceneGlobals', 'cc.AmbientInfo', 'cc.ShadowsInfo', 'cc.SkyboxInfo',
    'cc.FogInfo', 'cc.OctreeInfo', 'cc.SkinInfo', 'cc.LightProbeInfo', 'cc.PostSettingsInfo', 'cc.ModelBakeSettings']);
export function installTraceSettingsCodec (): void {
    traceRuntime.addCodec({
        name: 'EngineSettings',
        test: (value) => configurationTypes.has(js.getClassName(value)),
        encode: (value: any) => {
            const name = js.getClassName(value);
            const keys: string[] = value.constructor.__values__;
            if (!Array.isArray(keys)) throw new Error(`No serializable schema for ${name}`);
            const fields: Record<string, TraceValue> = {};
            for (const key of keys) fields[key] = traceRuntime.encode(value[key]);
            return { name, fields };
        },
        decode: (encoded) => {
            const { name, fields } = encoded as { name: string; fields: Record<string, TraceValue> };
            if (!configurationTypes.has(name)) throw new Error(`Unsupported engine settings ${name}`);
            const Type = js.getClassByName(name) as any;
            if (!Type) throw new Error(`Missing engine settings feature ${name}`);
            const value = new Type(); const keys: string[] = Type.__values__;
            for (const key of Object.keys(fields)) {
                if (!keys.includes(key) || key === '__proto__' || key === 'constructor') throw new Error(`Invalid settings field ${name}.${key}`);
                value[key] = traceRuntime.decode(fields[key]);
            }
            return value;
        },
    });
}
