"""Build game-ready animated people from Meshy rigs + Hunyuan text-to-motion clips.

Usage: /opt/bpyenv/bin/python blender/build_people.py <id> [<id> ...] [--check] [--mocap]
Inputs:  assets/generated/rig/<id>.glb (+ _basic_animations_walking/running_armature_glb.glb)
         assets/generated/motion/*.fbx (SMPL-H skeleton)
Output:  assets/build/people/<id>.glb  with actions: walk, run, idle, jump, enter_car, exit_car,
         talk, wave, flee, phone, shrug, push, fall  (all in place: the game moves the root)

Retargeting: both skeletons are authored in a T-pose, so for every mapped bone we transfer the
bone's world-space rotation relative to its rest pose:  R_target = (S_pose * S_rest^-1) * T_rest.
Hips height follows the source, scaled by leg length; horizontal root motion is removed.
"""
import glob
import math
import os
import sys

import bpy
from mathutils import Matrix, Quaternion, Vector

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEN = os.path.join(ROOT, 'assets', 'generated')
OUT = os.path.join(ROOT, 'assets', 'build', 'people')

MAP = {
    'Pelvis': 'Hips', 'Spine1': 'Spine02', 'Spine2': 'Spine01', 'Spine3': 'Spine', 'Neck': 'neck', 'Head': 'Head',
    'L_Collar': 'LeftShoulder', 'L_Shoulder': 'LeftArm', 'L_Elbow': 'LeftForeArm', 'L_Wrist': 'LeftHand',
    'R_Collar': 'RightShoulder', 'R_Shoulder': 'RightArm', 'R_Elbow': 'RightForeArm', 'R_Wrist': 'RightHand',
    'L_Hip': 'LeftUpLeg', 'L_Knee': 'LeftLeg', 'L_Ankle': 'LeftFoot', 'L_Foot': 'LeftToeBase',
    'R_Hip': 'RightUpLeg', 'R_Knee': 'RightLeg', 'R_Ankle': 'RightFoot', 'R_Foot': 'RightToeBase',
}
# limb segments (target bone -> the bone at the far end of it), used to align rest directions
SEGMENTS = {
    'Spine02': 'Spine01', 'Spine01': 'Spine', 'Spine': 'neck', 'neck': 'Head',
    'LeftShoulder': 'LeftArm', 'LeftArm': 'LeftForeArm', 'LeftForeArm': 'LeftHand',
    'RightShoulder': 'RightArm', 'RightArm': 'RightForeArm', 'RightForeArm': 'RightHand',
    'LeftUpLeg': 'LeftLeg', 'LeftLeg': 'LeftFoot', 'LeftFoot': 'LeftToeBase',
    'RightUpLeg': 'RightLeg', 'RightLeg': 'RightFoot', 'RightFoot': 'RightToeBase',
}
# keep root motion (vertical only) for these clips; everything is in place horizontally
MOTIONS = ['idle', 'jump', 'enter_car', 'exit_car', 'talk', 'wave', 'flee', 'phone', 'shrug', 'push', 'fall']

