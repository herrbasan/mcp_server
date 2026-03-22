import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function loadAgents(globalContext) {
    const agentsDir = path.join(__dirname, 'agents');
    const agentConfigs = new Map();
    const allTools = [];
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
                console.warn(`[Loader] Invalid config in ${folder}, skipping.`);
                continue;
            }
            config._folder = folder;
            agentConfigs.set(config.agent, config);
        } catch (e) {
            console.error(`[Loader] Failed to parse config.json in ${folder}`, e);
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
                    console.warn(`[Loader] Agent ${agentName} depends on unknown agent: ${dep}`);
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
        console.log(`[Loader] Initializing agent: ${config.agent}`);
        
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
            console.error(`[Loader] Failed to import ${folder}/index.js`, e);
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
                console.error(`[Loader] Failed to initialize agent ${config.agent}`, e);
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
                console.error(`[Loader] Agent ${config.agent} is missing exported handler for tool: ${tool.name}`);
                process.exit(1);
            }
            allTools.push(tool);
            routeMap.set(tool.name, { agentName: config.agent, handler });
        }
    }

    console.log(`[Loader] Loaded ${sortedAgents.length} agents, ${allTools.length} tools total.`);

    // 4. Return unified interfaces
    return {
        tools: allTools,
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

            try {
                return await route.handler(args, localScopeCtx);
            } catch (err) {
                console.error(`[Agent:${route.agentName}] Error in ${name}:`, err);
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
                        console.log(`[Loader] Shutting down agent: ${config.agent}`);
                        await mod.shutdown();
                        console.log(`[Loader] Agent ${config.agent} shutdown complete`);
                    }
                } catch (e) {
                    console.warn(`[Loader] Error shutting down agent ${config.agent}: ${e.message}`);
                }
            }
            console.log('[Loader] All agents shut down');
        }
    };
}
