# Vision Tool Design Document

## Overview

A vision analysis tool that allows non-vision LLMs to analyze images through an MCP interface. The tool stores images in "fleeting memory" with automatic TTL-based expiration, enabling iterative, ever-sharpening analysis where the LLM can drill down into specific image regions.

## Core Insight: Why MCP vs Gateway-Level

| Approach | Transparency | LLM Awareness | Drill-down Capability |
|----------|-------------|---------------|----------------------|
| **Gateway (automatic)** | Seamless | ❌ LLM doesn't know image exists | ❌ One-shot only |
| **MCP (explicit tool)** | Requires tool call | ✅ LLM knows it has vision access | ✅ Iterative refinement |

**Key insight**: The "ever-sharpening analysis" requires the LLM to be aware it can request more detail. With gateway-level interception, the LLM just gets text and thinks "this is complete." With MCP, the LLM can say *"wait, let me zoom in on that corner."*

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP Server                                │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐  │
│  │ vision_create   │  │ vision_analyze  │  │vision_close │  │
│  │ _session        │  │                 │  │ _session    │  │
│  └────────┬────────┘  └────────┬────────┘  └──────┬──────┘  │
│           │                    │                   │         │
│           └────────────────────┼───────────────────┘         │
│                                ▼                              │
│                     ┌─────────────────────┐                   │
│                     │   FleetingMemory    │                   │
│                     │   (TTL: 30 min)     │                   │
│                     │   Original only     │                   │
│                     └──────────┬──────────┘                   │
│                                │                              │
│                    ┌───────────▼───────────┐                 │
│                    │    MediaService       │                 │
│                    │    (crop/resize)      │                 │
│                    └───────────┬───────────┘                 │
│                                │                              │
└────────────────────────────────┼──────────────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │     LLM Gateway         │
                    │   (kimi-chat model)    │
                    └─────────────────────────┘
```

### FleetingMemory

**Purpose**: Temporary storage for image sessions with automatic cleanup.

**Session Structure**:
```typescript
interface ImageSession {
  id: string;                    // e.g., "img_1234567890_abc123"
  imageData: string;             // base64 encoded original image (full resolution)
  imageMimeType: string;         // e.g., "image/jpeg"
  originalWidth: number;         // Original image dimensions
  originalHeight: number;
  descriptions: Description[];   // Accumulated analyses
  createdAt: Date;
  lastAccessedAt: Date;         // Updated on every access
}

interface Description {
  id: string;
  focus: Focus | null;          // Focus object or null for full image
  content: string;               // The analysis text
  timestamp: Date;
}

