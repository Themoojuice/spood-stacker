/* Turns the finished stack into the saved JPEG, off the page's thread: the final sharpening
   (sharpen.js, at the slider's amount) and a full-colour-detail JPEG (vendor/jpeg-encoder.js;
   the browser's own encoder halves the colour resolution). Gets a copy of the unsharpened
   pixels, sharpens them in place, and hands back the JPEG's bytes. */
importScripts('sharpen.js', 'vendor/jpeg-encoder.js');

onmessage = e => {
  const { id, data, width, height, amount, quality } = e.data;
  try {
    SpoodSharpen.image(data, width, height, amount, data);
    const jpeg = SpoodJpegEncode({ data, width, height }, quality || 95).data;
    postMessage({ id, jpeg }, [jpeg.buffer]);
  } catch (err) {
    postMessage({ id, error: (err && err.message) || String(err) });
  }
};
