/* Copyright (c) 2026 Xiamen Yaji Software Co., Ltd. */
import { installTraceSettingsCodec } from './trace-settings';
import { ccclass } from 'cc.decorator';
import { Scene } from '../../scene-graph/scene';
import { TraceArchiveWriter, readTraceArchive } from './trace-archive';
import { TraceAssetRecorder, TraceAssetReader } from './trace-assets';
import { Node } from '../../scene-graph/node';
import { Component } from '../../scene-graph/component';
import { director, DirectorEvent } from '../director';
import { js, VERSION, Vec2, Vec3, Vec4, Quat, Color, Size, Rect, Mat4, CCObject, cclegacy } from '../../core';
import { Asset } from '../../asset/assets/asset';
import { assetManager } from '../../asset/asset-manager';
import { uiRendererManager } from '../../2d/framework/ui-renderer-manager';
import { TraceCommand, TraceFile, TraceOptions, TracePlayer, TraceValue, traceRuntime } from './trace';

/** Carries original script identity for inspection; replay never executes project script code. */
@ccclass('cc.TraceRecordedComponent')
export class TraceRecordedComponent extends Component {
    public recordedType = '';
}

export interface SceneTraceOptions extends TraceOptions {
    archive?: TraceArchiveWriter;
    onStarted?: () => void;
    /** Default localStorage key on Web. Supply save for native and mini-game filesystems. */
    storageKey?: string;
    /** Project revision/build identifier; required to distinguish builds sharing an engine version. */
    project?: string;
}

const nodeMethods = [
    'setPosition', 'setRotation', 'setRotationFromEuler', 'setScale', 'setRTS',
    'setWorldPosition', 'setWorldRotation', 'setWorldRotationFromEuler', 'setWorldScale',
    'translate', 'rotate', 'lookAt', 'setParent', 'addChild', 'insertChild', 'removeChild',
    'removeAllChildren', 'removeFromParent', 'setSiblingIndex', 'addComponent', 'destroy',
];
const nodeProperties = ['name', 'active', 'layer', 'position', 'rotation', 'scale', 'eulerAngles',
    'worldPosition', 'worldRotation', 'worldScale', 'parent', 'angle'];
const uiClasses = ['cc.UITransform', 'cc.UIOpacity', 'cc.Label', 'cc.RichText', 'cc.Sprite',
    'cc.Layout', 'cc.Widget', 'cc.Mask', 'cc.Graphics', 'cc.ScrollView', 'cc.ProgressBar',
    'cc.Button', 'cc.Toggle', 'cc.ToggleContainer', 'cc.Slider', 'cc.EditBox', 'cc.Canvas', 'cc.Camera', 'cc.DirectionalLight', 'cc.MeshRenderer'];
const derivedProperties = new Set(['material', 'materials', 'sharedMaterials', 'fontAtlas', 'actualFontSize', 'contentWidth', 'recieveShadows', 'enableDynamicBatching']);
const deprecatedProperties = new Set(['priority', 'color', 'depth', 'stencil', 'clearFlag', 'targetTexture']);
const uiMethods = new Set(['setContentSize', 'setAnchorPoint', 'convertToNodeSpaceAR', 'convertToWorldSpaceAR',
    'moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo', 'arc', 'ellipse', 'circle', 'rect', 'roundRect',
    'setSharedMaterial', 'setMaterialInstance', 'clear', 'close', 'stroke', 'fill', 'updateLayout', 'updateAlignment', 'scrollToTop', 'scrollToBottom',
    'scrollToLeft', 'scrollToRight', 'scrollToOffset', 'scrollToPercentHorizontal', 'scrollToPercentVertical', 'stopAutoScroll']);
const lifecycle = new Set(['constructor', 'onLoad', 'onEnable', 'onDisable', 'onDestroy', 'start', 'update', 'lateUpdate',
    'resetInEditor', 'onFocusInEditor', 'onLostFocusInEditor', 'onRestore', 'onValidate']);