interface Focus {
  type: 'text' | 'grid' | 'region' | 'centerCrop';
  text?: string;                  // Free text: "top-left corner"
  grid?: { cols: number; rows: number; cells: number[] };
  region?: { left: number; top: number; right: number; bottom: number }; // Normalized 0-1
  centerCrop?: number | { widthPercent: number; heightPercent: number };
}
```

**TTL Behavior**:
- Default TTL: 30 minutes of inactivity
- Cleanup interval: Every 60 seconds
- Accessing a session resets the TTL
- No manual cleanup required (but `vision_close_session` available)

## MCP Tool Interface

### 1. `vision_create_session`

**Purpose**: Initialize a new image analysis session.

```json
{
  "name": "vision_create_session",
  "description": "Create a new image session for analysis. Returns a session_id to use with vision_analyze.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "image_url": {
        "type": "string",
        "description": "Image URL (remote or data URL). Either this or image_data is required."
      },
      "image_data": {
        "type": "string", 
        "description": "Base64-encoded image data. Alternative to image_url."
      },
      "image_mime_type": {
        "type": "string",
        "description": "MIME type (e.g., 'image/jpeg', 'image/png'). Required if using image_data."
      }
    },
    "oneOf": [
      { "required": ["image_url"] },
      { "required": ["image_data", "image_mime_type"] }
    ]
  }
}
```

**Returns**:
```json
{
  "content": [{
    "type": "text",
    "text": "Session created: img_1234567890_abc123. The session will expire after 30 minutes of inactivity."
  }],
  "session_id": "img_1234567890_abc123"
}
```

### 2. `vision_analyze`

**Purpose**: Analyze an image with optional focus and accumulated context.

```json
{
  "name": "vision_analyze",
  "description": "Analyze an image. Previous analyses are included as context, enabling ever-sharpening detail. Use 'focus' to zoom into specific regions.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "session_id": {
        "type": "string",
        "description": "Session ID from vision_create_session"
      },
      "query": {
        "type": "string",
        "description": "What to analyze. Examples: 'Describe everything', 'What is the person wearing?', 'Read the text on the sign'"
      },
      "focus": {
        "type": "object",
        "description": "Optional: Region to focus on for higher resolution analysis",
        "properties": {
          "text": {
            "type": "string",
            "description": "Free text focus: 'top-left corner', 'person on the left', 'the sign in the background'"
          },
          "grid": {
            "type": "object",
            "description": "Grid-based focus: divide image into cols x rows, analyze specific cells",
            "properties": {
              "cols": { "type": "number", "description": "Number of columns (e.g., 2 for 2x2 grid)" },
              "rows": { "type": "number", "description": "Number of rows (e.g., 2 for 2x2 grid)" },
              "cells": { "type": "array", "items": { "type": "number" }, "description": "Cell indices to analyze (0=top-left, read left-to-right, top-to-bottom)" }
            }
          },
          "region": {
            "type": "object",
            "description": "Normalized pixel region for precise cropping",
            "properties": {
              "left": { "type": "number", "minimum": 0, "maximum": 1 },
              "top": { "type": "number", "minimum": 0, "maximum": 1 },
              "right": { "type": "number", "minimum": 0, "maximum": 1 },
              "bottom": { "type": "number", "minimum": 0, "maximum": 1 }
            }
          },
          "centerCrop": {
            "oneOf": [
              { "type": "number", "description": "Crop to center N% (e.g., 50 = keep center 50%)" },
              { "type": "object", "description": "Asymmetric center crop", "properties": { "widthPercent": { "type": "number" }, "heightPercent": { "type": "number" } } }
            ]
          }
        }
      },
      "include_context": {
        "type": "boolean",
        "default": true,
        "description": "Whether to include previous analyses as context"
      }
    },
    "required": ["session_id"]
  }
}
```

**Returns**:
```json
{
  "content": [{
    "type": "text",
    "text": "## Analysis (Focus: person on the left)\n\nThe person on the left is wearing..."
  }],
  "analysis": "The person on the left is wearing...",
  "description_id": "desc_1234567890_abc12",
  "total_descriptions": 3,
  "model_used": "gemini-flash"
}
```

### 3. `vision_close_session`

**Purpose**: Explicitly close a session and free memory.

```json
{
  "name": "vision_close_session",
  "description": "Close an image session and free memory. Sessions auto-expire after 30 minutes, but this frees resources immediately.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "session_id": {
        "type": "string",
        "description": "Session ID to close"
      }
    },
    "required": ["session_id"]
  }
}
```

## Usage Flow Example

```
User: What's in this image? [uploads image]

LLM: I don't have vision capabilities, but I can use the vision tool to analyze this.
     Let me create a session first.

[Calls vision_create_session with image]

LLM: Now let me analyze the full image.

[Calls vision_analyze: query="Describe everything in this image comprehensively"]

LLM: The image shows a kitchen scene with three people cooking. There's a person 
     on the left chopping vegetables, someone in the center stirring a pot, and 
     a third person on the right setting the table.

User: What is the person on the left wearing?

LLM: Let me focus on that person specifically.

[Calls vision_analyze: 
   query="Describe what this person is wearing in detail"
   focus="person on the left"]

Note: The vision model sees previous context + new focus, so it doesn't 
re-describe the kitchen, just drills into the clothing details.

LLM: The person on the left is wearing a red checkered apron over a white t-shirt,
     with dark blue jeans and brown leather shoes. The apron has a small stain 
     on the lower right corner.

User: Can you read the text on their apron?

LLM: Let me zoom in on that.

[Calls vision_analyze:
   query="Read any text visible on the apron"
   focus="apron of the person on the left"]

LLM: The apron has embroidered text that reads "Kiss the Cook" in cursive script.

---

### Grid-based Analysis Example

```
User: Give me an overview of all four quadrants of the image.

[Calls vision_analyze:
  query="Describe what you see in these quadrants"
  focus={ grid: { cols: 2, rows: 2, cells: [0, 1, 2, 3] } }]

LLM: Top-left: A wooden bookshelf with colorful spines...
     Top-right: A window with sunlight streaming through...
     Bottom-left: A desk with a laptop and coffee mug...
     Bottom-right: A potted plant on a small table...

User: Zoom into the bottom-left quadrant and read the laptop screen.

[Calls vision_analyze:
  query="Read all visible text on the laptop screen"
  focus={ grid: { cols: 2, rows: 2, cells: [2] } }]
```

