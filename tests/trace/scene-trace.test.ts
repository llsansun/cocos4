import { Node, Scene, Component } from '../../cocos/scene-graph';
import { Color, CCObject } from '../../cocos/core';
import { ccclass } from '../../cocos/core/data/decorators';
import { director, game, DirectorEvent } from '../../cocos/game';
import { Label, UITransform, UIOpacity } from '../../cocos/2d';
import { openSceneTraceArchive, configureSceneTrace, startSceneTrace, stopSceneTrace, exportSceneTrace, openSceneTrace, closeSceneTrace } from '../../cocos/game/trace/scene-trace';
import { uiRendererManager } from '../../cocos/2d/framework/ui-renderer-manager';
import { Batcher2D } from '../../cocos/2d/renderer/batcher-2d';
import { traceRuntime } from '../../cocos/game/trace/trace';

let disabledCalls = 0;
@ccclass('TraceTestScript')
class Script extends Component {
    onDisable (): void { ++disabledCalls; this.node.setPosition(17, 18, 0); }
}
function sceneFixture (): { scene: Scene; node: Node; label: Label } {
    if (!director.root!.batcher2D) (director.root as any)._batcher = new Batcher2D(director.root!);
    const scene = new Scene('trace-fixture');
    const node = new Node('label');
    node.addComponent(UITransform);
    const label = node.addComponent(Label);
    label.string = 'baseline';
    label.color = new Color(255, 255, 255, 255);
    scene.addChild(node);
    director.runSceneImmediate(scene);
    return { scene, node, label };
}
beforeEach(() => { configureSceneTrace(false); closeSceneTrace(); disabledCalls = 0;
    // JSDOM has no Canvas2D/WebGL; assert scene mutations and render invocation here.
    jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    jest.spyOn(uiRendererManager, 'updateAllDirtyRenderers').mockImplementation(() => {});
});
afterEach(() => { closeSceneTrace(); configureSceneTrace(false); jest.restoreAllMocks(); });

test('real scene -> JSON -> matching scene -> command/frame replay including inherited UI properties', () => {
    let { node, label } = sceneFixture();
    startSceneTrace({ project: 'fixture', save: () => {} });
    traceRuntime.beginFrame(0.016);
    node.setPosition(20, 30, 0);
    label.string = 'recorded';
    label.color = new Color(10, 20, 30, 255);
    traceRuntime.boundary('endFrame');
    traceRuntime.beginFrame(0.02);
    node.setScale(2, 3, 1);
    traceRuntime.boundary('endFrame');
    stopSceneTrace();
    const json = exportSceneTrace();
    expect(traceRuntime.file!.commands.filter((c) => c.unsupported)).toEqual([]);
    ({ node, label } = sceneFixture());
    const render = jest.spyOn(director.root!, 'frameMove').mockImplementation(() => {});
    const player = openSceneTrace(json, 'fixture');
    expect(game.isPaused()).toBe(true);
    player.stepFrame();
    expect(node.position.x).toBe(20);
    expect(label.string).toBe('recorded');
    expect(label.color.r).toBe(10);
    expect(node.scale.x).toBe(1);
    player.stepFrame();
    expect(node.scale.x).toBe(2);
    expect(player.lastStep?.command.error).toBeUndefined();
    expect(player.lastStep?.mismatch).toBeUndefined();
    expect(player.halted).toBe(false);
    expect(player.done).toBe(true);
    expect(render).toHaveBeenCalledTimes(2);
});

test('dynamic nodes and components retain their identity', () => {
    let { scene } = sceneFixture();
    startSceneTrace({ save: () => {} });
    const dynamic = new Node('dynamic');
    scene.addChild(dynamic);
    const opacity = dynamic.addComponent(UIOpacity);
    opacity.opacity = 81;
    stopSceneTrace();
    const json = exportSceneTrace();
    expect(traceRuntime.file!.commands.filter((c) => c.unsupported)).toEqual([]);
    ({ scene } = sceneFixture());
    jest.spyOn(director.root!, 'frameMove').mockImplementation(() => {});
    const player = openSceneTrace(json);
    while (!player.done && !player.halted) player.stepCommand();
    expect(player.lastStep?.command.error).toBeUndefined();
    expect(player.lastStep?.mismatch).toBeUndefined();
    expect(player.halted).toBe(false);
    expect(scene.children[1].getComponent(UIOpacity)!.opacity).toBe(81);
});

