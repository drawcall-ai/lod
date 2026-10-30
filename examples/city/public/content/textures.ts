import * as THREE from "three/webgpu";

/** Host-owned image textures; separate scene libraries keep their own materials and geometry. */
export class Textures {
  #disposed = false;
  #textures = new Map<string, THREE.Texture>();
  #pending = new WeakMap<THREE.Texture, Promise<void>>();
  #images = new Set<ImageBitmap>();
  #owned = new WeakSet<THREE.Texture>();

  load(url: string, repeat: readonly number[], colorSpace: THREE.ColorSpace, manager: THREE.LoadingManager): THREE.Texture {
    if (this.#disposed) throw new Error("Texture store is disposed");
    const key = JSON.stringify([url, repeat, colorSpace]);
    const cached = this.#textures.get(key);
    if (cached) {
      // A borrowing GLTS execution still needs this image in its provenance.
      manager.resolveURL(url);
      return cached;
    }
    const texture = new THREE.Texture();
    texture.flipY = false;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1 / (repeat[0] ?? 1), 1 / (repeat[1] ?? 1));
    texture.anisotropy = 8;
    texture.colorSpace = colorSpace;
    const image = new THREE.ImageBitmapLoader(manager).setOptions({ imageOrientation: "flipY", premultiplyAlpha: "none" }).loadAsync(url);
    this.#textures.set(key, texture);
    this.#owned.add(texture);
    this.#pending.set(
      texture,
      image
        .then((image) => {
          if (this.#disposed) {
            image.close();
            return;
          }
          this.#images.add(image);
          texture.image = image;
          texture.needsUpdate = true;
        })
        .catch((error: unknown) => {
          if (this.#textures.delete(key)) texture.dispose();
          throw error;
        }),
    );
    return texture;
  }

  owns(texture: THREE.Texture): boolean {
    return this.#owned.has(texture);
  }

  async ready(textures: Iterable<THREE.Texture>): Promise<void> {
    await Promise.all([...textures].map((texture) => this.#pending.get(texture)));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const texture of this.#textures.values()) texture.dispose();
    for (const image of this.#images) image.close();
    this.#textures.clear();
    this.#images.clear();
  }
}

// A host can supply its store through GLTS modules. Headless scripts own a local store instead.
export const sharedTextures: Textures | undefined = undefined;
