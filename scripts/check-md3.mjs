import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import ts from 'typescript';
import {pathToFileURL} from 'node:url';
import {Vector3} from 'three';

const root=path.resolve(import.meta.dirname,'..');
const modulePath=path.join(root,'node_modules/.cache/md3-check.mjs');
fs.mkdirSync(path.dirname(modulePath),{recursive:true});
fs.writeFileSync(modulePath,ts.transpileModule(fs.readFileSync(path.join(root,'src/lib/md3.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.ES2020}}).outputText);
const {readMd3}=await import(pathToFileURL(modulePath));
const manifest=JSON.parse(fs.readFileSync(process.argv[2]??path.join(root,'../notes/library-qa/preview-assets/assets.json'),'utf8'));
let count=0;
for(const asset of manifest.filter(asset=>asset.name.endsWith('.md3'))) {
 const file=fs.readFileSync(asset.path), buffer=file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength);
 const mesh=readMd3(buffer);
 let outward=0,inward=0,vertices=0;
 for(const surface of mesh.surfaces) {
  vertices+=surface.positions.length/3;
  assert(surface.positions.every(Number.isFinite));
  for(let i=0;i<surface.normals.length;i+=3) assert(Math.abs(new Vector3().fromArray(surface.normals,i).length()-1)<1e-5);
  for(let i=0;i<surface.indices.length;i+=3) {
   const ids=surface.indices.slice(i,i+3), p=Array.from(ids,j=>new Vector3().fromArray(surface.positions,j*3));
   const dot=p[1].sub(p[0]).cross(p[2].sub(p[0])).dot(new Vector3().fromArray(surface.normals,ids[0]*3));
   if(dot>1e-7)outward++; if(dot< -1e-7)inward++;
  }
 }
 if(vertices) assert(outward/(outward+inward)>.90,asset.name+': triangle fronts follow authored normals');
 assert.throws(()=>readMd3(buffer.slice(0,buffer.byteLength-1)));
 const invalid=buffer.slice(0);new DataView(invalid).setInt32(100,-1,true);
 assert.throws(()=>readMd3(invalid));
 console.log(JSON.stringify({model:asset.name,vertices,outward,inward}));count++;
}
assert(count>0,'Provide a manifest with real MD3 fixtures');
assert.throws(()=>readMd3(new ArrayBuffer(108)));
console.log(`MD3 checks passed on ${count} real models, including bounds, normals and malformed inputs.`);