test('deferred destruction is replayed only at its recorded boundary', () => {
    let { node } = sceneFixture();
    startSceneTrace({ save: () => {} });
    traceRuntime.beginFrame(0.016);
    node.destroy();
    node.setPosition(1, 2, 3);
    traceRuntime.boundary('deferredDestroy');
    CCObject._deferredDestroy();
    traceRuntime.boundary('endFrame');
    stopSceneTrace();
    const json = exportSceneTrace();
    ({ node } = sceneFixture());
    jest.spyOn(director.root!, 'frameMove').mockImplementation(() => {});
    const player = openSceneTrace(json);
    player.stepCommand(); // frame
    player.stepCommand(); // destroy
    expect(node.isValid).toBe(true);
    player.stepCommand(); // position
    expect(node.position.x).toBe(1);
    player.stepCommand(); // deferredDestroy
    expect(node.isValid).toBe(false);
});

test('custom lifecycle engine calls replay once without executing the script again', () => {
    let { node } = sceneFixture();
    node.addComponent(Script);
    startSceneTrace({ save: () => {} });
    node.active = false;
    expect(disabledCalls).toBe(1);
    stopSceneTrace();
    const json = exportSceneTrace();
    ({ node } = sceneFixture());
    node.addComponent(Script);
    disabledCalls = 0;
    jest.spyOn(director.root!, 'frameMove').mockImplementation(() => {});
    const player = openSceneTrace(json);
    player.stepFrame();
    expect(disabledCalls).toBe(0);
    expect(node.position.x).toBe(17);
    expect(node.active).toBe(false);
    closeSceneTrace();
    expect(() => player.stepCommand()).toThrow('halted');
});

test('rejects a changed baseline and project before executing commands', () => {
    let { node } = sceneFixture();
    startSceneTrace({ project: 'revision-a', save: () => {} });
    node.setPosition(100, 0, 0);
    stopSceneTrace();
    const json = exportSceneTrace();
    ({ node } = sceneFixture());
    expect(() => openSceneTrace(json, 'revision-b')).toThrow('revision');
    node.setPosition(1, 0, 0);
    expect(() => openSceneTrace(json, 'revision-a')).toThrow('baseline');
    expect(node.position.x).toBe(1);
});

test('a dynamically added Label binds its required UITransform for later API calls', () => {
    let { scene } = sceneFixture();
    startSceneTrace({ save: () => {} });
    const node = new Node('new-label');
    scene.addChild(node);
    const label = node.addComponent(Label);
    label.string = 'new';
    node.getComponent(UITransform)!.setContentSize(123, 45);
    stopSceneTrace();
    const json = exportSceneTrace();
    expect(traceRuntime.file!.commands.filter((c) => c.unsupported)).toEqual([]);
    ({ scene } = sceneFixture());
    jest.spyOn(director.root!, 'frameMove').mockImplementation(() => {});
    const player = openSceneTrace(json);
    player.stepFrame();
    expect(player.lastStep?.command.error).toBeUndefined();
    expect(player.lastStep?.mismatch).toBeUndefined();
    expect(player.halted).toBe(false);
    expect(scene.children[1].getComponent(UITransform)!.width).toBe(123);
});

test('director ticks are blocked during replay and pause state is restored on close', () => {
    const { node } = sceneFixture();
    startSceneTrace({ save: () => {} });
    node.setPosition(2, 0, 0);
    stopSceneTrace();
    const json = exportSceneTrace();
    sceneFixture();
    const onUpdate = jest.fn();
    director.on(DirectorEvent.BEFORE_UPDATE, onUpdate);
    const wasPaused = game.isPaused();
    try {
        openSceneTrace(json);
        director.tick(0.016);
        expect(onUpdate).not.toHaveBeenCalled();
        closeSceneTrace();
        expect(game.isPaused()).toBe(wasPaused);
    } finally { director.off(DirectorEvent.BEFORE_UPDATE, onUpdate); }
});

