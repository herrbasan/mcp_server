import fs from 'fs';
import { createProgressReporter } from '../../utils/progress-reporter.js';

export async function inspect_code(args, context) {
    const { gateway, prompts, progress } = context;
    const { files, prompt } = args;

    const pr = createProgressReporter(progress);
    pr.set('Reading files for inspection...', 10, true);

    let fileContext = '';
    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!fs.existsSync(file)) {
            pr.done('File not found');
            return { content: [{ type: "text", text: `Error: File not found: ${file}` }], isError: true };
        }
        const content = fs.readFileSync(file, 'utf8');
        fileContext += `\n\n--- File: ${file} ---\n${content}\n--- End File ---\n`;
        pr.step(i + 1, files.length, `Read ${file} (${i + 1}/${files.length})`, 10, 40);
    }

    const finalPrompt = `Files to analyze:\n${fileContext}\n\nTask:\n${prompt}`;
    const systemPrompt = prompts.system || 'You are an expert code inspector and architect. Analyze the provided code objectively, find issues, and answer questions concisely and clearly.';

    pr.set('Analyzing code with LLM...', 50, true);

    const response = await gateway.chat({
        task: 'inspect',
        messages: [{ role: 'user', content: finalPrompt }],
        systemPrompt: systemPrompt
    });

    pr.done('Analysis complete');

    return {
        content: [{ type: "text", text: response.content }]
    };
}
