/**
 * FleetingMemory - TTL-based temporary storage for image sessions
 * Provides automatic cleanup of expired sessions
 */

export function createFleetingMemory(options = {}) {
  const ttlMinutes = options.ttlMinutes ?? 30;
  const sessions = new Map();
  let cleanupTimer = null;

  function generateId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 9);
    return `img_${timestamp}_${random}`;
  }

  function generateDescriptionId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    return `desc_${timestamp}_${random}`;
  }

  function startCleanup() {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(() => {
      const now = Date.now();
      const ttlMs = ttlMinutes * 60 * 1000;
      for (const [id, session] of sessions) {
        if (now - session.lastAccessedAt.getTime() > ttlMs) {
          sessions.delete(id);
        }
      }
    }, 60000);
    cleanupTimer.unref?.();
  }

  function stopCleanup() {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }

  function createSession({ imageData, imageMimeType, originalWidth, originalHeight }) {
    const id = generateId();
    const now = new Date();
    const session = {
      id,
      imageData,
      imageMimeType,
      originalWidth,
      originalHeight,
      descriptions: [],
      createdAt: now,
      lastAccessedAt: now,
    };
    sessions.set(id, session);
    startCleanup();
    return session;
  }

  function getSession(sessionId) {
    const session = sessions.get(sessionId);
    if (session) {
      session.lastAccessedAt = new Date();
    }
    return session;
  }

  function hasSession(sessionId) {
    return sessions.has(sessionId);
  }

  function addDescription(sessionId, { focus, content }) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const description = {
      id: generateDescriptionId(),
      focus: focus || null,
      content,
      timestamp: new Date(),
    };
    session.descriptions.push(description);
    session.lastAccessedAt = new Date();
    return description;
  }

  function getCompiledContext(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return null;

    if (session.descriptions.length === 0) return null;

    return session.descriptions
      .map((desc, index) => {
        let header = `## Analysis ${index + 1}`;
        if (desc.focus) {
          if (typeof desc.focus === 'string') {
            header += ` [Focus: ${desc.focus}]`;
          } else if (desc.focus.text) {
            header += ` [Focus: ${desc.focus.text}]`;
          } else if (desc.focus.grid) {
            const { cols, rows, cells } = desc.focus.grid;
            header += ` [Grid: ${cols}x${rows}, Cells: [${cells.join(', ')}]]`;
          } else if (desc.focus.region) {
            const { left, top, right, bottom } = desc.focus.region;
            header += ` [Region: (${left},${top}) to (${right},${bottom})]`;
          } else if (desc.focus.centerCrop) {
            if (typeof desc.focus.centerCrop === 'number') {
              header += ` [CenterCrop: ${desc.focus.centerCrop}%]`;
            } else {
              const { widthPercent, heightPercent } = desc.focus.centerCrop;
              header += ` [CenterCrop: ${widthPercent}% x ${heightPercent}%]`;
            }
          }
        }
        return `${header}\n\n${desc.content}`;
      })
      .join('\n\n---\n\n');
  }

  function deleteSession(sessionId) {
    return sessions.delete(sessionId);
  }

  function listSessions() {
    return Array.from(sessions.values()).map((s) => ({
      id: s.id,
      descriptionCount: s.descriptions.length,
      createdAt: s.createdAt,
      lastAccessedAt: s.lastAccessedAt,
      originalWidth: s.originalWidth,
      originalHeight: s.originalHeight,
    }));
  }

  function dispose() {
    stopCleanup();
    sessions.clear();
  }

  return {
    createSession,
    getSession,
    hasSession,
    addDescription,
    getCompiledContext,
    deleteSession,
    listSessions,
    dispose,
  };
}