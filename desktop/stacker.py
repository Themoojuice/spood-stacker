#!/usr/bin/env python3
"""
Salticid stacker: handheld lean-in focus stacking for phone macro bursts.

Pipeline
  1. load + vignette mask (the dark clamp/lens-barrel edge)
  2. order frames by focus similarity (no reliance on filenames/EXIF)
  3. global alignment: SIFT + RANSAC homography to a mid-stack reference,
     refined with ECC (enhanced correlation coefficient)
  4. local alignment: dense optical flow on defocus-equalised images,
     chained through focus-neighbours, smoothed so it only corrects
     parallax / body shifts, never invents hair-scale motion
  5. ghost mask: down-weight a frame wherever it still disagrees with
     the reference at low frequency (spider moved, flow failed)
  5b. photo selection: leave out a photo whose subject moved (judged where
     the photos are sharp, not over the whole frame), more strictly for a
     photo taken more than 2 s apart from the rest (another burst)
  6. fusion: 'pmax' (pyramid max), 'dmap' (depth map), 'wpyr'
     (weighted pyramid), 'hybrid' (weighted pyramid at coarse levels,
     max-selection at fine levels where the stack is confidently textured)
  7. crop to area valid in all frames, mild finishing
  8. save PNG + high-quality JPEG, both carrying the reference photo's
     EXIF (date, GPS, camera) and colour profile
"""
import argparse, calendar, glob, os, re, struct, time, zlib
import cv2
import numpy as np

cv2.setNumThreads(os.cpu_count() or 2)


# ---------- helpers ----------
def to_gray(img):
    return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


def focus_measure(gray, sigma=4.0):
    """Local Laplacian energy - the per-pixel sharpness score."""
    lap = cv2.Laplacian(cv2.GaussianBlur(gray, (0, 0), 0.8), cv2.CV_32F, ksize=3)
    return cv2.GaussianBlur(lap * lap, (0, 0), sigma)


def guided_filter(I, p, r, eps):
    """Plain grey-guide guided filter (He et al.)."""
    k = (2 * r + 1, 2 * r + 1)
    mI = cv2.boxFilter(I, -1, k)
    mp = cv2.boxFilter(p, -1, k)
    cIp = cv2.boxFilter(I * p, -1, k) - mI * mp
    vI = cv2.boxFilter(I * I, -1, k) - mI * mI
    a = cIp / (vI + eps)
    b = mp - a * mI
    return cv2.boxFilter(a, -1, k) * I + cv2.boxFilter(b, -1, k)


def valid_mask(gray, thresh=0.12):
    """Exclude the black vignette from the lens clamp: dark regions that
    touch the frame edge. Dark subject matter in the middle is kept."""
    dark = (cv2.GaussianBlur(gray, (0, 0), 15) <= thresh).astype(np.uint8)
    n, lab = cv2.connectedComponents(dark)
    edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))) - {0}
    vign = np.isin(lab, list(edge)) if edge else np.zeros_like(dark, bool)
    m = (~vign).astype(np.uint8)
    m = cv2.erode(m, np.ones((31, 31), np.uint8))
    return m


