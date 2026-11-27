# Spood Stacker

Focus stacking for handheld macro bursts, as an installable web app that runs entirely on your phone.

**App:** https://themoojuice.github.io/spood-stacker/

## Use it on Android
1. Open the link above in **Chrome**, then tap **Install app** (or ⋮ → *Add to home screen* → *Install*).
2. In Gallery, select a burst (2–30 photos of the same subject), tap **Share**, then choose **Spood Stacker**.
3. Keep the screen open while it works (or try **Keep stacking if I switch apps**, below). The result is saved to **Downloads** and shown in the app.

You can also open the app and tap **Tap to choose photos**. Nothing is uploaded: stacking runs on the device (OpenCV.js in a Web Worker).

### Date and location (EXIF)
The saved JPEG carries the reference photo's EXIF: date taken, GPS location and camera, so iNaturalist can read them. The app says under the result what it kept. If it says the photos arrived without a location, Android removed it on the way in (Samsung's share sheet has a location option; Android can also strip location from photos handed to a browser). The laptop version reads the files directly and keeps it.

### Sharpening and colour
Under the result, **Sharpening** sets how crisp the saved stack is (0–150%; 70% is about as crisp as the old fixed setting). The close-up below it shows the stack at full size as you move the slider; drag it to look around. Letting go re-makes the JPEG; tap **Save again** to save that version. The setting is kept for the next stacks.

The sharpening lifts brightness only (coloured edges get no coloured fringes), keeps each pixel within a couple of levels of its neighbours' range (edges get steeper without the light and dark rims of a plain unsharp mask), and leaves faint grain alone. The saved JPEG keeps full colour detail (4:4:4): the browser's own encoder stores colour at a quarter of the resolution below quality 100, so the app encodes it itself (`finish.js`, off the main thread).

### What are you stacking?
Under the photo picker: **Spider or bug** (the usual), **Wet or shiny**, **Backlit eggs**, or **Silk or cobwebs**. The choice is remembered. Photos shared from Gallery open a **What are you stacking?** sheet with the remembered mode first: do nothing and it starts in that mode after 5 seconds (as before, nothing to tap); tap another mode and it starts at once, and that mode is remembered from then on; tap the sheet to hold the countdown; **Not now** leaves the photos chosen without stacking. While stacking, the screen says which mode is on; **Stop** goes back to the start screen to change it.

