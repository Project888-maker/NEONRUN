"""Clean up the image-to-3D hero car (assets/generated/model3d/car.glb) for the game.

- orient (front -> Blender -Y == glTF +Z), scale to 4.8 m, sit on the ground
- cut the baked-in wheels out so the game can spin real wheels (from citykit 'hero_wheel')
- add dark wheel-arch liners to hide the cut
- add emissive light strips (head / tail / brake) found by ray casting the body surface
- add empties marking wheel centres (wheel_FL, wheel_FR, wheel_RL, wheel_RR)
Run: /opt/bpyenv/bin/python blender/hero_car.py  -> public/assets/models/hero_car_raw.glb
(then scripts/optimize_models.mjs compresses textures/geometry)
"""
import math
import os

import bpy
import bmesh
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets', 'generated', 'model3d', 'car.glb')
OUT = os.path.join(ROOT, 'assets', 'build', 'hero_car_raw.glb')

SCALE = 4.9
# wheel centres measured from orthographic renders, in source units (x along length, z up)
WHEELS_SRC = {'F': 0.293, 'R': -0.281}
WHEEL_Z_SRC = -0.059
WHEEL_R_SRC = 0.0705
WHEEL_Y_SRC = 0.172


def emissive(name, color, strength):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Emission Color'].default_value = (*color, 1)
    b.inputs['Emission Strength'].default_value = strength
    return m


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=SRC)
    car = [o for o in bpy.context.scene.objects if o.type == 'MESH'][0]
    car.name = 'body'
    bpy.context.view_layer.objects.active = car
    car.select_set(True)

    # --- cut wheels (in source space, before transforming)
    me = car.data
    bm = bmesh.new()
    bm.from_mesh(me)
    kill = []
    for v in bm.verts:
        for wx in WHEELS_SRC.values():
            d = math.hypot(v.co.x - wx, v.co.z - WHEEL_Z_SRC)
            if d < WHEEL_R_SRC * 1.01 and abs(v.co.y) > 0.125:
                kill.append(v)
                break
    bmesh.ops.delete(bm, geom=list(set(kill)), context='VERTS')
    bm.to_mesh(me)
    bm.free()
    print('removed wheel verts', len(kill))

    # --- orient + scale: rotate -90 deg about Z (front +X -> -Y), scale, ground
    car.rotation_mode = 'XYZ'
    car.rotation_euler = (0, 0, math.radians(-90))
    car.scale = (SCALE, SCALE, SCALE)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    zs = [v.co.z for v in car.data.vertices]
    ys = [v.co.y for v in car.data.vertices]
    xs = [v.co.x for v in car.data.vertices]
    off = Vector((-(min(xs) + max(xs)) / 2, -(min(ys) + max(ys)) / 2, -min(zs)))
    for v in car.data.vertices:
        v.co += off
    print('dims', max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs))

    def to_game(x_src, y_src, z_src):
        # source (x,y,z) -> rotated (y, -x, z) * scale + off
        return Vector((y_src * SCALE, -x_src * SCALE, z_src * SCALE)) + off

    bvh = BVHTree.FromObject(car, bpy.context.evaluated_depsgraph_get())
    liner_mat = bpy.data.materials.new('liner')
    liner_mat.use_nodes = True
    liner_mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'].default_value = (0.005, 0.005, 0.006, 1)
    liner_mat.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value = 0.9

    for key, wx in WHEELS_SRC.items():
        for side, sy in (('L', 1), ('R', -1)):
            c = to_game(wx, sy * WHEEL_Y_SRC, WHEEL_Z_SRC)
            e = bpy.data.objects.new(f'wheel_{key}{side}', None)
            e.location = c
            bpy.context.collection.objects.link(e)
            # arch liner: half cylinder shell inside the arch
            bpy.ops.mesh.primitive_cylinder_add(radius=WHEEL_R_SRC * SCALE * 1.08, depth=0.36, vertices=24, location=(c.x - sy * 0.02, c.y, c.z), rotation=(0, math.radians(90), 0), end_fill_type='NOTHING')
            ln = bpy.context.active_object
            ln.name = f'liner_{key}{side}'
            ln.data.materials.append(liner_mat)
            bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
            # keep only the upper half
            bm = bmesh.new(); bm.from_mesh(ln.data)
            bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < -0.02], context='VERTS')
            bmesh.ops.reverse_faces(bm, faces=bm.faces[:])
            bm.to_mesh(ln.data); bm.free()

    # --- light strips by ray casting toward the body
    def surface(origin, direction):
        hit = bvh.ray_cast(Vector(origin), Vector(direction).normalized(), 20)
        return hit[0]

    L = max(ys) - min(ys)
    head = emissive('emit_headlight', (0.85, 0.92, 1.0), 8)
    tail = emissive('emit_taillight', (1.0, 0.02, 0.02), 4)

    def strip(name, mat, z, front, width, thick=0.035, segs=24):
        """Curved strip following the body surface across the car width at height z."""
        pts = []
        yo = -10 if front else 10
        for i in range(segs + 1):
            x = -width / 2 + width * i / segs
            p = surface((x, yo, z), (0, 1 if front else -1, 0))
            if p is not None:
                pts.append(p + Vector((0, -0.006 if front else 0.006, 0)))
        if len(pts) < 2:
            print('strip failed', name)
            return None
        me = bpy.data.meshes.new(name)
        bm = bmesh.new()
        prev = None
        for p in pts:
            a = bm.verts.new(p + Vector((0, 0, thick / 2)))
            b = bm.verts.new(p - Vector((0, 0, thick / 2)))
            if prev:
                bm.faces.new([prev[0], prev[1], b, a] if front else [prev[0], a, b, prev[1]])
            prev = (a, b)
        bm.to_mesh(me)
        o = bpy.data.objects.new(name, me)
        bpy.context.collection.objects.link(o)
        o.data.materials.append(mat)
        return o

    # find heights: scan the front for the LED strip line (approx 0.645 m measured from renders)
    strip('headlights', head, 0.655, True, 1.62, 0.04)
    strip('taillights', tail, 0.90, False, 1.55, 0.05)
    brake = emissive('emit_brake', (1.0, 0.0, 0.0), 1)
    strip('brakelights', brake, 0.86, False, 1.4, 0.03)

    bpy.ops.object.select_all(action='SELECT')
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_apply=True, export_yup=True, export_image_format='WEBP')
    print('exported', OUT)


if __name__ == '__main__':
    main()
