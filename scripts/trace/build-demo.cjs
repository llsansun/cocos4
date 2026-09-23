/* Build an isolated browser test using the current engine source and existing test shader fixtures. */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { buildEngine } = require('@cocos/ccbuild');
const engine = path.resolve(__dirname, '../..');
const out = path.resolve(process.argv[2] || path.join(engine, '.trace-demo'));
async function main () {
    fs.mkdirSync(out, { recursive: true });
    await buildEngine({ engine, out: path.join(out, 'engine'), moduleFormat: 'esm', mode: 'BUILD', platform: 'HTML5',
        targets: { chrome: '100', safari: '16' },
        features: ['base', '2d', '3d', 'gfx-webgl', 'gfx-webgl2', 'legacy-pipeline'], compress: false, mangleProperties: false });
    for (const name of ['builtin-effects', 'builtin-glsl4']) {
        const source = fs.readFileSync(path.join(engine, 'tests/fixtures', `${name}.ts`), 'utf8');
        fs.writeFileSync(path.join(out, `${name}.js`), ts.transpileModule(source, {
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2017 },
        }).outputText);
    }
    for (const name of ['index.html', 'demo.js']) fs.copyFileSync(path.join(engine, 'docs/trace/demo', name), path.join(out, name));
    console.log(`Trace demo ready: ${out}`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
