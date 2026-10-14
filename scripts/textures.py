#!/usr/bin/env python3
"""Process raw fal outputs (assets/generated) into game-ready files (public/assets).

- PBR sets: crop, make seamless (offset cross-fade), derive normal + roughness maps
- Facades: seamless in both directions, emissive window mask in alpha-free form
- Signs: crop to glowing content, record aspect ratios in signs.json
- Icons/liveries: luminance -> alpha PNG
Run: npm run gen:textures   (uses the bpy venv python which has numpy + Pillow + scipy)
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'assets' / 'generated'
DST = ROOT / 'public' / 'assets'


def out(rel: str) -> Path:
    p = DST / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def load(rel: str) -> Image.Image:
    return Image.open(SRC / rel).convert('RGB')


def seamless(img: np.ndarray, frac: float = 0.25, axes=(0, 1)) -> np.ndarray:
    """Make an image tile by cross-fading it with a half-offset copy near the borders."""
    h, w = img.shape[:2]
    res = img.astype(np.float32)
    for ax in axes:
        n = res.shape[ax]
        shifted = np.roll(res, n // 2, axis=ax)
        t = np.abs(np.linspace(-1, 1, n))  # 1 at borders, 0 at center
        m = np.clip((t - (1 - 2 * frac)) / (2 * frac), 0, 1)
        m = m * m * (3 - 2 * m)
        shape = [1, 1, 1][: res.ndim]
        shape[ax] = n
        m = m.reshape(shape)
        res = res * (1 - m) + shifted * m
    return res


def to_img(a: np.ndarray, mode='RGB') -> Image.Image:
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), mode)


def normal_from_height(h: np.ndarray, strength: float) -> np.ndarray:
    gx = ndimage.sobel(h, axis=1, mode='wrap')
    gy = ndimage.sobel(h, axis=0, mode='wrap')
    nx, ny, nz = -gx * strength, gy * strength, np.ones_like(h)
    l = np.sqrt(nx * nx + ny * ny + nz * nz)
    n = np.stack([nx / l, ny / l, nz / l], axis=-1)
    return (n * 0.5 + 0.5) * 255


PBR = {
    # name: (crop fraction, normal strength, roughness base, roughness range, invert)
    'asphalt': (0.9, 6.0, 0.55, 0.45, False),
    'roadlines': (0.9, 5.0, 0.5, 0.4, False),
    'concrete': (0.78, 4.0, 0.6, 0.35, False),
    'brushed_metal': (0.9, 2.0, 0.35, 0.2, False),
    'rusted_metal': (0.9, 6.0, 0.55, 0.4, False),
    'glass_grime': (0.9, 1.5, 0.1, 0.4, False),
    'brick': (0.9, 7.0, 0.6, 0.3, False),
    'rubber': (0.9, 6.0, 0.8, 0.15, False),
}


def process_pbr():
    for name, (crop, ns, rb, rr, _) in PBR.items():
        f = SRC / 'tex' / f'{name}.png'
        if not f.exists():
            continue
        im = Image.open(f).convert('RGB')
        w, h = im.size
        c = int(w * (1 - crop) / 2)
        im = im.crop((c, c, w - c, h - c)).resize((1024, 1024), Image.LANCZOS)
        a = seamless(np.asarray(im))
        to_img(a).save(out(f'tex/{name}_albedo.webp'), quality=88)
        lum = (a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114) / 255.0
        height = ndimage.gaussian_filter(lum, 1.0, mode='wrap')
        to_img(normal_from_height(height, ns)).save(out(f'tex/{name}_normal.webp'), quality=90)
        # Rougher where bright/high detail, smoother in dark (wet/puddle) areas.
        detail = np.abs(lum - ndimage.gaussian_filter(lum, 6, mode='wrap'))
        rough = rb + rr * (lum - lum.mean()) / (lum.std() * 3 + 1e-5) + detail * 1.5
        rough = np.clip(rough, 0.04, 1.0) * 255
        to_img(np.repeat(rough[..., None], 3, -1)).save(out(f'tex/{name}_rough.webp'), quality=88)
        print('pbr', name)


def process_facades():
    meta = {}
    for f in sorted((SRC / 'facade').glob('*.jpg')):
        im = Image.open(f).convert('RGB')
        w, h = im.size
        im = im.crop((int(w * 0.03), int(h * 0.03), int(w * 0.97), int(h * 0.97))).resize((1024, 1536), Image.LANCZOS)
        a = seamless(np.asarray(im), frac=0.12)
        to_img(a).save(out(f'facade/{f.stem}.webp'), quality=86)
        meta[f.stem] = {'w': 1024, 'h': 1536}
        print('facade', f.stem)
    return meta


def process_shops():
    for f in sorted((SRC / 'shop').glob('*.jpg')):
        im = Image.open(f).convert('RGB')
        w, h = im.size
        # keep the lower part of the frame: the actual storefront, drop sky / upper floors
        im = im.crop((0, int(h * 0.12), w, h)).resize((1024, 600), Image.LANCZOS)
        im.save(out(f'shop/{f.stem}.webp'), quality=86)
        print('shop', f.stem)


def crop_glow(im: Image.Image, pad=0.06):
    a = np.asarray(im).astype(np.float32)
    lum = a.max(axis=-1)
    mask = lum > 40
    mask = ndimage.binary_opening(mask, iterations=2)
    ys, xs = np.where(mask)
    if len(xs) < 50:
        return im
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    pw, ph = int((x1 - x0) * pad) + 8, int((y1 - y0) * pad) + 8
    x0, y0 = max(0, x0 - pw), max(0, y0 - ph)
    x1, y1 = min(im.width, x1 + pw), min(im.height, y1 + ph)
    return im.crop((x0, y0, x1, y1))


def process_signs():
    meta = {}
    for f in sorted((SRC / 'sign').glob('*.jpg')):
        im = crop_glow(Image.open(f).convert('RGB'))
        # crush near-black background to pure black so additive blending is clean
        a = np.asarray(im).astype(np.float32)
        lum = a.max(axis=-1, keepdims=True)
        k = np.clip((lum - 18) / 40, 0, 1)
        a = a * k
        im = to_img(a)
        scale = 512 / max(im.size)
        im = im.resize((max(8, int(im.width * scale)), max(8, int(im.height * scale))), Image.LANCZOS)
        im.save(out(f'sign/{f.stem}.webp'), quality=88)
        meta[f.stem] = round(im.width / im.height, 3)
        print('sign', f.stem, meta[f.stem])
    json.dump(meta, open(out('sign/signs.json'), 'w'), indent=1)


def process_ads():
    meta = {}
    for f in sorted((SRC / 'ad').glob('*.jpg')):
        im = Image.open(f).convert('RGB')
        scale = 768 / max(im.size)
        im = im.resize((int(im.width * scale), int(im.height * scale)), Image.LANCZOS)
        im.save(out(f'ad/{f.stem}.webp'), quality=85)
        meta[f.stem] = round(im.width / im.height, 3)
    json.dump(meta, open(out('ad/ads.json'), 'w'), indent=1)
    print('ads', len(meta))


def process_sky():
    f = SRC / 'sky' / 'night_pano.png'
    if f.exists():
        im = Image.open(f).convert('RGB')
        a = seamless(np.asarray(im), frac=0.1, axes=(1,))
        to_img(a).save(out('sky/night_pano.webp'), quality=90)
    f = SRC / 'sky' / 'clouds.jpg'
    if f.exists():
        im = Image.open(f).convert('RGB').resize((1024, 1024), Image.LANCZOS)
        to_img(seamless(np.asarray(im))).save(out('sky/clouds.webp'), quality=85)
    print('sky')


def lum_alpha(im: Image.Image, size, white=False, gamma=1.0):
    im = im.convert('RGB')
    if size:
        im.thumbnail(size, Image.LANCZOS)
    a = np.asarray(im).astype(np.float32)
    lum = a.max(axis=-1)
    alpha = np.clip((lum - 20) / 200, 0, 1) ** gamma * 255
    rgb = np.full_like(a, 255) if white else np.clip(a * 255 / np.maximum(lum[..., None], 1), 0, 255)
    return Image.fromarray(np.dstack([rgb, alpha]).astype(np.uint8), 'RGBA')


def process_ui():
    for f in sorted((SRC / 'icon').glob('*')):
        if f.suffix.lower() not in ('.png', '.jpg', '.webp', '.svg'):
            continue
        if f.suffix == '.svg':
            continue
        lum_alpha(Image.open(f), (128, 128), white=True).save(out(f'icon/{f.stem.split("_", 1)[1]}.png'))
    for f in sorted((SRC / 'livery').glob('*.png')):
        lum_alpha(Image.open(f), (1024, 1024)).save(out(f'livery/{f.stem}.png'))
    for name in ['loading', 'card_neon', 'card_docks', 'card_downtown', 'card_backstreets']:
        for ext in ('.jpg', '.png'):
            f = SRC / 'ui' / f'{name}{ext}'
            if f.exists():
                im = Image.open(f).convert('RGB')
                im.thumbnail((1600, 1600), Image.LANCZOS)
                im.save(out(f'ui/{name}.webp'), quality=84)
    for ext in ('.png', '.jpg', '.webp'):
        f = SRC / 'ui' / f'logo{ext}'
        if f.exists():
            im = crop_glow(Image.open(f).convert('RGB'), pad=0.04)
            lum_alpha(im, (1400, 1400), gamma=0.6).save(out('ui/logo.png'))
    print('ui')


def pack_atlas(items, width, pad=4):
    """Simple shelf packer. items: list of (id, PIL image). Returns atlas image and uv rects."""
    items = sorted(items, key=lambda t: -t[1].height)
    x = y = shelf = 0
    rects = {}
    for id_, im in items:
        if x + im.width + pad > width:
            x, y, shelf = 0, y + shelf + pad, 0
        rects[id_] = (x, y, im.width, im.height)
        x += im.width + pad
        shelf = max(shelf, im.height)
    height = y + shelf
    h2 = 1
    while h2 < height:
        h2 *= 2
    atlas = Image.new('RGB', (width, h2))
    for id_, im in items:
        r = rects[id_]
        atlas.paste(im, (r[0], r[1]))
    return atlas, {k: [r[0] / width, r[1] / h2, r[2] / width, r[3] / h2] for k, r in rects.items()}


def process_atlases():
    # neon signs atlas with average glow colour (for light pools)
    meta = json.load(open(DST / 'sign' / 'signs.json'))
    items, info = [], {}
    for id_ in meta:
        im = Image.open(DST / 'sign' / f'{id_}.webp').convert('RGB')
        im.thumbnail((400, 400), Image.LANCZOS)
        a = np.asarray(im).astype(np.float32) / 255
        w = a.max(axis=-1)
        col = (a * w[..., None]).sum(axis=(0, 1)) / max(w.sum(), 1e-3)
        col = col / max(col.max(), 1e-3)
        items.append((id_, im))
        info[id_] = {'aspect': meta[id_], 'color': [round(float(c), 3) for c in col]}
    atlas, rects = pack_atlas(items, 2048)
    atlas.save(out('atlas/signs.webp'), quality=90)
    for k in info:
        info[k]['uv'] = [round(v, 5) for v in rects[k]]
    json.dump(info, open(out('atlas/signs.json'), 'w'), indent=1)
    print('signs atlas', atlas.size)
    # ads atlas
    meta = json.load(open(DST / 'ad' / 'ads.json'))
    items, info = [], {}
    for id_ in meta:
        im = Image.open(DST / 'ad' / f'{id_}.webp').convert('RGB')
        im.thumbnail((640, 640), Image.LANCZOS)
        items.append((id_, im))
        info[id_] = {'aspect': meta[id_]}
    atlas, rects = pack_atlas(items, 2048)
    atlas.save(out('atlas/ads.webp'), quality=88)
    for k in info:
        info[k]['uv'] = [round(v, 5) for v in rects[k]]
    json.dump(info, open(out('atlas/ads.json'), 'w'), indent=1)
    print('ads atlas', atlas.size)
    # shops atlas: 2 x 4 grid of 1024x512
    shops = sorted((DST / 'shop').glob('*.webp'))
    atlas = Image.new('RGB', (2048, 2048))
    info = {}
    for i, f in enumerate(shops[:8]):
        im = Image.open(f).convert('RGB').resize((1024, 512), Image.LANCZOS)
        x, y = (i % 2) * 1024, (i // 2) * 512
        atlas.paste(im, (x, y))
        info[f.stem] = [x / 2048, y / 2048, 0.5, 0.25]
    atlas.save(out('atlas/shops.webp'), quality=86)
    json.dump(info, open(out('atlas/shops.json'), 'w'), indent=1)
    print('shops atlas')


if __name__ == '__main__':
    steps = sys.argv[1:] or ['pbr', 'facades', 'shops', 'signs', 'ads', 'sky', 'ui', 'atlases']
    for s in steps:
        globals()[f'process_{s}']()
