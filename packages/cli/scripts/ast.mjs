// Print a file's syntax tree with field names — handy when writing a language query.
// Usage: node --liftoff-only scripts/ast.mjs <grammar> <file>   (grammar: java, go, rust, c_sharp, …)
import Parser from 'web-tree-sitter';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);
await Parser.init();
const lang = await Parser.Language.load(require.resolve(`tree-sitter-wasms/out/tree-sitter-${process.argv[2]}.wasm`));
const p = new Parser(); p.setLanguage(lang);
const tree = p.parse(readFileSync(process.argv[3], 'utf8'));
const out = [];
function walk(cursor, depth) {
  do {
    const n = cursor.currentNode;
    if (n.isNamed) {
      const field = cursor.currentFieldName;
      const leaf = n.namedChildCount === 0 ? ` "${n.text.slice(0, 30).replace(/\n/g, ' ')}"` : '';
      out.push(`${'  '.repeat(depth)}${field ? field + ': ' : ''}${n.type}${leaf}`);
    }
    if (cursor.gotoFirstChild()) { walk(cursor, depth + (cursor.currentNode.parent.isNamed ? 1 : 0)); cursor.gotoParent(); }
  } while (cursor.gotoNextSibling());
}
walk(tree.walk(), 0);
console.log(out.join('\n'));
