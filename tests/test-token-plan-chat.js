const apiKey = 'sk-sp-D.IYDD.2GQi.MEYCIQDx4Y4Zj0zo54DLAeKdmt/PcM/lTF3jCdNbxfZNsWt8ZgIhANgWcvB6GuiQ+o0UpWF/2/dBU3pERVWfr+SoVakboKvk';
const endpoint = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/chat/completions';

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
