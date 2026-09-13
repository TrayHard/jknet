import { readBsp } from "./bsp";

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    const map = readBsp(event.data);
    const buffers: Transferable[] = [map.lightmaps.buffer, map.planes.buffer, map.nodes.buffer, map.leafClusters.buffer, map.visibility.buffer];
    for (const batch of map.batches) for (const value of Object.values(batch)) if (ArrayBuffer.isView(value)) buffers.push(value.buffer);
    self.postMessage({ map }, { transfer: buffers });
  } catch (error) { self.postMessage({ error: error instanceof Error ? error.message : String(error) }); }
};
