import * as THREE from "three/webgpu";

/**
 * Where the ladybird sits on the hero plant, in the plant's space: the leaf vertex test/world/corn/seat.test.ts finds
 * on it. Building the hero plant takes seconds, so the page keeps the result, which that test holds it to.
 */
export const LADYBIRD_SEAT = {
  point: new THREE.Vector3(0.234367, 1.49719, -0.058676),
  normal: new THREE.Vector3(-0.595192, 0.802471, 0.042267),
  heading: 1.926841,
};

/** The ladybird's transform in its plant's space: the beetle, built on y = 0 facing +z, stood on LADYBIRD_SEAT. */
export function seatMatrix(): THREE.Matrix4 {
  const { point, normal, heading } = LADYBIRD_SEAT;
  const tilt = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), normal.clone().normalize());
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading);
  return new THREE.Matrix4().compose(point, tilt.multiply(turn), new THREE.Vector3(1, 1, 1));
}
