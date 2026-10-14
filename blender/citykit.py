"""NEON RUN city kit, built procedurally with Blender's Python API (bpy).

Run headless:  /opt/bpyenv/bin/python blender/citykit.py
Outputs:       public/assets/models/citykit.glb  (one named node per prop)

Conventions: Blender Z-up, objects face -Y (glTF exporter maps -Y -> +Z, the game's forward).
Material names matter: the game remaps 'emit_*' materials to HDR emissive and 'glass' to
transparent physical glass.
"""
import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'assets', 'models', 'citykit.glb')


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


MATS = {}


def mat(name, color, metal=0.0, rough=0.5, emit=None, emit_strength=0.0, alpha=1.0):
    if name in MATS:
        return MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get('Principled BSDF')
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    if emit:
        b.inputs['Emission Color'].default_value = (*emit, 1)
        b.inputs['Emission Strength'].default_value = emit_strength
    if alpha < 1:
        b.inputs['Alpha'].default_value = alpha
    MATS[name] = m
    return m


def M():
    return {
        'metal_dark': mat('metal_dark', (0.03, 0.03, 0.035), 0.8, 0.45),
        'metal_grey': mat('metal_grey', (0.25, 0.26, 0.28), 0.9, 0.35),
        'paint_yellow': mat('paint_yellow', (0.8, 0.55, 0.02), 0.2, 0.45),
        'paint_red': mat('paint_red', (0.55, 0.03, 0.02), 0.2, 0.4),
        'paint_white': mat('paint_white', (0.7, 0.7, 0.72), 0.1, 0.4),
        'concrete': mat('concrete', (0.32, 0.31, 0.3), 0.0, 0.85),
        'plastic_black': mat('plastic_black', (0.015, 0.015, 0.018), 0.0, 0.5),
        'plastic_green': mat('plastic_green', (0.03, 0.12, 0.05), 0.0, 0.6),
        'rubber': mat('rubber', (0.02, 0.02, 0.02), 0.0, 0.9),
        'glass': mat('glass', (0.02, 0.03, 0.04), 0.0, 0.05, alpha=0.5),
        'chrome': mat('chrome', (0.8, 0.8, 0.82), 1.0, 0.12),
        'emit_warm': mat('emit_warm', (1, 0.8, 0.5), 0, 0.5, (1.0, 0.72, 0.4), 6),
        'emit_cool': mat('emit_cool', (0.8, 0.9, 1), 0, 0.5, (0.75, 0.9, 1.0), 6),
        'emit_red': mat('emit_red', (1, 0.05, 0.03), 0, 0.5, (1.0, 0.04, 0.02), 6),
        'emit_amber': mat('emit_amber', (1, 0.5, 0.0), 0, 0.5, (1.0, 0.45, 0.0), 6),
        'emit_green': mat('emit_green', (0.1, 1, 0.3), 0, 0.5, (0.1, 1.0, 0.35), 6),
        'emit_cyan': mat('emit_cyan', (0.1, 0.9, 1), 0, 0.5, (0.1, 0.9, 1.0), 6),
        'emit_magenta': mat('emit_magenta', (1, 0.1, 0.7), 0, 0.5, (1.0, 0.1, 0.7), 6),
    }


def finish(obj, name, bevel=0.0, segs=2, smooth=True):
    obj.name = name
    if bevel > 0:
        mod = obj.modifiers.new('bevel', 'BEVEL')
        mod.width = bevel
        mod.segments = min(segs, 2)
        mod.limit_method = 'ANGLE'
        mod.harden_normals = False
    if smooth:
        for p in obj.data.polygons:
            p.use_smooth = True
        try:
            obj.data.set_sharp_from_angle(angle=math.radians(35))
        except Exception:
            pass
    return obj


def box(name, size, loc=(0, 0, 0), material=None, bevel=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.active_object
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if material:
        o.data.materials.append(material)
    return finish(o, name, bevel)


def cyl(name, r, h, loc=(0, 0, 0), material=None, verts=10, rot=(0, 0, 0), bevel=0.0):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=h, location=loc, vertices=verts, rotation=rot)
    o = bpy.context.active_object
    if material:
        o.data.materials.append(material)
    return finish(o, name, bevel)


