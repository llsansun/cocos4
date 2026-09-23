import * as cc from './engine/cc.js';
import { effects } from './builtin-effects.js';
import { glsl4 } from './builtin-glsl4.js';
const result = document.querySelector('#result');
const project = 'scene-trace-demo-v1';
const surface = document.querySelector('#GameCanvas');
surface.width = Math.round(innerWidth * devicePixelRatio);
surface.height = Math.round(innerHeight * devicePixelRatio);
let label, moving, scene;
let lastJSON = '';
let lastPair = null;
const report = (text) => { result.textContent = text; };
window.addEventListener('error', (event) => report(`失败：${event.message}`));
window.addEventListener('unhandledrejection', (event) => report(`失败：${event.reason?.stack || event.reason}`));

function reset () {
    cc.closeSceneTrace();
    cc.stopSceneTrace();
    cc.game.pause();
    scene = new cc.Scene('TraceDemo');
    const canvasNode = new cc.Node('Canvas');
    canvasNode.layer = cc.Layers.Enum.UI_2D;
    scene.addChild(canvasNode);
    const canvas = canvasNode.addComponent(cc.Canvas);
    canvasNode.getComponent(cc.UITransform).setContentSize(800, 600);
    const cameraNode = new cc.Node('UICamera');
    canvasNode.addChild(cameraNode);
    cameraNode.setPosition(0, 0, 1000);
    const camera = cameraNode.addComponent(cc.Camera);
    camera.projection = cc.Camera.ProjectionType.ORTHO;
    camera.orthoHeight = 300;
    camera.near = 0.1;
    camera.far = 2000;
    camera.visibility = cc.Layers.Enum.UI_2D;
    camera.clearColor = new cc.Color(20, 30, 48, 255);
    canvas.cameraComponent = camera;
    moving = new cc.Node('Message');
    moving.layer = cc.Layers.Enum.UI_2D;
    canvasNode.addChild(moving);
    const transform = moving.addComponent(cc.UITransform);
    transform.setContentSize(500, 100);
    label = moving.addComponent(cc.Label);
    label.fontSize = 32;
    label.lineHeight = 40;
    label.string = 'Trace baseline';
    moving.setPosition(-200, 0, 0);
    label.color = new cc.Color(255, 255, 255, 255);
    const spriteNode = new cc.Node('PackedSprite');
    spriteNode.layer = cc.Layers.Enum.UI_2D; canvasNode.addChild(spriteNode); spriteNode.setPosition(-200, -100, 0);
    const sprite = spriteNode.addComponent(cc.Sprite);
    const image = new cc.ImageAsset({ _data: new Uint8Array([255, 90, 40, 255, 40, 170, 255, 255, 40, 170, 255, 255, 255, 90, 40, 255]),
        width: 2, height: 2, format: cc.Texture2D.PixelFormat.RGBA8888, _compressed: false });
    const texture = new cc.Texture2D(); texture.image = image;
    const frame = new cc.SpriteFrame(); frame.texture = texture; frame.packable = false; sprite.spriteFrame = frame;
    sprite.sizeMode = cc.Sprite.SizeMode.CUSTOM;
    spriteNode.getComponent(cc.UITransform).setContentSize(96, 96);
    const sun = new cc.Node('Sun'); scene.addChild(sun);
    const light = sun.addComponent(cc.DirectionalLight); light.color = new cc.Color(120, 140, 160, 255);
    cc.director.runSceneImmediate(scene);
    cc.director.tick(0);
}
async function record () {
    reset();
    const capture = await cc.createSceneTraceArchiveCapture();
    cc.startSceneTrace({ project, archive: capture.writer, maxCommands: 2000,
        captureFrame: () => cc.game.canvas.toDataURL('image/png'),
    });
    const actions = [
        () => { moving.setPosition(-240, 60, 0); label.string = 'Frame 1: move'; },
        () => { moving.setPosition(-180, 0, 0); label.color = new cc.Color(90, 220, 160, 255); label.string = 'Frame 2: color'; },
        () => { moving.setScale(1.4, 1.4, 1); label.string = 'Frame 3: scale'; },
    ];
    for (const action of actions) {
        cc.director.once(cc.Director.EVENT_BEFORE_UPDATE, action);
        cc.director.tick(1 / 60);
    }
    cc.stopSceneTrace();
    await capture.drain();
    lastPair = await cc.readWebTraceCapture(capture.id);
    lastJSON = JSON.stringify(cc.readTraceArchive(lastPair.text, lastPair.binary).file);
    const file = JSON.parse(lastJSON);
    const unsupported = file.commands.filter((entry) => entry.unsupported);
    report(`已录制 ${file.commands.length} 条指令，3 帧；不支持的指令 ${unsupported.length} 条。`);
    if (unsupported.length) throw new Error(JSON.stringify(unsupported));
}
async function verify () {
    if (!lastPair) await record();
    cc.closeSceneTrace();
    cc.director.runSceneImmediate(new cc.Scene('EmptyReplayScene'));
    const player = cc.openSceneTraceArchive(lastPair.text, lastPair.binary);
    moving = cc.director.getScene().getChildByName('Canvas').getChildByName('Message');
    label = moving.getComponent(cc.Label);
    const restoredLight = cc.director.getScene().getChildByName('Sun').getComponent(cc.DirectionalLight);
    if (restoredLight.color.r !== 120 || restoredLight.color.g !== 140) throw new Error('DirectionalLight baseline differs');
    const expected = ['Frame 1: move', 'Frame 2: color', 'Frame 3: scale'];
    for (const text of expected) {
        player.stepFrame();
        if (label.string !== text || player.halted) throw new Error(`回放不一致：${JSON.stringify(player.lastStep)}`);
    }
    if (!player.done || moving.scale.x !== 1.4 || label.color.g !== 220) throw new Error('回放最终状态不一致');
    if (cc.director.getScene().getChildByName('Canvas').getChildByName('PackedSprite').getComponent(cc.UITransform).width !== 96) throw new Error('Sprite layout differs after restore');
    const packed = cc.director.getScene().getChildByName('Canvas').getChildByName('PackedSprite').getComponent(cc.Sprite).spriteFrame.texture.image.data;
    if (packed.length !== 16 || packed[0] !== 255 || packed[4] !== 40) throw new Error('Packed texture bytes differ');
    report(`PASS：WebGL 录制 → Worker / IndexedDB → trace.txt + trace.bin → 空场景与纹理重建 → 三帧回放通过，共 ${player.cursor} 条指令。`);
}

