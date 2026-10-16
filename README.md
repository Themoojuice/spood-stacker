# Spood Stacker

Focus stacking for handheld macro bursts, as an installable web app that runs entirely on your phone.

**App:** https://themoojuice.github.io/spood-stacker/

## Use it on Android
1. Open the link above in **Chrome**, then tap **Install app** (or ⋮ → *Add to home screen* → *Install*).
2. In Gallery, select a burst (2–30 photos of the same subject), tap **Share**, then choose **Spood Stacker**.
3. Keep the screen open while it works. The result is saved to **Downloads** and shown in the app.

You can also open the app and tap **Tap to choose photos**. Nothing is uploaded: stacking runs on the device (OpenCV.js in a Web Worker).

## How it works (`engine.js`)
1. The photos are put in focus order. The reference is the photo that is sharpest in the centre of the frame.
2. Each photo is lined up with the reference (AKAZE features, a homography, and ECC fine-tuning). A local optical-flow correction is added only for photos where it measurably improves the alignment.
3. **Photo selection.** A photo is left out if it can't be lined up, if it is a near-duplicate (the higher-resolution copy is kept), if the spider moved too much in it, or if it adds no sharp detail the others lack. The app lists which photos were left out and why.
4. **Per-region merging.** Each pixel comes from whichever photos are sharpest there. So a photo with a sharp head and a blurry body contributes only its head. Coarse levels are blended by sharpness weights; fine detail is taken from the sharpest photo, and only where something was actually in focus.
5. The image is cropped to the area covered by every photo used, and lightly sharpened.

## Files
- `index.html`: the app screen
- `engine.js`: the stacking engine
- `worker.js`: runs the engine in a background thread
- `sw.js`: service worker (receives shared photos, works offline)
- `manifest.webmanifest`: install and share-menu settings
- `vendor/opencv-4.10.0.js`: OpenCV.js 4.10.0 (from `@techstark/opencv-js`, Apache 2.0)
