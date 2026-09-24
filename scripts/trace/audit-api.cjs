/* Static inventory for the full-API trace work. A hook is not proof of replay support. */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const rows = [];
function scan (directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) { if (file !== path.join(root, 'cocos/game/trace')) scan(file); continue; }
        if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
        const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
        function visit (node) {
            if (ts.isClassDeclaration(node) && node.name && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
                for (const member of node.members) {
                    if (!member.name || ![ts.SyntaxKind.MethodDeclaration, ts.SyntaxKind.GetAccessor, ts.SyntaxKind.SetAccessor].includes(member.kind)) continue;
                    const name = member.name.getText(source);
                    if (name.startsWith('_') || member.modifiers?.some(m => [ts.SyntaxKind.PrivateKeyword, ts.SyntaxKind.ProtectedKeyword].includes(m.kind))) continue;
                    rows.push({ api: `${node.name.text}.${name}`, kind: ts.SyntaxKind[member.kind], static: !!member.modifiers?.some(m => m.kind === ts.SyntaxKind.StaticKeyword), file: path.relative(root, file), line: source.getLineAndCharacterOfPosition(member.getStart(source)).line + 1, validation: 'needs-adapter-and-replay-verification' });
                }
            } else if (ts.isFunctionDeclaration(node) && node.name && node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) {
                rows.push({ api: node.name.text, kind: 'FunctionDeclaration', file: path.relative(root, file), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, validation: 'needs-adapter-and-replay-verification' });
            }
            ts.forEachChild(node, visit);
        }
        visit(source);
    }
}
scan(path.join(root, 'cocos'));
const report = { note: 'Source-level candidates, including internal exported classes. Not a count of cc public APIs or a support claim. Each entry needs mapping to exported API, recording, serialization, baseline restoration and deterministic replay tests.', count: rows.length, entries: rows };
const output = path.resolve(process.argv[2] || path.join(root, 'docs/trace/api-inventory.json'));
fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(`${rows.length} candidates: ${output}`);
