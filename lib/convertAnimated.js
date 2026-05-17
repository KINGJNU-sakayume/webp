// Animated WebP → MP4 (H.264) via WebCodecs API.
//
// Replaces the prior ffmpeg.wasm pipeline. The single-thread @ffmpeg/core
// build was missing the WebP demuxer ("Cannot determine format of input
// stream 0:0 after EOF"), and the cross-origin worker / module-type / Blob
// URL surface on iOS Safari was a constant fight even for the loading.
//
// Native WebCodecs gives us:
//   - ImageDecoder: decodes animated WebP frame-by-frame (Safari 16.4+).
//   - VideoEncoder: encodes H.264 (Safari 17+).
//   - mp4-muxer (CDN, ~10KB): boxes encoded chunks into a faststart MP4.
//
// No worker, no wasm, no 25MB download, same-origin everything.

const MSG_NO_IMAGE_DECODER = '이 브라우저는 애니메이션 WebP 디코딩을 지원하지 않습니다 (iOS 17 이상의 Safari, 또는 최신 Chrome/Edge 필요)';
const MSG_NO_VIDEO_ENCODER = '이 브라우저는 H.264 인코딩을 지원하지 않습니다 (iOS 17 이상의 Safari, 또는 최신 Chrome/Edge 필요)';
const MSG_NO_MUXER = 'MP4 라이브러리를 불러오지 못했습니다 (인터넷 연결을 확인해주세요)';
const MSG_DECODE_FAIL = 'WebP 프레임을 디코딩하지 못했습니다';
const MSG_ENCODE_FAIL = 'MP4 인코딩에 실패했습니다';
const MSG_NO_CODEC = '이 기기에서 지원하는 H.264 프로파일을 찾지 못했습니다';

const DEFAULT_FRAMERATE = 30;
const DEFAULT_FRAME_DURATION_US = Math.round(1_000_000 / DEFAULT_FRAMERATE);
const BITRATE_BPS = 2_000_000;
const KEYFRAME_INTERVAL = 30;

export function checkAnimatedSupport() {
  if (typeof ImageDecoder !== 'function') return MSG_NO_IMAGE_DECODER;
  if (typeof VideoEncoder !== 'function' || typeof VideoFrame !== 'function') {
    return MSG_NO_VIDEO_ENCODER;
  }
  if (!window.Mp4Muxer || !window.Mp4Muxer.Muxer || !window.Mp4Muxer.ArrayBufferTarget) {
    return MSG_NO_MUXER;
  }
  return null;
}

function evenDim(n) {
  return n % 2 === 0 ? n : n + 1;
}

function makeErr(message, cause) {
  const err = new Error(message);
  if (cause) {
    const text = cause && cause.message ? cause.message : String(cause);
    err.detail = text.slice(0, 240);
  }
  // eslint-disable-next-line no-console
  console.error(message, cause);
  return err;
}

async function chooseSupportedCodec(width, height) {
  // iOS Photos accepts these; ordered most-compatible first.
  const candidates = [
    'avc1.42E01F', // Constrained Baseline 3.1 — widest device support
    'avc1.42001F', // Baseline 3.1
    'avc1.4D401F', // Main 3.1
    'avc1.640028', // High 4.0
  ];
  for (const codec of candidates) {
    try {
      const result = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate: BITRATE_BPS,
        framerate: DEFAULT_FRAMERATE,
        avc: { format: 'avc' },
      });
      if (result && result.supported) return codec;
    } catch (_) { /* try next */ }
  }
  return null;
}

