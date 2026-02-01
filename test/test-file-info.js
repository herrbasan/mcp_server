import CodeSearchServer from '../src/servers/code-search.js';
import WorkspaceResolver from '../src/lib/workspace.js';
import { config } from '../src/llm/router.js';

const workspace = new WorkspaceResolver(config.workspaces);
const server = new CodeSearchServer(workspace, config);

const result = await server.callTool('get_file_info', {
  file: 'COOLKID-Work:Work/_GIT/ffmpeg-napi-interface/archive/SoundApp/libs/nui/nui_audio_context.js'
});

console.log(JSON.parse(result.content[0].text));