### Center Crop Example

```
User: The image seems to have a lot of background. Can you crop to just the center 50%?

[Calls vision_analyze:
  query="Describe the main subject in detail"
  focus={ centerCrop: 50 }]
```

```
User: I need a vertical crop of just the center - 60% width, 80% height.

[Calls vision_analyze:
  query="Describe this vertical center section"
  focus={ centerCrop: { widthPercent: 60, heightPercent: 80 } }]
```
```

## Implementation Notes

### FleetingMemory Module

```javascript
// src/agents/vision/fleeting-memory.js
export function createFleetingMemory(options = {}) {
  const ttlMinutes = options.ttlMinutes ?? 30;
  const sessions = new Map();
  let cleanupTimer = null;
  
  // Auto-cleanup expired sessions
  function startCleanup() {
    cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, session] of sessions) {
        if (now - session.lastAccessedAt.getTime() > ttlMinutes * 60 * 1000) {
          sessions.delete(id);
        }
      }
    }, 60000);
    cleanupTimer.unref?.();
  }
  
  return {
    createSession({ imageData, imageMimeType }),
    getSession(sessionId),           // Also updates lastAccessedAt
    hasSession(sessionId),
    addDescription(sessionId, { focus, content }),
    getCompiledContext(sessionId),   // All descriptions formatted
    deleteSession(sessionId),
    dispose()
  };
}
```

### Vision Service

```javascript
// src/agents/vision/index.js
const fleetingMemory = createFleetingMemory({ ttlMinutes: 30 });
const VISION_TASK = 'vision'; // Routed to kimi-chat via LLM Gateway

export async function vision_create_session(args, context) {
  // 1. Fetch image if URL provided
  // 2. Store original (full resolution) in FleetingMemory
  // 3. Return session_id
  // Note: LLM Gateway handles resize/transcode to fit model limits
}

export async function vision_analyze(args, context) {
  // 1. Get session from FleetingMemory
  // 2. If focus has region/grid/centerCrop:
  //    - Call MediaService to crop the original image
  //    - Use cropped image for vision analysis
  // 3. Build prompt with accumulated context
  // 4. Call LLM Gateway with task='vision' + image
  // 5. Store description (with focus) in session
  // 6. Return analysis
}

export async function vision_close_session(args, context) {
  // Delete session from memory
}
```

### Prompt Building

The key to "ever-sharpening" analysis is including previous descriptions as context:

```javascript
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
    } else if (focus.centerCrop) {
      const pct = typeof focus.centerCrop === 'number'
        ? `${focus.centerCrop}%`
        : `${focus.centerCrop.widthPercent}% x ${focus.centerCrop.heightPercent}%`;
      prompt += `FOCUS AREA: Center crop ${pct}\n\n`;
    }
  }

  prompt += `USER QUERY: ${query}\n\n`;
  prompt += `Provide a detailed, specific response. Name objects, colors, positions precisely.`;

  return prompt;
}
```

### LLM Gateway Image Processing

The LLM Gateway handles image conformance to model limits automatically via its integrated MediaService:

- **Original stored**: Sessions store the full-resolution original image
- **Gateway auto-processes**: When sending to the vision model, the Gateway:
  - Fetches the base64 image
  - Resizes to fit model context limits (using `image_processing.resize`)
  - Transcodes to optimal format (using `image_processing.transcode`)

**Current behavior**: Gateway uses default `image_processing` settings (`resize: "auto"`, `transcode: "jpg"`).

**For full control**: Pass explicit `image_processing` options when calling `gateway.chat()`:
```javascript
gateway.chat({
  model,
  messages,
  image_processing: {
    resize: 1024,  // explicit max pixels
    transcode: 'jpg',
    quality: 85
  }
});
```

**Crop workflow**: When a focus region is specified, MediaService crops at full resolution before sending to Gateway. This ensures zoomed regions maintain detail.

## Configuration

Add to MCP server's `config.json`:

```json
{
  "agents": {
    "vision": {
      "enabled": true,
      "task": "vision",
      "ttlMinutes": 30,
      "mediaServiceUrl": "http://localhost:3500"
    }
  }
}
```

**Note**: The `task` field routes to `kimi-chat` via the LLM Gateway's task-based routing. Model selection is configured in the router layer.

## Files to Create in mcp_server

```
src/agents/vision/
├── config.json          # Tool definitions
├── index.js             # Tool implementations
├── fleeting-memory.js   # Session storage with TTL
└── media-client.js      # MediaService API client
```

## MediaService Integration

The vision agent calls MediaService (`src/vendor/MediaService`) for image cropping operations.

### MediaService API: POST /v1/optimize/image/crop

**Endpoint**: `http://localhost:3500/v1/optimize/image/crop` (configurable via `config.json`)