export async function convertAnimatedToMp4(file, { onProgress } = {}) {
  const issue = checkAnimatedSupport();
  if (issue) throw new Error(issue);

  if (onProgress) onProgress(0);

  // 1. Read the whole file into memory once. ImageDecoder accepts a
  //    ReadableStream too, but a buffer makes .completed resolve
  //    immediately so we can rely on frameCount.
  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (err) {
    throw makeErr(MSG_DECODE_FAIL, err);
  }

  let decoder;
  try {
    decoder = new ImageDecoder({ data: buffer, type: 'image/webp' });
  } catch (err) {
    throw makeErr(MSG_DECODE_FAIL, err);
  }

  try {
    try {
      await decoder.tracks.ready;
      await decoder.completed;
    } catch (err) {
      throw makeErr(MSG_DECODE_FAIL, err);
    }

    const track = decoder.tracks.selectedTrack;
    if (!track) throw makeErr(MSG_DECODE_FAIL, new Error('no track'));
    const frameCount = track.frameCount;
    if (!Number.isFinite(frameCount) || frameCount < 1) {
      throw makeErr(MSG_DECODE_FAIL, new Error(`invalid frameCount=${frameCount}`));
    }

    // 2. Probe the first frame for dimensions.
    let firstResult;
    try {
      firstResult = await decoder.decode({ frameIndex: 0 });
    } catch (err) {
      throw makeErr(MSG_DECODE_FAIL, err);
    }
    const srcW = firstResult.image.displayWidth;
    const srcH = firstResult.image.displayHeight;
    const width = evenDim(srcW);
    const height = evenDim(srcH);
    const cropNeeded = width !== srcW || height !== srcH;
    firstResult.image.close();

    // 3. Pick a codec the device actually supports.
    const codec = await chooseSupportedCodec(width, height);
    if (!codec) throw makeErr(MSG_NO_CODEC, new Error(`${width}x${height}`));

    // 4. Initialize muxer.
    let muxer;
    try {
      muxer = new window.Mp4Muxer.Muxer({
        target: new window.Mp4Muxer.ArrayBufferTarget(),
        video: { codec: 'avc', width, height },
        fastStart: 'in-memory',
      });
    } catch (err) {
      throw makeErr(MSG_ENCODE_FAIL, err);
    }

    // 5. Initialize encoder.
    const encodeErrors = [];
    const encoder = new VideoEncoder({
      output: (chunk, meta) => {
        try {
          muxer.addVideoChunk(chunk, meta);
        } catch (err) {
          encodeErrors.push(err);
        }
      },
      error: (err) => encodeErrors.push(err),
    });

    try {
      encoder.configure({
        codec,
        width,
        height,
        bitrate: BITRATE_BPS,
        framerate: DEFAULT_FRAMERATE,
        avc: { format: 'avc' },
      });
    } catch (err) {
      throw makeErr(MSG_ENCODE_FAIL, err);
    }

    // 6. Walk every frame, decode, encode.
    let timestampUs = 0;
    try {
      for (let i = 0; i < frameCount; i++) {
        if (encodeErrors.length > 0) {
          throw makeErr(MSG_ENCODE_FAIL, encodeErrors[0]);
        }

        const result = await decoder.decode({ frameIndex: i });
        const sourceImage = result.image;

        const frameDurationUs =
          (typeof sourceImage.duration === 'number' && sourceImage.duration > 0)
            ? sourceImage.duration
            : DEFAULT_FRAME_DURATION_US;

        const frameInit = {
          timestamp: timestampUs,
          duration: frameDurationUs,
        };
        if (cropNeeded) {
          frameInit.visibleRect = { x: 0, y: 0, width, height };
        }

        const frame = new VideoFrame(sourceImage, frameInit);
        const isKeyFrame = (i === 0) || (i % KEYFRAME_INTERVAL === 0);
        encoder.encode(frame, { keyFrame: isKeyFrame });

        timestampUs += frameDurationUs;
        frame.close();
        sourceImage.close();

        if (onProgress) onProgress(0.02 + ((i + 1) / frameCount) * 0.93);

        // Periodically yield so the UI thread can paint progress.
        if (i % 10 === 9) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }

      try {
        await encoder.flush();
      } catch (err) {
        throw makeErr(MSG_ENCODE_FAIL, err);
      }

      if (encodeErrors.length > 0) {
        throw makeErr(MSG_ENCODE_FAIL, encodeErrors[0]);
      }

      muxer.finalize();
      if (onProgress) onProgress(1);

      const buf = muxer.target.buffer;
      if (!buf || buf.byteLength === 0) {
        throw makeErr(MSG_ENCODE_FAIL, new Error('empty output'));
      }
      return new Blob([buf], { type: 'video/mp4' });
    } finally {
      try { encoder.close(); } catch (_) { /* ignore */ }
    }
  } finally {
    try { decoder.close(); } catch (_) { /* ignore */ }
  }
}
