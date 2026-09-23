'use strict';
const fs = require('fs');
const path = require('path');
const signature = 'COCOS_TRACE_ENABLE_V1\n';
exports.throwError = true;
function syncMarker(project, destination) {
    if (!project || !destination) throw new Error('Trace marker requires project and build destination paths');
    const source = path.join(project, 'trace.txt');
    const target = path.join(destination, 'trace.txt');
    if (path.resolve(source) === path.resolve(target)) throw new Error('Build destination must differ from source project');
    let enabled = false;
    try {
        if (fs.statSync(source).size > 256 || fs.readFileSync(source, 'utf8').trim() !== '') {
            throw new Error('Project trace.txt must be an empty enable marker, not a captured trace');
        }
        enabled = true;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let existing;
    try { existing = fs.statSync(target).size <= 256 ? fs.readFileSync(target, 'utf8') : null; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (enabled) {
        if (existing !== undefined && existing !== signature) throw new Error('Refusing to overwrite an existing build trace.txt');
        fs.writeFileSync(target, signature, { flag: existing === undefined ? 'wx' : 'w' });
    } else if (existing === signature) fs.unlinkSync(target);
}
exports.syncMarker = syncMarker;
exports.onAfterBuild = (options, result) => syncMarker(Editor.Project.path, result && result.dest);