def sphere(name, r, loc, material):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=16, ring_count=8)
    o = bpy.context.active_object
    o.data.materials.append(material)
    return finish(o, name)


def join(objs, name, origin=(0, 0, 0)):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    for o in objs:
        for m in o.modifiers:
            bpy.context.view_layer.objects.active = o
            bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    o.name = name
    bpy.context.scene.cursor.location = origin
    bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
    return o


# ---------------------------------------------------------------- props
def lamp_post(m):
    parts = [
        cyl('p', 0.12, 0.6, (0, 0, 0.3), m['metal_dark'], 8, bevel=0.02),
        cyl('p', 0.07, 7.4, (0, 0, 4.0), m['metal_dark'], 12),
        cyl('p', 0.05, 2.2, (0, -1.0, 7.6), m['metal_dark'], 10, rot=(math.radians(90), 0, 0)),
        box('p', (0.42, 0.9, 0.16), (0, -2.0, 7.55), m['metal_dark'], bevel=0.03),
        box('p', (0.36, 0.8, 0.04), (0, -2.0, 7.45), m['emit_warm']),
    ]
    return join(parts, 'lamp_post')


def hydrant(m):
    parts = [
        cyl('h', 0.16, 0.6, (0, 0, 0.3), m['paint_red'], 10, bevel=0.03),
        cyl('h', 0.2, 0.06, (0, 0, 0.03), m['paint_red'], 16),
        sphere('h', 0.17, (0, 0, 0.62), m['paint_red']),
        cyl('h', 0.06, 0.45, (0, 0, 0.42), m['paint_red'], 10, rot=(0, math.radians(90), 0)),
        cyl('h', 0.07, 0.12, (0, -0.18, 0.42), m['metal_grey'], 10, rot=(math.radians(90), 0, 0)),
    ]
    return join(parts, 'hydrant')


def bin_(m):
    parts = [
        cyl('b', 0.3, 0.9, (0, 0, 0.45), m['plastic_green'], 8, bevel=0.02),
        cyl('b', 0.32, 0.08, (0, 0, 0.92), m['plastic_black'], 8, bevel=0.02),
    ]
    return join(parts, 'bin')


def barrier(m):
    # jersey barrier profile extruded along X
    verts2d = [(-0.3, 0), (0.3, 0), (0.3, 0.08), (0.1, 0.3), (0.08, 0.8), (-0.08, 0.8), (-0.1, 0.3), (-0.3, 0.08)]
    me = bpy.data.meshes.new('barrier')
    bm = bmesh.new()
    L = 2.0
    front = [bm.verts.new((-L / 2, y, z)) for (y, z) in verts2d]
    back = [bm.verts.new((L / 2, y, z)) for (y, z) in verts2d]
    bm.faces.new(front[::-1])
    bm.faces.new(back)
    n = len(verts2d)
    for i in range(n):
        bm.faces.new([front[i], front[(i + 1) % n], back[(i + 1) % n], back[i]])
    bm.to_mesh(me)
    o = bpy.data.objects.new('barrier', me)
    bpy.context.collection.objects.link(o)
    o.data.materials.append(m['concrete'])
    stripe = box('s', (2.0, 0.17, 0.12), (0, 0, 0.6), m['paint_yellow'])
    bpy.context.view_layer.objects.active = o
    return join([finish(o, 'barrier', 0.02), stripe], 'barrier')


def holo_barrier(m):
    parts = [
        box('hb', (0.25, 0.25, 1.2), (-6.5, 0, 0.6), m['metal_dark'], 0.03),
        box('hb', (0.25, 0.25, 1.2), (6.5, 0, 0.6), m['metal_dark'], 0.03),
        box('hb', (13.0, 0.06, 0.08), (0, 0, 1.1), m['emit_red']),
        box('hb', (13.0, 0.06, 0.08), (0, 0, 0.6), m['emit_red']),
    ]
    return join(parts, 'holo_barrier')


def vent(m):
    parts = [box('v', (1.2, 1.2, 0.12), (0, 0, 0.06), m['metal_grey'], 0.02)]
    for i in range(6):
        parts.append(box('v', (1.0, 0.06, 0.04), (0, -0.45 + i * 0.18, 0.13), m['metal_dark']))
    return join(parts, 'vent')


