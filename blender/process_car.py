"""Generic cleanup for image-to-3D cars (Tripo output) so any car can be driven in-game.

Usage: /opt/bpyenv/bin/python blender/process_car.py <id> [--length 4.7] [--flip]
Input:  assets/generated/model3d/<id>.glb
Output: assets/build/cars/<id>.glb  (nodes: body, wheel_FL/FR/RL/RR with origins at wheel centres, liners)
        public/assets/cars/<id>.json (dimensions, wheel positions/radius for physics)
        assets/build/cars/<id>_check.png (side render with detected wheel circles, for review)

Steps: orient (front -> Blender -Y == glTF +Z), scale to the target length, ground it, detect the
wheels from where the mesh touches the ground, split each baked wheel into its own mesh so it can
spin, and add dark arch liners behind them.
"""
import json
import math
import os
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def arg(name, default=None, cast=str):
    if name in sys.argv:
        return cast(sys.argv[sys.argv.index(name) + 1])
    return default


def main():
    cid = sys.argv[1]
    length = arg('--length', 4.7, float)
    flip = '--flip' in sys.argv
    src = os.path.join(ROOT, 'assets', 'generated', 'model3d', f'{cid}.glb')
    out_dir = os.path.join(ROOT, 'assets', 'build', 'cars')
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(os.path.join(ROOT, 'public', 'assets', 'cars'), exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
    bpy.ops.object.select_all(action='DESELECT')
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    car = bpy.context.active_object
    car.name = 'body'
    for o in list(bpy.context.scene.objects):
        if o.type != 'MESH':
            bpy.data.objects.remove(o)
    car.parent = None
    car.rotation_mode = 'XYZ'
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    co = np.array([v.co[:] for v in car.data.vertices])
    ext = co.max(0) - co.min(0)
    # long axis = length. Tripo puts it on X (front +X) for three-quarter-front concepts.
    if ext[1] > ext[0]:
        # rotate so length is on X
        car.rotation_euler = (0, 0, math.radians(90))
        bpy.ops.object.transform_apply(rotation=True)
    # front +X -> Blender -Y (glTF +Z): rotate -90 about Z (or +90 when the model faces -X)
    car.rotation_euler = (0, 0, math.radians(90 if flip else -90))
    bpy.ops.object.transform_apply(rotation=True)
    co = np.array([v.co[:] for v in car.data.vertices])
    s = length / (co[:, 1].max() - co[:, 1].min())
    car.scale = (s, s, s)
    bpy.ops.object.transform_apply(scale=True)
    co = np.array([v.co[:] for v in car.data.vertices])
    off = np.array([-(co[:, 0].min() + co[:, 0].max()) / 2, -(co[:, 1].min() + co[:, 1].max()) / 2, -co[:, 2].min()])
    for v in car.data.vertices:
        v.co += Vector(off)
    co = co + off
    W, L, H = (float(np.ptp(co[:, i])) for i in range(3))
    hw = W / 2

    # ---- wheel detection: tire contact patches are the dense clusters of the lowest vertices.
    low = co[(co[:, 2] < 0.035 * H) & (np.abs(co[:, 0]) > 0.35 * hw)]
    wheels = {}
    for axle, sign in (('F', -1), ('R', 1)):  # front is -Y
        pts = low[np.sign(low[:, 1]) == sign]
        if len(pts) < 5:
            raise SystemExit(f'{cid}: could not find {axle} contact patch')
        hist, edges = np.histogram(pts[:, 1], bins=40)
        k = hist.argmax()
        yc = (edges[k] + edges[k + 1]) / 2
        near = pts[np.abs(pts[:, 1] - yc) < 0.25]
        yc = float(np.median(near[:, 1]))
        # radius: outer tire face points (wide in x) form a circle around (yc, r); fit r from their extent
        side = co[(np.abs(co[:, 0]) > 0.82 * hw) & (np.abs(co[:, 1] - yc) < 0.6) & (co[:, 2] < 0.75)]
        r = 0.36
        if len(side) > 30:
            # the tire's front/back extent at mid-height gives the diameter
            mid = side[np.abs(side[:, 2] - np.median(side[:, 2])) < 0.08]
            r_est = (np.percentile(side[:, 1], 98) - np.percentile(side[:, 1], 2)) / 2
            r_est2 = np.percentile(side[:, 2], 97) / 2
            r = float(np.clip(min(r_est, r_est2), 0.27, 0.5))
        r = arg('--radius', r, float)
        for lr, sx in (('L', 1), ('R', -1)):
            xs = co[(np.sign(co[:, 0]) == sx) & (np.abs(co[:, 1] - yc) < r) & (co[:, 2] < 2 * r)][:, 0]
            xo = float(np.percentile(np.abs(xs), 99)) if len(xs) else hw
            wheels[f'{axle}{lr}'] = {'x': sx * (xo - 0.13), 'y': yc, 'z': r, 'r': r, 'outer': xo}
    print(cid, 'dims', round(W, 2), round(L, 2), round(H, 2), {k: {kk: round(vv, 3) for kk, vv in v.items()} for k, v in wheels.items()})

    # ---- split the baked wheels out of the body
    me = car.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.verts.ensure_lookup_table()
    wheel_objs = []
    for key, w in wheels.items():
        sel = set()
        for v in bm.verts:
            if np.sign(v.co.x) != np.sign(w['x']):
                continue
            if abs(v.co.x) < hw * 0.58:
                continue
            if math.hypot(v.co.y - w['y'], v.co.z - w['z']) < w['r'] * 1.0:
                sel.add(v)
        faces = [f for f in bm.faces if all(v in sel for v in f.verts)]
        nb = bmesh.new()
        vmap = {}
        uv_src = bm.loops.layers.uv.active
        uv_dst = nb.loops.layers.uv.new('UVMap') if uv_src else None
        for f in faces:
            vs = []
            for v in f.verts:
                if v not in vmap:
                    vmap[v] = nb.verts.new(v.co - Vector((w['x'], w['y'], w['z'])))
                vs.append(vmap[v])
            try:
                nf = nb.faces.new(vs)
                if uv_src:
                    for l_src, l_dst in zip(f.loops, nf.loops):
                        l_dst[uv_dst].uv = l_src[uv_src].uv
            except ValueError:
                pass
        wm = bpy.data.meshes.new(f'wheel_{key}')
        nb.to_mesh(wm)
        nb.free()
        wo = bpy.data.objects.new(f'wheel_{key}', wm)
        wo.location = (w['x'], w['y'], w['z'])  # origin at the wheel centre: spin about X, steer about Z
        bpy.context.collection.objects.link(wo)
        for m in me.materials:
            wm.materials.append(m)
        wheel_objs.append(wo)
        bmesh.ops.delete(bm, geom=faces, context='FACES_ONLY')
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context='VERTS')
    bm.to_mesh(me)
    bm.free()

    # ---- arch liners (upper half cylinders, dark)
    liner = bpy.data.materials.new('liner')
    liner.use_nodes = True
    liner.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.004, 0.004, 0.005, 1)
    for key, w in wheels.items():
        bpy.ops.mesh.primitive_cylinder_add(radius=w['r'] * 1.06, depth=0.42, vertices=24, location=(w['x'] - np.sign(w['x']) * 0.05, w['y'], w['z']), rotation=(0, math.radians(90), 0), end_fill_type='NOTHING')
        ln = bpy.context.active_object
        ln.name = f'liner_{key}'
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
        ln.data.materials.append(liner)
        b2 = bmesh.new()
        b2.from_mesh(ln.data)
        bmesh.ops.delete(b2, geom=[v for v in b2.verts if v.co.z < -0.05], context='VERTS')
        bmesh.ops.reverse_faces(b2, faces=b2.faces[:])
        b2.to_mesh(ln.data)
        b2.free()

    # ---- spec (game space: x = left, y = up, z = forward; Blender -Y forward -> game +Z)
    spec = {
        'id': cid, 'length': round(L, 3), 'width': round(W, 3), 'height': round(H, 3),
        'wheelRadius': round(float(np.mean([w['r'] for w in wheels.values()])), 3),
        'wheels': {k: [round(w['x'], 3), round(w['z'], 3), round(-w['y'], 3)] for k, w in wheels.items()},
    }
    json.dump(spec, open(os.path.join(ROOT, 'public', 'assets', 'cars', f'{cid}.json'), 'w'), indent=1)

    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=os.path.join(out_dir, f'{cid}.glb'), export_format='GLB', export_apply=True, export_yup=True, export_image_format='WEBP')

    # ---- review render: side view with detected wheel circles
    if '--check' in sys.argv:
        sc = bpy.context.scene
        sc.render.engine = 'CYCLES'
        sc.cycles.samples = 8
        sc.cycles.use_denoising = False
        sc.render.resolution_x, sc.render.resolution_y = 900, 400
        wd = bpy.data.worlds.new('w'); wd.use_nodes = True
        wd.node_tree.nodes['Background'].inputs[1].default_value = 1.4
        sc.world = wd
        for key, w in wheels.items():
            bpy.ops.mesh.primitive_torus_add(major_radius=w['r'], minor_radius=0.012, location=(w['outer'] * np.sign(w['x']) + np.sign(w['x']) * 0.05, w['y'], w['z']), rotation=(0, math.radians(90), 0))
            t = bpy.context.active_object
            m = bpy.data.materials.new('mark'); m.use_nodes = True
            m.node_tree.nodes['Principled BSDF'].inputs['Emission Color'].default_value = (1, 0, 1, 1)
            m.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = 20
            t.data.materials.append(m)
        cam = bpy.data.cameras.new('c'); cam.type = 'ORTHO'; cam.ortho_scale = L * 1.15
        co_ = bpy.data.objects.new('c', cam); sc.collection.objects.link(co_); sc.camera = co_
        co_.location = (8, 0, H / 2); co_.rotation_euler = (math.radians(90), 0, math.radians(90))
        sc.render.filepath = os.path.join(out_dir, f'{cid}_check.png')
        bpy.ops.render.render(write_still=True)


if __name__ == '__main__':
    main()
