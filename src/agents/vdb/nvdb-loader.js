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

function findNativeBinary() {
    const platform = process.platform;
    const arch = process.arch;
    const binaryName = PLATFORM_BINARIES[platform]?.[arch];
    if (!binaryName) {
        throw new Error(`nVDB: unsupported platform ${platform}/${arch}`);
    }

    // 1. Submodule build output (release)
    const releasePath = path.resolve(__dirname, '..', '..', 'nVDB', 'target', 'release', binaryName);
    if (fs.existsSync(releasePath)) return releasePath;

    // 2. Submodule napi directory
    const napiPath = path.resolve(__dirname, '..', '..', 'nVDB', 'napi', binaryName);
    if (fs.existsSync(napiPath)) return napiPath;

    // 3. Development fallback: chat app's prebuilt copy (same machine only)
    const chatFallback = `D:\\SRV\\LLM-Gateway-Chat\\lib\\nvdb\\napi\\${binaryName}`;
    if (process.platform === 'win32' && fs.existsSync(chatFallback)) return chatFallback;

    throw new Error(`nVDB native binary not found for ${platform}/${arch}. Run 'cd src/nVDB/napi && node setup.js' to build.`);
}

let cachedModule = null;

export function loadNvdb() {
    if (cachedModule) return cachedModule;

    const binaryPath = findNativeBinary();
    const napiDir = path.resolve(__dirname, '..', '..', 'nVDB', 'napi');
    const binaryName = path.basename(binaryPath);
    const expectedInNapi = path.join(napiDir, binaryName);

    // Ensure the binary is present in the submodule napi directory so require() resolves it.
    if (binaryPath !== expectedInNapi) {
        fs.mkdirSync(napiDir, { recursive: true });
        fs.copyFileSync(binaryPath, expectedInNapi);
    }

    // napi/index.js also checks for the legacy 'index.<platform>.node' filename.
    const legacyName = `index.${process.platform === 'win32' ? 'win32-x64-msvc' : process.platform === 'darwin' ? 'darwin-x64' : 'linux-x64-gnu'}.node`;
    const legacyPath = path.join(napiDir, legacyName);
    if (!fs.existsSync(legacyPath)) {
        fs.copyFileSync(binaryPath, legacyPath);
    }

    const { Database, FilterBuilder } = require(path.join(napiDir, 'index.js'));
    cachedModule = { Database, FilterBuilder };
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
