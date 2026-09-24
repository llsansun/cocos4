import fs from 'fs';
import path from 'path';

test('trace feature is registered for both engine compilation and Creator feature selection', () => {
    const root = path.resolve(__dirname, '../..');
    const build = JSON.parse(fs.readFileSync(path.join(root, 'cc.config.json'), 'utf8'));
    const editor = JSON.parse(fs.readFileSync(path.join(root, 'editor/engine-features/render-config.json'), 'utf8'));
    expect(build.features['scene-trace'].modules).toEqual(['scene-trace']);
    expect(build.features['scene-trace'].overrideConstants.SCENE_TRACE).toBe(true);
    expect(build.constants.SCENE_TRACE.value).toBe(false);
    expect(editor.features['scene-trace'].default).toBe(false);
    expect(editor.features['scene-trace'].envCondition).toBe('$HTML5 || $MINIGAME');
    expect(fs.existsSync(path.join(root, 'exports/scene-trace.ts'))).toBe(true);
    for (const lang of ['zh', 'en']) {
        const localization = fs.readFileSync(path.join(root, `editor/i18n/${lang}/localization.js`), 'utf8');
        expect(localization).toContain('scene_trace:');
    }
});
