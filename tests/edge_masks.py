#!/usr/bin/env python3
"""
Where halos show up in the synthetic bursts: for each frame, the background within BAND px
outside the spider's outline (and the legs'), in that frame's geometry. A defocused leg
bleeds over exactly this zone in the photos focused on the background, so a stack's error
here, against the truth, measures its halos.

Replays tests/make_synthetic.py's random draws (camera motion and noise) so the outlines
land where they are in the photos and truth images. Writes tests/bursts/<name>/truth/NN-edge.png
(the halo zone: each pixel's distance from the outline, 1..BAND px; 0 elsewhere).

    python tests/edge_masks.py            # all scenes
    python tests/edge_masks.py still legs
"""
import os, sys
import cv2
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_synthetic as S

BAND = 32


def masks(name):
    sc = S.SCENES[name]
    rng = np.random.default_rng(sc['seed'])
    bg = S.mesh(rng) if sc.get('bg') == 'mesh' else S.night(rng) if sc.get('bg') == 'night' else S.bokeh(rng) if sc.get('bg') == 'bokeh' else S.bark(rng)
    base = S.spider(np.random.default_rng(sc['seed'] + 100), S.W * 0.47, S.H * 0.42, 210, sc['legs'])
    moved = S.spider(np.random.default_rng(sc['seed'] + 100), S.W * 0.47, S.H * 0.42, 210, sc['legs'],
                     shift=sc['moved']) if sc['moved'] else None
    d = os.path.join(S.OUT, name, 'truth')
    n = sc['n']
    k_out = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * BAND + 1, 2 * BAND + 1))
    for k in range(n):
        Mc = np.eye(3) if sc.get('still') else S.cam_motion(rng, k, n, sc['lean'], sc.get('drift', 18))
        src = moved if (moved is not None and k >= n - 2) else base
        fg = np.zeros((S.H, S.W), np.float32)
        for p in src:
            dm = float(p.depth[p.alpha > 0.5].mean()) if (p.alpha > 0.5).any() else 0.4
            Hm = Mc @ S.parallax(dm, k, n, sc['par'])
            fg = np.maximum(fg, cv2.warpPerspective(p.alpha, Hm, (S.W, S.H), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT))
        inside = (fg > 0.5).astype(np.uint8)
        zone = cv2.dilate(inside, k_out) & (1 - cv2.dilate(inside, np.ones((3, 3), np.uint8)))
        # value = distance from the outline in px (1..BAND), 0 outside the zone
        dist = cv2.distanceTransform(1 - inside, cv2.DIST_L2, 5)
        cv2.imwrite(os.path.join(d, f'{k + 1:02d}-edge.png'), (zone * np.clip(np.round(dist), 1, BAND)).astype(np.uint8))
        # keep the random stream in step with make(): the photo's noise draw
        rng.normal(0, sc.get('noise', 1.6) / 255, (S.H, S.W, 3))
        print(f'{name}: frame {k + 1}/{n}  halo zone {zone.mean() * 100:.1f}% of the frame', flush=True)


if __name__ == '__main__':
    for nm in (sys.argv[1:] or [s for s in S.SCENES]):
        masks(nm)
    # dup is bark's photos plus one edited copy: same geometry
    if not sys.argv[1:] or 'dup' in sys.argv[1:]:
        import shutil
        src, dst = os.path.join(S.OUT, 'bark', 'truth'), os.path.join(S.OUT, 'dup', 'truth')
        if os.path.isdir(dst):
            for f in os.listdir(src):
                if f.endswith('-edge.png'):
                    shutil.copy2(os.path.join(src, f), dst)