# Real motion capture (CMU Graphics Lab database, BVH conversion by B. Hahne; free for any use, see
# assets/mocap/READMEFIRST.txt) replaces the generated clips wherever the database has the action.
# clip -> (file, search window in seconds, loop length range in seconds or None = play the window once)
MOCAP_DIR = os.path.join(ROOT, 'assets', 'mocap')
CMU_MAP = {
    'Hips': 'Hips', 'LowerBack': 'Spine02', 'Spine': 'Spine01', 'Spine1': 'Spine', 'Neck': 'neck', 'Head': 'Head',
    'LeftShoulder': 'LeftShoulder', 'LeftArm': 'LeftArm', 'LeftForeArm': 'LeftForeArm',
    'RightShoulder': 'RightShoulder', 'RightArm': 'RightArm', 'RightForeArm': 'RightForeArm',
    'LeftUpLeg': 'LeftUpLeg', 'LeftLeg': 'LeftLeg', 'LeftFoot': 'LeftFoot',
    'RightUpLeg': 'RightUpLeg', 'RightLeg': 'RightLeg', 'RightFoot': 'RightFoot',
}
# hands and toes are left out on purpose: the capture skeleton's hand and toe bones point differently
# from the generated rigs, and copying them bent wrists sideways; they now follow the forearm / foot
MOCAP = {
    'walk': ('141_25', (1.0, 4.5), (0.95, 1.35)),
    'run': ('141_34', (0.6, 2.4), (0.55, 0.85)),
    'flee': ('141_34', (0.6, 2.4), (0.55, 0.85)),
    'idle': ('77_02', (1.0, 7.5), (3.5, 5.5)),  # relaxed standing; the 'waiting' takes fidgeted
    'talk': ('18_08', (1.0, 16.0), (5.0, 8.0)),
    'wave': ('141_16', (0.2, 2.4), None),
    'shrug': ('141_21', (0.2, 2.2), None),
    # fighting: aimed along the strike (a boxer's hips are turned side-on, so the pelvis would misaim)
    'fight_idle': ('13_17', (5.6, 8.8), (1.0, 2.2), ('shoulders',)),  # the boxer bouncing in guard between punches
    'punch': ('13_17', (1.6, 2.45), None, ('aim', 'RightHand', 61)),
    'jab': ('13_17', (2.85, 3.45), None, ('aim', 'LeftHand', 93)),
    'kick': ('141_14', (1.7, 2.75), None, ('aim', 'RightFoot', 65)),
    'get_up': ('77_16', (0.15, 3.3), None, ('shoulders',)),
}
# impact moments inside the one-shot fight clips (seconds from clip start), for hit timing in game
FIGHT_IMPACT = {'punch': (61 - 1.6 * 30) / 30, 'jab': (93 - 2.85 * 30) / 30, 'kick': (65 - 1.7 * 30) / 30}
if os.environ.get('MOCAP_TRY'):  # preview alternatives: MOCAP_TRY=idle2:140_06,idle3:77_02
    for item in os.environ['MOCAP_TRY'].split(','):
        n, f = item.split(':')
        MOCAP[n] = (f, (1.0, 25.0), (3.5, 5.5))
# per character: an old man walks and waits like one
MOCAP_OVERRIDE = {
    'ped_elder': {'walk': ('07_04', (0.8, 6.0), (1.1, 1.6))},  # a real slow walk (the acted 'old man' take was a caricature)
}
LOOP_BONES = ['LeftUpLeg', 'LeftLeg', 'RightUpLeg', 'RightLeg', 'LeftArm', 'LeftForeArm', 'RightArm', 'RightForeArm', 'Spine', 'LowerBack', 'Head']


def import_bvh(name):
    before = set(o.name for o in bpy.context.scene.objects)
    bpy.ops.import_anim.bvh(filepath=os.path.join(MOCAP_DIR, f'{name}.bvh'), global_scale=0.056, frame_start=1,
                            use_fps_scale=True, update_scene_fps=False, update_scene_duration=False, rotate_mode='NATIVE',
                            axis_forward='-Z', axis_up='Y')
    return next(o for o in bpy.context.scene.objects if o.name not in before and o.type == 'ARMATURE')


def pose_features(src, f):
    bpy.context.scene.frame_set(f)
    out = []
    for b in LOOP_BONES:
        q = src.pose.bones[b].matrix_basis.to_quaternion()
        out.append(q)
    hp = src.pose.bones['Hips'].matrix_basis.to_quaternion()
    return out, hp


def pick_loop(src, window, loop):
    """Frames (a, b) inside the window where the pose at b best matches the pose at a, b - a within the loop range."""
    fps = bpy.context.scene.render.fps
    lo, hi = int(window[0] * fps) + 1, int(window[1] * fps)
    if loop is None:
        return lo, hi
    feats = {f: pose_features(src, f)[0] for f in range(lo, hi + 1)}
    best, pair = 1e9, (lo, hi)
    for a in range(lo, hi + 1):
        for b in range(a + int(loop[0] * fps), min(hi, a + int(loop[1] * fps)) + 1):
            d = sum(qa.rotation_difference(qb).angle for qa, qb in zip(feats[a], feats[b]))
            if d < best:
                best, pair = d, (a, b)
    print('  loop', pair, 'pose error', round(best, 3))
    return pair