let assetRecorder: TraceAssetRecorder | null = null;
let assetReader: TraceAssetReader | null = null;
let configured: SceneTraceOptions | null = null;
let codecsInstalled = false;
let replaying = false;
let autoStarted = false;
let activePlayer: TracePlayer | null = null;
let restoreCallbacks: (() => void)[] = [];
let removeErrors: (() => void) | null = null;
let replayWasPaused = false;
let replayGameWasPaused = false;

function instrumentSetter (prototype: object, property: string, prefix: string): void {
    let owner: object | null = prototype;
    while (owner && !Object.prototype.hasOwnProperty.call(owner, property)) owner = Object.getPrototypeOf(owner);
    if (owner) traceRuntime.instrument(owner, property, `${prefix}.${property}=`, true);
}

function install (): void {
    if (!codecsInstalled) {
        codecsInstalled = true;
        installTraceSettingsCodec();
        const valueTypes: [string, any, string[]][] = [
            ['Vec2', Vec2, ['x', 'y']], ['Vec3', Vec3, ['x', 'y', 'z']], ['Vec4', Vec4, ['x', 'y', 'z', 'w']],
            ['Quat', Quat, ['x', 'y', 'z', 'w']], ['Color', Color, ['r', 'g', 'b', 'a']],
            ['Size', Size, ['width', 'height']], ['Rect', Rect, ['x', 'y', 'width', 'height']],
            ['Mat4', Mat4, Array.from({ length: 16 }, (_, i) => `m${i < 10 ? '0' : ''}${i}`)],
        ];
        valueTypes.forEach(([name, Type, keys]) => traceRuntime.addCodec({
            name, test: (value) => value.constructor === Type,
            encode: (value) => keys.map((key) => traceRuntime.encode(value[key])),
            decode: (values) => {
                if (!Array.isArray(values) || values.length !== keys.length) throw new Error(`Invalid ${name}`);
                const value = new Type();
                keys.forEach((key, i) => { value[key] = traceRuntime.decode(values[i]); });
                return value;
            },
        }));
        traceRuntime.addCodec({
            name: 'StaticLightSettings',
            test: (value) => js.getClassName(value) === 'cc.StaticLightSettings',
            encode: (value: any) => [value.baked, value.editorOnly, value.castShadow],
            decode: (value) => {
                const Type = js.getClassByName('cc.StaticLightSettings') as any;
                if (!Type) throw new Error('Enable the 3d engine feature to replay light settings');
                const settings = new Type();
                [settings.baked, settings.editorOnly, settings.castShadow] = value as boolean[];
                return settings;
            },
        });
        traceRuntime.addCodec({
            name: 'Asset', test: (value) => value instanceof Asset,
            encode: (value: Asset) => {
                if (assetRecorder) return assetRecorder.encode(value);
                const archivedId = assetReader?.idFor(value); if (archivedId) return archivedId;
                if (!value.uuid) throw new Error('Runtime asset has no UUID; capture its creation with a custom adapter');
                return value.uuid;
            },
            decode: (uuid) => {
                if (assetReader) return assetReader.decode(uuid as string);
                const asset = assetManager.assets.get(uuid as string);
                if (!asset) throw new Error(`Preload trace asset: ${String(uuid)}`);
                return asset;
            },
        });
        traceRuntime.addCodec({
            name: 'ComponentClass',
            test: (value) => typeof value === 'function' && (value === Component || value.prototype instanceof Component),
            encode: (value) => {
                const name = js.getClassName(value); const id = js.getClassId(value, false);
                if (!uiClasses.includes(name)) throw new Error(`Unsupported component class: ${name} (classId: ${id || 'unregistered'}); add a component replay adapter`);
                return { name, id };
            },
            decode: (identity) => {
                // String payloads from earlier recordings remain readable.
                const name = typeof identity === 'string' ? identity : (identity as any)?.name;
                const id = typeof identity === 'string' ? '' : (identity as any)?.id;
                if (!uiClasses.includes(name)) throw new Error(`Unsupported component class: ${String(name)}`);
                const type = (id && js._getClassById(id)) || js.getClassByName(name);
                if (!type || js.getClassName(type) !== name) throw new Error(`Missing or mismatched component class: ${name}`);
                return type;
            },
        });
        traceRuntime.describeValue = (value) => {
            if (typeof value === 'function' && (value === Component || value.prototype instanceof Component)) {
                return `ComponentClass ${js.getClassName(value)} (classId: ${js.getClassId(value, false) || 'unregistered'})`;
            }
            if (value instanceof Component) return `Component ${js.getClassName(value)}`;
            return value === null ? 'null' : typeof value;
        };
        traceRuntime.factory('Node', (args) => new Node(args[0]));
        traceRuntime.onBindResult = (value, id) => {
            if (value instanceof Component) value.node.components.forEach((component, index) => {
                if (!traceRuntime.hasObject(component)) traceRuntime.bind(`${id}/required:${index}`, component);
            });
        };
        traceRuntime.adoptResult = (value) => value instanceof Component && uiClasses.includes(js.getClassName(value));
    }
    nodeMethods.forEach((method) => traceRuntime.instrument(Node.prototype, method, `Node.${method}`));
    nodeProperties.forEach((property) => instrumentSetter(Node.prototype, property, 'Node'));
    instrumentSetter(Component.prototype, 'enabled', 'Component');
    traceRuntime.instrument(Component.prototype, 'destroy', 'Component.destroy');
    uiClasses.forEach((name) => {
        const Type = js.getClassByName(name);
        if (!Type) return;
        let prototype = Type.prototype as object;
        while (prototype && prototype !== Component.prototype) {
            const ownerName = js.getClassName((prototype as any).constructor);
            Object.getOwnPropertyNames(prototype).forEach((property) => {
                if (property.startsWith('_') || lifecycle.has(property)) return;
                const descriptor = Object.getOwnPropertyDescriptor(prototype, property)!;
                if (descriptor.set) traceRuntime.instrument(prototype, property, `${ownerName}.${property}=`, true);
                else if (typeof descriptor.value === 'function' && uiMethods.has(property)) {
                    traceRuntime.instrument(prototype, property, `${ownerName}.${property}`);
                }
            });
            prototype = Object.getPrototypeOf(prototype);
        }
    });
}

