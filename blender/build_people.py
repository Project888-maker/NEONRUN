"""Build game-ready animated people from Meshy rigs + Hunyuan text-to-motion clips.

Usage: /opt/bpyenv/bin/python blender/build_people.py <id> [<id> ...] [--check]
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
# keep root motion (vertical only) for these clips; everything is in place horizontally
MOTIONS = ['idle', 'jump', 'enter_car', 'exit_car', 'talk', 'wave', 'flee', 'phone', 'shrug', 'push', 'fall']


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


def retarget(src, dst, action_name, frame_range, mapping=None):
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
    for f in range(int(f0), int(f1) + 1):
        scene.frame_set(f)
        for t in order:
            s = next((a for a, b in MAP.items() if b == t), None)
            if not s or s not in src.pose.bones:
                continue
            sq, sp = world_rot(src, src.pose.bones[s])
            delta = sq @ src_rest[s].inverted()
            want = (delta @ dst_rest[t]).normalized()
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
    # Meshy basic clips: same skeleton, copy actions directly
    for clip in ('walking', 'running'):
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
        rng = src.animation_data.action.frame_range
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
