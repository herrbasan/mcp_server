import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const PLATFORM_BINARIES = {
    win32: {
        x64: 'nvdb-node.win32-x64-msvc.node'
    },
    darwin: {
        x64: 'nvdb-node.darwin-x64.node',
        arm64: 'nvdb-node.darwin-arm64.node'
    },
    linux: {
        x64: 'nvdb-node.linux-x64-gnu.node',
        arm64: 'nvdb-node.linux-arm64-gnu.node'
    }
};

// Search order: explicit override, submodule release build, staged napi copy,
// the chat app's prebuilt copy.
//
// The module loads the chosen file DIRECTLY. It used to copy it into the napi
// directory first, which silently replaced a staged binary on every load — and
// would have destroyed a rollback copy the moment the service started.
function findNativeBinary() {
    const override = process.env.NODE_NVDB_NATIVE_PATH;
    if (override) {
        if (!fs.existsSync(override)) {
            throw new Error(`nVDB: NODE_NVDB_NATIVE_PATH points at a missing file: ${override}`);
        }
        return path.resolve(override);
    }

    const platform = process.platform;
    const arch = process.arch;
    const binaryName = PLATFORM_BINARIES[platform]?.[arch];
    if (!binaryName) {
        throw new Error(`nVDB: unsupported platform ${platform}/${arch}`);
    }

    const candidates = [
        path.resolve(__dirname, '..', '..', 'nVDB', 'target', 'release', binaryName),
        path.resolve(__dirname, '..', '..', 'nVDB', 'napi', binaryName)
    ];
    if (platform === 'win32') {
        candidates.push(`D:\\SRV\\LLM-Gateway-Chat\\lib\\nvdb\\napi\\${binaryName}`);
    }
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }

    throw new Error(`nVDB: native binary ${binaryName} not found. Searched:\n${candidates.map(c => `  - ${c}`).join('\n')}\nRun 'cd src/nVDB/napi && node setup.js' to build.`);
}

let cachedModule = null;

export function loadNvdb() {
    if (cachedModule) return cachedModule;

    const binaryPath = findNativeBinary();
    let native;
    try {
        native = require(binaryPath);
    } catch (e) {
        throw new Error(`nVDB: failed to load native module from ${binaryPath}: ${e.message}`);
    }
    if (typeof native.Database !== 'function') {
        throw new Error(`nVDB: ${binaryPath} does not export Database — not an nVDB addon`);
    }

    cachedModule = {
        Database: native.Database,
        Collection: native.Collection,
        FilterBuilder: native.FilterBuilder,
        // Absent unless the addon was built with the rerank-onnx feature.
        // Callers that need reranking must check and fail loudly.
        Reranker: native.Reranker ?? null,
        nativePath: binaryPath
    };
    return cachedModule;
}

export function isNvdbAvailable() {
    try {
        findNativeBinary();
        return true;
    } catch {
        return false;
    }
}
