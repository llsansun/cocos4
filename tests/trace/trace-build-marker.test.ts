import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
const { syncMarker } = require('../../scripts/trace/creator-extension/hooks');
test('build marker follows root switch without overwriting captures', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-build-'));
    const dest = path.join(root, 'build'); fs.mkdirSync(dest);
    try {
        syncMarker(root, dest); expect(fs.existsSync(path.join(dest, 'trace.txt'))).toBe(false);
        fs.writeFileSync(path.join(root, 'trace.txt'), ''); syncMarker(root, dest);
        expect(fs.readFileSync(path.join(dest, 'trace.txt'), 'utf8')).toBe('COCOS_TRACE_ENABLE_V1\n');
        fs.unlinkSync(path.join(root, 'trace.txt')); syncMarker(root, dest);
        expect(fs.existsSync(path.join(dest, 'trace.txt'))).toBe(false);
        fs.writeFileSync(path.join(dest, 'trace.txt'), 'captured trace');
        syncMarker(root, dest); expect(fs.readFileSync(path.join(dest, 'trace.txt'), 'utf8')).toBe('captured trace');
        fs.writeFileSync(path.join(root, 'trace.txt'), ''); expect(() => syncMarker(root, dest)).toThrow('overwrite');
        expect(() => syncMarker(root, root)).toThrow('differ');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