/** Bind by scene-relative child indices and component indices, not machine-dependent instance IDs. */
function baseline (): TraceValue {
    const scene = director.getScene();
    if (!scene) throw new Error('Load the matching project scene before using trace');
    traceRuntime.resetObjects();
    const nodes: Node[] = [];
    const paths: string[] = [];
    const visit = (node: Node, path: string): void => {
        traceRuntime.bind(path, node);
        nodes.push(node);
        paths.push(path);
        node.components.forEach((component, index) => traceRuntime.bind(`${path}/c${index}`, component));
        node.children.forEach((child, index) => visit(child, `${path}/${index}`));
    };
    visit(scene, 'scene');
    return nodes.map((node, i) => ({
        ...(i === 0 ? { globals: traceRuntime.encode(scene.globals) } : {}),
        path: paths[i], name: node.name, active: node.active, layer: node.layer,
        position: traceRuntime.encode(node.position), rotation: traceRuntime.encode(node.rotation), scale: traceRuntime.encode(node.scale),
        components: node.components.map((component) => ({
            type: js.getClassName(component), enabled: component.enabled,
            // Engine component properties that have public read/write accessors form a diagnostic fingerprint.
            properties: componentState(component),
            ...(js.getClassName(component) === 'cc.MeshRenderer' ? {
                renderMaterials: traceRuntime.encode((component as any)._materials.map((mat, index) => (component as any).getRenderMaterial(index))),
                bakeSettings: traceRuntime.encode((component as any).bakeSettings),
            } : {}),
            ...(js.getClassName(component) === 'cc.DirectionalLight' ? {
                lightIntensity: { hdr: (component as any)._illuminanceHDR, ldr: (component as any)._illuminanceLDR },
            } : {}),
        })),
    }));
}