def face_forward(src, a, b, moving, heading=None):
    """Yaw that turns the motion's heading onto the source skeleton's rest heading.

    Motion is transferred relative to the rest pose, so the clip has to face the way its own rest
    skeleton faces (turning the whole source object changes nothing). The heading is the travel
    direction for locomotion, the pelvis facing otherwise.
    """
    def pelvis_facing(get):
        l = get('LeftUpLeg') - get('RightUpLeg')
        return l.cross(Vector((0, 0, 1)))
    rest = pelvis_facing(lambda n: src.matrix_world @ src.data.bones[n].head_local)
    W = lambda n: src.matrix_world @ src.pose.bones[n].head
    if heading and heading[0] == 'aim':
        # the strike goes straight ahead: chest -> hand / foot at the moment of impact
        bpy.context.scene.frame_set(int(heading[2]))
        d = W(heading[1]) - W('Spine1')
    elif heading and heading[0] == 'shoulders':
        d = Vector()
        for f in range(a, b + 1, 3):
            bpy.context.scene.frame_set(f)
            d += (W('LeftArm') - W('RightArm')).cross(Vector((0, 0, 1)))
    elif moving:
        def hip(f):
            bpy.context.scene.frame_set(f)
            return src.matrix_world @ src.pose.bones['Hips'].head
        d = hip(b) - hip(a)
    else:
        d = Vector()
        for f in range(a, b + 1, 3):
            bpy.context.scene.frame_set(f)
            d += pelvis_facing(lambda n: src.matrix_world @ src.pose.bones[n].head)
    d.z = rest.z = 0
    if d.length < 1e-4 or rest.length < 1e-4:
        return Quaternion()
    ang = math.atan2(d.x, d.y) - math.atan2(rest.x, rest.y)
    return Quaternion(Vector((0, 0, 1)), ang)


def mocap_clip(arm, name, spec):
    file, window, loop = spec[:3]
    heading = spec[3] if len(spec) > 3 else None
    src = import_bvh(file)
    src.animation_data.action.name = f'src_{name}'
    a, b = pick_loop(src, window, loop)
    yaw = face_forward(src, a, b, name in ('walk', 'run', 'flee'), heading)
    act = retarget(src, arm, name, (a, b), CMU_MAP, yaw, ground_from_end=name == 'get_up')
    act.use_fake_user = True
    arm.animation_data.action = None
    bpy.data.actions.remove(src.animation_data.action)
    bpy.data.objects.remove(src, do_unlink=True)
    push_nla(arm, act)
    print('  mocap', name, 'from', file, 'frames', a, '-', b)


def objects_of(kind, before):
    return [o for o in bpy.context.scene.objects if o.type == kind and o.name not in before]


