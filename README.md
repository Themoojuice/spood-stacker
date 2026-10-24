# Spood Stacker

Focus stacking for handheld macro bursts, as an installable web app that runs entirely on your phone.

**App:** https://themoojuice.github.io/spood-stacker/

## Use it on Android
1. Open the link above in **Chrome**, then tap **Install app** (or ⋮ → *Add to home screen* → *Install*).
2. In Gallery, select a burst (2–30 photos of the same subject), tap **Share**, then choose **Spood Stacker**.
3. Keep the screen open while it works. The result is saved to **Downloads** and shown in the app.

You can also open the app and tap **Tap to choose photos**. Nothing is uploaded: stacking runs on the device (OpenCV.js in a Web Worker).

### Date and location (EXIF)
The saved JPEG carries the reference photo's EXIF: date taken, GPS location and camera, so iNaturalist can read them. The app says under the result what it kept. If it says the photos arrived without a location, Android removed it on the way in (Samsung's share sheet has a location option; Android can also strip location from photos handed to a browser). The laptop version reads the files directly and keeps it.

### Retouch
After stacking, tap **Retouch** to fix halos around legs and setae by hand, the way Zerene and Helicon do:
- **Pick**: tap a spot. The photo that is sharpest there is chosen and shown in a lens. Tap the same spot again to cycle to the next sharpest photo. Drag to move around.
- **Paint**: paint over the halo; the pixels come from the chosen photo. **Stack** as the source paints the automatic result back.
- Two fingers zoom and pan. **Hold to peek** shows the chosen photo across the whole frame. **Undo** takes back one stroke.
- **Done** saves a `-retouched.jpg` beside the original, with the same EXIF.

## How it works (`engine.js`)
1. The photos are put in focus order. The reference is the photo that is sharpest in the centre of the frame. The black clamp edge of a clip-on lens is masked out: a dark region at the frame edge counts as the clamp only if it is nearly black and (with 4+ photos) sits in the same place in most of them, so a dark subject crossing the frame edge is not mistaken for it.
2. Each photo is lined up with the reference (AKAZE features, a homography, and ECC fine-tuning; the fine-tune must still agree with the matched features, and when a repeating pattern such as an insect screen is in view it is skipped, since there it locks onto the wrong cells and shears the background). Photos don't need to be framed alike: each counts only where it has pixels of its own, and fades out over a short band at its edge, so a photo that covers half the view still contributes that half.
3. **Local correction, pixel by pixel.** Dense optical flow corrects parallax and small body shifts. It is worked out both ways (reference → photo and back); where following it there and back doesn't land where it started (an occlusion), or where it ripples from place to place instead of changing gently (locked onto different cells of a repeating mesh), that spot keeps the plain line-up. Each photo gets a trust map: the two-way check passed there, or the plain line-up already agreed.
4. **Photo selection.** A photo is left out if it can't be lined up, if it matched far worse than the others and couldn't be fine-tuned, if it is a near-duplicate (same picture, same framing *and* sharp in the same places; the higher-resolution copy is kept), if the subject moved in it, or if it adds no sharp detail the others lack. Movement is judged where the photos are sharp (the subject) and only where the photo has pixels, not over the whole frame, so a small subject that walked off is caught even when the background lines up perfectly. Capture times (EXIF, else the camera's file name) split the photos into moments: a photo taken more than 2 s apart from the rest (say, a second burst) is checked more strictly and is never the reference, but it is kept if it still lines up well (a still subject). The app lists which photos were left out and why.
5. **Per-region merging.** Each pixel comes from whichever photos are sharpest there, weighted by where each photo has pixels, agrees with the reference and can be trusted. So a photo with a sharp head and a blurry body contributes only its head. Coarse levels are blended by sharpness weights. Fine detail is merged from every photo that is nearly as sharp as the best one at that spot (at least 55%), as far as its detail agrees with the best photo's: near-equals average out each other's noise, while a photo whose detail differs (a slightly different line-up, a moved leg) is left out of that spot.
6. The image is cropped to the area that at least one used photo saw (not just the area every photo saw), keeping roughly the photo's own shape, and lightly sharpened. The lined-up photos are kept, cropped and sharpened the same way, for the retouch brush.

## Comparing engine versions
Every change to `engine.js` should be checked against a known-good version on the same bursts, so a fix for one artefact can't quietly break another.

```
cd tools && npm install            # once (installs the "sharp" image library)
cd ..
python tests/make_synthetic.py     # once: synthetic bursts with a known right answer
node tools/compare.js              # the gold version (tests/gold.txt) vs engine.js as it is now
```

It writes a contact sheet per burst to `compare-out/<time>/` (open `index.html`): both results, a map of where they differ, and 1:1 close-ups of the regions that differ most. Results are cached per engine version, so the gold runs only once.
- Put real bursts in their own folders under `tests/bursts/` (they are git-ignored, so their GPS never reaches GitHub). A `gold.jpg` in a burst folder (say, a Zerene stack of it) is shown beside the close-ups.
- Synthetic bursts have `truth/` images (the best any stacker could do), so the sheet also gives PSNR and SSIM against the truth for each version.
- `--a` / `--b` take a file, `git:<ref>`, or `py:desktop/stacker.py` (the laptop version). `--size 1600` runs faster; `--fresh` ignores the cache.

The synthetic scenes (`tests/make_synthetic.py`): `bark` (handheld lean-in with parallax), `legs` (legs running steeply through depth, portrait EXIF orientation), `still` (no camera movement, so the truth lines up exactly), `moved` (the abdomen moves in the last two photos), `drift` (photos framed far apart, so no area is covered by every photo), `dense` (16 photos with fine focus steps at a phone's noise level in shade, for multi-photo detail merging), `mesh` (spider on an insect screen: repeating texture behind a subject with parallax), `dup` (bark plus an edited lower-resolution copy of one photo).

`tests/app_check.py` drives the real app in headless Chromium at phone size (stack, EXIF, pick, paint, undo, save); `tests/retouch_effect.py` measures how much Pick-and-paint reduces the error in the worst regions.

## Laptop version (`desktop/`)
`stacker.py` and `stack.bat` (Windows): drag a burst folder onto `stack.bat`. It works like the app: the clamp mask, coverage, the two-way flow check and multi-photo detail merging, and it leaves out photos whose subject moved (`--keep-all` uses every photo). It saves `<folder>_stacked.png` and a quality-95 `<folder>_stacked.jpg`, both with the reference photo's EXIF (date, GPS, camera) and colour profile. `--jpeg-quality 0` skips the JPEG; `--no-exif` leaves the metadata out.

## Files
- `index.html`: the app screen
- `engine.js`: the stacking engine
- `worker.js`: runs the engine in a background thread
- `exif.js`: copies the EXIF into the saved JPEG
- `retouch.js`: the retouch brush
- `sw.js`: service worker (receives shared photos, works offline)
- `manifest.webmanifest`: install and share-menu settings
- `vendor/opencv-4.10.0.js`: OpenCV.js 4.10.0 (from `@techstark/opencv-js`, Apache 2.0)
- `tools/`: the engine compare tool
- `tests/`: synthetic bursts and app checks
- `desktop/`: the laptop version