### Wet or shiny subjects
Glare (the light's reflection in a wet or glossy surface) moves with the light and the camera, and a torch held by hand, or a refocus a few seconds later, lights each photo a little differently. The stacker can read both as the subject moving and leave out photos that were the only sharp ones somewhere, and out-of-focus glare swells into bright blobs that end up in the stack. Choose **Wet or shiny** before stacking, or tap **Stack again for a wet or shiny subject** under a result, and the stacker:
- matches features with local contrast evened out, so detail in shade and beside glare lines up too;
- relights each photo to match the reference photo's lighting before comparing them;
- looks past glare when deciding whether the subject moved, and keeps a photo whose features line up well even when the fine-tune is pulled off by moved shadows and glare (a photo framed far from the rest is then used only where its shapes match the reference's, so a part that doesn't line up isn't pasted in beside the real one);
- where one photo glares and another shows the surface underneath, takes the surface.

Glare that every photo has stays as it is: nothing is painted in. The result line says when the mode was on.

### Backlit eggs
Translucent eggs lit from behind are seen through a milky veil of scattered light, tinted by the lamp, with the detail that matters (eye spots, the embryo's outline and segments) only a few levels deep. Stacking itself does well on them: on a real 10-photo burst the stack was at least as sharp as the sharpest photo nearly everywhere. What **Backlit eggs** adds is the finish, worked out once from the reference photo and applied to the stack:
- the lamp's tint is taken out (the brightest unclipped, least coloured pixels are light straight through the silk, so they should be neutral; 80% of the way, as all of it overshoots to green);
- white and black points come from the picture itself, so every day's stack comes out alike whatever the phone's exposure did;
- local contrast at about 1/80 of the frame's long side, on brightness only and in log space (contrast grows, not brightness), held back on the lamp itself and in deep shadow.

The log shows the lamp's colour and the levels used (`eggPrep` in `engine.js`).

### Silk or cobwebs
A strand of silk hangs at a different depth from what's behind it, so it's sharp in a different photo from its surroundings. As you lean in it shifts against them, so each photo shows it in a different place, and picking the sharpest photo at every spot collects strands from several photos at once. Choose **Silk or cobwebs** before stacking, or tap **Stack again in silk mode** under a result, and the stacker:
- finds each photo's silk: thin, bright, straight lines (evidence added up along straight paths at 12 angles) whose surroundings are blurred in that same photo. A seta is sharp together with the palp or leg it grows from, so it stays; a strand over out-of-focus bark doesn't;
- takes those spots from a photo that covers them without silk there.

Silk every photo shows (a sheet lying on the bark, a blurred veil in front of everything) stays, since no photo has the spot clean. Leave the mode off for a spider on a web you want to keep. With a repeating pattern in view (an insect screen) it stays off by itself, because the screen's lines would be taken for silk. On a real 8-photo Gelotia burst it took out most strands across the out-of-focus bark and left the face, palps and leg setae as they were (0.9% of pixels changed). On the synthetic scenes, which have no silk, the stack is the same as without it (±0.01 dB; the dense scene +0.08 dB). It adds about 2 s per photo on one core (`silkEvidence` in `engine.js`).

### Watch the maths
While it stacks, the app animates what the engine is actually doing, from the engine's own working data (`maths.js`, fed by `opts.onPeek` in `engine.js`): your burst as a flipbook on its capture timeline, each photo's focus map with a loupe on its sharpest spot (full-resolution pixels, with the Laplacian's 3 × 3 sum worked out on them as it slides across) and the burst's sharpness curve, the focus order (the photos' similarity grid and its Fiedler vector), the AKAZE landmarks at their true size and angle and the strongest one's 486-bit fingerprint, two matched fingerprints with their differing bits counted (the Hamming distance) and the ratio test, the RANSAC vote re-enacted on the real pairs (four pairs propose a homography, the rest agree or not) and the homography it kept, your photos as a tilted deck of see-through layers sliding into line (with the correlation the fine-tune reached on a dial), every line-up drawn on the reference with your hand's path through the burst and how much bigger the spider got in frame as you leaned in, each photo flickering against the reference with a glow where they still disagree before the optical flow pulls it into place, the ghost maps (where each photo disagrees with the reference and isn't used) with left-out photos peeling off with their reasons, the per-pixel vote for the sharpest photo (coloured by focus order) rising into a rough 3D relief with your spider's colours on it, the merge re-enacted band by band on three of your photos (fine detail picked from the sharpest, broad shading averaged) and the real merged rows landing, then the reveal: your best single photo, the stack pulled across it, a closing card (photos used, landmarks matched, sharp area against your best photo, time) and a slow drift onto the most detailed spot. The reveal plays when the stack finishes (about 7 s, saved first; tap to skip). Each scene has its title and equation in the picture; **What's this?** under it explains it.

- **Paced to your stack:** each scene gets a share of the time the stack still needs, so a short stack shows every scene briskly (leaving out the close-ups: the loupe, fingerprints, voting rounds, the flicker) and a long one lingers on all of it.
- **Your photos move as one set** between scenes: filmstrip, focus line, the deck that collapses onto the reference, the legend of the vote.
- **Tap** the picture to hold a scene (the stack carries on), **swipe right** to look back at an earlier one, left to come forward again, and tap a photo in the focus scene's filmstrip to look at it. With the phone's reduce-motion setting it cuts and fades instead of gliding.
- **Hide the maths** puts the old progress screen back (remembered).
- **Replay the maths** (on the result) plays the whole film again at its full length, close-ups and all, from the previews kept since the stack, ending on the reveal.
- **Save the maths as a video** records that replay from the picture itself (MP4 where the browser can make it, as Chrome on Android can; otherwise WebM), about a minute and a half, 4:5, and saves it to Downloads, with **Share the video…** where the phone offers it.

The previews are small and read-only: the stack is identical with them on or off. On the 2-core test machine, with software drawing, the view costs about 3–7% of the stack's time (it draws at 30 frames a second only while something moves, 12 otherwise; between frames it asks the browser for nothing, and while the picture is scrolled out of sight it keeps time without drawing).

### Clear temporary memory
At the foot of the start and result screens. Hands back everything a stack leaves behind: the stacking engine and its helpers (their memory only grows while they run, so they're closed and started afresh), any scratch file left by a stack that was cut off, photos still waiting from the share sheet, the picture on screen and the maths view's previews, and the record of stacks cut short (so it's back to all cores). A version on screen that isn't saved yet (say, after changing the sharpening) is saved first. Kept: your settings and the app itself, so it still works offline. The page then starts afresh and says what was cleared.

### Switching apps while it stacks (experimental)
Android closes a browser page that's been off screen for a while. Two things may keep a stack going:
- **Keep stacking if I switch apps**: plays a near-silent hum (brown noise 56 dB below full scale, which Chrome counts as sound and a phone speaker barely plays) and shows the stack's progress, with the maths view as its picture, in a media notification. Chrome doesn't freeze a page that is playing sound. Also on the stacking screen as **Keep going if I switch apps**, for stacks started from the share sheet.
- **Pop out**: the maths view in a picture-in-picture window over other apps.

Whether either survives a big stack on your phone is not known yet: `lab.html` (open `/lab.html` on the app's address) tests it. It loads the phone like a big stack (busy cores, gigabytes held), records a heartbeat every second in storage that survives the page being killed, and after you come back from another app shows whether the work kept going, paused or was killed, with a **Copy results** button.

### Stacking on a computer instead
`node tools/serve.js` (after `cd tools && npm install`) runs the same engine on a computer, on several cores, and serves a page: open `http://<computer>:8790` on the phone (same Wi-Fi), pick a burst, send it, and leave; the page shows the progress and the result (sharpened, 4:4:4 JPEG with the reference photo's EXIF). From outside the house, put the computer on Tailscale and use its `https://<name>.ts.net` address (`tailscale serve 8790`).

## How it works (`engine.js`)
1. The photos are put in focus order. The first guess at the reference is the photo that is sharpest in the centre of the frame (the plan, step 3, may choose another). The black clamp edge of a clip-on lens is masked out. The clamp is fixed to the phone, so it is the same in every photo and its inner edge is the rim of the lens: near-black regions at the frame edge count as the clamp only if the ones present in (almost) every photo are matched by the outside of one circle or frame-shaped ellipse, with lit scene just inside the rim and the rim out near the frame edge. A black night background or a dark subject crossing the frame edge follows the subject's outline instead, and is kept.
2. Each photo is lined up with the reference (AKAZE features, found once per photo, a homography, and ECC fine-tuning, run at half the working size first and finished at the working size; the fine-tune must still agree with the matched features, and when a repeating pattern such as an insect screen is in view it is skipped, since there it locks onto the wrong cells and shears the background). A photo framed far from the rest (turned, zoomed, shot from a step to the side) gives few matches that fit one exact plane; for it the engine first finds the rough turn-shift-zoom, which tolerates parallax, lines up the overall shapes on blurred copies, then fine-tunes as usual. Photos don't need to be framed alike: each counts only where it has pixels of its own, and fades out over a short band at its edge, so a photo that covers half the view still contributes that half.
   *Wet or shiny subject* (`opts.tame`): next, each photo's glare is found (near-white, brighter than the surface around it) and each photo is relit to the reference's lighting with a smooth gain measured away from glare. Features are matched on contrast-evened greys. The movement checks below look past glare spots, a photo counts only where its shapes match the reference's (local correlation, so brightness doesn't matter), and glare a photo has where another photo shows the surface counts against that photo in the merge. A photo whose features line up well is kept even when the fine-tune disagrees with them, and the subject-moved bar is 0.5 instead of 0.65.
3. **Local correction, pixel by pixel.** Dense optical flow corrects parallax and small body shifts. It is worked out both ways (reference → photo and back); where following it there and back doesn't land where it started (an occlusion), or where it ripples from place to place instead of changing gently (locked onto different cells of a repeating mesh), that spot keeps the plain line-up. Each photo gets a trust map: the two-way check passed there, or the plain line-up already agreed.
3a. **The plan: which photos to use, decided before the heavy work.** As soon as every photo is lined up, a small sharpness map of each one (measured at up to 1600 px, kept at 640 px, already lined up) is compared with every other. This shows which photos agree with which. A spider that shifted between two bursts, or a second burst framed afresh, falls into its own group.
    - **The reference** is the photo whose group keeps the most sharp detail. The sharpest centre only decides between near-equals (within 3%), so in an ordinary burst nothing changes. Before this, a reference taken from the larger burst threw away the other burst, which could be the only photos sharp somewhere (a spider's palps).
    - **The photos used** are then taken in best first, and only while each adds sharp detail the ones already chosen lack (at least 0.5% of the subject; a spot counts as covered once a chosen photo has 4/5 of the best sharpness there). Photos clearly at odds with the reference go too. So 25 photos of a still subject come down to the 8–10 that carry it. A photo that is nearly as sharp everywhere as one already chosen adds nothing but its own slight misfit and noise. On synthetic bursts with a known right answer, the selected set beats the full set: 25 photos +0.8 dB, 16 photos +0.6 dB.
    - Photos left out here are dropped at once: no full-size warp, local correction or maps, and their parked copies are freed. Big stacks finish sooner and need less scratch space.
4. **Photo selection.** A photo is left out if it can't be lined up, if it matched far worse than the others and couldn't be fine-tuned, if it is a near-duplicate (same picture, same framing *and* sharp in the same places; the higher-resolution copy is kept), if the subject moved in it, or if it adds no sharp detail the others lack. Movement is judged where the photos are sharp (the subject) and only where the photo has pixels, not over the whole frame, so a small subject that walked off is caught even when the background lines up perfectly. Capture times (EXIF, else the camera's file name) split the photos into moments: a photo taken more than 2 s apart from the rest (say, a refocused shot a few seconds later) becomes the reference only if its group keeps clearly more detail (3a); otherwise it is judged like any other photo, by whether it matches, not by when it was taken: its matching parts are used, and any part that moved is left out spot by spot. The app lists which photos were left out and why.
5. **Per-region merging.** Each pixel comes from whichever photos are sharpest there, weighted by where each photo has pixels, agrees with the reference and can be trusted. So a photo with a sharp head and a blurry body contributes only its head. Coarse levels are blended by sharpness weights. Fine detail is merged from every photo that is nearly as sharp as the best one at that spot (at least 55%), as far as its detail agrees with the best photo's: near-equals average out each other's noise, while a photo whose detail differs (a slightly different line-up, a moved leg) is left out of that spot.
6. The image is cropped to the area that at least one used photo saw (not just the area every photo saw), keeping roughly the photo's own shape. The app sharpens it at the slider's amount (`sharpen.js`).

### Memory and stack size
With **Full detail** ticked (the default) the app stacks at the photos' own size, so a 12 MP burst comes out at about 12 MP. OpenCV.js keeps its work in one WebAssembly heap with a hard ceiling, however much memory the phone has, so the engine keeps that heap small:
- The photos stay as files until the engine reaches each one; they are decoded in the background thread one at a time.
- Lining up works on 8-bit copies at most 1,600 px across. The big per-photo images (each lined-up photo, its grey copy, its coverage mask, its trust and weight maps) are parked outside the heap, in a scratch file in the app's private storage on the phone (OPFS), and read back only while being worked on. If that storage isn't available or fills up, they are kept in memory instead.
- Steps that need a whole photo at full size work a band of rows at a time where they can: the warp, the grey copies, the local correction (the flow stays at its ~1,100 px working size and its full-size values are made band by band; a photo is resampled only if the correction moves it). Each band comes out exactly as the whole frame would. Ghost maps are worked out at half size.
- The merge works a strip of rows at a time, each with 256 rows of context above and below, cross-faded into the next; thresholds that must match across the frame are measured on the whole frame first. A strip comes out the same as the whole-frame merge to within 1/255.
- Greys are 8-bit, the clamp mask is shared by all photos, and pyramid bands are built in place.

Before starting, the engine estimates its peak memory from the number of photos and their size (`planSize` in `engine.js`, from measured peaks per stage), picks the strip height, and picks the largest working size that fits; if it had to shrink the stack, the result card says so. Running out of memory anyway still retries by itself at a smaller size. `node tools/memprobe.js` measures the heap per stage (see its header).

**Several cores at once.** The engine's worker starts up to four helper workers, each with its own OpenCV, and hands them the heavy steps that don't depend on each other: warping each photo, each photo's local correction, the merge's per-photo measurements and its strips. They read and write the parked images in the same scratch file (each with its own handle on it), and their results are the same as working through the steps one by one. How many run at once, and how tall the merge strips are, comes from the same memory plan (helpers share a budget). If the scratch file can't be shared, or a stack runs out of memory on several cores, it runs on one. If a stack runs out of memory, it tries again on half as many helpers, then on one core. If a stack is cut short (the phone closed the app mid-stack), the next ones use two helpers, then one core; ten good stacks in a row step back up. Memory for the whole tab with four helpers (headless Chrome 153, 12 MP photos): 16 photos 2.7 GB, 24 photos 2.85 GB. A local correction is written straight over the photo's parked copies by the helper that made it, and nothing keeps a parked image's working copy alive afterwards (until Nov 2026 every corrected photo's 57 MB copy stayed in the engine's worker to the end of the stack: 3.5 and 4.0 GB). In a private (incognito) window Chrome keeps the scratch file in memory, ignores sizing it in advance, and shows helpers only what was in it when they opened it, so the file's length is made by writing its last byte. `?helpers=N` in the address sets the number of helpers, for testing (0 = one core).

**OpenCV.js build.** The app loads `vendor/opencv-4.10.0-simd.js`, built for it by `.github/workflows/opencv-js.yml`: WebAssembly SIMD (blurs and pyramids 2-3x faster; a 20-photo stack took 30% less time) and a 4 GiB memory ceiling. A browser without SIMD gets `vendor/opencv-4.10.0-2g.js`, the stock build with its ceiling raised from 1 GiB to 2 GiB by `tools/patch_cv.py`.

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
- `--a` / `--b` take a file, `git:<ref>`, or `py:desktop/stacker.py` (the laptop version). Add `+option` to switch an engine option on, e.g. `--a engine.js --b engine.js+tame`. `--size 1600` runs faster; `--fresh` ignores the cache.

The synthetic scenes (`tests/make_synthetic.py`): `bark` (handheld lean-in with parallax), `legs` (legs running steeply through depth, portrait EXIF orientation), `still` (no camera movement, so the truth lines up exactly), `moved` (the abdomen moves in the last two photos), `drift` (photos framed far apart, so no area is covered by every photo), `dense` (16 photos with fine focus steps at a phone's noise level in shade, for multi-photo detail merging), `night` (flash at night: black background all round, which must not be taken for the lens clamp), `mesh` (spider on an insect screen: repeating texture behind a subject with parallax), `dup` (bark plus an edited lower-resolution copy of one photo), `dense25` (25 handheld photos with fine focus steps: what the plan's selection is for), `twoburst` (two bursts of one spider: the first sweeps the whole depth, then the spider shifts, the phone is turned about 5° and a second burst, 6 s later, sweeps only the far half).

`node tools/where.js engine.js <burst> <out>` stacks one burst and writes `where.png`: each used photo, lined up, lit where the stack took detail from it, with its share of the stack.

`tests/app_check.py` drives the real app in headless Chromium at phone size (stack, EXIF, save).

## Laptop version (`desktop/`)
`stacker.py` and `stack.bat` (Windows): drag a burst folder onto `stack.bat`. It works like the app: the clamp mask, coverage, the two-way flow check and multi-photo detail merging, and it leaves out photos whose subject moved (`--keep-all` uses every photo). It saves `<folder>_stacked.png` and a quality-95 `<folder>_stacked.jpg`, both with the reference photo's EXIF (date, GPS, camera) and colour profile. `--jpeg-quality 0` skips the JPEG; `--no-exif` leaves the metadata out.

## Files
- `index.html`: the app screen
- `engine.js`: the stacking engine
- `worker.js`: runs the engine in a background thread, with `helper.js` workers alongside it (`cvload.js` loads OpenCV into each)
- `exif.js`: copies the EXIF into the saved JPEG
- `sharpen.js`: the final sharpening (page and `finish.js`)
- `finish.js`: makes the saved JPEG off the main thread: sharpening, then `vendor/jpeg-encoder.js` (full colour detail; from jpeg-js, BSD-3-Clause)
- `sw.js`: service worker (receives shared photos, works offline)
- `manifest.webmanifest`: install and share-menu settings
- `vendor/opencv-4.10.0-simd.js`: OpenCV.js 4.10.0 (Apache 2.0) built with SIMD and a 4 GiB memory ceiling by `.github/workflows/opencv-js.yml`
- `vendor/opencv-4.10.0-2g.js`: OpenCV.js 4.10.0 (from `@techstark/opencv-js`, Apache 2.0), with its memory ceiling raised from 1 GiB to 2 GiB by `tools/patch_cv.py`; for browsers without SIMD
- `tools/`: the engine compare tool and the memory probe
- `tests/`: synthetic bursts and app checks
- `desktop/`: the laptop version
