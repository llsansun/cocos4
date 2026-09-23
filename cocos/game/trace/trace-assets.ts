/* Copyright (c) 2026 Xiamen Yaji Software Co., Ltd. */
import { PixelFormat } from '../../asset/assets/asset-enum';
import { Asset } from '../../asset/assets/asset';
import { js, Rect, Size, Vec2 } from '../../core';
import { traceRuntime } from './trace';
import { TraceArchiveWriter } from './trace-archive';

function jsonBytes (value: unknown): Uint8Array {
    const text = JSON.stringify(value).replace(/[\u007f-\uffff]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    return new Uint8Array(Array.from(text, (character) => character.charCodeAt(0)));
}
function readJSON (bytes: Uint8Array): any {
    let text = ''; for (const byte of bytes) text += String.fromCharCode(byte);
    return JSON.parse(text);
}

// Material._createPasses writes these per-material fields into the shared effect.
// They belong to Material snapshots, not to the immutable effect identity.
function effectState (effect: any): any {
    return { techniques: effect.techniques.map((technique) => ({ ...technique,
        passes: technique.passes.map((pass) => {
            const { defines, stateOverrides, passIndex, ...source } = pass;
            return source;
        }),
    })), shaders: effect.shaders, combinations: effect.combinations };
}

/** Immutable mesh, material, effect and UI texture snapshots. GPU-only textures and arbitrary asset classes fail explicitly. */
export class TraceAssetRecorder {
    private _ids = new WeakMap<Asset, string>();
    private _failed = new WeakMap<Asset, Error>();
    private _pending = new Map<string, Uint8Array>();
    private _next = 0;
    private _started = false;
    constructor (private _writer: TraceArchiveWriter) {}
    public start (): void { this._started = true; this.flush(); }
    public flush (): void {
        if (!this._started) return;
        for (const [id, bytes] of this._pending) { this._writer.putResource(id, bytes); this._pending.delete(id); }
    }
    public encode (asset: Asset): string {
        const failure = this._failed.get(asset); if (failure) throw failure;
        const previous = this._ids.get(asset); if (previous) return previous;
        const id = `asset:${++this._next}`;
        this._ids.set(asset, id);
        try {
            const value = asset as any; const type = js.getClassName(asset); let state: any;
            if (type === 'cc.Mesh') {
                if (!value.data?.byteLength) throw new Error('Mesh CPU data is unavailable');
                if (value.struct.dynamic) throw new Error('Dynamic mesh updates require a trace adapter');
                this._pending.set(`${id}:mesh`, value.data.slice());
                state = { struct: value.struct, data: `${id}:mesh` };
            } else if (type === 'cc.EffectAsset') {
                state = effectState(value);
            } else if (asset instanceof (js.getClassByName('cc.Material') as any || Asset) && value.effectAsset) {
                state = { effect: this.encode(value.effectAsset), technique: value.technique,
                    defines: value._defines, states: value._states, props: traceRuntime.encode(value._props) };
            } else if (type === 'cc.SpriteFrame') {
                if (value.original) throw new Error('Already packed dynamic atlas requires a trace asset adapter');
                if (value.vertices) throw new Error('Polygon SpriteFrame requires a trace asset adapter');
                state = { texture: this.encode(value.texture), rect: [value.rect.x, value.rect.y, value.rect.width, value.rect.height],
                    originalSize: [value.originalSize.width, value.originalSize.height], offset: [value.offset.x, value.offset.y],
                    isRotate: value.rotated, packable: value.packable, flipUVX: value.flipUVX, flipUVY: value.flipUVY, borderTop: value.insetTop, borderBottom: value.insetBottom,
                    borderLeft: value.insetLeft, borderRight: value.insetRight };
            } else if (type === 'cc.Texture2D') {
                if (!value.mipmaps.length) throw new Error('GPU-only texture cannot be captured');
                const sampler = value.getSamplerInfo();
                state = { mipmaps: value.mipmaps.map((image) => this.encode(image)),
                    sampler: [sampler.minFilter, sampler.magFilter, sampler.mipFilter, sampler.addressU, sampler.addressV, sampler.addressW, sampler.maxAnisotropy] };
            } else if (type === 'cc.ImageAsset') {
                const width = value.width; const height = value.height;
                if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > 16777216) throw new Error('Invalid or oversized trace image');
                if (value.isCompressed) throw new Error('Compressed image requires a trace asset adapter');
                const source = value.data;
                const nativeCanvas = !ArrayBuffer.isView(source);
                let bytes: Uint8Array; let format = value.format;
                if (ArrayBuffer.isView(source)) bytes = new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice();
                else {
                    const wx = (globalThis as any).wx;
                    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : wx?.createCanvas?.();
                    if (!canvas) throw new Error('No canvas for trace image readback');
                    canvas.width = width; canvas.height = height;
                    const context = canvas.getContext('2d'); if (!context) throw new Error('No 2D context for trace image readback');
                    context.drawImage(source, 0, 0);
                    bytes = new Uint8Array(context.getImageData(0, 0, width, height).data);
                    format = PixelFormat.RGBA8888;
                }
                this._pending.set(`${id}:pixels`, bytes);
                state = { width, height, format, nativeCanvas, pixels: `${id}:pixels` };
            } else throw new Error(`No standalone trace asset adapter for ${type}`);
            this._pending.set(id, jsonBytes({ type: state?.effect ? 'cc.Material' : type, name: asset.name, state })); this.flush();
            return id;
        } catch (error) {
            const failure = new Error(String(error)); this._failed.set(asset, failure); throw failure;
        }
    }
}