def ac_unit(m):
    parts = [
        box('a', (1.0, 0.6, 0.8), (0, 0, 0.4), m['paint_white'], 0.03),
        cyl('a', 0.26, 0.04, (0.18, -0.31, 0.42), m['metal_dark'], 8, rot=(math.radians(90), 0, 0)),
    ]
    return join(parts, 'ac_unit')


def water_tank(m):
    parts = [cyl('w', 2.0, 3.2, (0, 0, 4.6), m['metal_grey'], 24, bevel=0.05)]
    bpy.ops.mesh.primitive_cone_add(radius1=2.1, radius2=0.2, depth=1.0, location=(0, 0, 6.7), vertices=24)
    c = bpy.context.active_object
    c.data.materials.append(m['metal_dark'])
    parts.append(c)
    for a in range(4):
        ang = a * math.pi / 2 + math.pi / 4
        parts.append(cyl('w', 0.1, 3.0, (math.cos(ang) * 1.5, math.sin(ang) * 1.5, 1.5), m['metal_dark'], 8))
    return join(parts, 'water_tank')


def antenna(m):
    parts = [cyl('an', 0.06, 10, (0, 0, 5), m['metal_dark'], 8)]
    for z in (3, 6, 8.5):
        parts.append(box('an', (1.4 - z * 0.1, 0.04, 0.04), (0, 0, z), m['metal_dark']))
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.18, location=(0, 0, 10.1), segments=10, ring_count=6)
    s = bpy.context.active_object
    s.data.materials.append(m['emit_red'])
    parts.append(s)
    return join(parts, 'antenna')


def bollard(m):
    parts = [cyl('bo', 0.11, 0.9, (0, 0, 0.45), m['metal_dark'], 8, bevel=0.02), cyl('bo', 0.115, 0.06, (0, 0, 0.78), m['emit_amber'], 12)]
    return join(parts, 'bollard')


def bench(m):
    parts = [box('be', (1.8, 0.45, 0.06), (0, 0, 0.45), m['metal_grey'], 0.01), box('be', (1.8, 0.06, 0.4), (0, 0.22, 0.7), m['metal_grey'], 0.01)]
    for x in (-0.8, 0.8):
        parts.append(box('be', (0.06, 0.45, 0.45), (x, 0, 0.22), m['metal_dark']))
    return join(parts, 'bench')


def traffic_light(m):
    parts = [
        cyl('t', 0.1, 6.0, (0, 0, 3.0), m['metal_dark'], 12),
        cyl('t', 0.07, 5.0, (0, -2.5, 5.8), m['metal_dark'], 10, rot=(math.radians(90), 0, 0)),
        box('t', (0.36, 0.3, 1.0), (0, -4.6, 5.3), m['metal_dark'], 0.03),
    ]
    return join(parts, 'traffic_light')


def traffic_lamps(m):
    # separate emissive lamp discs (facing +X, perpendicular to the arm) so the game can drive red / amber / green
    out = []
    for i, (n, mm) in enumerate([('tl_red', 'emit_red'), ('tl_amber', 'emit_amber'), ('tl_green', 'emit_green')]):
        c = cyl(n, 0.11, 0.04, (0.2, -4.6, 5.62 - i * 0.32), m[mm], 14, rot=(0, math.radians(90), 0))
        bpy.context.view_layer.objects.active = c
        bpy.context.scene.cursor.location = (0, 0, 0)
        bpy.ops.object.origin_set(type='ORIGIN_CURSOR')
        out.append(c)
    return out


def container(m):
    # plain bevelled box; corrugation comes from the rusted-metal normal map in-game
    me = box('container', (2.44, 6.06, 2.59), (0, 0, 1.295), mat('container_paint', (0.4, 0.4, 0.4), 0.3, 0.55), bevel=0.04)
    rails = [me]
    for z in (0.06, 2.53):
        rails.append(box('r', (2.5, 6.1, 0.12), (0, 0, z), MATS['container_paint']))
    return join(rails, 'container')


