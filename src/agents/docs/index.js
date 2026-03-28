import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, '..', '..', '..', 'mcp_documentation');

function loadDoc(filename) {
    try {
        const content = readFileSync(join(DOCS_DIR, `${filename}.md`), 'utf-8');
        return { content: [{ type: 'text', text: content }] };
    } catch (err) {
        return {
            content: [{ type: 'text', text: `Error reading document: ${err.message}` }],
            isError: true
        };
    }
}

export async function get_philosophy(args, context) {
    return loadDoc('coding-philosophy');
}

export async function get_orchestrator_doc(args, context) {
    return loadDoc('orchestrator');
}
