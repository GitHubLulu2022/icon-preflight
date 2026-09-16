(function () {
  "use strict";

  const MAX_PIXELS = 1000 * 1000;
  const MAX_FRAMES = 2000;
  const VISUAL_SAMPLE_SIZE = 20;
  const VISUAL_CHANGE_THRESHOLD = 4;

  class Reader {
    constructor(bytes) {
      this.bytes = bytes;
      this.offset = 0;
    }

    byte() {
      if (this.offset >= this.bytes.length) throw new Error("GIF 数据不完整");
      return this.bytes[this.offset++];
    }

    word() {
      return this.byte() | (this.byte() << 8);
    }

    take(length) {
      if (this.offset + length > this.bytes.length) throw new Error("GIF 数据不完整");
      const value = this.bytes.slice(this.offset, this.offset + length);
      this.offset += length;
      return value;
    }

    blocks() {
      const chunks = [];
      let total = 0;
      while (true) {
        const size = this.byte();
        if (size === 0) break;
        const chunk = this.take(size);
        chunks.push(chunk);
        total += size;
      }
      const result = new Uint8Array(total);
      let offset = 0;
      chunks.forEach((chunk) => {
        result.set(chunk, offset);
        offset += chunk.length;
      });
      return result;
    }
  }

  function text(bytes) {
    return String.fromCharCode(...bytes);
  }

  function colorTable(reader, size) {
    const table = [];
    for (let index = 0; index < size; index += 1) {
      table.push([reader.byte(), reader.byte(), reader.byte()]);
    }
    return table;
  }

  function decodeLzw(minCodeSize, data, expectedSize) {
    const clearCode = 1 << minCodeSize;
    const endCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let nextCode = endCode + 1;
    let bitOffset = 0;
    let dictionary = [];
    let previous = null;
    const output = [];

    const reset = () => {
      dictionary = Array.from({ length: clearCode }, (_, value) => [value]);
      dictionary[clearCode] = [];
      dictionary[endCode] = null;
      codeSize = minCodeSize + 1;
      nextCode = endCode + 1;
      previous = null;
    };

    const readCode = () => {
      let code = 0;
      for (let bit = 0; bit < codeSize; bit += 1) {
        const source = bitOffset + bit;
        const byte = data[source >> 3];
        if (byte === undefined) return null;
        code |= ((byte >> (source & 7)) & 1) << bit;
      }
      bitOffset += codeSize;
      return code;
    };

    reset();
    while (output.length < expectedSize) {
      const code = readCode();
      if (code === null || code === endCode) break;
      if (code === clearCode) {
        reset();
        continue;
      }

      let entry;
      if (dictionary[code]) entry = dictionary[code];
      else if (code === nextCode && previous) entry = previous.concat(previous[0]);
      else throw new Error("GIF LZW 数据无效");

      output.push(...entry);
      if (previous && nextCode < 4096) {
        dictionary[nextCode++] = previous.concat(entry[0]);
        if (nextCode === (1 << codeSize) && codeSize < 12) codeSize += 1;
      }
      previous = entry;
    }
    return output.slice(0, expectedSize);
  }

  function deinterlace(indices, width, height) {
    const result = new Array(indices.length);
    const passes = [[0, 8], [4, 8], [2, 4], [1, 2]];
    let sourceRow = 0;
    passes.forEach(([start, step]) => {
      for (let y = start; y < height; y += step) {
        const source = sourceRow * width;
        result.splice(y * width, width, ...indices.slice(source, source + width));
        sourceRow += 1;
      }
    });
    return result;
  }

  function hashPixels(pixels) {
    let hash = 2166136261;
    for (let index = 0; index < pixels.length; index += 4) {
      hash ^= pixels[index];
      hash = Math.imul(hash, 16777619);
      hash ^= pixels[index + 1];
      hash = Math.imul(hash, 16777619);
      hash ^= pixels[index + 2];
      hash = Math.imul(hash, 16777619);
      hash ^= pixels[index + 3];
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function visualSignature(pixels, width, height) {
    const sampleWidth = Math.min(VISUAL_SAMPLE_SIZE, width);
    const sampleHeight = Math.min(VISUAL_SAMPLE_SIZE, height);
    const signature = new Uint8Array(sampleWidth * sampleHeight * 4);

    for (let sampleY = 0; sampleY < sampleHeight; sampleY += 1) {
      const startY = Math.floor(sampleY * height / sampleHeight);
      const endY = Math.max(startY + 1, Math.floor((sampleY + 1) * height / sampleHeight));
      for (let sampleX = 0; sampleX < sampleWidth; sampleX += 1) {
        const startX = Math.floor(sampleX * width / sampleWidth);
        const endX = Math.max(startX + 1, Math.floor((sampleX + 1) * width / sampleWidth));
        let red = 0;
        let green = 0;
        let blue = 0;
        let alpha = 0;
        let count = 0;

        for (let y = startY; y < endY; y += 1) {
          for (let x = startX; x < endX; x += 1) {
            const offset = (y * width + x) * 4;
            const pixelAlpha = pixels[offset + 3] / 255;
            red += pixels[offset] * pixelAlpha;
            green += pixels[offset + 1] * pixelAlpha;
            blue += pixels[offset + 2] * pixelAlpha;
            alpha += pixels[offset + 3];
            count += 1;
          }
        }

        const target = (sampleY * sampleWidth + sampleX) * 4;
        signature[target] = Math.round(red / count);
        signature[target + 1] = Math.round(green / count);
        signature[target + 2] = Math.round(blue / count);
        signature[target + 3] = Math.round(alpha / count);
      }
    }
    return signature;
  }

  function visualDifference(previous, current) {
    if (!previous || !current || previous.length !== current.length) return Infinity;
    let difference = 0;
    for (let index = 0; index < current.length; index += 1) {
      difference += Math.abs(current[index] - previous[index]);
    }
    return difference / current.length;
  }

  function hasTransparentPixels(pixels) {
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] === 0) return true;
    }
    return false;
  }

  function median(values) {
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] || 10;
  }

  function timingSummary(frames) {
    const totalMs = frames.reduce((sum, frame) => sum + frame.delayMs, 0);
    const boundaryMs = 4000;
    const boundaryFrame = frames.find((frame) => frame.startMs <= boundaryMs && frame.startMs + frame.delayMs > boundaryMs)
      || frames.find((frame) => frame.startMs >= boundaryMs)
      || frames.at(-1);
    const staticSectionStable = frames
      .filter((frame) => frame.startMs >= boundaryMs)
      .every((frame) => frame.hash === boundaryFrame.hash);
    const dynamicFrames = frames.filter((frame) => frame.startMs < boundaryMs);
    const hasDynamicChange = dynamicFrames.some((frame, index) => index > 0 && frame.hash !== dynamicFrames[index - 1].hash);
    const typicalDelay = median(dynamicFrames.map((frame) => frame.delayMs).filter((delay) => delay > 0));
    let maxTransitionFrames = 0;
    let transitionFrames = 0;

    for (let index = 1; index < dynamicFrames.length; index += 1) {
      const frame = dynamicFrames[index];
      const previous = dynamicFrames[index - 1];
      const followsLongHold = previous.delayMs > typicalDelay * 1.5;
      const isLongHold = frame.delayMs > typicalDelay * 1.5;
      const isVisualChange = visualDifference(previous.signature, frame.signature) >= VISUAL_CHANGE_THRESHOLD;
      if (followsLongHold) transitionFrames = 0;
      if (isVisualChange && !isLongHold) {
        transitionFrames += 1;
        maxTransitionFrames = Math.max(maxTransitionFrames, transitionFrames);
      } else {
        transitionFrames = 0;
      }
    }

    return {
      totalMs,
      dynamicMs: Math.min(boundaryMs, totalMs),
      staticMs: Math.max(0, totalMs - boundaryMs),
      staticSectionStable,
      hasDynamicChange,
      maxTransitionFrames
    };
  }

  function analyze(bytes) {
    const reader = new Reader(bytes);
    const signature = text(reader.take(6));
    if (signature !== "GIF87a" && signature !== "GIF89a") throw new Error("不是有效 GIF");

    const width = reader.word();
    const height = reader.word();
    if (!width || !height || width * height > MAX_PIXELS) throw new Error("GIF 尺寸过大，无法安全逐帧分析");

    const packed = reader.byte();
    reader.byte();
    reader.byte();
    const globalTable = packed & 0x80 ? colorTable(reader, 1 << ((packed & 0x07) + 1)) : null;
    const canvas = new Uint8ClampedArray(width * height * 4);
    const frames = [];
    let elapsedMs = 0;
    let gce = { delayMs: 10, transparentIndex: null, disposal: 0 };
    let previousFrame = null;

    while (reader.offset < bytes.length) {
      const marker = reader.byte();
      if (marker === 0x3b) break;
      if (marker === 0x21) {
        const label = reader.byte();
        if (label === 0xf9) {
          const size = reader.byte();
          if (size !== 4) throw new Error("GIF 图形控制块无效");
          const control = reader.byte();
          const rawDelay = reader.word();
          const transparentIndex = reader.byte();
          reader.byte();
          gce = {
            delayMs: Math.max(rawDelay * 10, 10),
            transparentIndex: control & 1 ? transparentIndex : null,
            disposal: (control >> 2) & 0x07
          };
        } else {
          reader.blocks();
        }
        continue;
      }
      if (marker !== 0x2c) throw new Error("GIF 区块无效");
      if (frames.length >= MAX_FRAMES) throw new Error("GIF 帧数过多，无法安全分析");

      if (previousFrame?.disposal === 2) {
        const { left, top, frameWidth, frameHeight } = previousFrame;
        for (let y = top; y < Math.min(top + frameHeight, height); y += 1) {
          for (let x = left; x < Math.min(left + frameWidth, width); x += 1) {
            canvas.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 4);
          }
        }
      } else if (previousFrame?.disposal === 3 && previousFrame.restore) {
        canvas.set(previousFrame.restore);
      }

      const left = reader.word();
      const top = reader.word();
      const frameWidth = reader.word();
      const frameHeight = reader.word();
      const imagePacked = reader.byte();
      const localTable = imagePacked & 0x80 ? colorTable(reader, 1 << ((imagePacked & 0x07) + 1)) : null;
      const table = localTable || globalTable;
      if (!table) throw new Error("GIF 缺少颜色表");
      const minCodeSize = reader.byte();
      let indices = decodeLzw(minCodeSize, reader.blocks(), frameWidth * frameHeight);
      if (imagePacked & 0x40) indices = deinterlace(indices, frameWidth, frameHeight);
      const restore = gce.disposal === 3 ? canvas.slice() : null;

      for (let y = 0; y < frameHeight; y += 1) {
        for (let x = 0; x < frameWidth; x += 1) {
          const colorIndex = indices[y * frameWidth + x];
          if (colorIndex === gce.transparentIndex) continue;
          const targetX = left + x;
          const targetY = top + y;
          if (targetX >= width || targetY >= height) continue;
          const color = table[colorIndex] || [0, 0, 0];
          const offset = (targetY * width + targetX) * 4;
          canvas[offset] = color[0];
          canvas[offset + 1] = color[1];
          canvas[offset + 2] = color[2];
          canvas[offset + 3] = 255;
        }
      }

      frames.push({
        startMs: elapsedMs,
        delayMs: gce.delayMs,
        hash: hashPixels(canvas),
        signature: visualSignature(canvas, width, height),
        hasTransparency: hasTransparentPixels(canvas)
      });
      elapsedMs += gce.delayMs;
      previousFrame = { left, top, frameWidth, frameHeight, disposal: gce.disposal, restore };
      gce = { delayMs: 10, transparentIndex: null, disposal: 0 };
    }

    if (!frames.length) throw new Error("GIF 中没有可读取的画面帧");
    return {
      width,
      height,
      frameCount: frames.length,
      hasTransparentBackground: frames.every((frame) => frame.hasTransparency),
      ...timingSummary(frames)
    };
  }

  window.GifAnalyzer = { analyze, summarizeFrames: timingSummary };
})();