function componentState (component: Component): TraceValue {
    const state: Record<string, TraceValue> = {};
    if (!uiClasses.includes(js.getClassName(component))) return state;
    let prototype = Object.getPrototypeOf(component);
    while (prototype && prototype !== Component.prototype) {
        for (const key of Object.getOwnPropertyNames(prototype)) {
            const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
            if (deprecatedProperties.has(key) && ['cc.Canvas', 'cc.Camera', 'cc.UITransform'].includes(js.getClassName(prototype.constructor))) continue;
            if (derivedProperties.has(key) || key.startsWith('_') || !descriptor.get || !descriptor.set || key in state) continue;
            try { state[key] = traceRuntime.encode((component as any)[key]); }
            catch (error) { state[key] = { $unavailable: String(error) }; }
        }
        prototype = Object.getPrototypeOf(prototype);
    }
    return state;
}

function startScene (): void {
    if (!configured || replaying || autoStarted) return;
    autoStarted = true;
    startSceneTrace(configured);
}

/** Called by game.init. Disabled by default; recording starts after the first scene launch. */
export function configureSceneTrace (options: boolean | SceneTraceOptions | undefined): void {
    director.off(DirectorEvent.AFTER_SCENE_LAUNCH, startScene);
    director.off(DirectorEvent.BEFORE_SCENE_LAUNCH, beforeSceneChange);
    autoStarted = false;
    configured = options ? (options === true ? {} : options) : null;
    if (!configured) {
        stopSceneTrace();
        traceRuntime.dispose();
        return;
    }
    install();
    director.on(DirectorEvent.AFTER_SCENE_LAUNCH, startScene);
}

export function startSceneTrace (options: SceneTraceOptions = configured || {}): void {
    if (replaying) throw new Error('Close replay before recording');
    stopSceneTrace();
    install();
    director.off(DirectorEvent.BEFORE_SCENE_LAUNCH, beforeSceneChange);
    director.once(DirectorEvent.BEFORE_SCENE_LAUNCH, beforeSceneChange);
    assetRecorder = options.archive ? new TraceAssetRecorder(options.archive) : null;
    const initial = baseline();
    wrapUserCallbacks();
    const save = options.save || (options.archive ? undefined : ((json: string): void => {
        if (typeof localStorage === 'undefined') throw new Error('Provide trace.save on this platform');
        localStorage.setItem(options.storageKey || 'cocos.scene-trace', json);
    }));
    const journal = options.archive ? {
        start: (file: TraceFile): void => { options.archive!.start(file); assetRecorder!.start(); },
        begin: (command: TraceCommand): void => options.archive!.begin(command),
        end: (command: TraceCommand): void => options.archive!.end(command),
        event: (command: TraceCommand): void => options.archive!.event(command),
        stop: (reason: string): void => options.archive!.stop(reason),
    } : options.journal;
    traceRuntime.start({ engine: VERSION, project: options.project || '', scene: director.getScene()!.name,
        platform: typeof navigator !== 'undefined' ? navigator.userAgent : 'non-browser',
        startedAt: new Date().toISOString() }, initial, { ...options, journal, save });
    const originalConsoleError = console.error;
    const captureConsoleError = (...args: unknown[]): void => {
        originalConsoleError.apply(console, args);
        traceRuntime.recordError(new Error(args.map((arg) => {
            try { return typeof arg === 'string' ? arg : JSON.stringify(arg); } catch { return '[unserializable console argument]'; }
        }).join(' ')));
    };
    console.error = captureConsoleError;
    const restoreConsole = (): void => { if (console.error === captureConsoleError) console.error = originalConsoleError; };
    const wx = (globalThis as any).wx;
    const onWxError = (message: string): void => traceRuntime.recordError(message);
    const onWxRejection = (event: { reason: unknown }): void => traceRuntime.recordError(event.reason);
    // Register only when removable, so repeated captures do not accumulate platform listeners.
    if (wx?.onError && wx?.offError) wx.onError(onWxError);
    if (wx?.onUnhandledRejection && wx?.offUnhandledRejection) wx.onUnhandledRejection(onWxRejection);
    const restorePlatformErrors = (): void => {
        restoreConsole();
        if (wx?.onError && wx?.offError) wx.offError(onWxError);
        if (wx?.onUnhandledRejection && wx?.offUnhandledRejection) wx.offUnhandledRejection(onWxRejection);
    };
    removeErrors = restorePlatformErrors;
    if (typeof window !== 'undefined' && window.addEventListener) {
        const onError = (event: ErrorEvent): void => traceRuntime.recordError(event.error || event.message);
        const onRejection = (event: PromiseRejectionEvent): void => traceRuntime.recordError(event.reason);
        const onPageHide = (): void => traceRuntime.flush();
        window.addEventListener('error', onError);
        window.addEventListener('unhandledrejection', onRejection);
        window.addEventListener('pagehide', onPageHide);
        removeErrors = (): void => {
            restorePlatformErrors();
            window.removeEventListener('error', onError);
            window.removeEventListener('unhandledrejection', onRejection);
            window.removeEventListener('pagehide', onPageHide);
        };
    }
    try { options.onStarted?.(); } catch (error) { console.warn(`Trace controls unavailable: ${String(error)}`); }
}

