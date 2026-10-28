import { BoxGeometry, Mesh, MeshBasicMaterial } from "three/webgpu";

export function shape(): Mesh<BoxGeometry, MeshBasicMaterial> {
  return new Mesh(new BoxGeometry(2, 3, 4), new MeshBasicMaterial({ color: "tomato" }));
}