**Request**:
```json
{
  "base64": "data:image/jpeg;base64,...",
  "crop": {
    "type": "region" | "center" | "grid",
    "left": 0.2,
    "top": 0.1,
    "right": 0.8,
    "bottom": 0.5,
    "width": 50,
    "height": 75,
    "grid": { "cols": 2, "rows": 2, "cells": [0, 2] }
  },
  "quality": 85,
  "format": "jpeg"
}
```

**Response**:
```json
{
  "original_size_bytes": 12345,
  "buffer": null,
  "metadata": {
    "originalSize": 12345,
    "crops": [
      {
        "cell_index": 0,
        "base64": "data:image/jpeg;base64,...",
        "width": 500,
        "height": 375
      }
    ],
    "format": "jpeg",
    "originalWidth": 1000,
    "originalHeight": 750
  }
}
```

### Focus Type to MediaService Mapping

| Focus Type | crop.type | Parameters |
|------------|-----------|------------|
| `region` | `"region"` | `left`, `top`, `right`, `bottom` (normalized 0-1) |
| `centerCrop` (number) | `"center"` | `width` = percentage |
| `centerCrop` (object) | `"center"` | `width`, `height` percentages |
| `grid` | `"grid"` | `grid: { cols, rows, cells[] }` |

### Example: MediaService Client

```javascript
// src/agents/vision/media-client.js
export async function cropImage(base64Image, cropOptions, mediaServiceUrl) {
  const response = await fetch(`${mediaServiceUrl}/v1/optimize/image/crop`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base64: base64Image,
      crop: cropOptions,
      quality: 85,
      format: 'jpeg'
    })
  });

  if (!response.ok) {
    throw new Error(`MediaService crop failed: ${response.statusText}`);
  }

  const data = await response.json();
  return data.metadata.crops;
}
```

## Key Design Decisions

1. **Session-based, not stateless**: Unlike most MCP tools, this maintains state between calls. This enables the accumulating context pattern.

2. **TTL cleanup, not manual**: Sessions auto-expire after inactivity. Users can explicitly close, but don't have to.

3. **Compiled context, not raw descriptions**: Previous analyses are formatted as `## Analysis N [Focus: X]` so the vision model understands the progression.

4. **Focus parameter with multiple types**: Text, grid, region, and centerCrop give the LLM flexible ways to specify zoom areas.

5. **Original storage, crop-on-demand**: FleetingMemory stores only the original image. Crops are generated via MediaService when needed. This keeps memory minimal while enabling unlimited re-cropping.

6. **Grid-based focus**: Dividing the image into a logical grid (e.g., 2x2, 3x3) is more LLM-friendly than pixel coordinates.

7. **Normalized region coordinates**: Region focus uses 0-1 normalized values, independent of image dimensions, making prompts cleaner.

8. **kimi-chat via task routing**: Vision uses the existing task-based routing (`task: 'vision'`) to connect to kimi-chat.

## Error Handling

- `session_not_found`: Session expired or invalid ID
- `image_fetch_failed`: Could not download from URL
- `image_validation_failed`: Unsupported format or dimensions
- `crop_failed`: MediaService could not process crop request
- `analysis_failed`: LLM Gateway error
- `invalid_image_data`: Malformed base64 or unsupported format

## Future Enhancements

1. **Multiple images per session**: Allow adding more images to an existing session
2. **Comparison mode**: Analyze differences between two images
3. **Persistent storage option**: Save important sessions to disk instead of just memory
4. **Histogram equalization**: Pre-process crops for better contrast in scanned/photos
5. **Auto-grid suggestion**: LLM decides optimal grid size based on image aspect ratio
