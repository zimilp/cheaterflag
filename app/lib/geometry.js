'use strict';
// Aim math for CS2 coordinates. Pitch is positive when looking down; yaw is degrees around Z.

const DEG = Math.PI / 180;
const EYE_HEIGHT = 64;     // standing eye height (units)
const TARGET_HEIGHT = 56;  // upper chest / neck — between body and head

function viewDir(pitch, yaw) {
  const p = pitch * DEG, y = yaw * DEG;
  return [Math.cos(p) * Math.cos(y), Math.cos(p) * Math.sin(y), -Math.sin(p)];
}

function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function angleBetween(a, b) {
  const d = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  return Math.acos(d) / DEG;
}

/** Degrees between where `shooter` is looking and the direction to `target`. */
function aimError(shooter, target) {
  const eye = [shooter.X, shooter.Y, shooter.Z + EYE_HEIGHT];
  const tgt = [target.X, target.Y, target.Z + TARGET_HEIGHT];
  const want = norm([tgt[0] - eye[0], tgt[1] - eye[1], tgt[2] - eye[2]]);
  return angleBetween(viewDir(shooter.pitch, shooter.yaw), want);
}

/** Degrees the view turned between two samples of the same player. */
function viewDelta(a, b) {
  return angleBetween(viewDir(a.pitch, a.yaw), viewDir(b.pitch, b.yaw));
}

function distance(a, b) {
  return Math.hypot(a.X - b.X, a.Y - b.Y, a.Z - b.Z);
}

module.exports = { aimError, viewDelta, distance, viewDir, angleBetween };
