/* Verify an existing Creator Web build against this checkout without changing the project. */
const fs = require('fs');
const path = require('path');
const { buildEngine } = require('@cocos/ccbuild');
const babel = require('@babel/core');
async function main () {
    const [projectArg, outputArg] = process.argv.slice(2);
    if (!projectArg || !outputArg) throw Error('Usage: node scripts/trace/build-project-demo.cjs <Creator project> <new output directory>');
    const project = path.resolve(projectArg); const out = path.resolve(outputArg);
    if (fs.existsSync(out)) throw Error('Use a new output directory; existing files will not be overwritten');
    const engine = path.resolve(__dirname, '../..');
    const source = path.join(project, 'build/web-desktop');
    const cfg = JSON.parse(fs.readFileSync(path.join(project, 'settings/v2/packages/engine.json'), 'utf8')).modules;
    const settings = JSON.parse(fs.readFileSync(path.join(source, 'src/settings.json'), 'utf8'));
    const config = cfg.configs[cfg.globalConfigKey];
    const pipeline = settings.rendering.customPipeline ? 'custom-pipeline' : 'legacy-pipeline';
    const features = config.includeModules.filter((feature) => !['custom-pipeline', 'legacy-pipeline'].includes(feature));
    features.push(pipeline);
    fs.cpSync(source, out, { recursive: true });
    await buildEngine({ engine, out: path.join(out, 'cocos-js'), moduleFormat: 'system', mode: 'BUILD', platform: 'HTML5',
        targets: { chrome: '100' }, features, compress: false, mangleProperties: false, sourceMap: true });
    // Existing game scripts use loose ES5 class inheritance. Transform classes alone:
    // downleveling block scopes with the installed preset breaks custom-pipeline loops.
    const bundle = path.join(out, 'cocos-js/cc.js');
    const transformed = babel.transformFileSync(bundle, { sourceMaps: true, inputSourceMap: JSON.parse(fs.readFileSync(`${bundle}.map`, 'utf8')), configFile: false, babelrc: false,
        plugins: [[require('@babel/plugin-transform-classes'), { loose: true }]], compact: false });
    fs.writeFileSync(bundle, `${transformed.code}\n//# sourceMappingURL=cc.js.map\n`);
    fs.writeFileSync(`${bundle}.map`, JSON.stringify(transformed.map));
    const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    const launch = /System\.import\('\.\/index\.js'\)\.catch\(function\(err\) \{ console\.error\(err\); \}\)/;
    if (!launch.test(html)) throw Error('Unsupported Web bootstrap; original copied files retained');
    for (const [page, script] of [['index.html', 'verify.js'], ['replay.html', 'replay-only.js']]) {
        fs.writeFileSync(path.join(out, page), html.replace(launch, `const s=document.createElement('script');s.src='${script}';document.body.appendChild(s)`));
        fs.copyFileSync(path.join(engine, 'docs/trace/project-demo', script), path.join(out, script));
    }
    settings.launch.launchScene = ''; // Retain shared Babel/SystemJS helpers needed by built-in pipeline settings.
    settings.assets.preloadBundles = []; settings.assets.projectBundles = ['internal']; settings.splashScreen.totalTime = 0;
    fs.writeFileSync(path.join(out, 'src/replay-settings.json'), JSON.stringify(settings));
    require('./version-project-demo.cjs').versionProjectDemo(out);
    console.log(`Ready: ${out}. Serve index.html to record; replay.html opens a panel to import a pair or restore local captures.`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