# ---------- 1. load ----------
def load(paths, max_side=None):
    imgs = []
    for p in paths:
        im = cv2.imread(p, cv2.IMREAD_COLOR)
        if im is None:
            raise SystemExit(f"cannot read {p}")
        if max_side and max(im.shape[:2]) > max_side:
            s = max_side / max(im.shape[:2])
            im = cv2.resize(im, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        imgs.append(im.astype(np.float32) / 255.0)
    # mixed resolutions (e.g. an edited copy): bring everything to the largest size;
    # alignment then corrects any crop/scale difference
    H = max(i.shape[0] for i in imgs); W = max(i.shape[1] for i in imgs)
    for k, im in enumerate(imgs):
        if im.shape[:2] != (H, W):
            print(f"note: frame {k + 1} is {im.shape[1]}x{im.shape[0]}, resized to {W}x{H}")
            imgs[k] = cv2.resize(im, (W, H), interpolation=cv2.INTER_CUBIC)
    return imgs


# ---------- 2. order ----------
def order_frames(grays):
    """Spectral ordering of frames by similarity of their focus maps.
    Neighbours in focus depth have similar sharpness maps."""
    n = len(grays)
    if n < 3:
        return list(range(n))
    V = []
    for g in grays:
        f = focus_measure(cv2.resize(g, (512, 384), interpolation=cv2.INTER_AREA), sigma=6)
        v = np.log(f.ravel() + 1e-7)
        V.append((v - v.mean()) / v.std())
    V = np.array(V)
    C = np.clip(V @ V.T / V.shape[1], 0, 1)
    L = np.diag(C.sum(1)) - C
    w, vecs = np.linalg.eigh(L)
    return [int(i) for i in np.argsort(vecs[:, 1])]


# ---------- 3. global alignment ----------
def homography(src_g, dst_g, mask_src, mask_dst):
    """H mapping src -> dst coordinates."""
    sift = cv2.SIFT_create(nfeatures=6000, contrastThreshold=0.01)
    u8 = lambda g: (np.clip(g, 0, 1) * 255).astype(np.uint8)
    k1, d1 = sift.detectAndCompute(u8(src_g), mask_src)
    k2, d2 = sift.detectAndCompute(u8(dst_g), mask_dst)
    if d1 is None or d2 is None or len(k1) < 20 or len(k2) < 20:
        return np.eye(3, dtype=np.float32), 0
    m = cv2.BFMatcher(cv2.NORM_L2).knnMatch(d1, d2, k=2)
    good = [a for a, b in (x for x in m if len(x) == 2) if a.distance < 0.75 * b.distance]
    if len(good) < 20:
        return np.eye(3, dtype=np.float32), len(good)
    p1 = np.float32([k1[g.queryIdx].pt for g in good])
    p2 = np.float32([k2[g.trainIdx].pt for g in good])
    H, inl = cv2.findHomography(p1, p2, cv2.USAC_MAGSAC, 3.0, maxIters=5000, confidence=0.999)
    if H is None:
        return np.eye(3, dtype=np.float32), 0
    return H.astype(np.float32), int(inl.sum())


def ecc_refine(src_g, dst_g, H, mask, scale=0.5):
    """Refine H with ECC on gradient magnitude (focus-insensitive-ish)."""
    def grad(g):
        g = cv2.GaussianBlur(g, (0, 0), 2.0)
        gx = cv2.Sobel(g, cv2.CV_32F, 1, 0); gy = cv2.Sobel(g, cv2.CV_32F, 0, 1)
        return cv2.GaussianBlur(np.sqrt(gx * gx + gy * gy), (0, 0), 2.0)
    s = cv2.resize(grad(src_g), None, fx=scale, fy=scale)
    d = cv2.resize(grad(dst_g), None, fx=scale, fy=scale)
    m = cv2.resize(mask, (d.shape[1], d.shape[0]), interpolation=cv2.INTER_NEAREST)
    S = np.diag([scale, scale, 1]).astype(np.float32)
    # ECC wants warp from template(dst) coords to input(src) coords
    W = (S @ np.linalg.inv(H) @ np.linalg.inv(S)).astype(np.float32)
    try:
        _, W = cv2.findTransformECC(d, s, W, cv2.MOTION_HOMOGRAPHY,
                                    (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6), m, 5)
        return (np.linalg.inv(np.linalg.inv(S) @ W @ S)).astype(np.float32), True
    except cv2.error:
        return H, False


# ---------- 4. local alignment ----------
def dense_flow(ref_g, mov_g, mask=None, blur=2.5, smooth=4.0, max_px=None):
    """Flow field: for each ref pixel, where to sample in mov.
    Both images blurred to equalise defocus; flow smoothed with
    normalised convolution inside the valid mask, then clamped."""
    a = (np.clip(cv2.GaussianBlur(ref_g, (0, 0), blur), 0, 1) * 255).astype(np.uint8)
    b = (np.clip(cv2.GaussianBlur(mov_g, (0, 0), blur), 0, 1) * 255).astype(np.uint8)
    dis = cv2.DISOpticalFlow_create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    dis.setFinestScale(1)
    flow = dis.calc(a, b, None)
    m = np.ones(ref_g.shape, np.float32) if mask is None else mask.astype(np.float32)
    # confidence: low where the blurred images still disagree after warping (occlusion / failure)
    warped_b = remap(b.astype(np.float32), flow)
    conf = np.exp(-np.abs(warped_b - a.astype(np.float32)) / 12.0) * m
    den = cv2.GaussianBlur(conf, (0, 0), smooth) + 1e-4
    for c in range(2):
        flow[..., c] = cv2.GaussianBlur(flow[..., c] * conf, (0, 0), smooth) / den
    if max_px is None:
        max_px = 0.04 * max(ref_g.shape)          # parallax/body shift, not teleportation
    mag = np.sqrt((flow ** 2).sum(-1, keepdims=True))
    flow *= np.minimum(1.0, max_px / (mag + 1e-6))
    return flow


def remap(img, flow):
    h, w = flow.shape[:2]
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    return cv2.remap(img, gx + flow[..., 0], gy + flow[..., 1], cv2.INTER_LANCZOS4,
                     borderMode=cv2.BORDER_REFLECT)


def gate_flow(flow, ref_g, mov_g, gain=FLOW_GATE_GAIN if 'FLOW_GATE_GAIN' in globals() else 3.0):
    """Keep the local warp only where it measurably improves agreement with
    the target. On repetitive or featureless texture (mesh, smooth blur)
    optical flow aliases and paints squiggles; there the global warp wins."""
    b = lambda g: cv2.GaussianBlur(g, (0, 0), 3)
    r = b(ref_g)
    e_glob = cv2.GaussianBlur(np.abs(b(mov_g) - r), (0, 0), 15)
    e_flow = cv2.GaussianBlur(np.abs(b(remap(mov_g, flow)) - r), (0, 0), 15)
    # absolute floor: in flat areas both errors are tiny and the ratio is noise
    alpha = np.clip((e_glob - e_flow - 0.002) / (e_glob + 0.01) * gain, 0, 1)
    alpha = cv2.GaussianBlur(alpha, (0, 0), 15)[..., None]
    return flow * alpha


# ---------- full alignment ----------
def align(imgs, local='chain', ref=None, log=print, avoid=()):
    n = len(imgs)
    grays = [to_gray(i) for i in imgs]
    masks = [valid_mask(g) for g in grays]
    order = order_frames(grays)
    if ref is None:
        # reference = frame sharpest in the centre of the frame (where the
        # subject's face usually is). The master inherits this frame's
        # geometry, so if the subject moved, its sharpest view wins.
        h0, w0 = grays[0].shape
        cy, cx = slice(int(h0 * .3), int(h0 * .7)), slice(int(w0 * .3), int(w0 * .7))
        score = [focus_measure(g[cy, cx]).mean() for g in grays]
        ref = int(np.argmax([-1 if i in avoid else v for i, v in enumerate(score)]))
    ref_pos = order.index(ref)
    log(f"focus order: {[int(o) + 1 for o in order]}  reference: frame {int(ref) + 1}")
    h, w = grays[0].shape
    Hs = {ref: np.eye(3, dtype=np.float32)}
    # chain outward from the reference through focus-neighbours
    for direction in (-1, 1):
        prev = ref
        pos = ref_pos + direction
        while 0 <= pos < n:
            cur = order[pos]
            Hn, inl = homography(grays[cur], grays[prev], masks[cur], masks[prev])
            H = Hs[prev] @ Hn
            Hd, inl_direct = homography(grays[cur], grays[ref], masks[cur], masks[ref])
            if inl_direct > 1.5 * inl:          # direct match clearly better
                H = Hd
            H, ok = ecc_refine(grays[cur], grays[ref], H, masks[ref])
            Hs[cur] = H
            log(f"  frame {cur + 1}: inliers neighbour={inl} direct={inl_direct} ecc={'ok' if ok else 'fail'}")
            prev, pos = cur, pos + direction

    warped, wmask = [None] * n, [None] * n
    for i in range(n):
        warped[i] = cv2.warpPerspective(imgs[i], Hs[i], (w, h), flags=cv2.INTER_LANCZOS4,
                                        borderMode=cv2.BORDER_REFLECT)
        wmask[i] = cv2.warpPerspective(masks[i], Hs[i], (w, h), flags=cv2.INTER_NEAREST)

    if local in ('chain', 'direct'):
        # chain: each frame aligned to its already-aligned focus-neighbour
        # direct: each frame aligned straight to the reference
        aligned = {ref: warped[ref]}
        for direction in (-1, 1):
            prev = ref
            pos = ref_pos + direction
            while 0 <= pos < n:
                cur = order[pos]
                tgt = prev if local == 'chain' else ref
                fm_mask = (wmask[tgt] > 0) & (wmask[cur] > 0)
                flow = dense_flow(to_gray(aligned[tgt]), to_gray(warped[cur]), fm_mask)
                flow = gate_flow(flow, to_gray(aligned[tgt]), to_gray(warped[cur]))
                cand = remap(warped[cur], flow)
                # accept the local warp only if it improves whole-frame agreement;
                # on some scenes (repetitive mesh, big pose changes) flow makes it worse
                band = lambda g: cv2.GaussianBlur(g, (0, 0), 2) - cv2.GaussianBlur(g, (0, 0), 10)
                T = band(to_gray(aligned[tgt]))[fm_mask]
                ncc_g = np.corrcoef(T, band(to_gray(warped[cur]))[fm_mask])[0, 1]
                ncc_f = np.corrcoef(T, band(to_gray(cand))[fm_mask])[0, 1]
                mag = np.sqrt((flow ** 2).sum(-1))
                if ncc_f >= ncc_g + 0.01:
                    aligned[cur] = cand
                    wmask[cur] = remap(wmask[cur].astype(np.float32), flow) > 0.5
                    verdict = 'kept'
                else:
                    aligned[cur] = warped[cur]
                    verdict = 'rejected'
                log(f"  frame {cur + 1}: local flow median {np.median(mag):.1f}px, "
                    f"agreement {ncc_g:.3f} -> {ncc_f:.3f} ({verdict})")
                prev, pos = cur, pos + direction
        warped = [aligned[i] for i in range(n)]

    common = np.logical_and.reduce([m > 0 for m in wmask])
    return warped, common, order, ref, wmask


# ---------- 5. ghost weights ----------
def ghost_weights(aligned, ref, sigma=6.0, tol=0.06):
    """1 where a frame agrees with the reference at low frequency, ->0 where not."""
    R = cv2.GaussianBlur(to_gray(aligned[ref]), (0, 0), sigma)
    out = []
    for i, a in enumerate(aligned):
        d = np.abs(cv2.GaussianBlur(to_gray(a), (0, 0), sigma) - R)
        g = np.clip(1.0 - (d - tol) / tol, 0, 1)
        out.append(cv2.GaussianBlur(g, (0, 0), 4))
    return out


# ---------- 5b. photo selection ----------
MOMENT_GAP = 2.0           # s between consecutive photos that starts a new "moment"
SUBJECT_MOVED = 0.8        # subject agreement below this: moved (real bursts 0.96+)
SUBJECT_MOVED_APART = 0.95  # stricter for a photo from a different moment


def taken_time(path):
    """Capture time in s (local clock), from EXIF DateTimeOriginal (+ sub-seconds),
    else a camera file name like IMG_20260828_155557_3.jpg; None if neither."""
    tiff, _ = read_meta(path)
    if tiff and len(tiff) >= 8 and tiff[:2] in (b'II', b'MM'):
        e = '<' if tiff[:2] == b'II' else '>'
        u16 = lambda o: struct.unpack(e + 'H', tiff[o:o + 2])[0]
        u32 = lambda o: struct.unpack(e + 'I', tiff[o:o + 4])[0]
        found = {}
        def ifd(off, name, seen):
            if not off or off + 2 > len(tiff) or off in seen:
                return
            seen.add(off)
            n = u16(off)
            for i in range(n):
                p = off + 2 + i * 12
                if p + 12 > len(tiff):
                    return
                tag, typ, cnt = u16(p), u16(p + 2), u32(p + 4)
                if typ == 2 and (name, tag) in (('exif', 0x9003), ('ifd0', 0x0132), ('exif', 0x9291)):
                    o = p + 8 if cnt <= 4 else u32(p + 8)
                    found[tag] = tiff[o:o + cnt].split(b'\0')[0].decode('ascii', 'ignore').strip()
                if tag == 0x8769:
                    ifd(u32(p + 8), 'exif', seen)
        try:
            ifd(u32(4), 'ifd0', set())
        except struct.error:
            pass
        d = found.get(0x9003) or found.get(0x0132)
        m = d and re.match(r'(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)', d)
        if m:
            sub = found.get(0x9291, '')
            return calendar.timegm(tuple(int(x) for x in m.groups())) + (float('0.' + sub) if sub.isdigit() else 0)
    m = re.search(r'(?:^|\D)(20\d\d)(\d\d)(\d\d)[_-](\d\d)(\d\d)(\d\d)(\d{3})?(?!\d)', os.path.basename(path))
    if m:
        g = [int(x) for x in m.groups()[:6]]
        return calendar.timegm(tuple(g)) + (int(m.group(7)) / 1000 if m.group(7) else 0)
    return None


def moments(times):
    """Signed gap (s) from each photo to the main moment (the largest group of
    photos no more than MOMENT_GAP apart); 0 for photos in it or without a time."""
    apart = [0.0] * len(times)
    timed = sorted((t, i) for i, t in enumerate(times) if t is not None)
    if len(timed) < 2:
        return apart
    groups = [[timed[0]]]
    for a, b in zip(timed, timed[1:]):
        if b[0] - a[0] > MOMENT_GAP:
            groups.append([])
        groups[-1].append(b)
    main = max(groups, key=len)                  # ties go to the earlier group
    t0, t1 = main[0][0], main[-1][0]
    for g in groups:
        if g is not main:
            for t, i in g:
                apart[i] = t - t1 if t > t1 else t - t0
    return apart


def gap_text(s):
    d = f"{round(abs(s) / 60)} min" if abs(s) >= 120 else f"{max(1, round(abs(s)))} s"
    return f"{d} {'after' if s > 0 else 'before'}"


def subject_agreement(ref_img, cur_img, ghost):
    """How well a photo agrees with the reference where either is sharp (0..1).
    The frame-wide mean is dominated by background, so a small subject that
    walked off barely moves it; this weights by sharpness."""
    h, w = ghost.shape
    sz = ((w + 1) // 2, (h + 1) // 2)
    half = lambda im: focus_measure(cv2.resize(to_gray(im), sz, interpolation=cv2.INTER_AREA), 3)
    mx = np.maximum(half(ref_img), half(cur_img))
    g = cv2.resize(ghost, sz, interpolation=cv2.INTER_AREA)
    top = np.percentile(mx[::5, ::5], 99) or 1e-9
    wgt = np.minimum(1, mx / top)
    wgt[wgt < 0.1] = 0
    return float((wgt * g).sum() / wgt.sum()) if wgt.sum() > 0 else 1.0


def select_photos(aligned, ghosts, ref, apart, log=print):
    """Indices of the photos to keep (the reference always stays)."""
    keep = []
    for i in range(len(aligned)):
        if i == ref:
            keep.append(i); continue
        sm = subject_agreement(aligned[ref], aligned[i], ghosts[i])
        gap = apart[i]
        if sm < SUBJECT_MOVED:
            log(f"frame {i + 1} left out: " + (f"taken {gap_text(gap)} the others, and the subject had moved" if gap
                                              else "the subject moved between photos") + f" (agreement {sm:.2f})")
        elif gap and sm < SUBJECT_MOVED_APART:
            log(f"frame {i + 1} left out: taken {gap_text(gap)} the others, and the subject had moved a little (agreement {sm:.2f})")
        else:
            if gap:
                log(f"frame {i + 1}: taken {gap_text(gap)} the others but lines up well, kept")
            keep.append(i)
    return keep


# ---------- 6. fusion ----------
def lap_pyr(img, levels):
    gp = [img]
    for _ in range(levels):
        gp.append(cv2.pyrDown(gp[-1]))
    lp = [gp[i] - cv2.pyrUp(gp[i + 1], dstsize=(gp[i].shape[1], gp[i].shape[0])) for i in range(levels)]
    return lp + [gp[-1]]


def gauss_pyr(img, levels):
    gp = [img]
    for _ in range(levels):
        gp.append(cv2.pyrDown(gp[-1]))
    return gp


def collapse(lp):
    img = lp[-1]
    for l in reversed(lp[:-1]):
        img = cv2.pyrUp(img, dstsize=(l.shape[1], l.shape[0])) + l
    return img


def soft_weights(aligned, ghosts, power=4.0, sigma=4.0, refine=True):
    F = np.stack([focus_measure(to_gray(a), sigma) for a in aligned])
    F = F / (F.max(0, keepdims=True) + 1e-9)          # relative sharpness
    W = (F ** power) * np.stack(ghosts) + 1e-6
    W /= W.sum(0, keepdims=True)
    if refine:
        guide = to_gray(np.mean(aligned, 0))
        W = np.stack([guided_filter(guide, w, 8, 1e-4) for w in W])
        W = np.clip(W, 0, None) + 1e-6
        W /= W.sum(0, keepdims=True)
    return W, F


def fuse_dmap(aligned, ghosts):
    W, _ = soft_weights(aligned, ghosts, power=8.0)
    return np.einsum('nhw,nhwc->hwc', W, np.stack(aligned)), W


def fuse_wpyr(aligned, ghosts, levels=6):
    W, _ = soft_weights(aligned, ghosts, power=4.0)
    acc = None
    for a, w in zip(aligned, W):
        lp = lap_pyr(a, levels); gp = gauss_pyr(w, levels)
        c = [l * g[..., None] for l, g in zip(lp, gp)]
        acc = c if acc is None else [x + y for x, y in zip(acc, c)]
    return collapse(acc), W


def fuse_pmax(aligned, ghosts, levels=6):
    lps = [lap_pyr(a, levels) for a in aligned]
    gh = [gauss_pyr(g, levels) for g in ghosts]
    out = []
    for L in range(levels + 1):
        stack = np.stack([lp[L] for lp in lps])              # n,h,w,c
        if L == levels:                                      # base: average
            out.append(stack.mean(0)); continue
        e = np.abs(stack).sum(-1)
        e = np.stack([cv2.GaussianBlur(x, (0, 0), 1.0) for x in e]) * np.stack([g[L] for g in gh])
        k = e.argmax(0)
        out.append(np.take_along_axis(stack, k[None, ..., None], 0)[0])
    return collapse(out), None


def fuse_hybrid(aligned, ghosts, levels=6, fine_levels=3, sel_sigma=None):
    """Weighted pyramid everywhere; at the finest levels, switch to
    max-selection where the stack has strong, confident texture (setae)."""
    W, F = soft_weights(aligned, ghosts, power=4.0)
    lps = [lap_pyr(a, levels) for a in aligned]
    gws = [gauss_pyr(w, levels) for w in W]
    gh = [gauss_pyr(g, levels) for g in ghosts]
    # texture mask: high max focus relative to local median focus -> hairy
    Fm = np.stack([focus_measure(to_gray(a), 2.0) for a in aligned])
    tex = Fm.max(0)
    tex = tex / (cv2.GaussianBlur(tex, (0, 0), 25) + 1e-6)
    t0, t1 = TEX
    tex_mask = np.clip((tex - t0) / t1, 0, 1)
    # gate by absolute sharpness: where no frame is sharp (never-focused
    # background) max-selection only stitches blur-disc edges into contour
    # artefacts, so fall back to the smooth weighted blend there
    fa = Fm.max(0)
    lo, hi = np.percentile(fa, 35), np.percentile(fa, 65)
    gate = np.clip((fa - lo) / (hi - lo + 1e-9), 0, 1)
    tex_mask = cv2.GaussianBlur((tex_mask * gate).astype(np.float32), (0, 0), 3)
    tp = gauss_pyr(tex_mask.astype(np.float32), levels)
    out = []
    for L in range(levels + 1):
        stack = np.stack([lp[L] for lp in lps])
        wts = np.stack([g[L] for g in gws])
        blend = np.einsum('nhw,nhwc->hwc', wts, stack)
        if L < fine_levels:
            e = np.abs(stack).sum(-1)
            e = np.stack([cv2.GaussianBlur(x, (0, 0), SEL_SIGMA if sel_sigma is None else sel_sigma) for x in e]) * np.stack([g[L] for g in gh])
            k = e.argmax(0)
            mx = np.take_along_axis(stack, k[None, ..., None], 0)[0]
            a = tp[L][..., None]
            blend = a * mx + (1 - a) * blend
        out.append(blend)
    return collapse(out), W


SEL_SIGMA = 1.0     # smoothing of the per-pixel 'which frame is sharpest' choice at fine levels
TEX = (0.0, 0.5)   # texture-mask threshold/softness for hybrid max-selection
METHODS = {'dmap': fuse_dmap, 'wpyr': fuse_wpyr, 'pmax': fuse_pmax, 'hybrid': fuse_hybrid}


# ---------- 7. finishing ----------
def crop_valid(img, common, f=4):
    """Largest axis-aligned rectangle containing only pixels valid in every
    frame (maximal-rectangle-in-histogram on a 1/f-scale mask)."""
    m = common.astype(np.uint8)
    h, w = m.shape
    # a coarse cell counts as valid only if all its pixels are valid
    small = cv2.erode(m, np.ones((f, f), np.uint8))[::f, ::f]
    H, W = small.shape
    heights = np.zeros(W, int)
    best = (0, 0, 0, 0, 0)                     # area, x0, y0, x1, y1 in coarse units
    for r in range(H):
        heights = np.where(small[r] > 0, heights + 1, 0)
        stack = []
        for c in range(W + 1):
            cur = heights[c] if c < W else 0
            start = c
            while stack and stack[-1][1] >= cur:
                st, ht = stack.pop()
                area = ht * (c - st)
                if area > best[0]:
                    best = (area, st, r - ht + 1, c - 1, r)
                start = st
            stack.append((start, cur))
    if best[0] == 0:
        return img, (0, 0, w - 1, h - 1)
    _, x0, y0, x1, y1 = best
    x0, y0 = x0 * f + f, y0 * f + f                       # 1-cell safety margin
    x1, y1 = min(w - 1, (x1 + 1) * f - 1 - f), min(h - 1, (y1 + 1) * f - 1 - f)
    return img[y0:y1 + 1, x0:x1 + 1], (x0, y0, x1, y1)


def finish(img, sharpen=0.35):
    """Gentle unsharp mask + clip. Kept mild: stacking already boosts contrast."""
    if sharpen > 0:
        b = cv2.GaussianBlur(img, (0, 0), 1.2)
        img = img + sharpen * (img - b)
    return np.clip(img, 0, 1)


def depth_map(W, order):
    """Pseudo-depth: weighted focus rank (near = warm, far = cool)."""
    n = W.shape[0]
    rank = np.empty(n); rank[np.asarray(order)] = np.arange(n)
    d = 1.0 - (W * rank[:, None, None]).sum(0) / max(n - 1, 1)
    return cv2.applyColorMap((d * 255).astype(np.uint8), cv2.COLORMAP_TURBO)


# ---------- 8. metadata (EXIF + colour profile) ----------
# cv2.imwrite drops all metadata. iNaturalist reads the date and location from
# EXIF, so the reference photo's EXIF is copied into the outputs. The block is
# copied byte for byte and patched in place: Orientation -> 1 (cv2.imread already
# turned the pixels upright), pixel dimensions -> the stack's size, and the
# embedded thumbnail (IFD1) is unlinked. The colour profile is copied as is:
# OpenCV never converts colour, so the pixels are still in the photo's space.
EXIF_ID = b'Exif\x00\x00'
ICC_ID = b'ICC_PROFILE\x00'


def jpeg_segments(b):
    """(marker, start, end, body) for each segment up to the start of scan."""
    if b[:2] != b'\xff\xd8':
        return None
    out, p = [], 2
    while p + 4 <= len(b):
        if b[p] != 0xFF:
            return None
        m = b[p + 1]
        if m == 0xFF:
            p += 1; continue
        if m in (0xDA, 0xD9):
            out.append((m, p, len(b), p)); break
        ln = struct.unpack('>H', b[p + 2:p + 4])[0]
        out.append((m, p, p + 2 + ln, p + 4))
        p += 2 + ln
    return out


def read_meta(path):
    """(EXIF TIFF block or None, list of raw ICC APP2 segments) of a JPEG."""
    try:
        with open(path, 'rb') as f:
            b = f.read(1 << 20)                  # metadata sits at the front
    except OSError:
        return None, []
    segs = jpeg_segments(b) or []
    exif, icc = None, []
    for m, s, e, body in segs:
        if m == 0xE1 and b[body:body + 6] == EXIF_ID and exif is None:
            exif = b[body + 6:e]
        elif m == 0xE2 and b[body:body + 12] == ICC_ID:
            icc.append(b[s:e])
    return exif, icc


def patch_exif(tiff, width, height):
    """Copy of the TIFF block with orientation, dimensions and thumbnail fixed."""
    t = bytearray(tiff)
    if len(t) < 8 or t[:2] not in (b'II', b'MM'):
        return None
    E = '<' if t[:2] == b'II' else '>'
    u16 = lambda o: struct.unpack_from(E + 'H', t, o)[0]
    u32 = lambda o: struct.unpack_from(E + 'I', t, o)[0]

    def set_int(e, typ, v):
        if typ == 3:
            struct.pack_into(E + 'H', t, e + 8, min(65535, v))
        elif typ == 4:
            struct.pack_into(E + 'I', t, e + 8, v)

    def ifd(off, name, seen):
        if not off or off + 2 > len(t) or off in seen:
            return None
        seen.add(off)
        n = u16(off)
        if off + 2 + n * 12 + 4 > len(t):
            return None
        for i in range(n):
            e = off + 2 + i * 12
            tag, typ, cnt = u16(e), u16(e + 2), u32(e + 4)
            if cnt == 1:
                if name == 'ifd0' and tag == 0x0112: set_int(e, typ, 1)          # Orientation
                if name == 'ifd0' and tag == 0x0100: set_int(e, typ, width)      # ImageWidth
                if name == 'ifd0' and tag == 0x0101: set_int(e, typ, height)     # ImageLength
                if name == 'exif' and tag == 0xA002: set_int(e, typ, width)      # PixelXDimension
                if name == 'exif' and tag == 0xA003: set_int(e, typ, height)     # PixelYDimension
            if tag == 0x8769:
                ifd(u32(e + 8), 'exif', seen)
        return off + 2 + n * 12

    nxt = ifd(u32(4), 'ifd0', set())
    if nxt is not None:
        struct.pack_into(E + 'I', t, nxt, 0)                                     # drop IFD1 (thumbnail)
    return bytes(t)


def jpeg_with_meta(jpeg, tiff, icc_segs):
    segs = jpeg_segments(jpeg)
    if not segs:
        return jpeg
    head = [b'\xff\xd8']
    if tiff and len(tiff) + 8 <= 65535:
        head.append(b'\xff\xe1' + struct.pack('>H', len(tiff) + 8) + EXIF_ID + tiff)
    head += icc_segs
    # drop what the encoder wrote (JFIF APP0, any EXIF/ICC) and keep the rest
    rest = [jpeg[s:e] for m, s, e, body in segs
            if not (m == 0xE0 or (m == 0xE1 and jpeg[body:body + 6] == EXIF_ID) or m == 0xE2)]
    return b''.join(head + rest)


def png_with_meta(png, tiff, icc_segs):
    """PNG with an eXIf chunk (EXIF) and an iCCP chunk (colour profile)."""
    chunk = lambda typ, data: struct.pack('>I', len(data)) + typ + data + struct.pack('>I', zlib.crc32(typ + data) & 0xffffffff)
    extra = b''
    if icc_segs:
        parts = sorted(icc_segs, key=lambda s: s[4 + 12])                         # by sequence number
        prof = b''.join(s[4 + 14:] for s in parts)
        extra += chunk(b'iCCP', b'ICC profile\x00\x00' + zlib.compress(prof))
    if tiff:
        extra += chunk(b'eXIf', tiff)
    ihdr_end = 8 + 8 + 13 + 4
    return png[:ihdr_end] + extra + png[ihdr_end:]


def save_outputs(path, img8, meta_src=None, jpeg_quality=95):
    """Write the PNG (and a JPEG beside it) carrying the source photo's metadata.
    Uses imencode + plain file writes, which also copes with non-ASCII paths."""
    h, w = img8.shape[:2]
    tiff, icc = read_meta(meta_src) if meta_src else (None, [])
    tiff = patch_exif(tiff, w, h) if tiff else None
    ok, png = cv2.imencode('.png', img8)
    with open(path, 'wb') as f:
        f.write(png_with_meta(png.tobytes(), tiff, icc) if (tiff or icc) else png.tobytes())
    outs = [path]
    if jpeg_quality > 0:
        jp = os.path.splitext(path)[0] + '.jpg'
        ok, jpg = cv2.imencode('.jpg', img8, [cv2.IMWRITE_JPEG_QUALITY, jpeg_quality,
                                              cv2.IMWRITE_JPEG_SAMPLING_FACTOR, cv2.IMWRITE_JPEG_SAMPLING_FACTOR_444])
        with open(jp, 'wb') as f:
            f.write(jpeg_with_meta(jpg.tobytes(), tiff, icc))
        outs.append(jp)
    return outs, tiff is not None


IMG_EXT = ('.jpg', '.jpeg', '.png', '.tif', '.tiff', '.webp')
VID_EXT = ('.mp4', '.mov', '.mkv')


def expand_inputs(inputs):
    """Folders -> their photos (skipping our own outputs); files kept as given."""
    paths = []
    for p in inputs:
        p = p.strip().strip('"').strip("'")
        if not p:
            continue
        if os.path.isdir(p):
            paths += [f for f in sorted(glob.glob(os.path.join(p, '*')))
                      if f.lower().endswith(IMG_EXT + VID_EXT)
                      and not any(t in os.path.basename(f).lower() for t in ('stacked', '_depth', '_aligned'))]
        elif os.path.isfile(p):
            paths.append(p)
        else:
            print(f"  skipped (not found): {p}")
    return paths


def default_out(inputs, paths):
    """Folder dropped -> <folder>_stacked.png beside it.
    Loose files -> a 'stacked' folder beside them, named after the first photo."""
    first = inputs[0].strip().strip('"')
    taken = lambda o: os.path.exists(o) or os.path.exists(os.path.splitext(o)[0] + '.jpg')
    if len(inputs) == 1 and os.path.isdir(first):
        base = first.rstrip('\\/') + '_stacked'
        out, k = base + '.png', 2
        while taken(out):
            out = f"{base}_{k}.png"; k += 1
        return out
    d = os.path.join(os.path.dirname(os.path.abspath(paths[0])), 'stacked')
    os.makedirs(d, exist_ok=True)
    stem = os.path.splitext(os.path.basename(paths[0]))[0]
    out = os.path.join(d, f"{stem}_stacked.png")
    k = 2
    while taken(out):                                # never overwrite an earlier stack
        out = os.path.join(d, f"{stem}_stacked_{k}.png"); k += 1
    return out


def stack_paths(inputs, a, out=None):
    paths = expand_inputs(inputs)
    vids = [p for p in paths if p.lower().endswith(VID_EXT)]
    imgs_p = [p for p in paths if p.lower().endswith(IMG_EXT)]
    if not vids and len(imgs_p) < 2:
        print("  Need at least 2 photos (or 1 video). Nothing stacked.")
        return None
    out = out or default_out(inputs, paths)
    t0 = time.time()
    print(f"  Reading {len(vids) and 'video' or str(len(imgs_p)) + ' photos'}...", flush=True)
    imgs = video_frames(vids[0], a.every) if vids else load(imgs_p, max_side=a.max_side or None)
    print(f"  {len(imgs)} frames, {imgs[0].shape[1]}x{imgs[0].shape[0]}")
    print("  Lining up photos (the slow part)...", flush=True)
    local = a.local if a.local != 'auto' else ('direct' if len(imgs) <= 15 else 'chain')
    apart = [0.0] * len(imgs) if vids else moments([taken_time(p) for p in imgs_p])
    if any(apart):
        print("   photos were taken at different moments (more than 2 s apart)", flush=True)
    aligned, common, order, ref, wmask = align(imgs, local=local, ref=(a.ref - 1) if a.ref > 0 else None,
                                               log=lambda m: print('   ' + m, flush=True),
                                               avoid={i for i, g in enumerate(apart) if g})
    gw = None if (a.no_ghost and a.keep_all) else ghost_weights(aligned, ref)
    ghosts = [np.ones(common.shape, np.float32)] * len(aligned) if a.no_ghost else gw
    meta_ref = ref
    if not a.keep_all:
        keep = select_photos(aligned, gw, ref, apart, log=lambda m: print('   ' + m, flush=True))
        if len(keep) < len(aligned):
            aligned, ghosts = [aligned[i] for i in keep], [ghosts[i] for i in keep]
            common = np.logical_and.reduce([wmask[i] > 0 for i in keep])
            order = [keep.index(o) for o in order if o in keep]
            ref = keep.index(ref)
            print(f"   using {len(keep)} of {len(imgs)} photos", flush=True)
    print(f"  Lined up in {time.time() - t0:.0f}s. Merging...", flush=True)
    base, ext = os.path.splitext(out)
    if a.save_aligned:
        for i, im in enumerate(aligned):
            cv2.imwrite(f"{base}_aligned_{i + 1}.jpg", (np.clip(im, 0, 1) * 255).astype(np.uint8))
    # metadata comes from the reference photo (its geometry is the stack's geometry)
    meta_src = None if (vids or a.no_exif) else imgs_p[meta_ref]
    methods = list(METHODS) if a.method == 'all' else [a.method]
    for m in methods:
        fused, W = METHODS[m](aligned, ghosts)
        fused, box = crop_valid(finish(fused, a.sharpen), common)
        o = out if len(methods) == 1 else f"{base}_{m}{ext}"
        if not o.lower().endswith('.png'):
            o = os.path.splitext(o)[0] + '.png'
        written, kept = save_outputs(o, (fused * 255 + 0.5).astype(np.uint8), meta_src, a.jpeg_quality)
        if W is not None and m == methods[-1] and a.depth:
            cv2.imwrite(f"{base}_depth.png", depth_map(W, order)[box[1]:box[3] + 1, box[0]:box[2] + 1])
    note = ('date/location/camera kept from ' + os.path.basename(meta_src)) if (meta_src and kept) else 'no EXIF to keep'
    print(f"  Done in {time.time() - t0:.0f}s ->  {', '.join(written)}  ({note})", flush=True)
    return written[0]


def split_dropped(line):
    """Explorer drops paths as  "C:\\a b\\x.jpg" C:\\c\\y.jpg  -> list of paths."""
    import re
    return [q or u for q, u in re.findall(r'"([^"]+)"|(\S+)', line)]


def open_file(path):
    try:
        if hasattr(os, 'startfile'):
            os.startfile(path)                      # Windows: open in the default viewer
    except OSError:
        pass


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('inputs', nargs='*', help='photos, folders, or a video file')
    ap.add_argument('-o', '--out', default=None, help='output .png (a .jpg is written beside it; default: beside the photos)')
    ap.add_argument('-m', '--method', default='hybrid', choices=list(METHODS) + ['all'])
    ap.add_argument('--local', default='auto', choices=['auto', 'chain', 'direct', 'none'],
                    help='optical-flow alignment mode')
    ap.add_argument('--no-ghost', action='store_true', help='skip moving-subject masking')
    ap.add_argument('--keep-all', action='store_true', help="use every photo, even one whose subject moved")
    ap.add_argument('--every', type=int, default=0, help='video: take every Nth frame (0=auto)')
    ap.add_argument('--sharpen', type=float, default=0.35)
    ap.add_argument('--ref', type=int, default=0, help='reference frame number (1-based); 0 = auto')
    ap.add_argument('--max-side', type=int, default=0, help='shrink photos to this many pixels on the long side (0 = full size)')
    ap.add_argument('--jpeg-quality', type=int, default=95, help='quality of the JPEG saved beside the PNG (0 = no JPEG)')
    ap.add_argument('--no-exif', action='store_true', help="don't copy the photo's date, location and camera into the output")
    ap.add_argument('--depth', action='store_true', help='also save a depth map')
    ap.add_argument('--save-aligned', action='store_true')
    ap.add_argument('--loop', action='store_true', help='keep the window open and stack each batch dropped into it')
    ap.add_argument('--open', action='store_true', help='open each result when done')
    a = ap.parse_args()

    def one(batch, out=None):
        try:
            o = stack_paths(batch, a, out)
            if o and a.open:
                open_file(o)
        except Exception as e:                       # keep the loop alive on a bad batch
            print(f"  Stacking failed: {e}")

    if a.inputs:
        one(a.inputs, a.out)
    if not a.loop:
        return
    while True:
        print("\n Drag photos (one or many) or a folder into this window, then press Enter."
              "\n (Close the window when you're finished.)")
        try:
            line = input("> ")
        except (EOFError, KeyboardInterrupt):
            break
        batch = split_dropped(line)
        if batch:
            one(batch)


def video_frames(path, every=0):
    cap = cv2.VideoCapture(path)
    frames = []
    while True:
        ok, f = cap.read()
        if not ok:
            break
        frames.append(f)
    if not frames:
        raise SystemExit(f"no frames in {path}")
    g = [cv2.cvtColor(cv2.resize(f, None, fx=0.25, fy=0.25), cv2.COLOR_BGR2GRAY).astype(np.float32) / 255 for f in frames]
    sharp = np.array([focus_measure(x, 4).mean() for x in g])
    # drop motion-blurred frames: keep those above 40th percentile of their local neighbourhood
    keep = [i for i in range(len(frames))
            if sharp[i] >= np.percentile(sharp[max(0, i - 5):i + 6], 40)]
    if every <= 0:
        every = max(1, len(keep) // 40)          # aim for ~40 slices
    keep = keep[::every]
    print(f"video: {len(frames)} frames, kept {len(keep)}")
    return [frames[i].astype(np.float32) / 255 for i in keep]


if __name__ == '__main__':
    main()