test('automatic recording stops on scene changes without overwriting the first trace', () => {
    configureSceneTrace({ save: () => {} });
    const { node } = sceneFixture();
    node.setPosition(3, 0, 0);
    const file = traceRuntime.file;
    sceneFixture();
    expect(traceRuntime.recording).toBe(false);
    expect(traceRuntime.file).toBe(file);
    expect(file!.stopped).toBe('scene changed');
    sceneFixture();
    expect(traceRuntime.file).toBe(file);
});

test('console errors are saved and console.error is restored after recording', () => {
    sceneFixture();
    const original = jest.spyOn(console, 'error').mockImplementation(() => {});
    startSceneTrace({ save: () => {} });
    console.error('UI failure', 42);
    expect(original).toHaveBeenCalledWith('UI failure', 42);
    expect(traceRuntime.file!.commands.some((entry) => entry.error?.message === 'UI failure 42')).toBe(true);
    stopSceneTrace();
    expect(console.error).toBe(original);
});


test('two-file snapshot rebuilds a Label scene without the original fixture', () => {
    const { TraceArchiveWriter } = require('../../cocos/game/trace/trace-archive');
    let text = ''; const chunks: number[] = [];
    const writer = new TraceArchiveWriter({ appendText: (line) => { text += line; },
        appendBinary: (bytes) => { chunks.push(...bytes); }, flush: () => {} }, 'standalone');
    const { node, label } = sceneFixture();
    startSceneTrace({ archive: writer, save: () => {} });
    traceRuntime.beginFrame(0.016); node.setPosition(77, 12, 0); label.string = 'restored'; traceRuntime.boundary('endFrame');
    stopSceneTrace();
    director.runSceneImmediate(new Scene('empty'));
    jest.spyOn(director.root!, 'frameMove').mockImplementation(() => {});
    const player = openSceneTraceArchive(text, new Uint8Array(chunks));
    expect(director.getScene()!.name).toBe('trace-fixture');
    expect(director.getScene()!.children[0].getComponent(Label)!.string).toBe('baseline');
    player.stepFrame();
    expect(player.halted).toBe(false);
    expect(director.getScene()!.children[0].getComponent(Label)!.string).toBe('restored');
    expect(director.getScene()!.children[0].position.x).toBe(77);
});

test('standalone pair carries texture bytes and uses script placeholders without executing scripts', () => {
    const { ImageAsset, Texture2D } = require('../../cocos/asset/assets');
    const { Sprite, SpriteFrame } = require('../../cocos/2d');
    const { TraceArchiveWriter } = require('../../cocos/game/trace/trace-archive');
    let text = ''; const chunks: number[] = [];
    const writer = new TraceArchiveWriter({ appendText: (line) => { text += line; },
        appendBinary: (bytes) => { chunks.push(...bytes); }, flush: () => {} }, 'texture');
    const { scene } = sceneFixture();
    const spriteNode = new Node('sprite'); spriteNode.active = false; scene.addChild(spriteNode);
    const image = new ImageAsset({ _data: new Uint8Array([13, 27, 45, 255]), width: 1, height: 1,
        format: Texture2D.PixelFormat.RGBA8888, _compressed: false });
    const texture = new Texture2D(); texture.image = image;
    const frame = new SpriteFrame(); frame.texture = texture; frame.packable = false;
    const sprite = spriteNode.addComponent(Sprite); sprite.spriteFrame = frame;
    sprite.sizeMode = Sprite.SizeMode.CUSTOM;
    spriteNode.getComponent(UITransform)!.setContentSize(96, 80);
    spriteNode.addComponent(Script);
    startSceneTrace({ archive: writer }); spriteNode.setPosition(33, 0, 0); stopSceneTrace();
    jest.spyOn(director.root!, 'frameMove').mockImplementation(() => {});
    const player = openSceneTraceArchive(text, new Uint8Array(chunks));
    const restored = director.getScene()!.getChildByName('sprite')!;
    expect(Array.from(restored.getComponent(Sprite)!.spriteFrame.texture.image.data)).toEqual([13, 27, 45, 255]);
    expect((restored.components[2] as any).recordedType).toBe('TraceTestScript');
    expect(restored.getComponent(Script)).toBeNull();
    expect(restored.getComponent(UITransform)!.width).toBe(96);
    expect(restored.getComponent(UITransform)!.height).toBe(80);
    player.stepCommand(); expect(player.halted).toBe(false); expect(restored.position.x).toBe(33);
});

