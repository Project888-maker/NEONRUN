#!/usr/bin/env bash
# Optimize GLBs for the web: meshopt geometry compression + WebP textures (resized).
# Requires: npm deps (@gltf-transform/cli, sharp). KTX2 would need the external `toktx`
# binary which is not available in this environment, so WebP is used instead (see NOTES.md).
set -euo pipefail
cd "$(dirname "$0")/.."
GT=node_modules/.bin/gltf-transform
OUT=public/assets/models
$GT optimize assets/build/hero_car_raw.glb $OUT/hero_car.glb --compress meshopt --texture-compress webp --texture-size 2048 --simplify false --prune false --join false --flatten false
for m in lm_pagoda lm_watertower lm_crane lm_gate lm_statue; do
  $GT optimize assets/generated/model3d/$m.glb $OUT/$m.glb --compress meshopt --texture-compress webp --texture-size 1024 --simplify true --simplify-ratio 0.5 --simplify-error 0.002
done
$GT optimize $OUT/citykit.glb $OUT/citykit_opt.glb --compress meshopt --texture-compress false --simplify false --join false --instance false --flatten false --palette false && mv $OUT/citykit_opt.glb $OUT/citykit.glb
ls -la $OUT
# generated traffic / garage cars (processed by blender/process_car.py)
mkdir -p public/assets/cars
for f in assets/build/cars/car_*.glb; do
  id=$(basename $f .glb)
  $GT optimize $f public/assets/cars/$id.glb --compress meshopt --texture-compress webp --texture-size 1024 --simplify false --prune false --join false --flatten false
done
# low-detail copies used for AI traffic
for f in assets/build/cars/car_*.glb; do
  id=$(basename $f .glb)
  $GT optimize $f public/assets/cars/${id}_lod.glb --compress meshopt --texture-compress webp --texture-size 512 --simplify true --simplify-ratio 0.25 --simplify-error 0.004 --prune false --join false --flatten false
done