def rail_portal(m):
    parts = [
        box('rp', (1.0, 1.0, 12.2), (-8.6, 0, 6.1), m['concrete'], 0.05),
        box('rp', (1.0, 1.0, 12.2), (8.6, 0, 6.1), m['concrete'], 0.05),
        box('rp', (18.4, 1.6, 1.4), (0, 0, 12.3), m['concrete'], 0.05),
    ]
    return join(parts, 'rail_portal')


def rail_track(m):
    # 32 m of guideway along -Y (game +Z)
    parts = [
        box('rt', (5.2, 32.0, 0.9), (0, 0, 13.45), m['concrete'], 0.04),
        box('rt', (0.12, 32.0, 0.18), (-0.75, 0, 13.99), m['metal_grey']),
        box('rt', (0.12, 32.0, 0.18), (0.75, 0, 13.99), m['metal_grey']),
        box('rt', (0.08, 32.0, 0.9), (-2.55, 0, 14.4), m['metal_dark']),
        box('rt', (0.08, 32.0, 0.9), (2.55, 0, 14.4), m['metal_dark']),
        box('rt', (0.1, 32.0, 0.05), (-2.5, 0, 13.0), m['emit_cyan']),
        box('rt', (0.1, 32.0, 0.05), (2.5, 0, 13.0), m['emit_cyan']),
    ]
    return join(parts, 'rail_track')


def train_car(m):
    body = mat('train_body', (0.55, 0.57, 0.6), 0.6, 0.3)
    parts = [box('tc', (3.0, 18.0, 3.2), (0, 0, 1.9), body, 0.25)]
    parts.append(box('tc', (3.04, 16.0, 0.9), (0, 0, 2.4), MATS['emit_cool'] if 'emit_cool' in MATS else m['emit_cool']))
    parts.append(box('tc', (3.06, 18.0, 0.12), (0, 0, 1.3), m['emit_magenta']))
    for y in (-6.5, 6.5):
        parts.append(box('tc', (2.2, 2.4, 0.6), (0, y, 0.3), m['metal_dark']))
    return join(parts, 'train_car')


def billboard_frame(m):
    parts = [
        box('bf', (12.4, 0.5, 0.25), (0, 0.1, 0.0), m['metal_dark']),
        box('bf', (12.4, 0.5, 0.25), (0, 0.1, 6.5), m['metal_dark']),
        box('bf', (0.25, 0.5, 6.75), (-6.2, 0.1, 3.25), m['metal_dark']),
        box('bf', (0.25, 0.5, 6.75), (6.2, 0.1, 3.25), m['metal_dark']),
        box('bf', (0.3, 0.3, 6.0), (-4.0, 0.6, -3.0), m['metal_dark']),
        box('bf', (0.3, 0.3, 6.0), (4.0, 0.6, -3.0), m['metal_dark']),
    ]
    for x in (-4, 0, 4):
        parts.append(box('bf', (0.5, 0.8, 0.1), (x, -0.5, 6.8), m['metal_dark']))
        parts.append(box('bf', (0.4, 0.1, 0.06), (x, -0.85, 6.75), m['emit_cool']))
    return join(parts, 'billboard_frame')


def sign_bracket(m):
    parts = [box('sb', (0.08, 1.4, 0.08), (0, -0.7, 0.0), m['metal_dark']), box('sb', (0.06, 1.0, 0.06), (0, -0.5, -0.5), m['metal_dark'])]
    return join(parts, 'sign_bracket')


def awning(m):
    me = bpy.data.meshes.new('awning')
    bm = bmesh.new()
    w, d = 1.0, 1.0
    v = [bm.verts.new(p) for p in [(-0.5, 0, 0), (0.5, 0, 0), (0.5, -1, -0.35), (-0.5, -1, -0.35), (-0.5, -1, -0.6), (0.5, -1, -0.6)]]
    bm.faces.new([v[0], v[1], v[2], v[3]])
    bm.faces.new([v[3], v[2], v[5], v[4]])
    bm.to_mesh(me)
    o = bpy.data.objects.new('awning', me)
    bpy.context.collection.objects.link(o)
    o.data.materials.append(mat('awning_fabric', (0.5, 0.5, 0.5), 0.0, 0.7))
    sol = o.modifiers.new('solid', 'SOLIDIFY')
    sol.thickness = 0.03
    return o