cc.game.on(cc.Game.EVENT_POST_SUBSYSTEM_INIT, () => {
    effects.forEach((source, i) => {
        const effect = Object.assign(new cc.EffectAsset(), source);
        effect.shaders.forEach((shader, j) => {
            const source = glsl4[i]?.[j];
            if (!source) return;
            shader.glsl4 = source;
            // The repository fixtures contain Vulkan GLSL. WebGL2 binds resources through JS.
            const web = (text) => text.replace(/layout\s*\([^)]*\)\s*/g, '').replace(/(\d\.\d+)f\b/g, '$1');
            shader.glsl3 = { vert: web(source.vert), frag: web(source.frag) };
            if (effect.name === 'builtin-sprite') {
                // A self-contained UI test shader: UI vertices already contain world transforms.
                // No Creator-imported camera UBO fixtures are required by this standalone demo.
                shader.glsl3 = {
                    vert: `precision highp float;
                        in vec3 a_position; in vec2 a_texCoord; in vec4 a_color;
                        out vec2 v_uv; out vec4 v_color;
                        void main() { v_uv=a_texCoord; v_color=a_color;
                            gl_Position=vec4(a_position.xy/vec2(${innerWidth / 2},${innerHeight / 2}),0.0,1.0); }`,
                    frag: `precision mediump float;
                        uniform sampler2D cc_spriteTexture; in vec2 v_uv; in vec4 v_color; out vec4 fragColor;
                        void main() { fragColor=texture(cc_spriteTexture,v_uv)*v_color; }`,
                };
            }
        });
        effect.onLoaded();
    });
    // Only the Label material is needed by this fixture. Register it before launch.
    const material = new cc.Material();
    material._uuid = 'ui-sprite-material';
    material.initialize({ effectName: 'builtin-sprite', defines: { USE_TEXTURE: true, CC_USE_EMBEDDED_ALPHA: false, IS_GRAY: false } });
    cc.builtinResMgr.addAsset(material.uuid, material);
});
await cc.game.init({ debugMode: cc.DebugMode.INFO, overrideSettings: {
    rendering: { renderMode: 2 }, assets: { preloadAssets: [] },
} });
await cc.game.run();
reset();
cc.createSceneTracePanel(document.body, project, { prepareReplay: reset });
document.querySelector('#record').disabled = false;
document.querySelector('#verify').disabled = false;
document.querySelector('#record').onclick = () => record().catch((e) => report(e.stack));
document.querySelector('#verify').onclick = () => verify().catch((e) => report(e.stack));
report('引擎就绪。点击“自动回放验收”测试两文件重建；也可录制后恢复后台记录逐条查看。');
