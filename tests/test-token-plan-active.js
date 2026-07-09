const apiKey = 'sk-sp-5e58c114ab4f4bcf91ed24aa1bfce2b8';
const endpoint = 'https://coding-intl.dashscope.aliyuncs.com/v1/chat/completions';

async function test() {
    const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: 'qwen3.7-plus',
            messages: [{ role: 'user', content: 'Say hello in one word.' }],
            max_tokens: 10
        })
    });
    const text = await res.text();
    console.log(`Status: ${res.status}`);
    console.log(text);
}

test().catch(e => console.error(e.message));
