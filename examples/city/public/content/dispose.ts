import { Mesh, Texture, type Object3D } from "three/webgpu";

export function dispose(object: Object3D): void {
  const resources = new Set<{ dispose(): void }>();
  object.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    resources.add(node.geometry);
    for (const material of [node.material].flat()) {
      resources.add(material);
      for (const value of Object.values(material)) if (value instanceof Texture) resources.add(value);
    }
  });
  for (const resource of resources) resource.dispose();
}
