import { createFleetingMemory } from './fleeting-memory.js';
import { createMediaClient } from './media-client.js';

let fleetingMemory;
let mediaClient;
let modelMaxDimension = 2048; // Default fallback

export async function init(context) {
  const ttlMinutes = context.config.ttlMinutes ?? 30;
  const mediaServiceUrl = context.config.mediaServiceUrl ?? 'http://localhost:3500';
  const gatewayUrl = context.config.gateway?.httpUrl ?? 'http://localhost:3400';

  fleetingMemory = createFleetingMemory({ ttlMinutes });
  mediaClient = createMediaClient(mediaServiceUrl);

  // Probe Gateway for vision model capabilities
  try {
    const response = await fetch(`${gatewayUrl}/v1/models?type=chat`);
    if (response.ok) {
      const data = await response.json();
      const visionModel = data.data?.find(m => m.capabilities?.vision);
      if (visionModel?.capabilities?.imageInputLimit?.maxDimension) {
        modelMaxDimension = visionModel.capabilities.imageInputLimit.maxDimension;
      }
    }
  } catch (e) {
    // Use default fallback
  }

  return { status: 'initialized', modelMaxDimension };
}

export async function shutdown() {
  if (fleetingMemory) {
    fleetingMemory.dispose();
  }
}

async function fetchImageAsBase64(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const base64 = buffer.toString('base64');
    return {
      data: `data:${contentType};base64,${base64}`,
      mimeType: contentType,
      width: null,
      height: null,
    };
  } catch (error) {
    throw new Error(`image_fetch_failed: ${error.message}`);
  }
}

async function optimizeForModel(base64Data, mediaServiceUrl) {
  try {
    const response = await fetch(`${mediaServiceUrl}/v1/optimize/image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base64: base64Data,
        max_dimension: modelMaxDimension,
        format: 'jpeg',
        quality: 85,
      }),
    });

    if (!response.ok) {
      throw new Error(`Optimization failed: ${response.status}`);
    }

    const result = await response.json();
    return {
      data: result.base64,
      mimeType: `image/${result.format}`,
      width: result.width,
      height: result.height,
    };
  } catch (error) {
    throw new Error(`image_optimization_failed: ${error.message}`);
  }
}

function buildAnalysisPrompt(query, focus, previousContext) {
  let prompt = '';

  if (previousContext) {
    prompt += `=== PREVIOUS ANALYSIS CONTEXT ===\n${previousContext}\n\n`;
    prompt += `=== NEW ANALYSIS REQUEST ===\n`;
    prompt += `Build upon the previous context. Focus on new details not already covered.\n\n`;
  }

  if (focus) {
    if (focus.text) {
      prompt += `FOCUS AREA: ${focus.text}\n\n`;
    } else if (focus.grid) {
      const { cols, rows, cells } = focus.grid;
      prompt += `FOCUS AREA: Grid ${cols}x${rows}, analyzing cells [${cells.join(', ')}]\n\n`;
    } else if (focus.region) {
      const { left, top, right, bottom } = focus.region;
      prompt += `FOCUS AREA: Region (${left},${top}) to (${right},${bottom}) normalized\n\n`;
    } else if (focus.centerCrop !== undefined) {
      if (typeof focus.centerCrop === 'number') {
        prompt += `FOCUS AREA: Center crop ${focus.centerCrop}%\n\n`;
      } else {
        const { widthPercent, heightPercent } = focus.centerCrop;
        prompt += `FOCUS AREA: Center crop ${widthPercent}% x ${heightPercent}%\n\n`;
      }
    }
  }

  prompt += `USER QUERY: ${query}\n\n`;
  prompt += `Provide a detailed, specific response. Name objects, colors, positions precisely.`;

  return prompt;
}

export async function vision_create_session(args, context) {
  const { gateway, progress } = context;
  let { image_url, image_data, image_mime_type } = args;

  progress?.('Processing image...', 10, 100);

  let imageResult;

  if (image_url) {
    imageResult = await fetchImageAsBase64(image_url);
    image_data = imageResult.data;
    image_mime_type = imageResult.mimeType;
  } else if (image_data) {
    if (!image_mime_type) {
      return {
        content: [{ type: 'text', text: 'Error: image_mime_type is required when using image_data' }],
        isError: true
      };
    }
    if (!image_data.startsWith('data:')) {
      image_data = `data:${image_mime_type};base64,${image_data}`;
    }
    imageResult = { data: image_data, mimeType: image_mime_type };
  } else {
    return {
      content: [{ type: 'text', text: 'Error: Either image_url or image_data is required' }],
      isError: true
    };
  }

  progress?.('Creating session...', 50, 100);

  const session = fleetingMemory.createSession({
    imageData: imageResult.data,
    imageMimeType: imageResult.mimeType,
    originalWidth: imageResult.width,
    originalHeight: imageResult.height,
  });

  return {
    content: [{
      type: 'text',
      text: `Session created: ${session.id}. The session will expire after 30 minutes of inactivity.`
    }],
    session_id: session.id
  };
}

export async function vision_analyze(args, context) {
  const { gateway, progress, config } = context;
  const { session_id, query, focus, include_context = true } = args;

  const session = fleetingMemory.getSession(session_id);
  if (!session) {
    return {
      content: [{ type: 'text', text: `Error: session_not_found - Session ${session_id} not found or expired` }],
      isError: true
    };
  }

  progress?.('Preparing analysis...', 20, 100);

  let imageToAnalyze = session.imageData;
  let focusDescription = null;

  if (focus && (focus.grid || focus.region || focus.centerCrop)) {
    progress?.('Cropping image...', 30, 100);
    try {
      const crops = await mediaClient.cropImage(session.imageData, focus);
      if (crops && crops.length > 0) {
        imageToAnalyze = crops[0].base64;
        focusDescription = `Crop at ${crops[0].width}x${crops[0].height}`;
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: crop_failed - ${error.message}` }],
        isError: true
      };
    }
  }

  // Optimize image for model limits (resize + transcode to JPEG)
  progress?.('Optimizing image for model...', 35, 100);
  try {
    imageToAnalyze = await optimizeForModel(imageToAnalyze, config.mediaServiceUrl);
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: image_optimization_failed - ${error.message}` }],
      isError: true
    };
  }

  progress?.('Building prompt...', 40, 100);

  const previousContext = include_context
    ? fleetingMemory.getCompiledContext(session_id)
    : null;

  const prompt = buildAnalysisPrompt(query, focus, previousContext);

  progress?.('Analyzing image...', 50, 100);

  const model = config.models?.vision || 'kimi-chat';

  const messages = [{
    role: 'user',
    content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: imageToAnalyze } }
    ]
  }];

  const response = await gateway.chat({
    model,
    messages,
    systemPrompt: 'You are a detailed visual analysis assistant. Provide precise, descriptive responses.',
    onProgress: (phase, ctx) => {
      progress?.(`Analysis: ${phase}`, 60, 100);
    }
  });

  progress?.('Storing analysis...', 90, 100);

  const description = fleetingMemory.addDescription(session_id, {
    focus: focus || null,
    content: response.content
  });

  return {
    content: [{
      type: 'text',
      text: `## Analysis${focusDescription ? ` (${focusDescription})` : ''}\n\n${response.content}`
    }],
    analysis: response.content,
    description_id: description.id,
    total_descriptions: session.descriptions.length,
    model_used: model
  };
}