test('TraceReplay component survives scene replacement and exposes stepping and inspection', () => {
    const { TraceReplay } = require('../../cocos/game/trace/trace-replay');
    const { TraceArchiveWriter } = require('../../cocos/game/trace/trace-archive');
    let text = ''; const bytes: number[] = [];
    const writer = new TraceArchiveWriter({ appendText: (line) => { text += line; },
        appendBinary: (chunk) => { bytes.push(...chunk); }, flush: () => {} }, 'component');
    const { label } = sceneFixture(); startSceneTrace({ archive: writer });
    label.string = 'component replay'; stopSceneTrace();
    const control = new Node('TraceControl'); director.getScene()!.addChild(control);
    const replay = control.addComponent(TraceReplay);
    jest.spyOn(director.root!, 'frameMove').mockImplementation(() => {});
    try {
        replay.loadPair({ text, binary: new Uint8Array(bytes) });
        expect(replay.isValid).toBe(true); expect(control.parent).toBe(director.getScene());
        replay.stepCommand();
        expect(replay.player.halted).toBe(false);
        expect(director.getScene()!.getChildByName('label')!.getComponent(Label)!.string).toBe('component replay');
        expect(replay.inspect().nodeCount).toBe(3);
        replay.close(); expect(replay.player).toBeNull();
    } finally { game.removePersistRootNode(control); control.destroy(); CCObject._deferredDestroy(); }
});

test('directional light baseline, inherited settings and API changes survive standalone replay', () => {
    const { DirectionalLight } = require('../../cocos/3d/lights/directional-light-component');
    const { TraceArchiveWriter } = require('../../cocos/game/trace/trace-archive');
    let text = ''; const bytes: number[] = [];
    const writer = new TraceArchiveWriter({ appendText: (line) => { text += line; },
        appendBinary: (chunk) => { bytes.push(...chunk); }, flush: () => {} }, 'directional');
    const { scene } = sceneFixture();
    const sun = new Node('Sun'); scene.addChild(sun);
    const light = sun.addComponent(DirectionalLight);
    light.color = new Color(120, 140, 160, 255);
    light.colorTemperature = 4300; light.useColorTemperature = true;
    light.shadowEnabled = true; light.shadowBias = 0.004;
    light.staticSettings.castShadow = true;
    light._illuminanceHDR = 71000; light._illuminanceLDR = 2.5;
    startSceneTrace({ archive: writer });
    light.color = new Color(200, 100, 50, 255); light.shadowBias = 0.008;
    stopSceneTrace();
    expect(traceRuntime.file!.commands.filter((command) => command.unsupported)).toEqual([]);
    jest.spyOn(director.root!, 'frameMove').mockImplementation(() => {});
    const player = openSceneTraceArchive(text, new Uint8Array(bytes));
    const restored = director.getScene()!.getChildByName('Sun')!.getComponent(DirectionalLight) as any;
    expect(restored.color.r).toBe(120); expect(restored.colorTemperature).toBe(4300);
    expect(restored.useColorTemperature).toBe(true); expect(restored.shadowEnabled).toBe(true);
    expect(restored.staticSettings.castShadow).toBe(true);
    expect(restored._illuminanceHDR).toBe(71000); expect(restored._illuminanceLDR).toBe(2.5);
    expect(restored.shadowBias).toBe(0.004); expect(player.warnings).toEqual([]);
    while (!player.done && !player.halted) player.stepCommand();
    expect(player.halted).toBe(false); expect(restored.color.r).toBe(200); expect(restored.shadowBias).toBe(0.008);
});