def pipe_cluster(m):
    parts = []
    for i, r in enumerate((0.12, 0.08, 0.1)):
        parts.append(cyl('pc', r, 20, (i * 0.3, 0, 10), m['metal_grey'] if i % 2 else m['metal_dark'], 10))
    return join(parts, 'pipes')


# ---------------------------------------------------------------- traffic cars
def car_body(name, L, W, profile, paint, cabin, extra=None):
    """profile: list of (y_along_length 0..1 from front, z) for the body side silhouette."""
    m = M()
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    left = [bm.verts.new((-W / 2, -L / 2 + t * L, z)) for t, z in profile]
    right = [bm.verts.new((W / 2, -L / 2 + t * L, z)) for t, z in profile]
    bm.faces.new(left[::-1])
    bm.faces.new(right)
    n = len(profile)
    for i in range(n):
        bm.faces.new([left[i], left[(i + 1) % n], right[(i + 1) % n], right[i]])
    bm.normal_update()
    bm.to_mesh(me)
    body = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(body)
    body.data.materials.append(paint)
    finish(body, name, 0.06, 3)
    # cabin glass (tapered prism)
    (c0, c1, cz0, cz1, inset) = cabin
    me2 = bpy.data.meshes.new(name + '_glass')
    bm2 = bmesh.new()
    y0, y1 = -L / 2 + c0 * L, -L / 2 + c1 * L
    wb, wt = W / 2 - 0.05, W / 2 - inset
    pts = [(-wb, y0, cz0), (wb, y0, cz0), (wb, y1, cz0), (-wb, y1, cz0),
           (-wt, y0 + 0.45, cz1), (wt, y0 + 0.45, cz1), (wt, y1 - 0.3, cz1), (-wt, y1 - 0.3, cz1)]
    vv = [bm2.verts.new(p) for p in pts]
    for f in [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]:
        bm2.faces.new([vv[i] for i in f])
    bm2.normal_update()
    bm2.to_mesh(me2)
    glass = bpy.data.objects.new(name + '_glass', me2)
    bpy.context.collection.objects.link(glass)
    glass.data.materials.append(m['glass'])
    finish(glass, name + '_glass', 0.04, 2)
    # roof panel over glass
    roof = box('roof', (2 * wt - 0.02, (y1 - 0.3) - (y0 + 0.45) - 0.1, 0.05), (0, (y0 + y1 + 0.15) / 2, cz1 + 0.02), paint, 0.02)
    # lights
    lights = [
        box('hl', (0.45, 0.06, 0.12), (-W / 2 + 0.35, -L / 2 + 0.02, profile[1][1] - 0.12), m['emit_cool']),
        box('hl', (0.45, 0.06, 0.12), (W / 2 - 0.35, -L / 2 + 0.02, profile[1][1] - 0.12), m['emit_cool']),
        box('tl', (0.5, 0.06, 0.1), (-W / 2 + 0.35, L / 2 - 0.02, profile[-2][1] - 0.15), m['emit_red']),
        box('tl', (0.5, 0.06, 0.1), (W / 2 - 0.35, L / 2 - 0.02, profile[-2][1] - 0.15), m['emit_red']),
    ]
    # wheels (static for traffic: they are small and far)
    wheels = []
    for sx in (-1, 1):
        for sy in (-0.32, 0.32):
            wheels.append(cyl('w', 0.34, 0.24, (sx * (W / 2 - 0.12), sy * L, 0.34), m['rubber'], 18, rot=(0, math.radians(90), 0)))
            wheels.append(cyl('w', 0.22, 0.25, (sx * (W / 2 - 0.12), sy * L, 0.34), m['metal_grey'], 8, rot=(0, math.radians(90), 0)))
    parts = [body, roof] + lights + wheels + (extra or [])
    j = join(parts, name)
    return [j, glass]