export async function vision_close_session(args, context) {
  const { session_id } = args;

  const deleted = fleetingMemory.deleteSession(session_id);
  if (deleted) {
    return {
      content: [{ type: 'text', text: `Session ${session_id} closed successfully.` }]
    };
  } else {
    return {
      content: [{ type: 'text', text: `Session ${session_id} not found.` }],
      isError: true
    };
  }
}

export async function vision_list_sessions(args, context) {
  const sessions = fleetingMemory.listSessions();
  if (sessions.length === 0) {
    return {
      content: [{ type: 'text', text: 'No active image sessions.' }]
    };
  }

  const sessionList = sessions.map(s =>
    `- ${s.id}: ${s.descriptionCount} analyses, created ${s.createdAt.toISOString()}`
  ).join('\n');

  return {
    content: [{ type: 'text', text: `Active sessions:\n\n${sessionList}` }]
  };
}

export async function vision_get_session(args, context) {
  const { session_id } = args;

  const session = fleetingMemory.getSession(session_id);
  if (!session) {
    return {
      content: [{ type: 'text', text: `Session ${session_id} not found or expired.` }],
      isError: true
    };
  }

  const descriptions = session.descriptions.map((d, i) =>
    `## ${i + 1}. ${d.id}${d.focus ? ` [${JSON.stringify(d.focus)}]` : ''}\n${d.content}`
  ).join('\n\n');

  return {
    content: [{
      type: 'text',
      text: `Session: ${session_id}\nCreated: ${session.createdAt.toISOString()}\nLast accessed: ${session.lastAccessedAt.toISOString()}\nImage: ${session.imageMimeType} (${session.originalWidth || '?'}x${session.originalHeight || '?'})\n\nDescriptions:\n\n${descriptions || 'No analyses yet.'}`
    }]
  };
}