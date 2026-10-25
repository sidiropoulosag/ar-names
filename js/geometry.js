// Geometry helpers: similarity transform (Umeyama), head pose, boxes.

// ArcFace / SFace 112x112 5-point template.
export const TEMPLATE_112 = [
  [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
  [41.5493, 92.3655], [70.7299, 92.2041],
];

// Least-squares similarity transform mapping src -> dst. Returns [a, b, tx, ty]
// meaning x' = a*x - b*y + tx ; y' = b*x + a*y + ty
export function similarity(src, dst) {
  const n = src.length;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { sx += src[i][0]; sy += src[i][1]; dx += dst[i][0]; dy += dst[i][1]; }
  sx /= n; sy /= n; dx /= n; dy /= n;
  let num1 = 0, num2 = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const x = src[i][0] - sx, y = src[i][1] - sy;
    const u = dst[i][0] - dx, v = dst[i][1] - dy;
    num1 += x * u + y * v;
    num2 += x * v - y * u;
    den += x * x + y * y;
  }
  const a = num1 / den, b = num2 / den;
  return [a, b, dx - (a * sx - b * sy), dy - (b * sx + a * sy)];
}

// Approximate head pose (degrees) from the 5 YuNet points
// [image-left eye, image-right eye, nose, image-left mouth, image-right mouth], image coords (y down).
// yaw > 0: face turned towards image-right. pitch > 0: looking down. roll > 0: clockwise on screen.
export function poseFrom5(k) {
  const ex = (k[0][0] + k[1][0]) / 2, ey = (k[0][1] + k[1][1]) / 2;
  const mx = (k[3][0] + k[4][0]) / 2, my = (k[3][1] + k[4][1]) / 2;
  const roll = Math.atan2(k[1][1] - k[0][1], k[1][0] - k[0][0]);
  const c = Math.cos(-roll), s = Math.sin(-roll);
  const rot = (x, y) => [(x - ex) * c - (y - ey) * s, (x - ex) * s + (y - ey) * c];
  const [nx, ny] = rot(k[2][0], k[2][1]);
  const [, mY] = rot(mx, my);
  const iod = Math.hypot(k[1][0] - k[0][0], k[1][1] - k[0][1]) || 1;
  const faceH = Math.max(mY, iod * 0.5);
  // nose tip sits ~0.5 IOD in front of the eye plane; eyes foreshorten with cos(yaw)
  const yaw = Math.atan(2 * nx / iod);
  const r = ny / faceH; // ~0.55 frontal; bigger = looking down
  const pitch = Math.atan((r - 0.55) * 3);
  const D = 180 / Math.PI;
  return { yaw: yaw * D, pitch: pitch * D, roll: roll * D, up: [ex - mx, ey - my], iod };
}

export function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  const ua = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return ua > 0 ? inter / ua : 0;
}

export function l2norm(v) {
  let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s) || 1;
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = v[i] / s;
  return o;
}