test('legacy directional light traces load with an explicit missing-state warning', () => {
    const { DirectionalLight } = require('../../cocos/3d/lights/directional-light-component');
    const { TraceArchiveWriter } = require('../../cocos/game/trace/trace-archive');
    const { scene } = sceneFixture(); const sun = new Node('Sun'); scene.addChild(sun); sun.addComponent(DirectionalLight);
    startSceneTrace({ save: () => {} }); stopSceneTrace();
    const file = JSON.parse(exportSceneTrace());
    const record = file.baseline.find((node) => node.name === 'Sun').components[0];
    record.properties = {}; delete record.lightIntensity;
    let text = ''; const bytes: number[] = [];
    const writer = new TraceArchiveWriter({ appendText: (line) => { text += line; },
        appendBinary: (chunk) => { bytes.push(...chunk); }, flush: () => {} }, 'legacy-directional');
    writer.start(file); writer.stop('stopped');
    jest.spyOn(director.root!, 'frameMove').mockImplementation(() => {});
    const player = openSceneTraceArchive(text, new Uint8Array(bytes));
    expect(director.getScene()!.getChildByName('Sun')!.getComponent(DirectionalLight)).not.toBeNull();
    expect(player.warnings.join(' ')).toContain('旧 trace 未记录方向光属性');
});

test('addComponent records registered identity despite a minified constructor name', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Label, 'name')!;
    const { scene } = sceneFixture();
    try {
        Object.defineProperty(Label, 'name', { ...descriptor, value: 't' });
        startSceneTrace({ save: () => {} });
        const node = new Node('dynamic-label'); scene.addChild(node); const label = node.addComponent(Label);
        label.string = 'minified'; stopSceneTrace();
        const command = traceRuntime.file!.commands.find((entry) => entry.api === 'Node.addComponent')!;
        expect(command.unsupported).toBeUndefined();
        expect(command.argumentTypes![0]).toContain('cc.Label');
        expect((command.args[0] as any).value.name).toBe('cc.Label');
        const json = exportSceneTrace(); sceneFixture();
        jest.spyOn(director.root!, 'frameMove').mockImplementation(() => {});
        const player = openSceneTrace(json);
        while (!player.done && !player.halted) player.stepCommand();
        expect(player.halted).toBe(false);
        expect(director.getScene()!.getChildByName('dynamic-label')!.getComponent(Label)!.string).toBe('minified');
    } finally { Object.defineProperty(Label, 'name', descriptor); }
});

test('unsupported custom component reports its registered type and keeps the argument failure', () => {
    const { node } = sceneFixture(); startSceneTrace({ save: () => {} });
    const component = node.addComponent(Script); stopSceneTrace();
    expect(component).toBeInstanceOf(Script);
    const command = traceRuntime.file!.commands.find((entry) => entry.api === 'Node.addComponent')!;
    expect(command.unsupported).toContain('TraceTestScript');
    expect(command.argumentTypes![0]).toContain('TraceTestScript');
    expect(command.serializationErrors![0].stage).toBe('arguments');
    expect(command.serializationErrors![1].stage).toBe('result');
});

