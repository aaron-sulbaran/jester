// Which landmark pairs to draw as bones. MediaPipe Pose has 33 landmarks: 0 nose, 1-6 eyes, 7-8 ears, 9-10 mouth,
// 11-12 shoulders, 13-14 elbows, 15-16 wrists, 17-22 hands (pinky, index, thumb), 23-24 hips, 25-26 knees,
// 27-28 ankles, 29-32 heels and toes.
export const BODY_BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]];
export const HAND_BONES = [[15, 17], [15, 19], [15, 21], [17, 19], [16, 18], [16, 20], [16, 22], [18, 20]];
export const FOOT_BONES = [[27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32]];
export const FACE_BONES = [[0, 1], [1, 2], [2, 3], [3, 7], [0, 4], [4, 5], [5, 6], [6, 8], [9, 10]];
/** Everything the pose model gives: body, hands, feet and face. */
export const DETAIL_BONES = [...BODY_BONES, ...HAND_BONES, ...FOOT_BONES, ...FACE_BONES];
/** Joints drawn as dots: shoulders, elbows, wrists, hips, knees, ankles. */
export const JOINTS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