export class TraceAssetReader {
    private _assets = new Map<string, Asset>();
    private _ids = new WeakMap<Asset, string>();
    public idFor (asset: Asset): string | undefined { return this._ids.get(asset); }
    private _loading = new Set<string>();
    private _borrowed = new Set<Asset>();
    constructor (private _resources: Map<string, Uint8Array>) {}
    public decode (id: string): Asset {
        const previous = this._assets.get(id); if (previous) return previous;
        if (this._loading.has(id)) throw new Error('Cyclic trace asset dependency');
        const bytes = this._resources.get(id); if (!bytes) throw new Error(`Missing trace asset ${id}`);
        const { type, name, state } = readJSON(bytes);
        if (!['cc.ImageAsset', 'cc.Texture2D', 'cc.SpriteFrame', 'cc.Mesh', 'cc.Material', 'cc.EffectAsset'].includes(type)) throw new Error(`Unsupported trace asset ${type}`);
        const Type = js.getClassByName(type) as any; if (!Type) throw new Error(`Enable engine feature for ${type}`);
        this._loading.add(id);
        let asset: any;
        try {
            if (type === 'cc.Mesh') {
                const data = this._resources.get(state.data); if (!data) throw new Error(`Missing mesh bytes ${state.data}`);
                asset = new Type(); asset.reset({ struct: state.struct, data: data.slice() });
            } else if (type === 'cc.EffectAsset') {
                const existing = Type.get(name);
                if (existing) {
                    if (JSON.stringify(effectState(existing)) !== JSON.stringify(effectState(state))) {
                        throw new Error(`Replay effect differs from the loaded engine effect: ${name}`);
                    }
                    asset = existing; this._borrowed.add(asset);
                } else {
                    asset = new Type(); asset.name = name;
                    asset.techniques = state.techniques; asset.shaders = state.shaders; asset.combinations = state.combinations;
                    asset.onLoaded();
                }
            } else if (type === 'cc.Material') {
                asset = new Type(); asset.initialize({ effectAsset: this.decode(state.effect), technique: state.technique,
                    defines: state.defines, states: state.states });
                const props = traceRuntime.decode(state.props);
                props.forEach((pass, index) => Object.keys(pass).forEach((key) => asset.setProperty(key, pass[key], index)));
            } else if (type === 'cc.ImageAsset') {
                const pixels = this._resources.get(state.pixels); if (!pixels) throw new Error(`Missing image bytes ${state.pixels}`);
                if (state.nativeCanvas) {
                    const wx = (globalThis as any).wx;
                    const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : wx?.createCanvas?.();
                    if (!canvas) throw new Error('Canvas required to restore image');
                    canvas.width = state.width; canvas.height = state.height;
                    const context = canvas.getContext('2d'); if (!context) throw new Error('Canvas2D required to restore image');
                    const data = context.createImageData(state.width, state.height); data.data.set(pixels); context.putImageData(data, 0, 0);
                    asset = new Type(canvas);
                } else asset = new Type({ _data: pixels.slice(), width: state.width, height: state.height, format: state.format, _compressed: false });
            } else if (type === 'cc.Texture2D') {
                asset = new Type(); asset.mipmaps = state.mipmaps.map((image: string) => this.decode(image));
                const s = state.sampler; asset.setFilters(s[0], s[1]); asset.setMipFilter(s[2]); asset.setWrapMode(s[3], s[4], s[5]); asset.setAnisotropy(s[6]);
            } else {
                asset = new Type(); asset.reset({ ...state, texture: this.decode(state.texture),
                    rect: new Rect(state.rect[0], state.rect[1], state.rect[2], state.rect[3]), originalSize: new Size(state.originalSize[0], state.originalSize[1]), offset: new Vec2(state.offset[0], state.offset[1]) });
            }
            if (type === 'cc.SpriteFrame') { asset.packable = state.packable; asset.flipUVX = state.flipUVX; asset.flipUVY = state.flipUVY; }
            asset.name = name; this._assets.set(id, asset); this._ids.set(asset, id); return asset;
        } catch (error) { if (asset && !this._borrowed.has(asset)) asset.destroy(); throw error; } finally { this._loading.delete(id); }
    }
    public close (): void { Array.from(this._assets.values()).reverse().forEach((asset) => { if (!this._borrowed.has(asset)) asset.destroy(); }); this._assets.clear(); this._borrowed.clear(); }
}
