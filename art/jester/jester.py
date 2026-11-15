"""Procedural Jester sprites. Run with Blender 5.2, then inspect index.html."""
import argparse
import json
import math
from pathlib import Path
import subprocess
import sys
import time

import bpy
from mathutils import Vector

P = argparse.ArgumentParser()
P.add_argument('--out', default='app/public/jester')
P.add_argument('--test', action='store_true', help='Render one still for art direction')
P.add_argument('--badge', action='store_true', help='Render the cap and collar with the face left open, for player face badges')
P.add_argument('--run', action='store_true', help='Render a side profile run cycle (16 frames) for the loading bars')
P.add_argument('--faces', action='store_true', help='Render every animation with a see-through face hole per player colourway, plus where the face sits in each frame')
ARGS = P.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
OUT = Path(ARGS.out).resolve()
OUT.mkdir(parents=True, exist_ok=True)
START = time.monotonic()
PALETTES = {'classic': ('6B2FB3', 'D4243A'), 'lisa': ('E8507A', '6B2FB3'),
            'alex': ('3B82C4', '2E9E6B'), 'aaron': ('F2C14E', 'D4243A')}
ANIMS = {'idle': 24, 'dance': 24, 'win': 24, 'lose': 16}
FPS = 24
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)
scene = bpy.context.scene
scene.render.engine = 'BLENDER_EEVEE'
scene.eevee.taa_render_samples = 32
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.render.image_settings.compression = 20
scene.render.fps = FPS
scene.view_settings.view_transform = 'Standard'
scene.view_settings.exposure = 0
scene.view_settings.gamma = 1
scene.render.dither_intensity = 0
scene.world.color = (.16, .16, .16)