def traffic_cars():
    m = M()
    out = []
    sedan = [(0, 0.35), (0.02, 0.72), (0.25, 0.85), (0.75, 0.88), (0.98, 0.82), (1.0, 0.4), (0.97, 0.22), (0.03, 0.22)]
    out += car_body('car_sedan', 4.6, 1.85, sedan, mat('paint_sedan', (0.5, 0.5, 0.5), 0.6, 0.3), (0.27, 0.78, 0.86, 1.38, 0.18))
    taxi_extra = [box('taxi_sign', (0.6, 0.25, 0.22), (0, 0.15, 1.52), m['emit_amber'], 0.03)]
    out += car_body('car_taxi', 4.5, 1.8, sedan, mat('paint_taxi', (0.9, 0.62, 0.02), 0.4, 0.35), (0.27, 0.78, 0.86, 1.38, 0.18), taxi_extra)
    van = [(0, 0.35), (0.02, 0.9), (0.12, 1.55), (0.2, 1.95), (1.0, 1.98), (1.0, 0.35), (0.97, 0.22), (0.03, 0.22)]
    out += car_body('car_van', 5.2, 2.0, van, mat('paint_van', (0.85, 0.85, 0.86), 0.2, 0.4), (0.13, 0.35, 1.0, 1.85, 0.12))
    hatch = [(0, 0.35), (0.02, 0.7), (0.3, 0.86), (0.9, 0.9), (1.0, 0.75), (1.0, 0.35), (0.97, 0.22), (0.03, 0.22)]
    out += car_body('car_hatch', 4.0, 1.78, hatch, mat('paint_hatch', (0.5, 0.5, 0.5), 0.6, 0.3), (0.3, 0.9, 0.88, 1.42, 0.16))
    return out


# ---------------------------------------------------------------- hero car wheel
def hero_wheel():
    m = M()
    # tire with rounded profile via torus-ish lathe, rim with spokes; axis along X
    parts = []
    bpy.ops.mesh.primitive_torus_add(major_radius=0.27, minor_radius=0.105, major_segments=40, minor_segments=14, location=(0, 0, 0), rotation=(0, math.radians(90), 0))
    t = bpy.context.active_object
    t.scale = (1.0, 1.0, 1.0)
    t.data.materials.append(m['rubber'])
    finish(t, 'tire')
    parts.append(t)
    parts.append(cyl('tread', 0.37, 0.24, (0, 0, 0), m['rubber'], 40, rot=(0, math.radians(90), 0)))
    rim = mat('rim', (0.05, 0.05, 0.055), 0.9, 0.25)
    parts.append(cyl('barrel', 0.255, 0.2, (0, 0, 0), rim, 32, rot=(0, math.radians(90), 0)))
    parts.append(cyl('hub', 0.06, 0.24, (0.0, 0, 0), m['chrome'], 16, rot=(0, math.radians(90), 0)))
    for i in range(10):
        a = i * math.tau / 10
        s = box('spoke', (0.03, 0.05, 0.22), (0.11, math.cos(a) * 0.13, math.sin(a) * 0.13), rim, 0.01)
        s.rotation_euler = (a + math.pi / 2, 0, 0)
        bpy.context.view_layer.objects.active = s
        bpy.ops.object.transform_apply(rotation=True)
        parts.append(s)
    disc = cyl('disc', 0.2, 0.03, (-0.03, 0, 0), m['metal_grey'], 32, rot=(0, math.radians(90), 0))
    cal = box('caliper', (0.06, 0.1, 0.16), (-0.02, 0.0, 0.16), mat('caliper', (0.8, 0.05, 0.05), 0.3, 0.4), 0.02)
    parts += [disc, cal]
    return join(parts, 'hero_wheel')


def build():
    reset()
    m = M()
    objs = [lamp_post(m), hydrant(m), bin_(m), barrier(m), holo_barrier(m), vent(m), ac_unit(m), water_tank(m), antenna(m), bollard(m), bench(m),
            traffic_light(m), *traffic_lamps(m), container(m), rail_portal(m), rail_track(m), train_car(m), billboard_frame(m), sign_bracket(m),
            awning(m), pipe_cluster(m), *traffic_cars(), hero_wheel()]
    # lay them out so they don't overlap in the file (positions are reset in-game)
    for i, o in enumerate(bpy.context.scene.objects):
        if o.parent is None and o.type == 'MESH':
            pass
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=OUT, export_format='GLB', export_apply=True, export_yup=True, export_materials='EXPORT')
    print('exported', OUT, [o.name for o in bpy.context.scene.objects])


if __name__ == '__main__':
    build()