export function stopSceneTrace (): void {
    traceRuntime.stop();
    assetRecorder = null;
    removeErrors?.();
    removeErrors = null;
    if (!replaying) restoreUserCallbacks();
}

export function exportSceneTrace (): string {
    if (!traceRuntime.file) throw new Error('No trace recorded');
    return JSON.stringify(traceRuntime.file, null, 2);
}

/** Render without dispatching input, component updates, scheduler or physics. */
function renderReplay (command: TraceCommand, draw = true): void {
    if (command.api === 'deferredDestroy' && command.kind === 'frame') CCObject._deferredDestroy();
    if (draw) {
        uiRendererManager.updateAllDirtyRenderers();
        director.root?.frameMove(0);
    }
    if (command.api === 'endFrame' && command.kind === 'frame') {
        Node.resetHasChangedFlags();
        Node.clearNodeArray();
    }
}

/** Caller loads the same scene/assets before opening. Baseline differences fail before any command executes. */
export function openSceneTrace (json: string, project = ''): TracePlayer {
    if (replaying) throw new Error('Close the current replay and reload the scene first');
    if (json.length > 32 * 1024 * 1024) throw new Error('Trace exceeds 32 MiB');
    const file = JSON.parse(json) as TraceFile;
    if (file.version !== 1 || !file.metadata || file.metadata.engine !== VERSION || file.metadata.project !== project) {
        throw new Error('Trace schema, engine version or project revision differs');
    }
    stopSceneTrace();
    install();
    const player = new TracePlayer(file, traceRuntime, renderReplay);
    const actual = baseline();
    if (JSON.stringify(actual) !== JSON.stringify(file.baseline)) throw new Error('Scene baseline differs; reload the original scene and initial state');
    replayWasPaused = director.isPaused();
    replayGameWasPaused = directorGame().isPaused();
    directorGame().pause();
    director.pause();
    replaying = true;
    traceRuntime.replaying = true;
    wrapUserCallbacks();
    activePlayer = player;
    return player;
}

// Resolve the game singleton lazily to avoid a game -> trace -> game initialization cycle.
function directorGame (): { pause: () => void; resume: () => void; isPaused: () => boolean } { return cclegacy.game; }

/** The replayed scene is mutated; reload it before starting another replay. */
export function closeSceneTrace (): void {
    if (!replaying) return;
    replaying = false;
    traceRuntime.replaying = false;
    activePlayer?.close();
    activePlayer = null;
    restoreUserCallbacks();
    assetReader = null; // Reconstructed scene owns these assets until it is destroyed.
    if (!replayWasPaused) director.resume();
    if (!replayGameWasPaused) directorGame().resume();
}

function restoreUserCallbacks (): void {
    restoreCallbacks.reverse().forEach((restore) => restore());
    restoreCallbacks = [];
}

