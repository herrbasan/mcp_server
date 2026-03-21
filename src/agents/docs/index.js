import { readFileSync, readdirSync } from 'fs';
import { dirname, join, extname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = join(__dirname, '..', '..', '..', 'mcp_documentation');

function getDocFiles() {
    try {
        const files = readdirSync(DOCS_DIR);
        return files
            .filter(f => extname(f) === '.md')
            .map(f => ({
                name: basename(f, '.md'),
                filename: f,
                path: join(DOCS_DIR, f)
            }));
    } catch (err) {
        return [];
    }
}

function loadDoc(name) {
    const files = getDocFiles();
    const doc = files.find(f => f.name.toLowerCase() === name.toLowerCase());
    
    if (!doc) {
        return {
            content: [{ type: 'text', text: `Document '${name}' not found. Available documents: ${files.map(f => f.name).join(', ')}` }],
            isError: true
        };
    }

    try {
        const content = readFileSync(doc.path, 'utf-8');
        return {
            content: [{ type: 'text', text: content }]
        };
    } catch (err) {
        return {
            content: [{ type: 'text', text: `Error reading document: ${err.message}` }],
            isError: true
        };
    }
}

export async function get_documentation(args, context) {
    return loadDoc('orchestrator');
}

export async function list_documents(args, context) {
    const files = getDocFiles();
    if (files.length === 0) {
        return {
            content: [{ type: 'text', text: 'No documentation files found in mcp_documentation directory.' }]
        };
    }

    const fileList = files.map(f => `- ${f.name}`).join('\n');
    return {
        content: [{ type: 'text', text: `Available documentation files:\n${fileList}\n\nRead a file using mcp_orchestrator_read_document({name: "filename"}).` }]
    };
}

export async function read_document(args, context) {
    return loadDoc(args.name);
}
