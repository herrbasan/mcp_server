import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getLogger } from './utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = getLogger();

export async function loadAgents(globalContext) {
    const agentsDir = path.join(__dirname, 'agents');
    const agentConfigs = new Map();
    const allTools = [];
    const adminTools = [];
    const routeMap = new Map();

    if (!fs.existsSync(agentsDir)) {
        return { tools: [], routeToolCall: async () => { throw new Error("No tools available"); } };
    }

    // 1. Scan src/agents/ for directories
    const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
    const agentFolders = entries.filter(e => e.isDirectory()).map(e => e.name);

    for (const folder of agentFolders) {
        const configPath = path.join(agentsDir, folder, 'config.json');
        if (!fs.existsSync(configPath)) continue;

        const configStr = fs.readFileSync(configPath, 'utf8');
        try {
            const config = JSON.parse(configStr);
            if (!config.agent || !Array.isArray(config.tools)) {
                logger.warn(`Invalid config in ${folder}, skipping.`, null, 'Loader');
                continue;
            }
            config._folder = folder;
            agentConfigs.set(config.agent, config);
        } catch (e) {
            logger.error(`Failed to parse config.json in ${folder}`, e, null, 'Loader');
        }
    }

    // 2. Topologically sort based on dependsOn
    const sortedAgents = [];
    const visited = new Set();
    const visiting = new Set();

    function visit(agentName) {
        if (visiting.has(agentName)) throw new Error(`Circular dependency detected involving agent: ${agentName}`);
        if (visited.has(agentName)) return;

        visiting.add(agentName);
        const config = agentConfigs.get(agentName);
        if (config && config.dependsOn) {
            for (const dep of Array.isArray(config.dependsOn) ? config.dependsOn : [config.dependsOn]) {
                if (agentConfigs.has(dep)) {
                    visit(dep);
                } else {
                    logger.warn(`Agent ${agentName} depends on unknown agent: ${dep}`, null, 'Loader');
                }
            }
        }
        visiting.delete(agentName);
        visited.add(agentName);
        if (config) sortedAgents.push(config);
    }

    for (const name of agentConfigs.keys()) {
        visit(name);
    }

    // 3. Import and initialize
    for (const config of sortedAgents) {
        const folder = config._folder;
        logger.info(`Initializing agent: ${config.agent}`, null, 'Loader');
        
        // Auto-load prompts
        const promptsDir = path.join(agentsDir, folder, 'prompts');
        const agentPrompts = {};
        if (fs.existsSync(promptsDir)) {
            const promptFiles = fs.readdirSync(promptsDir).filter(f => f.endsWith('.txt'));
            for (const pf of promptFiles) {
                const name = path.basename(pf, '.txt');
                agentPrompts[name] = fs.readFileSync(path.join(promptsDir, pf), 'utf8');
            }
        }
        globalContext.prompts.set(config.agent, agentPrompts);

        // Import index.js
        const indexUrl = `file://${path.join(agentsDir, folder, 'index.js').replace(/\\/g, '/')}`;
        let mod = {};
        try {
            mod = await import(indexUrl);
        } catch (e) {
            logger.error(`Failed to import ${folder}/index.js`, e, null, 'Loader');
            process.exit(1); // Hard fail
        }

        // Initialize
        if (typeof mod.init === 'function') {
            try {
                // Pass a locally scoped context
                const localContext = {
                    ...globalContext,
                    prompts: agentPrompts
                };
                const instance = await mod.init(localContext);
                globalContext.agents.set(config.agent, instance);
            } catch (e) {
                logger.error(`Failed to initialize agent ${config.agent}`, e, null, 'Loader');
                process.exit(1); // Hard fail
            }
        } else {
            globalContext.agents.set(config.agent, true); // Mark as loaded
        }

        // Verify tools and map handlers
        for (const tool of config.tools) {
            if (!tool.name) continue;
            const handler = mod[tool.name];
            if (typeof handler !== 'function') {
                logger.error(`Agent ${config.agent} is missing exported handler for tool: ${tool.name}`, null, null, 'Loader');
                process.exit(1);
            }
            if (tool.adminOnly) adminTools.push(tool);
            else allTools.push(tool);
            routeMap.set(tool.name, { agentName: config.agent, handler });
        }
    }

    logger.info(`Loaded ${sortedAgents.length} agents, ${allTools.length} tools (${adminTools.length} admin-only).`, null, 'Loader');

    // 4. Return unified interfaces
    return {
        tools: allTools,
        adminTools,
        async routeToolCall(name, args, requestContext) {
            const route = routeMap.get(name);
            if (!route) {
                return {
                    content: [{ type: "text", text: `Tool ${name} not found.` }],
                    isError: true
                };
            }
            
            // Re-scope the request context prompts to this agent's prompts
            const localScopeCtx = {
                ...requestContext,
                prompts: requestContext.prompts.get(route.agentName) || {}
            };

            logger.info(`Executing tool ${name}...`, { args }, `Agent:${route.agentName}`);

            try {
                const result = await route.handler(args, localScopeCtx);
                logger.info(`Tool ${name} completed successfully`, null, `Agent:${route.agentName}`);
                return result;
            } catch (err) {
                logger.error(`Error in ${name}:`, err, null, `Agent:${route.agentName}`);
                return {
                    content: [{ type: "text", text: `Error: ${err.message}` }],
                    isError: true
                };
            }
        },
        async shutdownAll() {
            for (const config of sortedAgents.reverse()) { // Reverse order for shutdown
                const folder = config._folder;
                try {
                    const indexUrl = `file://${path.join(agentsDir, folder, 'index.js').replace(/\\/g, '/')}`;
                    const mod = await import(indexUrl);
                    if (typeof mod.shutdown === 'function') {
                        logger.info(`Shutting down agent: ${config.agent}`, null, 'Loader');
                        await mod.shutdown();
                        logger.info(`Agent ${config.agent} shutdown complete`, null, 'Loader');
                    }
                } catch (e) {
                    logger.warn(`Error shutting down agent ${config.agent}: ${e.message}`, null, 'Loader');
                }
            }
            logger.info('All agents shut down', null, 'Loader');
        }
    };
}