/** Suppress script lifecycle side effects on replay; their recorded engine calls run independently. */
function wrapUserCallbacks (): void {
    restoreUserCallbacks();
    const visit = (node: Node): void => {
        node.components.forEach((component) => {
            if (js.getClassName(component).startsWith('cc.')) return;
            lifecycle.forEach((name) => {
                if (name === 'constructor') return;
                const original = (component as any)[name];
                if (typeof original !== 'function') return;
                const descriptor = Object.getOwnPropertyDescriptor(component, name);
                Object.defineProperty(component, name, { configurable: true, writable: true, value: function (...args: unknown[]): unknown {
                    if (traceRuntime.replaying) return undefined;
                    return traceRuntime.external(() => original.apply(this, args));
                } });
                restoreCallbacks.push(() => {
                    if (descriptor) Object.defineProperty(component, name, descriptor);
                    else delete (component as any)[name];
                });
            });
        });
        node.children.forEach(visit);
    };
    const scene = director.getScene();
    if (scene) visit(scene);
}

function beforeSceneChange (): void {
    if (traceRuntime.recording) traceRuntime.stop('scene changed');
    stopSceneTrace();
}

/** Rebuild the supported UI subset from its baseline and packed immutable textures. */
export function openSceneTraceArchive (text: string, binary: Uint8Array): TracePlayer {
    if (replaying) throw new Error('Close the current replay first');
    const archive = readTraceArchive(text, binary);
    const file = archive.file;
    if (file.metadata.engine !== VERSION) throw new Error('Trace engine version differs');
    if (!Array.isArray(file.baseline) || file.baseline.length === 0 || file.baseline.length > 100000) throw new Error('Invalid scene snapshot');
    const supported = new Set(['cc.UITransform', 'cc.UIOpacity', 'cc.Label', 'cc.Sprite', 'cc.Canvas', 'cc.Camera', 'cc.DirectionalLight', 'cc.MeshRenderer', 'cc.Button']);
    const warnings: string[] = [];
    const rows = file.baseline as any[];
    const paths = new Set<string>();
    for (const row of rows) {
        if (typeof row.path !== 'string' || !/^scene(?:\/\d+)*$/.test(row.path) || paths.has(row.path)
            || (row.path !== 'scene' && !paths.has(row.path.slice(0, row.path.lastIndexOf('/'))))
            || !Array.isArray(row.components)) throw new Error('Invalid scene snapshot hierarchy');
        paths.add(row.path);
        for (const component of row.components) {
            if (typeof component.type !== 'string' || (component.type.startsWith('cc.') && !supported.has(component.type))) throw new Error(`Standalone replay does not support component ${component.type}`);
            if (supported.has(component.type) && !js.getClassByName(component.type)) throw new Error(`Replay engine feature is missing for ${component.type}; enable the 3d feature for lights`);
            if (component.type === 'cc.DirectionalLight') {
                if (!component.properties || !Object.keys(component.properties).length) {
                    warnings.push(`${row.path}: 旧 trace 未记录方向光属性，使用默认灯光；要准确还原光照，请更新录制端后重新录制。`);
                    component.properties = {};
                }
                const intensity = component.lightIntensity;
                if (intensity && (!Number.isFinite(intensity.hdr) || !Number.isFinite(intensity.ldr))) throw new Error('Invalid directional light intensity');
            }
            if (JSON.stringify(component.properties).includes('"$unavailable"')) throw new Error(`Incomplete snapshot for ${row.path}: ${component.type}: ${JSON.stringify(component.properties)}`);
        }
    }
    stopSceneTrace(); install();
    // Validate command structure before creating engine objects or changing the current scene.
    const player = new TracePlayer(file, traceRuntime, renderReplay);
    player.warnings.push(...warnings);
    const reader = new TraceAssetReader(archive.resources);
    assetReader = reader;
    const scene = new Scene(rows[0].name);
    const nodes = new Map<string, Node>();
    traceRuntime.resetObjects();
    try {
        if (rows[0].globals) scene._globals = traceRuntime.decode(rows[0].globals);
        for (const row of rows) {
            const node: Node = row.path === 'scene' ? scene : new Node(row.name);
            node.active = false; node.layer = row.layer;
            nodes.set(row.path, node); traceRuntime.bind(row.path, node);
            if (row.path !== 'scene') nodes.get(row.path.slice(0, row.path.lastIndexOf('/')))!.addChild(node);
            for (let i = 0; i < row.components.length; ++i) {
                const record = row.components[i]; const Type = supported.has(record.type) ? js.getClassByName(record.type) as typeof Component : TraceRecordedComponent;
                const component = node.components[i] || node.addComponent(Type);
                if (component instanceof TraceRecordedComponent) component.recordedType = record.type;
                else if (js.getClassName(component) !== record.type) throw new Error(`Component dependency order differs at ${row.path}`);
                component.enabled = false; traceRuntime.bind(`${row.path}/c${i}`, component);
            }
        }
        for (const row of rows) {
            const node = nodes.get(row.path)!;
            node.setPosition(traceRuntime.decode(row.position) as Vec3);
            node.setRotation(traceRuntime.decode(row.rotation) as Quat);
            node.setScale(traceRuntime.decode(row.scale) as Vec3);
            // Sprite/Label setters can resize their UITransform. Restore explicit layout last.
            const ordered = row.components.map((record, index) => ({ record, index }))
                .sort((a, b) => Number(a.record.type === 'cc.UITransform') - Number(b.record.type === 'cc.UITransform'));
            ordered.forEach(({ record, index }) => {
                const component = node.components[index];
                for (const key of Object.keys(record.properties)) {
                    if (key.startsWith('_') || key === '__proto__' || key === 'constructor') throw new Error('Invalid snapshot property');
                    let prototype = Object.getPrototypeOf(component); let descriptor: PropertyDescriptor | undefined;
                    while (prototype && !descriptor) { descriptor = Object.getOwnPropertyDescriptor(prototype, key); prototype = Object.getPrototypeOf(prototype); }
                    if (!descriptor?.set) throw new Error(`Unknown snapshot setter ${record.type}.${key}`);
                    (component as any)[key] = traceRuntime.decode(record.properties[key]);
                }
                if (record.type === 'cc.MeshRenderer') {
                    if (record.bakeSettings) (component as any).bakeSettings = traceRuntime.decode(record.bakeSettings);
                    if (record.renderMaterials) (component as any).sharedMaterials = traceRuntime.decode(record.renderMaterials);
                }
                if (record.type === 'cc.DirectionalLight' && record.lightIntensity) {
                    // Preserve both exposure branches before onLoad creates the render light.
                    (component as any)._illuminanceHDR = record.lightIntensity.hdr;
                    (component as any)._illuminanceLDR = record.lightIntensity.ldr;
                }
                component.enabled = record.enabled;
            });
        }
        rows.forEach((row) => { nodes.get(row.path)!.active = row.active; });
        replayWasPaused = director.isPaused(); replayGameWasPaused = directorGame().isPaused();
        directorGame().pause(); director.pause();
        director.off(DirectorEvent.AFTER_SCENE_LAUNCH, startScene);
        wrapUserCallbacks();
        replaying = true; traceRuntime.replaying = true;
        director.runSceneImmediate(scene);
        scene.once(Node.EventType.NODE_DESTROYED, () => reader.close());
        activePlayer = player;
        renderReplay({ index: -1, frame: 0, kind: 'frame', target: '', api: 'baseline', args: [] });
        return player;
    } catch (error) {
        if (replaying) closeSceneTrace();
        scene.destroy(); reader.close(); assetReader = null;
        throw error;
    }
}


export function inspectSceneTrace (): { nodeCount: number; componentCount: number; scene: unknown } {
    let nodeCount = 0; let componentCount = 0;
    const visit = (node: Node): unknown => {
        ++nodeCount; componentCount += node.components.length;
        return { name: node.name, active: node.active, layer: node.layer,
            position: { x: node.position.x, y: node.position.y, z: node.position.z },
            scale: { x: node.scale.x, y: node.scale.y, z: node.scale.z },
            components: node.components.map((component) => ({
                type: component instanceof TraceRecordedComponent ? component.recordedType : js.getClassName(component),
                enabled: component.enabled, properties: componentState(component),
            })), children: node.children.map(visit) };
    };
    const scene = director.getScene(); const state = scene ? visit(scene) : null;
    return { nodeCount, componentCount, scene: state };
}