def import_glb(path):
    before = set(o.name for o in bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [o for o in bpy.context.scene.objects if o.name not in before]


def world_rot(arm, pb_or_bone, rest=False):
    if rest:
        m = arm.matrix_world @ pb_or_bone.matrix_local
    else:
        m = arm.matrix_world @ pb_or_bone.matrix
    return m.to_quaternion().normalized(), m.to_translation()


def retarget(src, dst, action_name, frame_range, mapping=None, yaw=None, ground_from_end=False):
    """Bake src animation onto dst armature as a new action (mapping: src bone -> dst bone)."""
    MAP = mapping or globals()['MAP']
    hip_s = next(k for k, v in MAP.items() if v == 'Hips')
    lhip_s = next(k for k, v in MAP.items() if v == 'LeftUpLeg')
    lank_s = next(k for k, v in MAP.items() if v == 'LeftFoot')
    scene = bpy.context.scene
    dst.animation_data_create()
    act = bpy.data.actions.new(action_name)
    dst.animation_data.action = act
    # rest data
    src_rest = {s: world_rot(src, src.data.bones[s], rest=True)[0] for s in MAP if s in src.data.bones}
    dst_rest = {t: world_rot(dst, dst.data.bones[t], rest=True)[0] for t in MAP.values() if t in dst.data.bones}
    # Rest poses differ: the generated character's T-pose has legs spread and arms out, the motion
    # skeleton stands with legs together. Copying rotations relative to rest kept that difference in
    # every frame (wide stance, stiff arms). Align each limb segment's rest direction first, so the
    # target bone points where the source bone points.
    inv = {v: k for k, v in MAP.items()}
    def rest_head(arm, name):
        return arm.matrix_world @ arm.data.bones[name].head_local
    align = {}
    for t, c in SEGMENTS.items():
        sname, cname = inv.get(t), inv.get(c)
        if cname is None and c in src.data.bones:
            cname = c  # unmapped end bone (hands, toes) that still exists in the source: use it for the direction
        if not sname or not cname:
            continue
        if t in dst.data.bones and c in dst.data.bones and sname in src.data.bones and cname in src.data.bones:
            dd = rest_head(dst, c) - rest_head(dst, t)
            sd = rest_head(src, cname) - rest_head(src, sname)
            if dd.length > 1e-4 and sd.length > 1e-4:
                align[t] = dd.normalized().rotation_difference(sd.normalized())
    # leg length ratio for hips height
    def leg(arm, hip, ank):
        return (arm.matrix_world @ arm.data.bones[hip].head_local - arm.matrix_world @ arm.data.bones[ank].head_local).length
    k = leg(dst, 'LeftUpLeg', 'LeftFoot') / max(1e-4, leg(src, lhip_s, lank_s))
    src_hips0 = (src.matrix_world @ src.data.bones[hip_s].head_local)
    dst_hips0 = (dst.matrix_world @ dst.data.bones['Hips'].head_local)
    order = [b.name for b in dst.data.bones]  # parents come before children
    f0, f1 = frame_range
    start_pose_xz = None
    base_z = None
    if ground_from_end:
        # clips that start on the ground (getting up): the standing end is the height baseline
        scene.frame_set(int(frame_range[1]))
        base_z = world_rot(src, src.pose.bones[hip_s])[1].z
    for f in range(int(f0), int(f1) + 1):
        scene.frame_set(f)
        for t in order:
            s = next((a for a, b in MAP.items() if b == t), None)
            if not s or s not in src.pose.bones:
                continue
            sq, sp = world_rot(src, src.pose.bones[s])
            if yaw is not None:
                sq = yaw @ sq  # turn the whole motion (mocap facing correction)
            delta = sq @ src_rest[s].inverted()
            want = (delta @ align.get(t, Quaternion()) @ dst_rest[t]).normalized()
            pb = dst.pose.bones[t]
            # world -> armature space rotation, keep current head position
            cur = dst.matrix_world @ pb.matrix
            m = Matrix.Translation(cur.to_translation()) @ want.to_matrix().to_4x4() @ Matrix.Diagonal(cur.to_scale()).to_4x4()
            if t == 'Hips':
                # hips: vertical motion scaled, horizontal motion removed (in-place clip)
                if base_z is None:
                    base_z = sp.z  # clips start standing: first frame is the height baseline
                d = Vector((0, 0, sp.z - base_z))
                if start_pose_xz is None:
                    start_pose_xz = Vector((d.x, d.y, 0))
                pos = dst_hips0 + Vector((0, 0, d.z * k))
                m = Matrix.Translation(pos) @ want.to_matrix().to_4x4()
            pb.matrix = dst.matrix_world.inverted() @ m
            bpy.context.view_layer.update()
        for t in order:
            pb = dst.pose.bones[t]
            pb.rotation_mode = 'QUATERNION'
            pb.keyframe_insert('rotation_quaternion', frame=f - f0 + 1)
            if t == 'Hips':
                pb.keyframe_insert('location', frame=f - f0 + 1)
    return act


def push_nla(arm, act):
    tr = arm.animation_data.nla_tracks.new()
    tr.name = act.name
    tr.strips.new(act.name, int(act.frame_range[0]), act)
    tr.mute = False


def build(cid, check=False):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.fps = 30
    new = import_glb(os.path.join(GEN, 'rig', f'{cid}.glb'))
    arm = next(o for o in new if o.type == 'ARMATURE')
    arm.name = 'Armature'
    arm.animation_data_create()
    for a in list(bpy.data.actions):
        bpy.data.actions.remove(a)  # drop the 1-frame bind clip
    mocap = {**MOCAP, **MOCAP_OVERRIDE.get(cid, {})} if '--mocap' in sys.argv else {}
    for name, spec in mocap.items():
        mocap_clip(arm, name, spec)
    # Meshy basic clips: same skeleton, copy actions directly
    for clip in ('walking', 'running'):
        if ('walk' if clip == 'walking' else 'run') in mocap:
            continue
        p = os.path.join(GEN, 'rig', f'{cid}_basic_animations_{clip}_armature_glb.glb')
        if not os.path.exists(p):
            continue
        objs = import_glb(p)
        a2 = next(o for o in objs if o.type == 'ARMATURE')
        rng = a2.animation_data.action.frame_range
        ident = {b.name: b.name for b in arm.data.bones if b.name in a2.data.bones}
        src_act = a2.animation_data.action
        act = retarget(a2, arm, 'walk' if clip == 'walking' else 'run', rng, ident)
        act.use_fake_user = True
        arm.animation_data.action = None
        bpy.data.actions.remove(src_act)
        for o in objs:
            bpy.data.objects.remove(o, do_unlink=True)
        push_nla(arm, act)
    # text-to-motion clips
    for name in MOTIONS:
        if name in mocap:
            continue
        fbx = os.path.join(GEN, 'motion', f'{name}.fbx')
        calm = os.path.join(GEN, 'motion', f'{name}_calm.fbx')
        if os.path.exists(calm):
            fbx = calm  # regenerated, steadier version (the first idle swayed side to side)
        if not os.path.exists(fbx):
            continue
        before = set(o.name for o in scene.objects)
        bpy.ops.import_scene.fbx(filepath=fbx)
        objs = [o for o in scene.objects if o.name not in before]
        src = next(o for o in objs if o.type == 'ARMATURE')
        rng = tuple(src.animation_data.action.frame_range)
        src_act = src.animation_data.action
        act = retarget(src, arm, name, rng)
        act.use_fake_user = True
        arm.animation_data.action = None
        bpy.data.actions.remove(src_act)
        for o in objs:
            bpy.data.objects.remove(o, do_unlink=True)
        push_nla(arm, act)
        print(cid, 'retargeted', name, int(rng[1] - rng[0] + 1), 'frames')
    # reset to rest
    for pb in arm.pose.bones:
        pb.matrix_basis = Matrix()
    os.makedirs(OUT, exist_ok=True)
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, f'{cid}.glb'), export_format='GLB', export_animations=True,
                              export_animation_mode='ACTIONS', export_force_sampling=True, export_frame_range=False, export_image_format='WEBP', export_yup=True)
    print('exported', cid)
    if check:
        render_check(cid, arm)


