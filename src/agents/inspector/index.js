import fs from 'fs';

export async function inspect_code(args, context) {
    const { gateway, prompts, progress } = context;
    const { files, prompt } = args;

    if (progress) progress('Reading files for inspection...', 10, 100);
    
    let fileContext = '';
    for (const file of files) {
        if (!fs.existsSync(file)) {
            return { content: [{ type: "text", text: `Error: File not found: ${file}` }], isError: true };
        }
        const content = fs.readFileSync(file, 'utf8');
        fileContext += `\n\n--- File: ${file} ---\n${content}\n--- End File ---\n`;
    }

    const finalPrompt = `Files to analyze:\n${fileContext}\n\nTask:\n${prompt}`;
    const systemPrompt = prompts.system || 'You are an expert code inspector and architect. Analyze the provided code objectively, find issues, and answer questions concisely and clearly.';

    if (progress) progress('Analyzing code with LLM...', 50, 100);

    const response = await gateway.chat({
        task: 'inspect',
        messages: [{ role: 'user', content: finalPrompt }],
        systemPrompt: systemPrompt
    });

    if (progress) progress('Analysis complete', 100, 100);

    return {
        content: [{ type: "text", text: response.content }]
    };
}
