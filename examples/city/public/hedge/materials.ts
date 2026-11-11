import * as THREE from "three/webgpu";

/** Clipped leaves: Poly Haven's leafy_grass (2 m a repeat), greyed green and darkened by vertex colours toward the base. */
export function hedgeMaterial(manager: THREE.LoadingManager): THREE.MeshStandardMaterial {
  const arm = texture(manager, "leafy_grass", "arm", 2);
  return new THREE.MeshStandardMaterial({
    name: "leafy_grass",
    color: "#7f9a6a",
    map: texture(manager, "leafy_grass", "diff", 2),
    normalMap: texture(manager, "leafy_grass", "nor", 2),
    normalScale: new THREE.Vector2(2.5, 2.5),
    vertexColors: true,
    aoMap: arm,
    roughnessMap: arm,
    roughness: 1.1,
    // arm stores metalness in blue, which Poly Haven leaves at zero for non-metals
    metalnessMap: arm,
    metalness: 1,
  });
}

/** Map `name` of Poly Haven set `id` in public/assets/textures (see scripts/fetch-assets.ts), one repeat over `size` metres. */
function texture(manager: THREE.LoadingManager, id: string, name: "diff" | "nor" | "arm", size: number): THREE.Texture {
  const texture = new THREE.Texture();
  texture.flipY = false;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.setScalar(1 / size);
  texture.anisotropy = 8;
  texture.colorSpace = name === "diff" ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  const url = new URL(`../assets/textures/${id}/${name}.webp`, import.meta.url).href;
  // through the script's manager, so its load waits for the image
  new THREE.ImageBitmapLoader(manager).setOptions({ imageOrientation: "flipY", premultiplyAlpha: "none" }).load(url, (image) => {
    texture.image = image;
    texture.needsUpdate = true;
  });
  return texture;
}