def render_check(cid, arm):
    """Render a few poses (one frame from several clips) side by side for review."""
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 12
    scene.cycles.use_denoising = False
    scene.render.resolution_x, scene.render.resolution_y = 360, 480
    w = bpy.data.worlds.new('w'); w.use_nodes = True
    w.node_tree.nodes['Background'].inputs[1].default_value = 1.5
    scene.world = w
    cam = bpy.data.cameras.new('c'); cam.type = 'ORTHO'; cam.ortho_scale = 2.4
    co = bpy.data.objects.new('c', cam); scene.collection.objects.link(co); scene.camera = co
    co.location = (3.0, -3.0, 0.95); co.rotation_euler = (math.radians(90), 0, math.radians(45))
    for tr in arm.animation_data.nla_tracks:
        tr.mute = False
    for name in ('walk', 'idle', 'enter_car', 'talk', 'jump', 'flee'):
        act = bpy.data.actions.get(name)
        if not act:
            continue
        arm.animation_data.action = act
        mid = int((act.frame_range[0] + act.frame_range[1]) / 2)
        scene.frame_set(mid)
        scene.render.filepath = os.path.join(OUT, f'{cid}_{name}.png')
        bpy.ops.render.render(write_still=True)


if __name__ == '__main__':
    ids = [a for a in sys.argv[1:] if not a.startswith('--')]
    for cid in ids:
        build(cid, '--check' in sys.argv)
