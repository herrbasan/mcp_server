// Persist each file as soon as every chunk has arrived. A later batch failure
// must not discard earlier successful work (issue #61).
export async function embedGroupWithPersistence(group, embedInBatches, insertPreparedFile) {
    const allChunkTexts = [];
    const chunkOffsets = [];
    let offset = 0;
    for (const prepared of group) {
        const count = prepared.chunks.length;
        chunkOffsets.push({ prepared, start: offset, count });
        offset += count;
        for (const chunk of prepared.chunks) allChunkTexts.push(chunk.text);
    }

    const inserted = new Set();
    const persistCompleted = (embeddings) => {
        for (const { prepared, start, count } of chunkOffsets) {
            if (inserted.has(prepared.docBaseId) || start + count > embeddings.length) continue;
            insertPreparedFile(prepared, embeddings.slice(start, start + count));
            inserted.add(prepared.docBaseId);
        }
    };

    try {
        const embeddings = await embedInBatches(allChunkTexts, persistCompleted);
        persistCompleted(embeddings);
        return { embeddings, inserted };
    } catch (err) {
        err.persistedFiles = [...inserted];
        throw err;
    }
}
