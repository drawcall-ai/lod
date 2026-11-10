import { BoxGeometry, Mesh, MeshBasicMaterial } from "three/webgpu";

/** A 2 m box named `name`, the level object most tests draw. */
export const box = (name = "") => Object.assign(new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial()), { name });
