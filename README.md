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
1. The photos are put in focus order. The reference is the photo that is sharpest in the centre of the frame.
2. Each photo is lined up with the reference (AKAZE features, a homography, and ECC fine-tuning). A local optical-flow correction is added only for photos where it measurably improves the alignment.
3. **Photo selection.** A photo is left out if it can't be lined up, if it is a near-duplicate (same picture *and* sharp in the same places; the higher-resolution copy is kept), if the spider moved too much in it, or if it adds no sharp detail the others lack. The app lists which photos were left out and why.
4. **Per-region merging.** Each pixel comes from whichever photos are sharpest there. So a photo with a sharp head and a blurry body contributes only its head. Coarse levels are blended by sharpness weights; fine detail is taken from the sharpest photo, and only where something was actually in focus.
5. The image is cropped to the area covered by every photo used, and lightly sharpened. The lined-up photos are kept, cropped and sharpened the same way, for the retouch brush.

## Comparing engine versions
Every change to `engine.js` should be checked against a known-good version on the same bursts, so a fix for one artefact can't quietly break another.

```
cd tools && npm install            # once (installs the "sharp" image library)
cd ..
python tests/make_synthetic.py     # once: synthetic bursts with a known right answer
git tag gold <commit>              # once: the version everything is judged against
node tools/compare.js              # gold vs engine.js as it is on disk now
```

It writes a contact sheet per burst to `compare-out/<time>/` (open `index.html`): both results, a map of where they differ, and 1:1 close-ups of the regions that differ most. Results are cached per engine version, so the gold runs only once.
- Put real bursts in their own folders under `tests/bursts/` (they are git-ignored, so their GPS never reaches GitHub). A `gold.jpg` in a burst folder (say, a Zerene stack of it) is shown beside the close-ups.
- Synthetic bursts have `truth/` images (the best any stacker could do), so the sheet also gives PSNR and SSIM against the truth for each version.
- `--a` / `--b` take a file, `git:<ref>`, or `py:desktop/stacker.py` (the laptop version). `--size 1600` runs faster; `--fresh` ignores the cache.

The synthetic scenes (`tests/make_synthetic.py`): `bark` (handheld lean-in with parallax), `legs` (legs running steeply through depth, portrait EXIF orientation), `still` (no camera movement, so the truth lines up exactly), `moved` (the abdomen moves in the last two photos), `dup` (bark plus an edited lower-resolution copy of one photo).

`tests/app_check.py` drives the real app in headless Chromium at phone size (stack, EXIF, pick, paint, undo, save); `tests/retouch_effect.py` measures how much Pick-and-paint reduces the error in the worst regions.

## Laptop version (`desktop/`)
`stacker.py` and `stack.bat` (Windows): drag a burst folder onto `stack.bat`. It saves `<folder>_stacked.png` and a quality-95 `<folder>_stacked.jpg`, both with the reference photo's EXIF (date, GPS, camera) and colour profile. `--jpeg-quality 0` skips the JPEG; `--no-exif` leaves the metadata out.

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
