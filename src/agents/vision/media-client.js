/**
 * MediaService client for image crop operations
 */

export function createMediaClient(baseUrl) {
  async function cropImage(base64Image, cropOptions, quality = 85, format = 'jpeg') {
    const mediaServiceCrop = focusToMediaServiceCrop(cropOptions);
    if (!mediaServiceCrop) {
      return [{ base64: base64Image, cell_index: null, width: null, height: null }];
    }

    const response = await fetch(`${baseUrl}/v1/optimize/image/crop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        base64: base64Image,
        crop: mediaServiceCrop,
        quality,
        format,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`MediaService crop failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return data.metadata.crops;
  }

  function focusToMediaServiceCrop(focus) {
    if (!focus) return null;

    if (focus.text) {
      return null;
    }

    if (focus.grid) {
      return {
        type: 'grid',
        grid: {
          cols: focus.grid.cols,
          rows: focus.grid.rows,
          cells: focus.grid.cells,
        },
      };
    }

    if (focus.region) {
      return {
        type: 'region',
        left: focus.region.left,
        top: focus.region.top,
        right: focus.region.right,
        bottom: focus.region.bottom,
      };
    }

    if (focus.centerCrop !== undefined) {
      if (typeof focus.centerCrop === 'number') {
        return {
          type: 'center',
          width: focus.centerCrop,
        };
      } else {
        return {
          type: 'center',
          width: focus.centerCrop.widthPercent,
          height: focus.centerCrop.heightPercent,
        };
      }
    }

    return null;
  }

  return {
    cropImage,
  };
}