def linear(hexcode):
    c = [int(hexcode[i:i+2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v <= .04045 else ((v + .055) / 1.055) ** 2.4 for v in c)


def set_tones(ramp, color):
    # Work in sRGB for the shadow tint, then let Standard restore the base hex.
    rgb = [int(color[i:i+2], 16) for i in (0, 2, 4)]
    shadow = ''.join(f'{round(c*.82):02X}' for c in rgb)
    for element, hexcode in zip(ramp.color_ramp.elements, (shadow, color)):
        element.color = (*linear(hexcode), 1)


def toon(name, color):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    n = mat.node_tree.nodes
    n.clear()
    geometry = n.new('ShaderNodeNewGeometry')
    light = n.new('ShaderNodeVectorMath')
    light.operation = 'DOT_PRODUCT'
    light.inputs[1].default_value = Vector((-.4, -.65, .65)).normalized()
    ramp = n.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'CONSTANT'
    ramp.color_ramp.elements[0].position = 0
    ramp.color_ramp.elements[1].position = .12
    set_tones(ramp, color)
    emission = n.new('ShaderNodeEmission')
    output = n.new('ShaderNodeOutputMaterial')
    links = mat.node_tree.links
    links.new(geometry.outputs['Normal'], light.inputs[0])
    links.new(light.outputs['Value'], ramp.inputs[0])
    links.new(ramp.outputs[0], emission.inputs[0])
    links.new(emission.outputs[0], output.inputs['Surface'])
    return mat


A = toon('Suit A', '6B2FB3')
B = toon('Suit B', 'D4243A')
GOLD = toon('Marigold', 'F2B630')
SKIN = toon('Porcelain peach', 'F6D9BE')
SHOE = toon('Cobalt shoes', '2F4BB8')
RED = toon('Rouge', 'D4243A')
DARK = toon('Ink features', '211B32')
WHITE = toon('Eye glints', 'FFFFFF')
INK = bpy.data.materials.new('Outline, inverted hull')
INK.use_nodes = True
INK.use_backface_culling = True
nodes = INK.node_tree.nodes
nodes.clear()
e = nodes.new('ShaderNodeEmission')
e.inputs[0].default_value = (.001, .001, .001, 1)
o = nodes.new('ShaderNodeOutputMaterial')
INK.node_tree.links.new(e.outputs[0], o.inputs[0])


def finish(obj, name, mat, parent, outline=.018):
    obj.name = name
    obj.data.materials.append(mat)
    if obj.type == 'MESH':
        for face in obj.data.polygons:
            face.use_smooth = True
        if outline:
            obj.data.materials.append(INK)
            mod = obj.modifiers.new('Ink silhouette', 'SOLIDIFY')
            mod.thickness = outline
            mod.offset = 1
            mod.use_flip_normals = True
            mod.use_rim = False
            mod.material_offset = 1
    obj.parent = parent
    return obj


def empty(name, loc=(0, 0, 0), parent=None):
    obj = bpy.data.objects.new(name, None)
    scene.collection.objects.link(obj)
    obj.parent = parent
    obj.location = loc
    return obj


def ball(name, loc, scale, mat, parent, outline=.018):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=20, location=loc)
    obj = bpy.context.object
    obj.scale = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(obj, name, mat, parent, outline)


def capsule(name, start, end, radius, mat, parent):
    start, end = Vector(start), Vector(end)
    direction = (end-start).normalized()
    across = Vector((1, 0, 0))
    around = direction.cross(across).normalized()
    profile = ((0, .001), (.025, .48), (.07, .80), (.15, .96),
               (.30, 1.06), (.50, 1.12), (.70, 1.04), (.85, .94),
               (.93, .76), (.975, .45), (1, .001))
    vertices, faces = [], []
    segments = 32
    for along, width in profile:
        center = start.lerp(end, along)
        for i in range(segments):
            angle = 2*math.pi*i/segments
            offset = radius*width*(across*math.cos(angle)+around*math.sin(angle))
            vertices.append(tuple(center+offset))
    for j in range(len(profile)-1):
        for i in range(segments):
            k = j*segments+i
            following = j*segments+(i+1)%segments
            faces.append((k, following, following+segments, k+segments))
    faces.extend((tuple(reversed(range(segments))),
                  tuple(range((len(profile)-1)*segments, len(profile)*segments))))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    finish(obj, name, mat, parent, .016)
    smooth = obj.modifiers.new('Rounded tailored fabric', 'SUBSURF')
    smooth.levels = smooth.render_levels = 1
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.modifier_move_up(modifier=smooth.name)
    return obj


def tube(name, points, radius, mat, parent):
    curve = bpy.data.curves.new(name, 'CURVE')
    curve.dimensions = '3D'
    curve.resolution_u = 16
    curve.bevel_depth = radius
    curve.bevel_resolution = 4
    s = curve.splines.new('BEZIER')
    s.bezier_points.add(len(points)-1)
    for p, xyz in zip(s.bezier_points, points):
        p.co = xyz
        p.handle_left_type = p.handle_right_type = 'AUTO'
    obj = bpy.data.objects.new(name, curve)
    scene.collection.objects.link(obj)
    obj.parent = parent
    obj.data.materials.append(mat)
    return obj


hips = empty('Hips', (0, 0, 1.05))
torso = empty('Torso', (0, 0, .25), hips)
head = empty('Head', (0, 0, 1.45), torso)
# A single seamless body mesh with material assignment across its center.
body = ball('Split velvet tunic', (0, 0, .22), (.51, .34, .65), A, torso)
body.data.materials.clear()
for material in (A, B, INK): body.data.materials.append(material)
body.modifiers[0].material_offset = 2
# Use polygon vertex centers because mesh centers update on depsgraph evaluation.
for f in body.data.polygons:
    f.material_index = 0 if sum(body.data.vertices[v].co.x for v in f.vertices) < 0 else 1
# Gold piping follows the rounded front of the suit.
tube('Center gold braid', [(0, -.30, -.21), (0, -.35, .20), (0, -.28, .69)], .023, GOLD, torso)
for z, y in ((-.05, -.355), (.20, -.368), (.45, -.34)):
    ball('Round brass button', (0, y-.024, z), (.066, .037, .066), GOLD, torso, .009)
ball('Face', (0, 0, .07), (.77, .57, .77), SKIN, head, .024)
for side in (-1, 1):
    x = side * .265
    ball('Oval eye', (x, -.534, .18), (.072, .034, .111), DARK, head, .005)
    ball('Catchlight', (x-.017, -.568, .222), (.021, .012, .027), WHITE, head, 0)
    # Thin diamond applique sits on the curved cheek surface.
    verts = [(x, -.541, -.02), (x+.074, -.541, -.115), (x, -.541, -.21), (x-.074, -.541, -.115)]
    mesh = bpy.data.meshes.new('Diamond')
    mesh.from_pydata(verts, [], [(0, 3, 2, 1)])
    obj = bpy.data.objects.new('Red cheek diamond', mesh)
    scene.collection.objects.link(obj)
    finish(obj, obj.name, RED, head, 0)
    ball('Ear', (side*.73, 0, .01), (.12, .13, .18), SKIN, head, .013)
ball('Button nose', (0, -.579, .015), (.077, .059, .065), SKIN, head, .006)
tube('Mischievous smile', [(-.17, -.539, -.245), (0, -.565, -.295), (.17, -.539, -.245)], .018, DARK, head)
# Crown collar: rounded gold base and alternating triangular rays around the neck.
ball('Collar cushion', (0, 0, .78), (.61, .40, .12), GOLD, torso, .014)
verts, faces = [], []
for i in range(12):
    t = 2*math.pi*i/12
    for angle, r, z in ((t-.23, .38, .83), (t, .70, .61), (t+.23, .38, .83)):
        verts.append((r*math.cos(angle), r*.68*math.sin(angle), z))
    faces.append((3*i, 3*i+1, 3*i+2))
mesh = bpy.data.meshes.new('Crown collar rays')
mesh.from_pydata(verts, [], faces)
obj = bpy.data.objects.new('Gold zigzag collar', mesh)
scene.collection.objects.link(obj)
finish(obj, obj.name, GOLD, torso, .012)
# Split skullcap is a hemisphere, so the face stays visible below the brow.
verts, faces = [], []
for j in range(9):
    theta = .001 + (math.pi/2-.001)*j/8
    for i in range(49):
        phi = 2*math.pi*i/48
        verts.append((.79*math.sin(theta)*math.cos(phi), .585*math.sin(theta)*math.sin(phi), .49+.43*math.cos(theta)))
for j in range(8):
    for i in range(48):
        k=j*49+i
        faces.append((k,k+49,k+50,k+1))
mesh = bpy.data.meshes.new('Split cap dome')
mesh.from_pydata(verts, [], faces)
obj = bpy.data.objects.new('Two tone cap', mesh)
scene.collection.objects.link(obj)
finish(obj, obj.name, A, head, .019)
obj.data.materials.clear()
for material in (A, B, INK): obj.data.materials.append(material)
for f in mesh.polygons:
    f.material_index = 0 if sum(mesh.vertices[v].co.x for v in f.vertices) < 0 else 1
obj.modifiers[0].material_offset = 2
caps, arms, elbows, legs, knees = [], [], [], [], []
for side, mat in ((-1, A), (1, B)):
    cap = empty('Floppy cap point', (side*.44, 0, .74), head)
    caps.append(cap)
    # Ring mesh follows a drooping centerline, tapering all the way to the bell.
    centers = [(0,0,0,.32), (side*.23,0,.28,.29), (side*.53,0,.27,.22),
               (side*.72,-.015,.06,.145), (side*.76,-.035,-.22,.07), (side*.73,-.045,-.32,.012)]
    vv, ff = [], []
    for x,y,z,r in centers:
        j = len(vv)//24
        previous = Vector(centers[max(0,j-1)][:3])
        following = Vector(centers[min(len(centers)-1,j+1)][:3])
        tangent = (following-previous).normalized()
        u = Vector((0,1,0))
        v = tangent.cross(u).normalized()
        for i in range(24):
            a=2*math.pi*i/24
            point=Vector((x,y,z))+r*(u*math.cos(a)+v*math.sin(a))
            vv.append(tuple(point))
    for j in range(len(centers)-1):
        for i in range(24):
            k=j*24+i
            ff.append((k,j*24+(i+1)%24,(j+1)*24+(i+1)%24,k+24))
    ff.extend([tuple(reversed(range(24))), tuple(range(120,144))])
    me=bpy.data.meshes.new('Curled cap rings')
    me.from_pydata(vv,[],ff)
    ob=bpy.data.objects.new('Velvet floppy horn',me)
    scene.collection.objects.link(ob)
    finish(ob,ob.name,mat,cap,.02)
    sub=ob.modifiers.new('Soft sewn cap','SUBSURF'); sub.levels=2
    bpy.context.view_layer.objects.active=ob
    bpy.ops.object.modifier_move_up(modifier=sub.name)
    bell=ball('Gold bell',(side*.73,-.045,-.36),(.13,.12,.145),GOLD,cap,.012)
    tube('Bell slit',[(side*.73-.055,-.159,-.40),(side*.73,-.169,-.425),(side*.73+.055,-.159,-.40)],.011,DARK,cap)
    arm=empty('Upper arm',(side*.59,0,.59),torso); arms.append(arm)
    arm.rotation_euler.y=side*-.12
    capsule('Puffed sleeve',(0,0,.10),(0,0,-.68),.185,mat,arm)
    elbow=empty('Lower arm',(0,0,-.57),arm); elbows.append(elbow)
    capsule('Tapered forearm',(0,0,.13),(0,0,-.46),.115,mat,elbow)
    ball('Gold cuff',(0,0,-.36),(.14,.15,.055),GOLD,elbow,.011)
    ball('Mitten',(0,-.015,-.50),(.16,.14,.17),SKIN,elbow,.014)
    ball('Thumb',(-side*.11,-.06,-.46),(.072,.08,.09),SKIN,elbow,.008)
    leg=empty('Thigh',(side*.255,0,.02),hips); legs.append(leg)
    capsule('Puffy trouser',(0,0,.13),(0,0,-.54),.195,mat,leg)
    knee=empty('Shin',(0,0,-.43),leg); knees.append(knee)
    capsule('Tapered stocking',(0,0,.11),(0,0,-.36),.115,mat,knee)
    ball('Ankle gold trim',(0,0,-.28),(.14,.15,.055),GOLD,knee,.01)
    shoe=ball('Round blue shoe',(side*.045,-.15,-.41),(.23,.36,.16),SHOE,knee)
    ball('Curled toe',(side*.10,-.37,-.36),(.15,.19,.13),SHOE,knee,.014)

bpy.ops.object.camera_add(location=(3.1,-11,5.1))
camera=bpy.context.object
camera.rotation_euler=(Vector((0,0,2.65))-camera.location).to_track_quat('-Z','Y').to_euler()
camera.data.type='ORTHO'; camera.data.ortho_scale=6.1
scene.camera=camera
for name,loc,power,size in [('Key',(-3,-5,8),900,4),('Fill',(4,-2,5),350,5)]:
    bpy.ops.object.light_add(type='AREA',location=loc)
    light=bpy.context.object; light.name=name; light.data.energy=power; light.data.shape='DISK'; light.data.size=size
    light.rotation_euler=(Vector((0,0,2))-light.location).to_track_quat('-Z','Y').to_euler()

rig=[hips,torso,head]+caps+arms+elbows+legs+knees
base={o: (o.location.copy(), o.rotation_euler.copy(), o.scale.copy()) for o in rig}

def smooth_keys(frame, keys):
    for (f0, values0), (f1, values1) in zip(keys, keys[1:]):
        if f0 <= frame <= f1:
            u = (frame-f0)/(f1-f0)
            u = u*u*(3-2*u)
            return tuple(a+(b-a)*u for a, b in zip(values0, values1))
    return keys[-1][1]


def raise_arms(amount, swing=0):
    # Long chibi sleeves stretch during the overhead gesture to clear the cap.
    for i, side in enumerate((-1, 1)):
        arms[i].rotation_euler.y = -side*(.12+2.64*amount)
        arms[i].rotation_euler.x = swing*(1-.85*amount)
        arms[i].scale.z = 1+.95*amount
        elbows[i].rotation_euler.x = -.16*(1-amount)


def pose(anim, frame):
    for ob, (loc, rot, scale) in base.items():
        ob.location=loc; ob.rotation_euler=rot; ob.scale=scale
    t=frame/ANIMS[anim]; p=2*math.pi*t
    if anim=='idle':
        hips.location.z += .065*(1-math.cos(p))
        hips.location.x = .075*math.sin(p)
        torso.rotation_euler.z = .045*math.sin(p)
        head.rotation_euler.y = -.065*math.sin(p)
        head.rotation_euler.x = .035*math.sin(p)
        for i, cap in enumerate(caps):
            cap.rotation_euler.y = .10*math.sin(p-.6+i*.4)
    elif anim=='dance':
        sway=math.sin(p)
        lift=.5-.5*math.cos(2*p)
        hips.location.x = .36*sway
        hips.location.z += .10*(1-math.cos(2*p))
        hips.rotation_euler.y = .12*sway
        torso.rotation_euler.z = math.radians(20)*sway
        torso.rotation_euler.y = -.12*sway
        head.location.z += .085*math.sin(2*p)
        head.rotation_euler.x = .14*math.sin(2*p)
        head.rotation_euler.y = .16*sway
        head.rotation_euler.z = -.12*sway
        raise_arms(lift, .55*sway)
        for i, side in enumerate((-1, 1)):
            knee_lift=max(0, math.sin(p+i*math.pi))
            # Beyond horizontal at the peak, so the knee reaches hip height.
            legs[i].rotation_euler.x = -1.85*knee_lift
            legs[i].rotation_euler.y = side*.16*knee_lift
            knees[i].rotation_euler.x = 1.95*knee_lift
            caps[i].rotation_euler.x = -1.5*head.rotation_euler.x+.20*math.sin(2*p-.65)
            caps[i].rotation_euler.y = -1.6*head.rotation_euler.y+.28*math.sin(2*p-.7+side*.3)
    elif anim=='win':
        # Height, arm raise, squash, yaw, lean. Apex lift is one third of the body.
        z, raised, squash, yaw, lean = smooth_keys(frame, [
            (0, (0, 0, 1, 0, 0)),
            (4, (-.27, .06, .82, -.10, -.08)),
            (7, (.48, .95, 1.08, .08, .04)),
            (10, (1.30, 1, 1, .32, -.12)),
            (12, (1.30, 1, 1, .55, -.16)),
            (16, (.38, 1, 1.04, .20, -.05)),
            (18, (-.25, .55, .74, -.08, .10)),
            (21, (.06, .35, 1.05, .02, -.03)),
            (23, (0, .18, 1, 0, 0)),
        ])
        hips.location.z += z
        hips.rotation_euler.z = yaw
        torso.rotation_euler.y = lean
        # Scale the torso around the hips, leaving the legs independent.
        torso.scale = (1+(1-squash)*.5, 1+(1-squash)*.35, squash)
        raise_arms(raised)
        crouch=max(0, -z/.27)
        for i, side in enumerate((-1, 1)):
            legs[i].rotation_euler.x = -1.05*crouch+.12*max(0,z/1.30)
            knees[i].rotation_euler.x = 1.9*crouch+.15*max(0,z/1.30)
            caps[i].rotation_euler.y = side*.40*math.sin(frame*1.15)*math.sin(math.pi*t)
            caps[i].rotation_euler.x = .25*math.sin(frame*.95)*math.sin(math.pi*t)
    elif anim=='run':
        # A side profile run: legs swing forward and back with the knee folding on the way through, arms pump
        # against the legs, a forward lean, two bounces per stride, cap points flopping behind.
        for i, side in enumerate((-1, 1)):
            phase = p + i*math.pi
            legs[i].rotation_euler.x = -.95*math.sin(phase)
            knees[i].rotation_euler.x = 1.35*max(0, math.sin(phase + 1.2))
            arms[i].rotation_euler.x = -.95*math.sin(phase + math.pi)
            elbows[i].rotation_euler.x = -1.15
            caps[i].rotation_euler.x = .32*math.sin(2*p - .9) - .25
        hips.location.z += .11*abs(math.sin(p))
        torso.rotation_euler.x = .32
        head.rotation_euler.x = -.16 + .05*math.sin(2*p)
    else:
        slump, shrug = smooth_keys(frame, [
            (0, (0, 0)), (5, (1, 0)), (8, (1, .15)),
            (10, (1, 1)), (12, (1, 1)), (15, (1, 0)),
        ])
        hips.location.z -= .10*slump
        torso.rotation_euler.x = .17*slump
        head.rotation_euler.x = .36*slump
        head.rotation_euler.y = -.12*slump
        head.location.z -= .09*slump
        for i, side in enumerate((-1, 1)):
            arms[i].location.z -= .16*slump-.13*shrug
            arms[i].rotation_euler.y = -side*(.04+.38*shrug)
            elbows[i].rotation_euler.x = -.65*shrug
            caps[i].rotation_euler.x = .17*slump
            caps[i].rotation_euler.y = side*.12*slump
            legs[i].rotation_euler.x = -.52*slump
            knees[i].rotation_euler.x = 1.0*slump
    for ob in rig:
        ob.keyframe_insert(data_path='location', frame=frame)
        ob.keyframe_insert(data_path='rotation_euler', frame=frame)
        ob.keyframe_insert(data_path='scale', frame=frame)
    scene.frame_set(frame)
    bpy.context.view_layer.update()


def palette(colors):
    for material,color in zip((A,B),colors):
        ramp=next(n for n in material.node_tree.nodes if n.type=='VALTORGB')
        set_tones(ramp, color)


def render(path,size):
    scene.render.resolution_x=scene.render.resolution_y=size
    scene.render.filepath=str(path)
    bpy.ops.render.render(write_still=True)


if ARGS.run:
    # The loading bar runner: the classic jester seen from its side, running to the right, 16 frames a loop.
    ANIMS['run'] = 16
    SIZE = 192
    # Mostly side on, turned a little toward the front so both cap points and the face still read.
    camera.location = (-11 * math.cos(math.radians(30)), -11 * math.sin(math.radians(30)), 1.95)
    camera.rotation_euler = (Vector((0, 0, 1.95)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
    camera.data.ortho_scale = 4.7
    palette(PALETTES['classic'])
    for ob in rig: ob.animation_data_clear()
    for frame in range(17):
        pose('run', frame)
    TEMP = OUT / '_run'
    TEMP.mkdir(exist_ok=True)
    for frame in range(16):
        scene.frame_set(frame)
        render(TEMP / f'run-{frame:02}.png', SIZE)
    subprocess.run(['/usr/bin/env', 'python3', '-c', r"""
from PIL import Image
from pathlib import Path
import sys, shutil
out = Path(sys.argv[1])
strip = Image.new('RGBA', (192 * 16, 192))
for f in range(16):
    with Image.open(out / '_run' / f'run-{f:02}.png') as im:
        strip.paste(im, (192 * f, 0))
strip.save(out / 'classic-run.webp', format='WEBP', quality=82, method=4, alpha_quality=100)
shutil.rmtree(out / '_run')
""", str(OUT)], check=True)
    print('RUN_SECONDS', round(time.monotonic() - START, 2))
    sys.exit(0)

if ARGS.faces:
    # Player jesters: the face is a holdout (transparent, but it still hides what is behind it) with its ink
    # outline, so the browser can draw a player's photo into the hole. face-track.json says where the hole is
    # in every frame (centre, radius, sideways squash from turning, tilt), in pixels of the 384 px frame.
    from bpy_extras.object_utils import world_to_camera_view
    hole = bpy.data.materials.new('Face hole')
    hole.use_nodes = True
    hn = hole.node_tree.nodes
    hn.clear()
    hold = hn.new('ShaderNodeHoldout')
    hout = hn.new('ShaderNodeOutputMaterial')
    hole.node_tree.links.new(hold.outputs[0], hout.inputs['Surface'])
    for ob in scene.objects:
        if ob.name.startswith('Face'):
            ob.material_slots[0].link = 'OBJECT'
            ob.material_slots[0].material = hole
            face_ob = ob
        elif ob.name.startswith(('Oval eye', 'Catchlight', 'Red cheek diamond', 'Ear', 'Button nose', 'Mischievous smile')):
            ob.hide_render = True
    PLAYERS = {'p1': ('F47FA6', '6B2FB3'), 'p2': ('4F7BF0', 'FFC93C'), 'p3': ('FFC93C', 'D4243A'), 'p4': ('3FBF8F', '4F7BF0')}
    SIZE = 384
    def to_px(point):
        v = world_to_camera_view(scene, camera, point)
        return Vector((v.x * SIZE, (1 - v.y) * SIZE))
    track = {}
    TEMP = OUT / '_faces'
    TEMP.mkdir(exist_ok=True)
    first = True
    for variant, colors in PLAYERS.items():
        palette(colors)
        for anim, count in ANIMS.items():
            for ob in rig: ob.animation_data_clear()
            for frame in range(count + (1 if anim in ('idle', 'dance') else 0)):
                pose(anim, frame)
            rows = []
            for frame in range(count):
                scene.frame_set(frame)
                bpy.context.view_layer.update()
                m = head.matrix_world
                c = to_px(m @ Vector((0, 0, .07)))
                up = to_px(m @ Vector((0, 0, .07 + .77)))
                side = to_px(m @ Vector((.77, 0, .07)))
                r = (up - c).length
                rot = math.atan2(up.x - c.x, -(up.y - c.y))
                rows.append([round(c.x, 1), round(c.y, 1), round(r, 1), round(min(1.0, (side - c).length / max(r, 1e-6)), 3), round(rot, 3)])
                render(TEMP / f'face-{variant}-{anim}-{frame:02}.png', SIZE)
            if first or anim not in track:
                track[anim] = {'frames': count, 'loop': anim in ('idle', 'dance'), 'face': rows}
        first = False
        print('FACES_VARIANT', variant, round(time.monotonic() - START, 2), flush=True)
    manifest = {'fps': FPS, 'frameSize': SIZE, 'variants': {k: ['#' + a for a in v] for k, v in PLAYERS.items()}, 'anims': track}
    (OUT / 'face-track.json').write_text(json.dumps(manifest))
    subprocess.run(['/usr/bin/env', 'python3', '-c', r"""
from PIL import Image
from pathlib import Path
import json, sys, shutil
out = Path(sys.argv[1]); data = json.loads((out / 'face-track.json').read_text())
for variant in data['variants']:
    for anim, meta in data['anims'].items():
        strip = Image.new('RGBA', (384 * meta['frames'], 384))
        for f in range(meta['frames']):
            with Image.open(out / '_faces' / f'face-{variant}-{anim}-{f:02}.png') as im:
                strip.paste(im, (384 * f, 0))
        strip.save(out / f'face-{variant}-{anim}.webp', format='WEBP', quality=80, method=4, alpha_quality=100)
shutil.rmtree(out / '_faces')
""", str(OUT)], check=True)
    print('FACES_SECONDS', round(time.monotonic() - START, 2))
    sys.exit(0)

if ARGS.badge:
    # Arcade style face badge: the jester's cap and collar seen straight on, with the face, ears and body hidden,
    # so the browser can put a player's photographed face in the opening (like Mario Kart arcade results).
    pose('idle', 0)
    HIDE = ('Face', 'Oval eye', 'Catchlight', 'Red cheek diamond', 'Ear', 'Button nose', 'Mischievous smile',
            'Split velvet tunic', 'Center gold braid', 'Round brass button', 'Puffed sleeve', 'Tapered forearm',
            'Gold cuff', 'Mitten', 'Thumb', 'Puffy trouser', 'Tapered stocking', 'Ankle gold trim',
            'Round blue shoe', 'Curled toe')
    for ob in scene.objects:
        if ob.name.startswith(HIDE):
            ob.hide_render = True
    bpy.context.view_layer.update()
    face_center = head.matrix_world @ Vector((0, 0, .07))
    SIZE, SPAN = 512, 3.1
    cam_z = face_center.z + .22
    camera.location = (face_center.x, face_center.y - 10, cam_z)
    camera.rotation_euler = (math.pi / 2, 0, 0)
    camera.data.ortho_scale = SPAN
    to_px = SIZE / SPAN
    meta = {'size': SIZE, 'face': {'cx': round(SIZE / 2 + (face_center.x - camera.location.x) * to_px, 1),
                                   'cy': round(SIZE / 2 - (face_center.z - cam_z) * to_px, 1),
                                   'rx': round(.77 * to_px, 1), 'ry': round(.77 * to_px, 1)},
            'variants': {}}
    for variant, colors in PALETTES.items():
        palette(colors)
        render(OUT / f'_{variant}-badge.png', SIZE)
        subprocess.run(['/usr/bin/env', 'python3', '-c',
                        "from PIL import Image; from pathlib import Path; import sys; "
                        "p=Path(sys.argv[1]); im=Image.open(p); "
                        "im.save(p.with_name(p.name[1:]).with_suffix('.webp'),format='WEBP',quality=85,method=4,alpha_quality=100); "
                        "im.close(); p.unlink()", str(OUT / f'_{variant}-badge.png')], check=True)
        meta['variants'][variant] = {'file': f'{variant}-badge.webp', 'colors': ['#' + c for c in colors]}
    (OUT / 'badge.json').write_text(json.dumps(meta, indent=2))
    print('BADGE_SECONDS', round(time.monotonic() - START, 2))
    sys.exit(0)

if ARGS.test:
    pose('idle',0)
    render(OUT/'_test.png',768)
    subprocess.run(['/usr/bin/env', 'python3', '-c',
                    "from PIL import Image; from pathlib import Path; import sys; "
                    "p=Path(sys.argv[1]); im=Image.open(p); "
                    "im.save(p.with_name('test.webp'),format='WEBP',quality=80,method=4,alpha_quality=100); "
                    "im.close(); p.unlink()", str(OUT/'_test.png')], check=True)
    print('TEST_SECONDS',round(time.monotonic()-START,2))
    sys.exit(0)

TEMP=OUT/'_frames'
TEMP.mkdir(exist_ok=True)
manifest={'fps':FPS,'format':'webp','frameSize':{'width':384,'height':384},'variants':{},'strips':{}}
for variant,colors in PALETTES.items():
    palette(colors)
    manifest['variants'][variant]={'colors':['#'+c for c in colors],'still':f'{variant}-still.webp'}
    for anim,count in ANIMS.items():
        for ob in rig: ob.animation_data_clear()
        for frame in range(count+(1 if anim in ('idle','dance') else 0)):
            pose(anim,frame)
        for frame in range(count):
            scene.frame_set(frame)
            render(TEMP/f'{variant}-{anim}-{frame:02}.png',384)
        if anim=='idle':
            scene.frame_set(0)
            render(TEMP/f'{variant}-still.png',768)
        manifest['strips'][f'{variant}-{anim}']={'file':f'{variant}-{anim}.webp','frames':count,'frameWidth':384,'frameHeight':384,'fps':FPS,'loop':anim in ('idle','dance')}
    print('VARIANT_COMPLETE',variant,round(time.monotonic()-START,2),flush=True)
# System Pillow is intentionally used instead of installing into Blender's Python.
assembler=r'''
from PIL import Image, ImageDraw
from pathlib import Path
import json, sys, shutil
out=Path(sys.argv[1]); data=json.loads((out/'manifest.json').read_text())
sheet=Image.new('RGB',(4*256,4*282),'#211b32'); draw=ImageDraw.Draw(sheet)
for idx,(name,meta) in enumerate(data['strips'].items()):
    strip=Image.new('RGBA',(384*meta['frames'],384))
    for f in range(meta['frames']):
        with Image.open(out/'_frames'/f'{name}-{f:02}.png') as im:
            strip.paste(im,(384*f,0))
    strip.save(out/meta['file'],format='WEBP',quality=80,method=4,alpha_quality=100)
    first=strip.crop((0,0,384,384)); first.thumbnail((256,256))
    x=(idx%4)*256; y=(idx//4)*282
    sheet.paste(first,(x,y),first); draw.text((x+12,y+259),name,fill='white')
for variant,meta in data['variants'].items():
    with Image.open(out/'_frames'/f'{variant}-still.png') as still:
        still.save(out/meta['still'],format='WEBP',quality=80,method=4,alpha_quality=100)
sheet.save(out/'contact-sheet.png')
# Remove only superseded mascot files, after every WebP has encoded successfully.
for meta in list(data['strips'].values()):
    (out/meta['file']).with_suffix('.png').unlink(missing_ok=True)
for meta in data['variants'].values():
    (out/meta['still']).with_suffix('.png').unlink(missing_ok=True)
shutil.rmtree(out/'_frames')
'''
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
subprocess.run(['/usr/bin/env','python3','-c',assembler,str(OUT)],check=True)
html='''<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jester | mascot rehearsal</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#15101f;color:#fff4df;font:15px system-ui,sans-serif;padding:36px}header{max-width:1200px;margin:auto auto 28px}h1{font-size:40px;margin:0 0 8px}p{color:#c7b8d5}button{font:inherit;background:#f2b630;color:#211b32;border:0;border-radius:8px;padding:9px 18px;cursor:pointer}.grid{display:grid;grid-template-columns:90px repeat(4,minmax(160px,1fr));gap:14px;max-width:1400px;margin:auto}.heading{text-align:center;font-size:12px;text-transform:uppercase;letter-spacing:.16em}.variant{align-self:center;text-transform:capitalize;font-weight:700}.card{min-width:0;text-align:center}.stage{height:280px;border-radius:16px;overflow:hidden;position:relative;background:radial-gradient(ellipse at 50% 0%,#fbe1a440,transparent 65%),#282033}.stage:before{content:"";position:absolute;inset:0;background:conic-gradient(from 155deg at 50% -20%,transparent,#ffe3a315 5deg 45deg,transparent 50deg);pointer-events:none}.floor{position:absolute;bottom:0;width:100%;height:64px;background:repeating-linear-gradient(0deg,transparent 0 19px,#2c182480 20px 22px),repeating-linear-gradient(90deg,#68442f 0 65px,#805239 66px 130px,#41291f 131px 133px);transform:perspective(200px) rotateX(20deg);transform-origin:bottom;box-shadow:inset 0 16px 24px #0008}.shadow{position:absolute;bottom:27px;left:30%;width:40%;height:15px;background:#0005;border-radius:50%;filter:blur(4px)}.sprite{position:absolute;width:256px;height:256px;left:50%;bottom:8px;margin-left:-128px;background-repeat:no-repeat;background-size:var(--strip-width) 256px;animation:play var(--duration) steps(var(--frames)) infinite}.once{animation-iteration-count:1;animation-fill-mode:forwards;animation-name:once}.label{padding:10px;font-size:12px;color:#c7b8d5}@keyframes play{to{background-position-x:var(--loop-end)}}@keyframes once{to{background-position-x:var(--once-end)}}@media(max-width:850px){body{padding:20px}.grid{grid-template-columns:70px repeat(4,200px);overflow:auto}.stage{height:260px}}@media(prefers-reduced-motion:reduce){.sprite{animation-play-state:paused}}
</style>
<header><h1>Jester rehearsal</h1><p>Four costumes. One court fool. Idle and dance loop; win and lose play once.</p><button id="replay">Replay reactions</button></header>
<div class="grid"><div></div><div class="heading">Idle</div><div class="heading">Dance</div><div class="heading">Win</div><div class="heading">Lose</div>
'''
for variant in PALETTES:
    html+=f'<div class="variant">{variant}</div>'
    for anim,count in ANIMS.items():
        # One-shot strips use n-1 intervals so forwards holds the last visible cell.
        intervals=count if anim in ('idle','dance') else count-1
        cls='sprite' if anim in ('idle','dance') else 'sprite once'
        html+=f'<div class="card"><div class="stage"><div class="floor"></div><div class="shadow"></div><div role="img" aria-label="{variant} jester {anim}" class="{cls}" style="--frames:{count};--strip-width:{count*256}px;--loop-end:{-count*256}px;--once-end:{-(count-1)*256}px;--duration:{(count if anim in ('idle','dance') else count-1)/FPS}s;background-image:url({variant}-{anim}.webp);animation-timing-function:steps({intervals})"></div></div><div class="label">{variant} / {anim} / {count} frames</div></div>'
html+='''</div><script>const probe=new Image();probe.onerror=()=>{const p=document.createElement('p');p.textContent='Sprites have not been rendered yet. Run the Blender command to populate this stage.';document.querySelector('header').append(p)};probe.src='classic-idle.webp';document.querySelector('#replay').onclick=()=>{document.querySelectorAll('.once').forEach(el=>{el.style.animationName='none';void el.offsetWidth;el.style.animationName='once'})}</script></html>'''
(OUT/'index.html').write_text(html)
seconds=round(time.monotonic()-START,2)
manifest['renderSeconds']=seconds
manifest['rendered']=True
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(f'JESTER_COMPLETE: 16 strips, 4 stills, contact sheet, manifest, preview. {seconds} seconds.',flush=True)
