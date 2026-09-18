(function () {
  "use strict";

  const LIMIT_BYTES = 15 * 1024;
  const GIF_LIMIT_BYTES = 1024 * 1024;
  const GIF_MIN_MS = 7000;
  const GIF_MAX_MS = 8000;
  const GIF_PHASE_MS = 4000;
  const GIF_MIN_STATIC_MS = 3000;
  const GIF_TIME_TOLERANCE_MS = 50;
  const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
  const elements = {
    intro: document.querySelector("#intro"),
    dropZone: document.querySelector("#drop-zone"),
    dropHint: document.querySelector("#drop-hint"),
    pasteButton: document.querySelector("#paste-button"),
    shareToolButton: document.querySelector("#share-tool-button"),
    fileInput: document.querySelector("#file-input"),
    resultPanel: document.querySelector("#result-panel"),
    resultTitle: document.querySelector("#result-title"),
    replaceButton: document.querySelector("#replace-button"),
    previewStage: document.querySelector("#preview-stage"),
    previewCanvas: document.querySelector("#preview-canvas"),
    gifPreview: document.querySelector("#gif-preview"),
    fileCaption: document.querySelector("#file-caption"),
    summary: document.querySelector("#summary"),
    summaryMark: document.querySelector("#summary-mark"),
    summaryTitle: document.querySelector("#summary-title"),
    summaryCopy: document.querySelector("#summary-copy"),
    checkList: document.querySelector("#check-list"),
    toast: document.querySelector("#toast")
  };

  let toastTimer;
  let currentBitmap;
  let currentGifUrl;

  function formatBytes(bytes) {
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
  }

  function isPng(bytes) {
    return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
  }

  function detectImageFormat(bytes, file) {
    if (isPng(bytes)) return "PNG";
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "JPEG";
    if (
      bytes.length >= 12
      && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
      && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
    ) return "WebP";
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "GIF";

    const mime = file.type?.replace(/^image\//, "");
    return mime ? mime.toUpperCase() : "未知";
  }

  function readPngMetadata(bytes) {
    if (!isPng(bytes) || bytes.length < 33) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    const bitDepth = bytes[24];
    const colorType = bytes[25];
    let hasTransparencyChunk = false;
    let offset = 8;

    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset);
      const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
      if (type === "tRNS") hasTransparencyChunk = true;
      offset += length + 12;
      if (type === "IEND") break;
    }

    return {
      width,
      height,
      bitDepth,
      colorType,
      hasAlphaChannel: colorType === 4 || colorType === 6 || hasTransparencyChunk
    };
  }

  function analyzePixels(imageData) {
    const { data, width, height } = imageData;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let transparentCount = 0;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const alpha = data[(y * width + x) * 4 + 3];
        if (alpha < 255) transparentCount += 1;
        if (alpha >= 16) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }

    const hasVisiblePixels = maxX >= 0;
    const bounds = hasVisiblePixels
      ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, right: maxX, bottom: maxY }
      : null;
    return {
      hasTransparentPixels: transparentCount > 0,
      transparentRatio: transparentCount / (width * height),
      bounds
    };
  }

  async function decodeImage(file) {
    if ("createImageBitmap" in window) {
      try {
        return await createImageBitmap(file);
      } catch (error) {
        console.warn("createImageBitmap failed, falling back to Image", error);
      }
    }

    const objectUrl = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.decoding = "async";
      image.src = objectUrl;
      await image.decode();
      return image;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  function makeCheck(name, tone, detail, value) {
    const marks = { pass: "✓", warn: "!", fail: "×" };
    return { name, tone, detail, value, mark: marks[tone] };
  }

  function withinTime(actual, expected) {
    return Math.abs(actual - expected) <= GIF_TIME_TOLERANCE_MS;
  }

  function formatSeconds(milliseconds) {
    return `${(milliseconds / 1000).toFixed(2).replace(/\.00$/, "")} 秒`;
  }

  function evaluateGif(file, gif) {
    const durationPass = gif.totalMs >= GIF_MIN_MS && gif.totalMs <= GIF_MAX_MS;
    const structurePass = withinTime(gif.dynamicMs, GIF_PHASE_MS)
      && gif.staticMs >= GIF_MIN_STATIC_MS
      && gif.staticMs <= GIF_PHASE_MS
      && gif.hasDynamicChange
      && gif.staticSectionStable;
    const transitionPass = gif.maxTransitionFrames <= 10;
    const dimensionsPass = gif.width === 200 && gif.height === 200;
    const formatPass = gif.hasTransparentBackground;
    const sizePass = file.size <= GIF_LIMIT_BYTES;

    return [
      makeCheck(
        "总时长",
        durationPass ? "pass" : "fail",
        durationPass ? "总时长在 7–8 秒内" : "GIF 总时长必须在 7–8 秒内",
        formatSeconds(gif.totalMs)
      ),
      makeCheck(
        "动静结构",
        structurePass ? "pass" : "fail",
        structurePass ? "约 4 秒动态，末尾 3–4 秒保持最终画面" : "需要约 4 秒动态、末尾 3–4 秒静止",
        `${formatSeconds(gif.dynamicMs)} + ${formatSeconds(gif.staticMs)}`
      ),
      makeCheck(
        "动静转场",
        transitionPass ? "pass" : "fail",
        transitionPass ? "最长连续视觉转场不超过 10 帧" : "动态过程中的单段连续视觉转场超过 10 帧",
        `${gif.maxTransitionFrames} 帧`
      ),
      makeCheck(
        "尺寸",
        dimensionsPass ? "pass" : "fail",
        dimensionsPass ? "符合统一画布尺寸" : "必须导出为 200 × 200 px",
        `${gif.width} × ${gif.height}`
      ),
      makeCheck(
        "格式与透明底",
        formatPass ? "pass" : "fail",
        formatPass ? "真实 GIF，且每个合成帧均保留透明背景" : "GIF 必须使用透明背景",
        formatPass ? "GIF / 透明" : "GIF / 不透明"
      ),
      makeCheck(
        "文件大小",
        sizePass ? "pass" : "fail",
        sizePass ? "原始 GIF 未超过 1 MB" : `超出 ${formatBytes(file.size - GIF_LIMIT_BYTES)}`,
        formatBytes(file.size)
      )
    ];
  }

  function showGifPreview(file) {
    currentBitmap?.close?.();
    currentBitmap = null;
    if (currentGifUrl) URL.revokeObjectURL(currentGifUrl);
    currentGifUrl = URL.createObjectURL(file);
    elements.previewCanvas.hidden = true;
    elements.gifPreview.hidden = false;
    elements.gifPreview.src = currentGifUrl;
  }

  function showCanvasPreview() {
    if (currentGifUrl) URL.revokeObjectURL(currentGifUrl);
    currentGifUrl = null;
    elements.gifPreview.removeAttribute("src");
    elements.gifPreview.hidden = true;
    elements.previewCanvas.hidden = false;
  }

  function evaluate(file, image, png, pixels, source, detectedFormat) {
    const checks = [];
    const dimensionsPass = image.width === 200 && image.height === 200;
    checks.push(makeCheck(
      "画布尺寸",
      dimensionsPass ? "pass" : "fail",
      dimensionsPass ? "符合统一画布尺寸" : "必须导出为 200 × 200 px",
      `${image.width} × ${image.height}`
    ));

    checks.push(makeCheck(
      "文件格式",
      png ? "pass" : "fail",
      png ? "已通过 PNG 文件签名校验" : "图片内容不是有效 PNG",
      detectedFormat
    ));

    const transparentPass = Boolean(pixels?.hasTransparentPixels);
    checks.push(makeCheck(
      "透明背景",
      transparentPass ? "pass" : "fail",
      transparentPass ? "检测到真实透明像素" : "需要 Alpha 通道和透明背景像素",
      pixels?.hasTransparentPixels ? "有透明像素" : "无透明像素"
    ));

    if (source === "clipboard") {
      checks.push(makeCheck(
        "文件大小",
        "warn",
        "剪贴板会重新编码图片，需下载原始文件才能准确判断",
        "不可核验"
      ));
    } else {
      const sizePass = file.size <= LIMIT_BYTES;
      checks.push(makeCheck(
        "文件大小",
        sizePass ? "pass" : "fail",
        sizePass ? "原始文件未超过 15 KB 上限" : `超出 ${(file.size - LIMIT_BYTES) / 1024 < 0.1 ? "0.1" : ((file.size - LIMIT_BYTES) / 1024).toFixed(1)} KB`,
        formatBytes(file.size)
      ));
    }

    let areaTone = "warn";
    let areaDetail = "没有识别到可见主体，请人工确认";
    let areaValue = "待确认";
    if (pixels?.bounds && dimensionsPass) {
      const b = pixels.bounds;
      const insideProduction = b.x >= 5 && b.y >= 5 && b.right <= 194 && b.bottom <= 194;
      areaTone = insideProduction ? "pass" : "fail";
      areaDetail = insideProduction
        ? "可见内容位于 190 × 190 px 制图区内"
        : "可见内容超出 190 × 190 px 制图区";
      areaValue = `${b.width} × ${b.height}`;
    }
    checks.push(makeCheck("内容占比", areaTone, areaDetail, areaValue));

    return checks;
  }

  function renderChecks(checks) {
    elements.checkList.replaceChildren();
    checks.forEach((check) => {
      const row = document.createElement("div");
      row.className = "check-row";
      row.dataset.tone = check.tone;

      const mark = document.createElement("span");
      mark.className = "check-mark";
      mark.textContent = check.mark;
      mark.setAttribute("aria-hidden", "true");

      const copy = document.createElement("div");
      copy.className = "check-copy";
      const name = document.createElement("span");
      name.className = "check-name";
      name.textContent = check.name;
      const detail = document.createElement("span");
      detail.className = "check-detail";
      detail.textContent = check.detail;
      copy.append(name, detail);

      const value = document.createElement("span");
      value.className = "check-value";
      value.textContent = check.value;
      row.append(mark, copy, value);
      elements.checkList.append(row);
    });

    const hasFailure = checks.some((check) => check.tone === "fail");
    const hasWarning = checks.some((check) => check.tone === "warn");
    const tone = hasFailure ? "fail" : hasWarning ? "warn" : "pass";
    elements.summary.dataset.tone = tone;
    elements.summaryMark.textContent = tone === "pass" ? "✓" : tone === "warn" ? "!" : "×";
    elements.summaryTitle.textContent = hasFailure ? "预审不通过" : hasWarning ? "待人工确认" : "预审通过";
    elements.summaryCopy.textContent = hasFailure
      ? "存在硬性规范问题，请修改后重新检测。"
      : hasWarning
        ? "图像规范已通过，需下载原始文件核验文件大小。"
        : "所有预审项目均符合当前规则。";
    elements.resultTitle.textContent = elements.summaryTitle.textContent;
  }

  async function processFile(file, source) {
    if (!file) return;
    elements.resultPanel.hidden = false;
    elements.dropZone.hidden = true;
    elements.intro.hidden = true;
    elements.resultTitle.textContent = "正在检测";
    elements.fileCaption.textContent = `${file.name || "剪贴板图片"}  ${formatBytes(file.size)}`;

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const detectedFormat = detectImageFormat(bytes, file);
      if (detectedFormat === "GIF") {
        const gif = window.GifAnalyzer.analyze(bytes);
        showGifPreview(file);
        renderChecks(evaluateGif(file, gif));
        if (source === "clipboard") showToast("已读取剪贴板 GIF。文件大小需使用下载后的原文件核验。", 3200);
        return;
      }

      showCanvasPreview();
      const png = readPngMetadata(bytes);
      const bitmap = await decodeImage(file);
      currentBitmap?.close?.();
      currentBitmap = bitmap;

      const image = { width: bitmap.width, height: bitmap.height };
      const canvas = elements.previewCanvas;
      canvas.width = 200;
      canvas.height = 200;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      context.clearRect(0, 0, canvas.width, canvas.height);
      const previewScale = Math.min(canvas.width / image.width, canvas.height / image.height);
      const previewWidth = image.width * previewScale;
      const previewHeight = image.height * previewScale;
      context.drawImage(
        bitmap,
        (canvas.width - previewWidth) / 2,
        (canvas.height - previewHeight) / 2,
        previewWidth,
        previewHeight
      );
      const pixels = image.width === 200 && image.height === 200
        ? analyzePixels(context.getImageData(0, 0, canvas.width, canvas.height))
        : null;

      renderChecks(evaluate(file, image, png, pixels, source, detectedFormat));
      if (source === "clipboard") showToast("已读取剪贴板图片。结果基于浏览器收到的文件。", 3200);
    } catch (error) {
      console.error(error);
      renderChecks([
        makeCheck("读取图片", "fail", "浏览器无法解析这张图片，请改用原始图片文件", "读取失败")
      ]);
    }
  }

  function imageFromClipboardItems(items) {
    for (const item of items) {
      if (item.type?.startsWith("image/")) return item.getAsFile();
    }
    return null;
  }

  async function readClipboard() {
    if (!navigator.clipboard?.read) {
      showToast("当前浏览器不支持主动读取图片。请长按页面粘贴，或选择原始文件。", 4200);
      elements.dropZone.focus?.();
      return;
    }

    try {
      const clipboardItems = await navigator.clipboard.read();
      for (const item of clipboardItems) {
        const imageType = item.types.find((type) => type.startsWith("image/"));
        if (imageType) {
          const blob = await item.getType(imageType);
          const extension = imageType === "image/png" ? "png" : "image";
          await processFile(new File([blob], `剪贴板图片.${extension}`, { type: imageType }), "clipboard");
          return;
        }
      }
      showToast("剪贴板中没有图片。请先在群聊中复制图标。", 3200);
    } catch (error) {
      showToast("未能读取剪贴板。请允许访问，或选择原始 PNG 文件。", 4200);
    }
  }

  function showToast(message, duration = 3000) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    toastTimer = window.setTimeout(() => {
      elements.toast.hidden = true;
    }, duration);
  }

  function resetView() {
    elements.resultPanel.hidden = true;
    elements.dropZone.hidden = false;
    elements.intro.hidden = false;
    elements.fileInput.value = "";
    elements.dropZone.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function shareTool() {
    if (location.protocol !== "https:") {
      showToast("当前是本地预览。部署到 HTTPS 后即可分享工具链接。", 3800);
      return;
    }

    const url = `${location.origin}${location.pathname}`;
    if (navigator.share) {
      try {
        await navigator.share({
          title: "百宝箱图标预审",
          text: "用这个工具检查 PNG 与 GIF 图标的尺寸、格式、透明背景、文件大小和动效时序。",
          url
        });
        return;
      } catch (error) {
        if (error.name === "AbortError") return;
      }
    }

    try {
      await navigator.clipboard.writeText(url);
      showToast("工具链接已复制，可以发到群聊。", 3200);
    } catch (error) {
      showToast("当前地址无法分享，请部署到 HTTPS 后再试。", 3200);
    }
  }

  elements.pasteButton.addEventListener("click", readClipboard);
  elements.fileInput.addEventListener("change", (event) => processFile(event.target.files?.[0], "file"));
  elements.replaceButton.addEventListener("click", resetView);
  elements.shareToolButton.addEventListener("click", shareTool);

  document.addEventListener("paste", (event) => {
    const file = imageFromClipboardItems(event.clipboardData?.items || []);
    if (file) {
      event.preventDefault();
      processFile(file, "clipboard");
    } else {
      showToast("粘贴内容中没有图片。", 2600);
    }
  });

  ["dragenter", "dragover"].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.add("is-dragging");
    });
  });
  ["dragleave", "drop"].forEach((eventName) => {
    elements.dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      elements.dropZone.classList.remove("is-dragging");
    });
  });
  elements.dropZone.addEventListener("drop", (event) => processFile(event.dataTransfer?.files?.[0], "file"));

  document.querySelectorAll(".preview-option").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".preview-option").forEach((option) => option.classList.remove("is-active"));
      button.classList.add("is-active");
      elements.previewStage.className = `preview-stage preview-${button.dataset.preview}`;
    });
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
      try {
        await navigator.serviceWorker.register("service-worker.js", { scope: "./" });
      } catch (error) {
        console.warn("Service worker registration failed", error);
      }
    });
  }

})();
