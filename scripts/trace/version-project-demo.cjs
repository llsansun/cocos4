/* Keep the entry point, import map and engine from different builds out of HTTP caches. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function versionProjectDemo (out) {
    const hash = crypto.createHash('sha256');
    for (const file of ['cocos-js/cc.js', 'replay-only.js', 'verify.js']) hash.update(fs.readFileSync(path.join(out, file)));
    const version = hash.digest('hex').slice(0, 16);
    const mapPath = path.join(out, 'src/import-map.json');
    const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
    map.imports.cc = `${map.imports.cc.split('?')[0]}?traceBuild=${version}`;
    fs.writeFileSync(mapPath, JSON.stringify(map));
    for (const page of ['index.html', 'replay.html']) {
        const file = path.join(out, page);
        let html = fs.readFileSync(file, 'utf8');
        html = html.replace(/src\/import-map\.json(?:\?traceBuild=[a-f0-9]+)?/g, `src/import-map.json?traceBuild=${version}`)
            .replace(/(replay-only|verify)\.js(?:\?traceBuild=[a-f0-9]+)?/g, `$1.js?traceBuild=${version}`);
        fs.writeFileSync(file, html);
    }
    return version;
}
module.exports = { versionProjectDemo };
if (require.main === module) console.log(versionProjectDemo(path.resolve(process.argv[2])));