test('MeshRenderer snapshot and dynamic mesh/material assignment replay with packed dependencies', () => {
    const { MeshRenderer } = require('../../cocos/3d/framework/mesh-renderer');
    const { createMesh } = require('../../cocos/3d/misc/create-mesh');
    const { Material } = require('../../cocos/asset/assets/material');
    const sphere = require('../../cocos/primitive/sphere').default;
    const { TraceArchiveWriter } = require('../../cocos/game/trace/trace-archive');
    let text = ''; const bytes: number[] = [];
    const writer = new TraceArchiveWriter({ appendText: (line) => { text += line; },
        appendBinary: (chunk) => { for (const byte of chunk) bytes.push(byte); }, flush: () => {} }, 'mesh-scene');
    const { scene } = sceneFixture(); const node = new Node('Capsule'); node.active = false; scene.addChild(node);
    const renderer = node.addComponent(MeshRenderer);
    const mesh = createMesh(sphere(0.3, { segments: 8 })); renderer.mesh = mesh;
    const material = new Material(); material.initialize({ effectName: 'builtin-unlit' });
    material.setProperty('mainColor', new Color(20, 70, 190, 255)); renderer.material = material;
    scene.globals.ambient.skyIllum = 34567;
    startSceneTrace({ archive: writer });
    const dynamic = new Node('Sphere_0'); dynamic.active = false; scene.addChild(dynamic);
    const dynamicRenderer = dynamic.addComponent(MeshRenderer); dynamicRenderer.mesh = mesh; dynamicRenderer.material = material;
    dynamic.setPosition(3, 4, 5); stopSceneTrace();
    expect(traceRuntime.file!.commands.filter((command) => command.unsupported)).toEqual([]);
    jest.spyOn(director.root!, 'frameMove').mockImplementation(() => {});
    const player = openSceneTraceArchive(text, new Uint8Array(bytes));
    const restored = director.getScene()!.getChildByName('Capsule')!.getComponent(MeshRenderer) as any;
    expect(Array.from(restored.mesh.data)).toEqual(Array.from(mesh.data));
    expect(restored.mesh.struct).toEqual(JSON.parse(JSON.stringify(mesh.struct)));
    expect(restored.getRenderMaterial(0).getProperty('mainColor')).toEqual(new Color(20, 70, 190, 255));
    expect(director.getScene()!.globals.ambient.skyIllum).toBe(34567);
    while (!player.done && !player.halted) player.stepCommand();
    expect(player.lastStep?.mismatch).toBeUndefined(); expect(player.halted).toBe(false);
    const replayed = director.getScene()!.getChildByName('Sphere_0')!;
    expect(replayed.position.x).toBe(3);
    expect((replayed.getComponent(MeshRenderer) as any).mesh).toBe(restored.mesh);
    expect((replayed.getComponent(MeshRenderer) as any).getRenderMaterial(0)).toBe(restored.getRenderMaterial(0));
});

test('closing trace assets never unregisters a borrowed engine effect', () => {
    const { EffectAsset } = require('../../cocos/asset/assets/effect-asset');
    const { TraceAssetReader, TraceAssetRecorder } = require('../../cocos/game/trace/trace-assets');
    const resources = new Map();
    const recorder = new TraceAssetRecorder({ putResource: (id, data) => resources.set(id, data) });
    const effect = EffectAsset.get('builtin-unlit'); expect(effect).toBeTruthy();
    const id = recorder.encode(effect); recorder.start();
    const reader = new TraceAssetReader(resources);
    expect(reader.decode(id)).toBe(effect); reader.close();
    expect(EffectAsset.get('builtin-unlit')).toBe(effect);
});

test('effect snapshots ignore material-injected pass fields but retain shader identity', () => {
    const { EffectAsset } = require('../../cocos/asset/assets/effect-asset');
    const { TraceAssetReader, TraceAssetRecorder } = require('../../cocos/game/trace/trace-assets');
    const effect = EffectAsset.get('builtin-unlit'); const pass = effect.techniques[0].passes[0];
    const before = pass.defines;
    const resources = new Map();
    const recorder = new TraceAssetRecorder({ putResource: (id, data) => resources.set(id, data) });
    const id = recorder.encode(effect); recorder.start();
    try {
        pass.defines = { ...before, CC_IS_TRANSPARENCY_PASS: 1 };
        const reader = new TraceAssetReader(resources); expect(reader.decode(id)).toBe(effect); reader.close();
    } finally { pass.defines = before; }
});
