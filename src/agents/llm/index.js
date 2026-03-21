import fs from 'fs';

export async function query_model(args, context) {
    const { gateway, prompts, progress } = context;
    const { prompt, files = [], systemPrompt } = args;

    let fileContext = '';
    for (const file of files) {
        if (!fs.existsSync(file)) {
            return { content: [{ type: "text", text: `Error: File not found: ${file}` }], isError: true };
        }
        const content = fs.readFileSync(file, 'utf8');
        fileContext += `\n\n--- File: ${file} ---\n${content}\n--- End File ---\n`;
    }

    const finalPrompt = fileContext ? `${fileContext}\n\n${prompt}` : prompt;
    const sysPrompt = systemPrompt || prompts.system || 'You are a helpful AI assistant.';

    if (progress) progress('Querying LLM...', 10, 100);

    const response = await gateway.chat({
        model: context.config.models?.query || 'default',
        messages: [{ role: 'user', content: finalPrompt }],
        systemPrompt: sysPrompt,
    });

    return { content: [{ type: "text", text: response.content }] };
}
